# Supabase setup

Do this once, before starting the backend.

## 1. Create the project

<https://supabase.com/dashboard> → **New project**. Pick a region near you and
save the database password somewhere safe.

## 2. Apply the schema

Run the migrations in order — `0001_init.sql` through `0007_company_watch.sql` —
either by pasting each into **SQL Editor → New query**, or with the CLI:

```bash
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

`0001` creates the `applications` and `resumes` tables, the `resumes` storage
bucket, the `application_stats()` function, and — the important part — the Row
Level Security policies. `0002` adds the job board an application came from and
widens the uniqueness key to `(user, board, job id)`, since the same job id can
exist on two different boards. It is safe to run on an existing database:
existing rows default to `linkedin`. `0005` keeps the posting text with each
application and adds your match rating (`feedback`), which the dashboard sets
and `ranker/evaluate.py` checks the ranker against. `0006` adds your job list
(`job_queue`): links uploaded on the website's Job list page, which a run
applies to before it searches the boards. It also lets an application be
recorded under `direct`, for links to a company's own site. `0007` adds your
favourite companies (`company_watch`) and the postings already considered for
them (`company_seen`); section 6 below sets up the schedule that checks them.

## 3. Confirm new accounts with an emailed code

Creating an account emails a 6-digit code; the account exists once the code is
entered, on the website or on the extension's Account page. Three settings make
that happen:

1. **Authentication → Sign In / Providers → Email → Confirm email: on.**
   Without it, accounts are created on the spot with no email at all.
2. **Authentication → Emails → Templates → Confirm signup:** send the code,
   not a link. Replace the body with something like:

   ```html
   <h2>Your jobDo code</h2>
   <p>Enter this code to finish creating your account:</p>
   <p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
   <p>It expires in an hour. If you did not sign up for jobDo, ignore this email.</p>
   ```

   The template must not contain `{{ .ConfirmationURL }}`, or people get a link
   the site does not use.
3. **Authentication → Emails → SMTP Settings: set up your own email provider**
   (Resend, Brevo, SendGrid, Amazon SES, or a Gmail app password). Supabase's
   built-in sender only delivers to your project's own team members, a few an
   hour, so anyone else would never get a code.

The code is good for an hour (**Email OTP Expiration** on the Email provider
page) and "Send a new code" can be pressed once a minute. The backend calls
`verifyOtp`, which confirms the address and signs in at once; ten wrong codes
from one address lock that address out for fifteen minutes.

## 4. Copy the keys

**Project Settings → API**:

- **Project URL** → `SUPABASE_URL`
- **anon / public key** → `SUPABASE_ANON_KEY`

Everything a signed-in person does runs with their own token, so the database
enforces isolation itself; the `anon` key is all that needs.

The `service_role` key bypasses Row Level Security. The backend uses it for one
thing only, and only if you set it: the **scheduled** favourite-companies check
(section 6), which has to read every account that is due while nobody is signed
in. That code names the account in every query and can only read the settings,
resume and favourites it needs and add to that account's job list. If you skip
section 6, leave `SUPABASE_SERVICE_ROLE_KEY` unset.

## 5. Check it

```bash
cd backend && npm run check:supabase
```

It verifies the auth service answers, both tables exist, an anonymous read
returns **no rows** (which is RLS working), and the stats function is
installed.

The storage bucket is reported as `?` rather than pass or fail, because it
genuinely cannot be determined from outside: `storage.buckets` is itself behind
RLS, so an anonymous listing is empty whether or not the bucket exists, and the
storage API answers "Bucket not found" in both cases by design — it will not
tell an anonymous caller which buckets exist.

Two ways to settle it. In the SQL editor:

```sql
select id, public, file_size_limit from storage.buckets where id = 'resumes';
```

One row with `public = false` is what you want. Or run the check signed in as
one of your own accounts, which tests the thing you actually care about —
that uploads work and the policies hold:

```bash
CHECK_EMAIL=you@example.com CHECK_PASSWORD=... npm run check:supabase
```

That uploads a small file to your own folder, reads it back, confirms the
public URL is **not** reachable, confirms a write into another account's folder
is refused, and cleans up after itself.

## 6. Schedule the favourite-companies check (optional)

On the website's **Job list** page you can pick companies whose jobs are listed
on Greenhouse, Lever, Ashby or Workday, and how often to check them. The checks
themselves are started by Supabase: `pg_cron` calls the backend every 15
minutes, and the backend checks the accounts whose interval has come round.
Without this, only the page's **Check now** button runs a check.

1. Make a secret, at least 24 characters: `openssl rand -hex 32`.
2. On the backend (Vercel → Settings → Environment Variables) set
   `CRON_SECRET` to it and `SUPABASE_SERVICE_ROLE_KEY` to the **service_role**
   key from **Project Settings → API**. Redeploy. `/api/health` then shows
   `"companyChecks": true`.
3. **Database → Extensions**: switch on `pg_cron` and `pg_net`.
4. In the SQL editor, with your secret and API address filled in:

   ```sql
   -- The secret lives in Vault, not in the job's text.
   select vault.create_secret('PASTE-THE-SAME-CRON_SECRET', 'jobdo_cron_secret');

   select cron.schedule(
     'jobdo-favourite-companies',
     '*/15 * * * *',
     $$
     select net.http_post(
       url := 'https://job-do.vercel.app/api/cron/companies',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'jobdo_cron_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     );
     $$
   );
   ```

To see it working: `select * from cron.job_run_details order by start_time desc limit 5;`
shows each call, and `select status_code, content from net._http_response order by created desc limit 5;`
what the API answered (`{"due":..,"checked":..,"added":..}`; a `401` means the
two secrets differ). To stop it: `select cron.unschedule('jobdo-favourite-companies');`

Each call checks up to 25 due accounts and stops starting new ones after 45
seconds; whatever is left is picked up 15 minutes later.

## How isolation works

Every policy is the same shape:

```sql
using (auth.uid() = user_id) with check (auth.uid() = user_id)
```

Storage keys off the first path segment, so a file at `<user-id>/<uuid>-cv.pdf`
is only reachable by that user:

```sql
using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text)
```

This is why the backend's job is validation and shaping, not access control. A
mistake in the API cannot leak another account's rows, because Postgres will
not return them.

## Backups

**Database → Backups** in the dashboard. Free-tier projects also pause after a
week of inactivity — if the app suddenly cannot connect, check whether the
project needs waking up.

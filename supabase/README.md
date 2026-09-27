# Supabase setup

Do this once, before starting the backend.

## 1. Create the project

<https://supabase.com/dashboard> → **New project**. Pick a region near you and
save the database password somewhere safe.

## 2. Apply the schema

Run the migrations in order — `0001_init.sql` through `0005_ranking_feedback.sql` —
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
and `ranker/evaluate.py` checks the ranker against.

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

Do **not** put the `service_role` key in the backend. It bypasses Row Level
Security, and this server deliberately never uses it — every query runs with
the signed-in user's own token so the database enforces isolation itself.

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

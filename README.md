# jobDo

Reads your resume, finds matching jobs on **LinkedIn, Naukri and Indeed**, and
applies to them one at a time while you watch — through each board's own quick
apply form, or through the employer's career site. Everything it does is
recorded, and the history is visible in a dashboard from the extension or from
the web.

**Read this first.** Automated applying breaks the terms of every one of these
sites — LinkedIn's User Agreement forbids bots outright (section 8.2), and
Naukri and Indeed say the same. Accounts do get restricted for it, and Indeed
in particular runs active bot detection. Nothing here hides what it is doing: it drives the real page,
paces itself like a person, caps how much it does per day, and logs every
decision. Start in dry run, keep the caps low, and read the log before you
trust it. The account risk is yours.

## The pieces

| | | |
|---|---|---|
| [`extension/`](extension/README.md) | Chrome extension (Manifest V3) | The part that actually applies, on all three boards |
| [`frontend/`](frontend/README.md) | Static web app | Sign in and see your history anywhere |
| [`backend/`](backend/README.md) | Express API | Accounts, history, resume storage, your ranking threshold |
| [`ranker/`](ranker/README.md) | Python service | Scores each posting against your resume and decides apply or skip |
| [`supabase/`](supabase/README.md) | Postgres schema + RLS + storage bucket | The database |

The extension works entirely on its own, with a simpler built-in keyword
scorer. The rest are needed for the ranker, and for the history to outlive an
uninstall and be readable from another machine.

## How a run chooses jobs

Every run, manual or scheduled, reads the full description of about three times
as many postings as it is allowed to apply to, has the ranker score each one,
and then applies to the highest scores first, down to your threshold. The
threshold is stored on your account and can be changed from the web dashboard
or the extension's Settings.

Once a day (2 PM by default) a run starts by itself on postings from the last 24
hours, newest first, because early applicants get seen first. If Chrome is closed
at 2 PM, it runs as soon as Chrome opens, any time before midnight.

## Getting started

**Just the extension** — no server, nothing leaves your machine:

`chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
Then upload your resume in Settings and read
[extension/README.md](extension/README.md).

**With an account and the web dashboard:**

```bash
# 1. Create a Supabase project and run the migrations in supabase/migrations/
#    (see supabase/README.md)

# 2. API
cd backend && cp .env.example .env    # fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm install && npm run check:supabase && npm start

# 3. Web app
cd frontend && npm run dev            # http://localhost:4173
```

Then connect the extension from **Settings → 8. Account & sync**.

## How the parts fit

```
 Chrome extension ──┐                        ┌── Supabase Auth
   applies, logs    │                        │
                    ├──► backend (Express) ──┼── Postgres  (applications, RLS)
 Web app (static) ──┘     validation only    │
   reads history                             └── Storage   (resume files, RLS)
```

Two decisions shape everything else:

**One dashboard, two data sources.** The dashboard the extension shows and the
one the web app serves are the same code. `source.js` checks for
`chrome.runtime.id` and reads either `chrome.storage` or the REST API. The
canonical copy lives in `frontend/public/app/`; `npm run sync:dashboard` copies
it into the extension, which needs it on disk because Manifest V3 forbids
loading code over the network. `npm run check:dashboard` fails if that copy has
drifted.

**Boards are adapters, not branches.** Each board supplies only three things:
a search URL, a way to read its results list, and its own quick-apply flow.
The resume parsing, job scoring, answer engine, pacing, history, sync,
dashboard **and the whole ATS portal engine** are shared. Adding a fourth board
is one file in `extension/src/shared/sites.js` and one in
`extension/src/content/sites/`.

**Access control lives in Postgres, not in the API.** Every Supabase call the
backend makes carries the caller's own access token, so Row Level Security
applies to it. The `service_role` key is never used and is not needed to run
the server. A bug in the API cannot leak another account's rows, because the
database will not return them.

## Commands

| | |
|---|---|
| `npm run sync:dashboard` | Copy the dashboard into the extension |
| `npm run check:dashboard` | Fail if the extension's copy is stale (for CI) |
| `npm test` | Backend test suite |
| `npm run dev:api` / `npm run dev:web` | Backend and frontend in watch mode |

## Deploying

The frontend is static files and the backend is a plain Node process, so they
deploy independently:

- **frontend** → any static host. Output directory `public`, no build command.
  Set `API_BASE` in `public/config.js` to the backend's URL.
- **backend** → any Node host. `npm install` / `npm start`, plus the
  environment variables in `.env.example`. Point `CORS_ORIGINS` at the frontend
  and set `TRUST_PROXY=true`.
- **ranker** → a Python host; on Vercel, a second project with root directory
  `ranker`. See [ranker/README.md](ranker/README.md). The backend then needs
  `RANKER_URL` and `RANKER_SECRET`.
- **Upstash Redis** (free tier is enough to start) → one database, whose REST
  URL and token go into **both** the backend and the ranker as
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. The ranker caches
  parsed postings in it; the backend keeps login rate limits in it. Both work
  without it, just less well.
- **the extension** is loaded unpacked, or zipped for the Chrome Web Store.

Because the two ends are then on different sites, the backend also needs
`COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` — without that pair the browser
drops the session cookie and you appear signed out the moment you sign in.

## Tests

```bash
npm test                 # 82 backend tests (in-memory providers, no network)
```

The extension's 192 tests were written against a scratch harness outside the
repo: resume parsing, years estimation, job scoring, answer resolution, the
DOCX reader, the portal fill engine, the Naukri and Indeed adapters against
realistic markup, and the dashboard's metrics, both data sources and chart
geometry under jsdom.

No board's DOM layer can be verified against the live site from here. Each
board's selectors are isolated in one place for when the page changes:
[`selectors.js`](extension/src/content/selectors.js) for LinkedIn, and the
`SEL` block at the top of
[`sites/naukri.js`](extension/src/content/sites/naukri.js) and
[`sites/indeed.js`](extension/src/content/sites/indeed.js).

## What is stored where

| | |
|---|---|
| In the extension (`chrome.storage.local`) | settings, answer rules, resume file and text, local history, activity log |
| In Supabase Postgres | one row per job per account per board: title, company, outcome, reason, score, board, route, timestamp |
| In Supabase Storage | the resume file, under `<user-id>/…` in a private bucket |

Sync is one-way: the extension pushes up. Nothing is pulled back down into the
extension's local dedupe list, so two machines syncing to one account will each
keep their own idea of what they have already applied to.

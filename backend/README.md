# Backend

The API behind the web dashboard and the extension's sync. Express in front of
Supabase: Postgres for application history, Supabase Auth for accounts, Supabase
Storage for resume files.

## Run it

```bash
cd backend
cp .env.example .env     # fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm install
npm start
```

Set the project up first — see [`../supabase/README.md`](../supabase/README.md).
Confirm it with `npm run check:supabase`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SUPABASE_URL` | — | Project URL |
| `SUPABASE_ANON_KEY` | — | anon/public key. The **only** key needed |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `CORS_ORIGINS` | empty | Comma-separated frontend origins. Without this, browser calls are blocked |
| `COOKIE_SAMESITE` | `lax` | `none` when the frontend is on a different site |
| `COOKIE_SECURE` | derived | Forced on with `SameSite=none`; browsers require it |
| `COOKIE_DOMAIN` | unset | For sharing cookies across subdomains |
| `ALLOW_SIGNUP` | `true` | Set `false` once your account exists |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy, so rate limits see real IPs |
| `PROVIDERS` | `supabase` | `memory` swaps in the in-memory test doubles |
| `RANKER_URL` | empty | The Python ranker (`ranker/`). Empty turns ranking off: `/api/rank` answers 503 and the extension uses its built-in scorer |
| `RANKER_SECRET` | — | Shared with the ranker; required when `RANKER_URL` is set |
| `RANKER_TIMEOUT_MS` | `25000` | |
| `UPSTASH_REDIS_REST_URL` | empty | Upstash Redis (REST URL, `https://`). Holds login rate-limit counts so every serverless instance shares them. Without it each instance counts on its own. `KV_REST_API_URL` also works |
| `UPSTASH_REDIS_REST_TOKEN` | — | Required with the URL. `KV_REST_API_TOKEN` also works |

### Cookies, and why SameSite matters

The web app keeps its session in `HttpOnly` cookies, so page script — including
anything injected through an XSS — cannot read the token.

- **Same site** (including `localhost:4173` and `localhost:8787`, since ports
  do not affect "site"): leave `COOKIE_SAMESITE=lax`.
- **Different domains** (`app.vercel.app` → `api.onrender.com`): that is
  cross-site, so set `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`. Both
  sides must then be HTTPS, which they will be on those hosts.

The extension does not use cookies at all; it holds a bearer token, so nothing
of its traffic is cross-site.

## Deploying

Any Node host works — Render, Railway, Fly, a VPS. Build command `npm install`,
start command `npm start`. Set the environment variables above, including
`CORS_ORIGINS` pointing at the deployed frontend, and `TRUST_PROXY=true`.

There is no database to provision: Supabase is the database.

## API

`Authorization: Bearer <token>` or the `sb-access` cookie. Everything except
`auth/*` and `health` needs one.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | `{email, password, client}`. `202` if email confirmation is on |
| POST | `/api/auth/login` | Rate limited: 10 failures per email+IP per 15 min |
| POST | `/api/auth/refresh` | Access tokens last ~1 hour; this renews them |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/reset-password` | Always the same answer, so it cannot enumerate accounts |
| GET | `/api/me` | |
| POST | `/api/applications` | `{records:[...]}`, upserted on `(user, jobId)` — re-sending is safe. A record's `description` (the posting, up to 12,000 characters) is kept; a record without one leaves the saved one alone |
| GET | `/api/applications` | `?since=&limit=&offset=` |
| GET | `/api/stats` | Aggregated in Postgres, not in the browser |
| DELETE | `/api/applications` | Needs `?confirm=yes` |
| PUT | `/api/feedback` | `{ jobId, site, feedback }`: your match rating, `"good"`, `"bad"`, or `null` to take it back. 404 if the account has no such application |
| GET | `/api/feedback/export` | Every rated application with its posting, plus the resume and threshold: the file `ranker/evaluate.py` reads |
| POST | `/api/resume` | `{filename, mime, data, text, profile}`; base64 or data URL, 8 MB cap |
| GET | `/api/resumes` | Metadata only |
| GET | `/api/resumes/:id/file` | The original file |
| GET | `/api/resumes/current/profile` | The parsed profile |
| DELETE | `/api/resumes/:id` | |
| GET | `/api/config` | Every setting, as `{ config: { sites, search, match, rank, schedule, safety, portal, answers, resume }, unknownQuestions }`. `match.minScore` is the ranking threshold |
| PATCH | `/api/config` | `{ config: { section: { field: value } } }`. Replaces only the named fields of the named sections, so the extension can flip one switch without overwriting the rest |
| POST | `/api/unknown-questions` | `{ questions: [...] }` from the extension: questions a run could not answer. Deduplicated by label, last 60 kept |
| DELETE | `/api/unknown-questions` | `?label=` dismisses one; no label dismisses all |
| GET | `/api/resumes/current` | What the extension runs on: profile, text and the file's `sha256` (it downloads the file again only when that changes) |
| PUT | `/api/resumes/current/profile` | `{ profile }`, saved by the website's Settings page |
| GET | `/api/settings` | `{ minScore }`, the ranking threshold (60 until changed) |
| PUT | `/api/settings` | `{ minScore }`, a whole number 0-100 |
| POST | `/api/rank` | `{ jobs: [{id, title, company, location, description}], profile?, resumeText? }`, at most 50 jobs. Scores them with the ranker against the stored resume (or the one sent) and the account's threshold |

`client: "extension"` returns tokens in the body and sets no cookie; anything
else gets the cookies.

## How it is put together

`providers.supabase.js` and `providers.memory.js` implement the same two
contracts — `auth` and `repoFor(user, token)`. `config.PROVIDERS` picks one at
startup. The route code never imports Supabase directly, which is what lets the
whole API be tested without a project, and would make another backend a matter
of writing one more file.

**Security notes worth knowing before you change anything here:**

- Every Supabase call uses a client carrying *the caller's own access token*, so
  Row Level Security applies to it. The `service_role` key is never used and is
  not required to run this server. Access control lives in Postgres; this layer
  does validation and shaping.
- Login says "wrong email or password" either way, and password reset always
  gives the same answer, so neither can be used to discover who has an account.
- Uploaded filenames are sanitised before they reach a `Content-Disposition`
  header, and unexpected MIME types are served as `application/octet-stream`
  with `nosniff` so an uploaded file can never execute as HTML.
- CORS echoes an exact allowed origin and never a wildcard, because these
  requests carry credentials.

## Tests

```bash
npm test
```

About 170 checks against a real listener using the in-memory providers — no
Supabase project, no network. They cover registration and login, token refresh
and replay, the auth guard, upsert semantics, input sanitising, resume round-trips,
match ratings and their export,
header injection through filenames, CORS behaviour for allowed, unknown and
extension origins, and cross-account isolation.

The isolation tests assert the API's own behaviour. In production RLS enforces
the same thing a second time, in the database.

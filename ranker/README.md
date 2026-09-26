# Ranker

Scores job postings against your resume, 0-100, and says **apply** or **skip**.
The extension reads a pool of postings (three times as many as it will apply
to), sends them here through the backend, then applies to the highest scores
first. Anything below your threshold is never applied to.

Pure Python standard library, with FastAPI as a thin HTTP layer. No model files,
no GPU, and it starts in well under a second on a serverless host.

## What it looks at

| Component | Weight | How |
|---|---|---|
| Required skills | 35 | ~220 skills with their aliases (`k8s` = Kubernetes, `ReactJS` = React). A skill counts as *required* or *nice to have* by the section it's in ("Requirements" vs "Nice to have") and the wording ("must", "is a plus"). Close relatives earn partial credit: knowing React counts for half of a Vue requirement. Products outside that list (Duck Creek, Guidewire, Pega, CyberArk) count too, and you have one if your resume names it: see below |
| Experience | 20 | Years asked for (`3-5 years`, `5+ yrs`, `minimum of 4 years`) vs the years on your profile. Company age ("founded 20 years ago") is ignored. Years tied to one skill ("5+ years of Java") are checked against that skill |
| Title | 15 | Same line of work (software, data science, QA, DevOps...), shared title words, and whether the tech in the title is yours |
| Seniority | 10 | Intern ... director, from the title or the years asked for, against your level |
| Text similarity | 10 | TF-IDF cosine between the resume and the posting, with IDF computed over the batch |
| Nice-to-have skills | 5 | As for required skills |
| Education | 5 | Degree asked for vs degree held. "Or equivalent experience" waives it |

A component the posting says nothing about is left out and the rest are
re-weighted, instead of being guessed at.

On top of the average:

- **The title decides what the job is.** If the technology or product in the
  title isn't on your resume ("Salesforce Developer", "Duck Creek Policy
  Developer"), the posting cannot score above 45, however well the generic
  skills around it match. If you only have a close relative of it (C++ for a
  "Rust Developer"), not above 55.
- **Caps**: a posting where you cover under 35% of 4+ required skills, are 3+
  years short, or that is a different line of work cannot score above 45-50.
- **Knockouts** (always skip): security clearance, US citizens only, fluency
  in a language your resume doesn't mention, 5+ years short, an internship
  when you have 3+ years.
- **Thin postings** (under ~250 characters) are judged cautiously: they
  have to beat the threshold by 10.

**Products it has never heard of.** A skill list can't cover every insurance
platform and vendor tool, and a posting built around one would otherwise look
like a fit on the Java and SQL around it. So a word counts as a product when it
is written like a name (mid-sentence capital, CamelCase, a short acronym), is
repeated, and is *asked for* ("experience in Duck Creek", "Gosu programming").
That last test is what keeps out cities, team names, clients and level codes
("our Thane office", "the Atlas team", "Software Engineer II"), as do the
posting's company and location.

**Seniority from your title** moves your level halfway toward what the title
says, not all the way: titles run ahead of experience at many companies, and
two years as "Senior Software Developer" reads as mid-level.

Every result carries its reasons, e.g.
`91 apply: 10/11 key skills (missing web accessibility); asks 3-6y, you have 4y`,
and those show up in the extension's log and in the dashboard's history.

## Checking it against your ratings

The rules above were tuned by hand, so the real test is jobs you have seen.
Every job a run scores is saved to your account with its posting, and the
dashboard's "Every application" table lets you mark each one a good or a bad
match, whatever the run did with it. Rating a few skipped jobs matters as much
as rating applied ones: that is the only way to find good jobs it turned down.

Press **Export ratings** on the dashboard, then:

```bash
python evaluate.py jobdo-ratings.json                 # against your account's threshold
python evaluate.py jobdo-ratings.json --threshold 65   # or try another
```

It scores every rated job again with the ranker in this folder, against the
resume on your account, and prints how often it disagrees with you, how many
good jobs it would skip and bad ones it would apply to, how well it keeps good
jobs above bad ones (1.00 is perfect), and the threshold that would have agreed
with you most. Each figure is shown for the scores given at the time and for
the ranker as it is now, followed by every job it still gets wrong with its
reasons. Run it before and after changing the ranker: a change that fixes one
posting and breaks three others shows up here.

The export holds your resume text, so keep it out of the repository.

## Caching

Parsing a posting is almost all of the ranker's work (~10 ms for a typical one,
close to a second for the longest), and the result doesn't depend on who is
asking. So each parsed posting is cached and shared by everyone who comes
across it, and each resume's features are cached per resume.
A cached batch of 15 ranks in about 20 ms instead of a few hundred.

- **Keys are hashes of the content**: title + description + company + location
  (+ any of your custom skills that appear in it) for a posting, resume text +
  profile for a resume.
  Never a job id, so nobody can send a fake description for a real job and
  change other people's scores.
- **Two layers**: a small in-memory cache per instance (free, lives while the
  instance is warm) and **Upstash Redis** (shared, entries expire after 7 days).
- **Optional**: without Upstash it caches in memory only. If Upstash fails, it
  stops asking it for 60 s and carries on. Results are identical either way.
- **Bump `__version__`** in `jobdo_ranker/__init__.py` whenever parsing
  changes. It's part of every key, so old entries are simply never read again.

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or the
`KV_REST_API_URL` / `KV_REST_API_TOKEN` pair that Vercel's Upstash
integration creates. `/health` pings Redis and says `"cache": "redis"` when
it works.

## Run it locally

```bash
python -m unittest discover -s tests              # the tests need nothing installed

pip install -r requirements.txt uvicorn
RANKER_SECRET=dev uvicorn api.index:app --port 8000
```

Then run the backend with `RANKER_URL=http://127.0.0.1:8000 RANKER_SECRET=dev`.

## Deploy on Vercel

A second Vercel project, next to the backend's:

1. Vercel → **Add New → Project** → the same GitHub repo.
2. **Root Directory:** `ranker`. Framework preset: **FastAPI**. Vercel finds the
   app in `api/index.py` and sends every path to it, so no `vercel.json` is needed.
   A rewrite there would break it: the app would see every request as `/api/index`.
3. **Environment variables:**
   - `RANKER_SECRET` = a long random string, e.g. from
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, from the
     database's page on upstash.com (the **REST** URL, starting `https://`).
4. Deploy, then open `https://<ranker>.vercel.app/health`. It should show
   `"secretConfigured": true` and `"cache": "redis"`.

Then, in the **backend** project, add `RANKER_URL=https://<ranker>.vercel.app`
and the same `RANKER_SECRET`, and redeploy it.

The ranker refuses every request without the secret, and refuses to run at all
if none is set, so its URL being public does no harm.

## API

| Method | Path | |
|---|---|---|
| GET | `/health` | `{ ok, version, secretConfigured, cache }` |
| POST | `/rank` | Header `X-Ranker-Secret`. Body `{ threshold, candidate: { resume_text, profile }, jobs: [{ id, title, company, location, description }] }`, at most 50 jobs. Returns `{ threshold, version, results: [{ id, score, verdict, confidence, reasons, summary, breakdown, matched_skills, missing_skills, knockouts, rank }] }` in the order the jobs were sent |

Both are also served under `/api/...`.

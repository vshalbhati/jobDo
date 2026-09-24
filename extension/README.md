# The Chrome extension

This is the extension itself. For the project overview, the backend and the web
app, see the [root README](../README.md).

A Chrome extension (Manifest V3) that reads your resume, searches **LinkedIn,
Naukri and Indeed** for matching jobs, and fills and submits the applications
one at a time while you watch. Two routes on every board: the board's own quick
apply form, and **company portals** (the employer's site it hands you off to).

**Read this first.** Automated applying breaks LinkedIn's User Agreement
(section 8.2 forbids bots and automated browsing), and LinkedIn does restrict
accounts for it. Nothing here hides what it is doing: it drives the real page,
paces itself like a person, caps how much it does per day, and logs every
decision. Start in dry run, keep the caps low, and read the log before you
trust it. The account risk is yours.

---

## Install

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder (the one holding `manifest.json`).
3. Pin the extension, open **Settings & resume** from the popup.

No build step, no npm install. `src/vendor/pdf.min.mjs` is a vendored copy of
Mozilla's pdf.js (MV3 forbids loading remote code, so it ships with the
extension).

## First run

1. **Settings → 1. Resume** — upload a PDF, DOCX or TXT. It is parsed locally
   and never leaves your machine unless you choose the "upload on every
   application" strategy, which sends it to LinkedIn exactly as you would.
2. **2. Profile** — check what the parser found. These values get typed into
   real application forms, so fix the wrong ones. Pay attention to the skill
   list and the years on each skill; they answer the "how many years with X"
   questions.

   Total years is taken from a phrase like "2+ years of experience" if your
   resume states one, otherwise from the union of the date ranges under your
   employment heading — education, projects, certifications and volunteering
   are excluded, so a four-year degree is not counted as four years of work.
   If you correct the total by hand, **Apply to skills** pushes it onto every
   skill in one go.
3. **3. Search** — location, date posted, workplace type. The generated search
   URL is shown at the bottom; paste it into a browser tab to see exactly the
   job set the extension will work through. Leave keywords blank to use ones
   derived from your resume.
4. **5. Safety** — leave **Dry run** on for the first run.
5. Open LinkedIn, click the extension, press **Start applying**.

In dry run it opens each job, fills every page of the Easy Apply form, reaches
the Submit button, then discards the application. The activity log shows each
field it filled and the value it chose. When the log looks right, turn dry run
off — and consider leaving **Ask me before each submit** on for a while, which
pops a small confirm box in the page at the final step.

## Job boards

Switch boards on in **Settings → 3. Search → Job boards**. Each is worked
through in turn with its own per-run budget, and they share the keywords,
filters, matching rules and answer rules.

| Board | Quick apply | What is different |
|---|---|---|
| **LinkedIn** | Easy Apply, in a modal | The only board that can filter the *search* to jobs it can finish in-page (`f_AL=true`). Default on. |
| **Naukri** | Apply, usually one click | Sometimes opens a chat questionnaire instead of applying straight away. The adapter answers it from your rules, one message at a time, and hands the tab over if a question has no answer. |
| **Indeed** | Indeed Apply | Hands off to `smartapply.indeed.com`, which is a separate origin, so the **portal engine** completes it — the same code that fills Greenhouse and Lever. Assisted by default. |

**Indeed is the one to be careful with.** It runs the most active bot detection
of the three. This extension does not try to defeat it: the adapter recognises
a verification or challenge page, stops, and says so in the log, because
quietly hammering a challenge is how an account gets banned. Indeed also
defaults to filling the form and leaving it to you; "submit automatically" is a
checkbox you have to tick.

Boards differ in how a job is opened, which is why the results behave
differently: LinkedIn shows jobs in a side pane so a card is clicked, while
Naukri and Indeed have real job pages, so the tab is navigated to the job URL —
more reliable than clicking into a list that re-renders underneath us.

## How a job gets chosen

Two passes:

1. **From the results list** (title only, at 60% of your threshold) — skips
   anything already in your history, already applied to, not Easy Apply, on a
   blocked company, or matching a title exclusion.
2. **With the description open** (the real decision) — the score is 45% title
   overlap against your resume titles, 55% how many of your skills appear in
   the description, minus a seniority penalty when the level is far from your
   experience. Entry-level postings are a hard skip once you have 5+ years.

Every score and reason goes into the log, so if the threshold is wrong you can
see why. Start at 35 and adjust.

## How questions get answered

`Settings → 6. Application answers` is an ordered list of regex → answer rules,
matched against the question's label. First match wins. A rule with a blank
answer falls back to your profile, which is how "City" or "Expected salary"
get filled without hardcoding them.

When a question matches nothing, the extension does **not** guess. It abandons
that application (if "Abandon an application that asks something I have no
answer for" is on) and parks the question at the top of the answers section
with an **Add a rule for this** button. Answer it once and every later run
handles it. This is the loop that makes the thing actually work: the first few
runs will stop a lot, and then it stops stopping.

## Pacing and caps

Defaults: 20 per run, 50 per day, 25–70s between applications, a 12-minute
break every 10 applications, and 0.5–1.6s between individual form fields.
These are deliberately slow. The daily counter resets at midnight local time
and survives browser restarts.

**Stop** in the popup (or on the in-page HUD) aborts immediately and discards
whatever modal is open.

## Dashboard

A full-page app at **Dashboard** in the popup (or the link in Settings). It runs
inside the extension, so it reads the live history straight from
`chrome.storage` — no server, no sync, no export step — and updates itself
while a run is going via `storage.onChanged`.

What it shows:

- **A live strip** in the header: running or idle, the current phase and job,
  this run's counters, and today's usage against your daily cap.
- **The headline**: total submitted, out of how many attempted, plus today,
  last 7 days, submit rate, and distinct employers reached.
- **Applications submitted per day** over 7/30/90 days or all time.
- **What happened to each attempt** — submitted / handed to you / failed / dry
  run / skipped, as a part-to-whole bar.
- **Route taken** — LinkedIn's own form versus company portals.
- **Companies applied to most**, **match score distribution**, and an
  18-week **calendar of activity**.
- **Every application** in a sortable, searchable table with the outcome, the
  route (naming the ATS for portal applications), the reason, and a link to the
  posting. Filters apply to the export, so the CSV is whatever you are looking at.

Filters (date range, route) sit in one row above the charts and drive the whole
page. There is a light/dark toggle; dark is a selected palette, not an inverted
one.

The charts are hand-rolled SVG — no charting library, since MV3 forbids remote
code and a vendored one would be 200KB for five simple charts. The palette was
run through a contrast/colour-blindness validator rather than eyeballed: an
earlier five-status version was rejected for putting two oranges at ΔE 13.6
(below the readability floor), which is why outcomes use three status colours
plus a de-emphasis gray. Outcome is never colour alone — every status carries a
dot *and* its name, in the legend and in the table.

## Optional: sync to your account

By default nothing leaves your machine, and the history dies with the
extension. Connecting an account mirrors each application and your resume to
the [backend](../backend/README.md), so the history survives an uninstall and
opens in any browser.

**Settings → 8. Account & sync**: enter the API address and the web dashboard
address, create an account, connect. Chrome asks for permission to reach that
host, which is why the button has to be clicked rather than configured silently.

From then on each application is uploaded as it happens. Sync failures never
interrupt a run - they are logged, and the next "Sync everything now" catches
up, because uploads are upserts keyed on the LinkedIn job id. Access tokens
expire after about an hour, so the sync client renews once on a 401 before
reporting a problem.

The web dashboard is **the same dashboard**, not a second one. Its source of
truth lives in `frontend/public/app/`; `src/dashboard/` here is a generated
copy, because Manifest V3 forbids loading it over the network. Edit the
frontend, then run `npm run sync:dashboard` from the repo root.
`source.js` checks for `chrome.runtime.id` and reads either
`chrome.storage` or the REST API; everything else is identical.

## When it breaks

LinkedIn reskins its job pages a few times a year. When that happens the
symptom is "0 jobs on page" or "Easy Apply modal never opened", and the fix is
almost always in one file:

- `src/content/selectors.js` — every LinkedIn-specific CSS selector, as lists
  of fallbacks tried in order. Add the new selector to the front of the
  relevant list.
- Buttons are matched by visible text and `aria-label` (`window.LEA.BTN`)
  rather than class names, since labels change far less often.

Other things worth knowing:

- The service worker is killed by Chrome after ~30s idle. The run loop pings
  the content script during every wait to keep it alive, and a watchdog alarm
  restarts the loop from persisted state if it dies anyway.
- A scanned/image-only PDF yields no text. The upload will tell you so rather
  than silently producing an empty profile.
- History is keyed by LinkedIn job id, so a job is never applied to twice.
  Clearing history re-opens everything.

## Layout

```
manifest.json
src/
  background/service-worker.js   run loop, caps, pacing, tab + message plumbing
  content/
    selectors.js                 ALL LinkedIn selectors (edit here when it breaks)
    dom.js                       click/typing helpers that Ember actually notices
    answer-engine.js             question label -> value
    scrape.js                    results list + job details pane
    easy-apply.js                the modal state machine
    main.js                      message endpoint + on-page HUD
    portal/
      portal-fill.js             mode 2: understands an arbitrary ATS form
      portal-main.js             message endpoint + hand-off banner
  shared/
    defaults.js                  config schema + built-in answer rules
    storage.js                   config, history, log, run state
    resume.js                    resume text -> profile
    matcher.js                   job scoring + search URL builder
    ats.js                       career-site host -> which ATS, and how far to go
    sync.js                      optional upload to your own server
server/                          accounts, history, resumes, the web app
  src/{server,db,auth,routes}.js
  public/                        login page
  test/api.test.js
  dashboard/
    dashboard.html/.css/.js      metrics, filters, history table
    charts.js                    hand-rolled SVG charts (no chart library)
    source.js                    chrome.storage or the REST API, decided at load
  options/                       settings page (+ PDF/DOCX text extraction)
  popup/                         start/stop, counters, live log
  vendor/                        pdf.js
```

## Mode 2: company portals

Postings whose Apply button sends you to the employer's own site. Turn it on in
`Settings → 6. Company portals`. Doing so also **drops the Easy Apply filter
from the search**, so both kinds of job come back — the search URL preview
updates to show this.

What happens per job: the extension clicks Apply, follows the tab LinkedIn
opens (through its redirector), works out which ATS is behind it, fills the
form, and then either submits or hands the tab to you.

How far it goes depends on the ATS:

| | |
|---|---|
| **auto** | A public one-page form. Filled and submitted. Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Teamtailor, BambooHR, JazzHR, Breezy, Personio, Rippling. |
| **assisted** | Wants an account or a multi-step wizard. Filled as far as possible, tab left open with a banner explaining why. Workday, iCIMS, Taleo, SuccessFactors, BrassRing, Avature, Oracle, Zoho, Eightfold. |
| **unknown** | Some company's own careers page. Same as assisted unless you tick "Submit on unrecognised career sites". |

Nothing is selector-driven here — there is no fixed markup to target across
thousands of career sites. `portal-fill.js` finds the form by where the
controls are, derives each question's label from whatever the page offers
(`label[for]`, `aria-*`, the wrapper's label-ish child, placeholder, finally
the field name), and routes the answer through the **same answer engine** the
Easy Apply flow uses. A rule you write once works on both paths, and an
unanswerable question parks itself in Settings the same way.

Other things it does on a portal form: attaches your resume file (falling back
to a synthetic drop event for drag-and-drop widgets), writes a cover letter
from your template if the form asks for one, ticks consent/privacy checkboxes
(each one logged, never silently), and answers EEO questions with "decline to
self identify" unless you have set a rule.

It refuses to submit when anything required is still empty, and says which
question stopped it.

**Permissions.** The recognised ATS domains are in the manifest. Unrecognised
career sites are not — allowing those is an explicit opt-in button in Settings
that requests the optional `https://*/*` permission, and you can revoke it from
the same place.

**Budget.** Portal applications have their own smaller per-run cap (default 10)
because each one costs a tab, a page load and a minute or two. They still count
toward your overall run and daily caps.

Dry run applies here too: the tab opens, the form is filled, the submit button
is located, nothing is sent.

## Limitations

- Resume parsing is heuristic. Check the profile page after uploading.
- One LinkedIn tab at a time; it drives the tab in the foreground.
- Assisted ATSes are never submitted automatically. Workday et al. want an
  account per employer, and guessing through a signup flow is a good way to
  create a mess in someone's recruiting system.
- Portal forms vary enormously. Expect a higher hand-off rate than Easy Apply,
  especially at first, and use the log to see what it could not answer.
- Sync is one-way: the extension pushes to the server. Two machines running the
  extension both upload to the same account, but neither pulls the other's
  history back down into its local dedupe list.
- The server has no email verification or password reset. It is built for one
  person running it for themselves, not for public signups.
- Tests: the server's 49 live under `server/test` and run with `npm test`. The
  extension's 136 were written against a scratch harness outside the repo and
  cover resume parsing, years estimation, job scoring, answer resolution, the
  DOCX reader, the portal fill engine, and the dashboard's metrics, both data
  sources and chart geometry under jsdom. The LinkedIn DOM layer can only be
  verified against the live site.

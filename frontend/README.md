# Frontend

The web dashboard: sign in, then see every application, the charts and the
history. Plain static files — no framework, no build step, no bundler.

```
public/
  index.html        sign in / create account / reset password
  config.js         where the API lives          <- the one file you edit to deploy
  login.css  login.js
  app/
    index.html      the dashboard
    dashboard.js    metrics, filters, table
    charts.js       hand-rolled SVG charts
    source.js       chrome.storage or the REST API, decided at load
    dashboard.css
```

## Run it locally

```bash
cd frontend
npm run dev          # http://localhost:4173, zero dependencies
```

with the API running on `localhost:8787`. `config.js` points at that
automatically when the page is served from localhost.

## Deploy it

`public/` is the whole site. Upload it to Vercel, Netlify, Cloudflare Pages, S3,
or any web server — output directory `public`, no build command.

**One thing to change:** set `API_BASE` at the top of `public/config.js` to your
backend's URL.

```js
var API_BASE = 'https://easy-apply-api.onrender.com';
```

Then add this site's origin to `CORS_ORIGINS` in the backend's environment, and
— since the two are now different sites — set `COOKIE_SAMESITE=none` and
`COOKIE_SECURE=true` there. Without that pair the browser will discard the
session cookie and you will appear to be signed out immediately after signing
in.

For testing a deployed API from a local page, `localStorage.setItem('easyApplyApi', 'https://...')`
overrides it without editing the file.

## The dashboard is shared with the extension

`public/app/` is the **source of truth** for the dashboard. The extension cannot
load it over the network — Manifest V3 forbids remote code — so it keeps a copy
on disk, produced by:

```bash
npm run sync:dashboard        # from the repo root
```

`source.js` is what makes one codebase serve both: it checks for
`chrome.runtime.id` and reads either `chrome.storage` or this API. Everything
else is identical.

So: **edit here, then run the sync.** `npm run check:dashboard` fails if the
extension's copy has drifted, which is worth wiring into CI.

## Sessions

The session lives in `HttpOnly` cookies set by the API, so no token is reachable
from page script. `source.js` retries once through `/api/auth/refresh` when a
request comes back 401 — access tokens last about an hour — and only sends you
back to the sign-in page if that also fails.

// Where the API lives. The frontend and the backend deploy to different
// origins, so this has to be set at deploy time.
//
//   Static host (Vercel / Netlify / Cloudflare Pages):
//     set API_BASE below to your backend URL, e.g. 'https://job-do.vercel.app'
//   Then add that frontend origin to CORS_ORIGINS in the backend's .env.
//
// Leave it empty to call the same origin that served this page.
(function () {
  var API_BASE = 'https://job-do.vercel.app';

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  // Handy during development: run the API on 8787 and the pages on any port.
  if (!API_BASE && isLocal) API_BASE = 'http://localhost:8787';

  // An override for testing against a deployed API from a local page.
  try {
    var override = localStorage.getItem('jobdoApi');
    if (override) API_BASE = override;
  } catch (e) { /* storage blocked */ }

  window.JOBDO_API = String(API_BASE || '').replace(/\/$/, '');
})();

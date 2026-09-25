// The dashboard runs in two places: inside the extension, where the data lives
// in chrome.storage, and on the web app, where it comes from the server's REST
// API. Everything environment-specific is confined to this file so there is
// only ever one copy of the dashboard UI.

const IS_EXTENSION = typeof chrome !== 'undefined'
  && !!(chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);

export const MODE = IS_EXTENSION ? 'extension' : 'web';

// Imported lazily and only in the extension: a static import would make the web
// build fetch a module it can never use.
let ext = null;
async function extStorage() {
  if (!ext) ext = await import('../shared/storage.js');
  return ext;
}

// Set by config.js at deploy time; empty means "same origin as this page".
const API = (typeof window !== 'undefined' && window.JOBDO_API) || '';

function toLogin() {
  location.href = '../index.html?next=' + encodeURIComponent(location.pathname);
}

export async function apiFetch(path, opts = {}) {
  const res = await fetch(API + '/api' + path, {
    credentials: 'include',          // the session is in HttpOnly cookies
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (res.status === 401) {
    // The access token expires long before the refresh token does, so try once
    // to renew it before giving up and sending the person back to the login.
    if (!opts._retried) {
      const renewed = await fetch(API + '/api/auth/refresh', {
        method: 'POST', credentials: 'include'
      }).then((r) => r.ok).catch(() => false);
      if (renewed) return apiFetch(path, { ...opts, _retried: true });
    }
    toLogin();
    throw new Error('not signed in');
  }
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const apiGet = (path) => apiFetch(path);

// --------------------------------------------------------------------- data

// Both sides return the same shape the dashboard expects: { jobId: record }.
export async function loadHistory() {
  if (IS_EXTENSION) return (await extStorage()).getHistory();
  const { records } = await apiGet('/applications');
  const out = {};
  for (const r of records) out[r.jobId] = r;
  return out;
}

export async function loadRun() {
  if (IS_EXTENSION) return (await extStorage()).getRun();
  // The web app watches history that has already been synced; there is no run
  // happening here.
  return { active: false, paused: false, applied: 0, skipped: 0, failed: 0, phase: '', current: null };
}

export async function loadSummary() {
  if (IS_EXTENSION) {
    const cfg = await (await extStorage()).getConfig();
    const today = new Date().toDateString();
    return {
      mode: 'extension',
      appliedToday: cfg.stats.day === today ? cfg.stats.appliedToday : 0,
      maxPerDay: cfg.safety.maxPerDay,
      dryRun: cfg.safety.dryRun
    };
  }
  const me = await apiGet('/me');
  return {
    mode: 'web',
    email: me.email,
    applications: me.applications,
    resume: me.resume
  };
}

// --------------------------------------------------------------- reactivity

export function onChange(cb) {
  if (IS_EXTENSION) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.history) cb('history');
      if (changes.run || changes.config) cb('run');
    });
    return;
  }
  // No push channel on the web; a slow poll picks up whatever the extension
  // has synced since.
  setInterval(() => cb('history'), 30000);
}

// ------------------------------------------------------------------- theme

export async function getTheme() {
  if (IS_EXTENSION) {
    const { dashTheme } = await chrome.storage.local.get('dashTheme');
    return dashTheme || '';
  }
  try { return localStorage.getItem('dashTheme') || ''; } catch { return ''; }
}

export async function setTheme(value) {
  if (IS_EXTENSION) return chrome.storage.local.set({ dashTheme: value });
  try { localStorage.setItem('dashTheme', value); } catch { /* private window */ }
}

// ------------------------------------------------------------------- resume

// What the ranker compares every job against: the resume on the account on
// the web, the one in this browser inside the extension. null if there is none.
export async function loadResume() {
  if (IS_EXTENSION) {
    const cfg = await (await extStorage()).getConfig();
    if (!cfg.resume.fileName) return null;
    return {
      filename: cfg.resume.fileName, mime: cfg.resume.mime, size: null,
      uploadedAt: cfg.resume.uploadedAt, profile: cfg.profile,
      downloadable: !!cfg.resume.dataUrl
    };
  }
  try {
    const r = await apiGet('/resumes/current/profile');
    // Supabase sends an ISO date; the in-memory test backend a timestamp.
    const at = typeof r.uploadedAt === 'number' ? r.uploadedAt : Date.parse(r.uploadedAt);
    return { ...r, uploadedAt: Number.isFinite(at) ? at : null, downloadable: true };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function downloadResume(resume) {
  const a = document.createElement('a');
  a.download = resume.filename || 'resume';
  if (IS_EXTENSION) {
    a.href = (await (await extStorage()).getConfig()).resume.dataUrl;
    a.click();
    return;
  }
  const res = await fetch(API + '/api/resumes/' + encodeURIComponent(resume.id) + '/file', { credentials: 'include' });
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  a.href = URL.createObjectURL(await res.blob());
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------- ranking threshold

// The threshold lives on the account. The web app edits it here; inside the
// extension it is changed on the Settings page instead, so this returns null.
export async function loadThreshold() {
  if (IS_EXTENSION) return null;
  return (await apiGet('/settings')).minScore;
}

export async function saveThreshold(minScore) {
  const res = await apiFetch('/settings', {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ minScore })
  });
  return res.minScore;
}

// ------------------------------------------------------------------ actions

// Settings are edited on the website. Inside the extension that page is on
// another origin, so it opens in a tab at the account's web address.
export async function openSettings() {
  if (!IS_EXTENSION) { location.href = '../settings/'; return; }
  const cfg = await (await extStorage()).getConfig();
  const web = String(cfg.sync.webUrl || '').replace(/\/+$/, '');
  if (web) chrome.tabs.create({ url: web + '/settings/' });
  else chrome.runtime.openOptionsPage();
}

export async function signOut() {
  if (IS_EXTENSION) return;
  await fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  location.href = '../index.html';
}

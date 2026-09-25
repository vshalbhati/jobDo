// Talks to the jobDo account. Settings, profile and resume come down from it
// (they are edited on the website); applications go up to it as they happen.
import { getConfig, setConfig, getHistory, log } from './storage.js';

export function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

export function originOf(url) {
  try { return new URL(normalizeUrl(url)).origin + '/*'; } catch { return ''; }
}

async function call(serverUrl, path, { method = 'GET', body, token, timeoutMs = 60000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  // A hung request would stall the run loop for good; give up instead.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(normalizeUrl(serverUrl) + '/api' + path, {
      method, headers, signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The server did not answer in time.' : 'Could not reach the server: ' + e.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(data.error || ('Server returned ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function authenticate(serverUrl, email, password, mode = 'login') {
  const data = await call(serverUrl, '/auth/' + mode, {
    method: 'POST',
    body: { email, password, client: 'extension' }
  });
  if (data.pendingConfirmation) {
    const e = new Error(data.message || 'Confirm your email address, then connect again.');
    e.pendingConfirmation = true;
    throw e;
  }
  return {
    token: data.token,
    refreshToken: data.refreshToken,
    email: data.email,
    expiresAt: Date.now() + (data.expiresIn || 3600) * 1000
  };
}

// Access tokens last about an hour - far less than a long run - so every
// authenticated call renews once on a 401 before reporting failure.
async function authedCall(cfg, path, opts = {}) {
  try {
    return await call(cfg.sync.serverUrl, path, { ...opts, token: cfg.sync.token });
  } catch (e) {
    if (e.status !== 401 || !cfg.sync.refreshToken) throw e;

    let renewed;
    try {
      renewed = await call(cfg.sync.serverUrl, '/auth/refresh', {
        method: 'POST',
        body: { refresh_token: cfg.sync.refreshToken }
      });
    } catch {
      await setConfig({ sync: { lastError: 'Sign-in expired. Reconnect in Settings.' } });
      throw new Error('Sign-in expired. Reconnect in Settings.');
    }

    // Supabase rotates the refresh token on every use; keeping the old one
    // would make the next renewal fail.
    const sync = {
      token: renewed.token,
      refreshToken: renewed.refreshToken || cfg.sync.refreshToken,
      expiresAt: Date.now() + (renewed.expiresIn || 3600) * 1000
    };
    await setConfig({ sync });
    cfg.sync = { ...cfg.sync, ...sync };
    return call(cfg.sync.serverUrl, path, { ...opts, token: sync.token });
  }
}

export async function whoAmI(cfg) {
  return authedCall(cfg, '/me');
}

const toRecord = (jobId, r) => ({
  jobId,
  title: r.title, company: r.company, location: r.location, url: r.url,
  status: r.status, reason: r.reason, score: r.score,
  source: r.source || 'easy', ats: r.ats || '', site: r.site || 'linkedin', at: r.at
});

// Idempotent: the server upserts on (user, jobId), so re-sending a record that
// is already there just refreshes it.
export async function pushRecords(cfg, records) {
  if (!records.length) return { saved: 0 };
  return authedCall(cfg, '/applications', { method: 'POST', body: { records } });
}

export async function pushOne(cfg, jobId, entry) {
  return pushRecords(cfg, [toRecord(jobId, entry)]);
}

export async function pushAll(cfg) {
  const history = await getHistory();
  const all = Object.entries(history).map(([id, r]) => toRecord(id, r));
  let saved = 0;
  // The server caps a batch at 2000 records.
  for (let i = 0; i < all.length; i += 1000) {
    const res = await pushRecords(cfg, all.slice(i, i + 1000));
    saved += res.saved || 0;
  }
  return { saved, total: all.length };
}

// Only used once, to hand a resume kept by an older version of the extension
// to the account (see adoptLocalData). Resumes are uploaded on the website.
async function pushResume(cfg) {
  return authedCall(cfg, '/resume', {
    method: 'POST',
    body: {
      filename: cfg.resume.fileName,
      mime: cfg.resume.mime,
      data: cfg.resume.dataUrl,
      text: cfg.resume.text,
      profile: cfg.profile
    }
  });
}

// Called from the run loop after each application. Failures are recorded and
// swallowed: losing the network must never interrupt a run.
export async function autoPush(jobId, entry) {
  return autoPushMany([[jobId, entry]]);
}

// items: [[jobId, entry], ...] - one request for a whole batch of skips.
export async function autoPushMany(items) {
  if (!items.length) return;
  const cfg = await getConfig();
  if (!cfg.sync.enabled || !cfg.sync.autoPush || !cfg.sync.token || !cfg.sync.serverUrl) return;
  try {
    await pushRecords(cfg, items.map(([id, entry]) => toRecord(id, entry)));
    await setConfig({ sync: { lastPushAt: Date.now(), lastError: '', pending: 0 } });
  } catch (e) {
    const pending = (cfg.sync.pending || 0) + items.length;
    await setConfig({ sync: { lastError: e.message, pending } });
    log('warn', 'Sync failed (' + pending + ' record(s) not uploaded): ' + e.message);
  }
}

export const isConnected = (cfg) => !!(cfg.sync.enabled && cfg.sync.token && cfg.sync.serverUrl);

// ------------------------------------------------------ account -> browser

// Settings sections the website owns. schedule.lastRunDay and the stats are
// this browser's own state and are never overwritten.
const PULLED = ['sites', 'search', 'match', 'rank', 'safety', 'portal'];

// Downloads everything a run needs and stores it as this browser's copy: the
// settings, the profile typed into forms, and the resume (its text for the
// ranker, the file itself for uploading to applications). The file is only
// downloaded again when its hash has changed. Returns the updated config.
export async function pullAccount(cfg) {
  let conf = await authedCall(cfg, '/config');
  let current = await authedCall(cfg, '/resumes/current').catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });

  // Upgrading from a version that kept settings in the browser: the first
  // time, the account adopts this browser's settings and resume rather than
  // this browser being reset to defaults.
  if (!cfg.sync.migrated) {
    const adopted = await adoptLocalData(cfg, conf, current);
    if (adopted.config) conf = adopted.config;
    if (adopted.resume) current = adopted.resume;
  }

  const c = conf.config || {};
  const patch = { sync: { lastPullAt: Date.now(), lastPullError: '', migrated: true } };
  for (const s of PULLED) if (c[s] && typeof c[s] === 'object') patch[s] = c[s];
  if (c.schedule) patch.schedule = { enabled: !!c.schedule.enabled, time: c.schedule.time || '14:00' };
  if (c.answers && Array.isArray(c.answers.rules)) patch.answers = { rules: c.answers.rules };

  if (current) {
    const sameFile = cfg.resume.sha256 === current.sha256 && cfg.resume.dataUrl;
    patch.resume = {
      id: current.id, sha256: current.sha256, fileName: current.filename, mime: current.mime,
      text: current.text || '', uploadedAt: Date.parse(current.uploadedAt) || Number(current.uploadedAt) || 0,
      dataUrl: sameFile ? cfg.resume.dataUrl : await downloadResumeFile(cfg, current)
    };
    if (current.profile) patch.profile = current.profile;
  } else {
    // Removed on the website: runs must not keep using an old copy.
    patch.resume = { id: '', sha256: '', fileName: '', mime: '', text: '', uploadedAt: 0, dataUrl: '' };
  }
  if (c.resume && c.resume.strategy) patch.resume.strategy = c.resume.strategy;
  return setConfig(patch);
}

async function adoptLocalData(cfg, conf, current) {
  const out = {};
  const empty = !conf.config || !Object.keys(conf.config).some((k) => k !== 'match' || Object.keys(conf.config.match).length > 1);
  if (empty) {
    const config = {
      sites: cfg.sites, search: cfg.search, match: cfg.match, rank: cfg.rank, safety: cfg.safety,
      portal: cfg.portal, answers: { rules: cfg.answers.rules },
      schedule: { enabled: cfg.schedule.enabled, time: cfg.schedule.time },
      resume: { strategy: cfg.resume.strategy }
    };
    out.config = await authedCall(cfg, '/config', { method: 'PATCH', body: { config } });
  }
  if (!current && cfg.resume.dataUrl) {
    await pushResume(cfg);
    out.resume = await authedCall(cfg, '/resumes/current');
  }
  return out;
}

async function downloadResumeFile(cfg, current) {
  // The /config call just before has already renewed the token if it had to.
  const res = await fetch(normalizeUrl(cfg.sync.serverUrl) + '/api/resumes/' + encodeURIComponent(current.id) + '/file', {
    headers: { Authorization: 'Bearer ' + cfg.sync.token }
  });
  if (!res.ok) throw new Error('Could not download the resume file (' + res.status + ')');
  const bytes = new Uint8Array(await res.arrayBuffer());
  // No FileReader in a service worker: base64 by hand, in chunks, because
  // String.fromCharCode(...bigArray) overflows the call stack.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:' + (current.mime || 'application/octet-stream') + ';base64,' + btoa(bin);
}

// ------------------------------------------------------ browser -> account

// A quick switch flipped in the popup (dry run, review before submit) is
// saved to the account, or the next download would flip it straight back.
export async function patchConfig(cfg, config) {
  return authedCall(cfg, '/config', { method: 'PATCH', body: { config } });
}

// Questions a run could not answer, so they can be turned into rules on the website.
export async function pushUnknownQuestions(cfg, questions) {
  if (!questions.length) return null;
  return authedCall(cfg, '/unknown-questions', { method: 'POST', body: { questions: questions.slice(-20) } });
}

// ------------------------------------------------------------------ ranking

// Scores postings with the ranker on the server, against your resume and
// your account's threshold. Sends the current profile and resume text, since
// they may carry corrections the uploaded copy lacks.
export async function rankRemote(cfg, jobs) {
  return authedCall(cfg, '/rank', {
    method: 'POST',
    body: { jobs, profile: cfg.profile, resumeText: cfg.resume.text || '' },
    timeoutMs: 45000
  });
}

// The threshold lives on the account so the web dashboard can change it too.
export async function fetchSettings(cfg) {
  return authedCall(cfg, '/settings');
}

export async function saveSettings(cfg, patch) {
  return authedCall(cfg, '/settings', { method: 'PUT', body: patch });
}

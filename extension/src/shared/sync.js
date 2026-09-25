// Talks to the self-hosted server. The extension stays fully usable with sync
// switched off - this only ever mirrors data upward, never depends on it.
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

export async function pushResume(cfg) {
  if (!cfg.resume.dataUrl) throw new Error('No resume stored in the extension yet.');
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

// The profile is corrected by hand far more often than the file changes;
// this keeps the server's copy (and the web dashboard) in step with it.
export async function pushProfile(cfg) {
  return authedCall(cfg, '/resumes/current/profile', { method: 'PUT', body: { profile: cfg.profile } });
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

import { STORAGE_KEY, HISTORY_KEY, LOG_KEY, RUN_KEY, defaultConfig, mergeConfig as merge } from './defaults.js';

export async function getConfig() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return merge(defaultConfig(), raw[STORAGE_KEY]);
}

export async function setConfig(patch) {
  const next = merge(await getConfig(), patch);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function replaceConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
  return cfg;
}

export async function getHistory() {
  const raw = await chrome.storage.local.get(HISTORY_KEY);
  return raw[HISTORY_KEY] || {};   // { jobId: { title, company, status, at, reason } }
}

export async function recordApplication(jobId, entry) {
  const h = await getHistory();
  h[jobId] = { ...(h[jobId] || {}), ...entry, at: Date.now() };
  await chrome.storage.local.set({ [HISTORY_KEY]: h });
  return h;
}

// Unlike recordApplication, leaves the entry's time alone: rating a job is
// not doing anything to it.
export async function setFeedback(jobId, feedback) {
  const h = await getHistory();
  if (!h[jobId]) return false;
  h[jobId] = { ...h[jobId], feedback: feedback || null };
  await chrome.storage.local.set({ [HISTORY_KEY]: h });
  return true;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: {} });
}

// Drops the entries that match, so those jobs can be tried again. Returns how many.
export async function forgetHistory(match) {
  const h = await getHistory();
  let n = 0;
  for (const [key, entry] of Object.entries(h)) {
    if (match(entry, key)) { delete h[key]; n++; }
  }
  if (n) await chrome.storage.local.set({ [HISTORY_KEY]: h });
  return n;
}

const MAX_LOG = 600;

export async function log(level, message, extra) {
  const raw = await chrome.storage.local.get(LOG_KEY);
  const entries = raw[LOG_KEY] || [];
  entries.push({ t: Date.now(), level, message, extra });
  while (entries.length > MAX_LOG) entries.shift();
  await chrome.storage.local.set({ [LOG_KEY]: entries });
  ping({ type: 'LOG_APPENDED' });
}

export async function getLog() {
  const raw = await chrome.storage.local.get(LOG_KEY);
  return raw[LOG_KEY] || [];
}

export async function clearLog() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

const IDLE_RUN = {
  active: false, paused: false, applied: 0, seen: 0, skipped: 0, failed: 0,
  page: 0, startedAt: 0, phase: 'idle', current: null, nextActionAt: 0, tabId: null
};

export async function getRun() {
  const raw = await chrome.storage.local.get(RUN_KEY);
  return { ...IDLE_RUN, ...(raw[RUN_KEY] || {}) };
}

export async function setRun(patch) {
  const run = { ...(await getRun()), ...patch };
  await chrome.storage.local.set({ [RUN_KEY]: run });
  ping({ type: 'RUN_UPDATED', run });
  return run;
}

export async function resetRun() {
  await chrome.storage.local.set({ [RUN_KEY]: { ...IDLE_RUN } });
}

// The popup is usually closed; a message with no receiver rejects, and an
// unhandled rejection in the service worker is noise. Swallow it.
function ping(msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* ignore */ }
}

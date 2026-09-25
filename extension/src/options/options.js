// The extension's own page: the account it runs for, the one permission only
// an extension page can ask Chrome for, and this computer's history. Every
// setting and the resume are edited on the jobDo website instead.
import { getConfig, setConfig, getHistory, clearHistory } from '../shared/storage.js';
import { defaultConfig } from '../shared/defaults.js';
import { SITES } from '../shared/sites.js';
import { describeNextRun } from '../shared/schedule.js';
import { authenticate, whoAmI, pushAll, normalizeUrl, originOf, isConnected } from '../shared/sync.js';

const $ = (id) => document.getElementById(id);
let cfg = null;

async function load() {
  cfg = await getConfig();
  await renderAccount();
  renderFacts();
  await renderPermission();
  await renderHistory();
}

// ------------------------------------------------------------------ account

async function renderAccount() {
  const connected = isConnected(cfg);
  $('signedOut').classList.toggle('hidden', connected);
  $('signedIn').classList.toggle('hidden', !connected);
  $('using').classList.toggle('hidden', !connected);
  $('sy-url').value = cfg.sync.serverUrl || defaultConfig().sync.serverUrl;
  $('sy-webUrl').value = cfg.sync.webUrl || defaultConfig().sync.webUrl;
  $('sy-email').value = cfg.sync.email || '';
  if (!connected) return;

  renderPulled();
  $('sy-who').className = 'status-line';
  $('sy-who').textContent = 'Checking your account…';
  try {
    const me = await whoAmI(cfg);
    $('sy-who').className = 'status-line ok';
    $('sy-who').textContent = 'Signed in as ' + me.email + ' · ' + me.applications.toLocaleString() + ' applications on the account';
  } catch (e) {
    $('sy-who').className = 'status-line err';
    $('sy-who').textContent = e.status === 401
      ? 'The saved sign-in is no longer valid. Sign out and sign in again.'
      : 'Cannot reach your account: ' + e.message;
  }
}

function renderPulled() {
  const err = cfg.sync.lastPullError;
  $('sy-pulled').className = 'status-line' + (err ? ' err' : '');
  $('sy-pulled').textContent = err
    ? 'Last download failed: ' + err + '. Runs use the copy from ' + when(cfg.sync.lastPullAt) + '.'
    : (cfg.sync.lastPullAt ? 'Settings and resume downloaded ' + when(cfg.sync.lastPullAt) + '.' : 'Nothing downloaded yet.');
}

const when = (t) => (t ? new Date(t).toLocaleString() : 'never');

function status(msg, kind) {
  $('sy-status').className = 'status-line' + (kind ? ' ' + kind : '');
  $('sy-status').textContent = msg;
}

// Reaching the server needs host permission for its exact origin, which
// Chrome only grants from a user gesture like this click.
async function connect(mode) {
  const serverUrl = normalizeUrl($('sy-url').value);
  const webUrl = normalizeUrl($('sy-webUrl').value);
  const email = $('sy-email').value.trim();
  const password = $('sy-password').value;
  if (!serverUrl || !email || !password) return status('Enter your email and password.', 'err');

  const origin = originOf(serverUrl);
  if (!origin) return status('That server address is not a valid URL.', 'err');
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return status('Permission to reach ' + origin + ' was declined.', 'err');

  status(mode === 'register' ? 'Creating the account…' : 'Signing in…');
  try {
    const session = await authenticate(serverUrl, email, password, mode);
    cfg = await setConfig({
      sync: {
        enabled: true, serverUrl, webUrl, email: session.email, token: session.token,
        refreshToken: session.refreshToken, expiresAt: session.expiresAt,
        lastError: '', pending: 0, lastPullError: ''
      }
    });
    $('sy-password').value = '';
    status('Signed in. Downloading your settings and resume…');
    await pullNow();
    status(cfg.resume.text
      ? 'Signed in. Your settings and resume are downloaded.'
      : 'Signed in. Now upload your resume on the website: press "Open settings on the website".', 'ok');
  } catch (e) {
    status(e.message, 'err');
  }
}

async function pullNow() {
  const res = await chrome.runtime.sendMessage({ type: 'PULL_NOW' });
  cfg = await getConfig();
  await renderAccount();
  renderFacts();
  if (res && res.error) throw new Error('Could not download your settings: ' + res.error);
}

$('sy-login').onclick = () => connect('login');
$('sy-register').onclick = () => connect('register');
$('sy-pull').onclick = async () => {
  status('Downloading…');
  try {
    await pullNow();
    status('Up to date.', 'ok');
  } catch (e) {
    status(e.message, 'err');
  }
};
$('sy-openSettings').onclick = () => {
  chrome.tabs.create({ url: normalizeUrl(cfg.sync.webUrl || defaultConfig().sync.webUrl) + '/settings/' });
};
$('sy-logout').onclick = async () => {
  cfg = await setConfig({ sync: { enabled: false, token: '', refreshToken: '', expiresAt: 0, lastError: '', pending: 0 } });
  await renderAccount();
  status('Signed out. Nothing was deleted from your account.');
};

// --------------------------------------------------------------- run summary

function renderFacts() {
  const dl = $('facts');
  dl.replaceChildren();
  const fact = (label, value) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  };
  const boards = Object.keys(SITES).filter((id) => cfg.sites[id] && cfg.sites[id].enabled).map((id) => SITES[id].name);
  fact('Resume', cfg.resume.fileName || 'none: upload one on the website');
  fact('Job boards', boards.join(', ') || 'none switched on');
  fact('Keywords', cfg.search.keywords || 'built from your resume');
  fact('Minimum score', String(cfg.match.minScore));
  fact('Per run / per day', cfg.safety.maxPerRun + ' / ' + cfg.safety.maxPerDay);
  fact('Daily run', describeNextRun(cfg));
  fact('Dry run', cfg.safety.dryRun ? 'on: forms are filled, never submitted' : 'off: applications are submitted');
}

// ------------------------------------------------------------- permissions

// Unknown career sites are not in the manifest, so touching them needs an
// optional permission the user grants explicitly.
const ANY_SITE = { origins: ['https://*/*'] };

async function renderPermission() {
  const granted = await chrome.permissions.contains(ANY_SITE);
  $('permStatus').className = 'status-line' + (granted ? ' ok' : '');
  $('permStatus').textContent = granted
    ? 'Access granted: it can fill forms on any https career site.'
    : 'Not granted: unrecognised sites are opened and left for you to finish.';
  $('grantSites').classList.toggle('hidden', granted);
  $('revokeSites').classList.toggle('hidden', !granted);
}

$('grantSites').onclick = async () => {
  await chrome.permissions.request(ANY_SITE).catch(() => false);
  await renderPermission();
};

$('revokeSites').onclick = async () => {
  await chrome.permissions.remove(ANY_SITE).catch(() => {});
  await renderPermission();
};

// ------------------------------------------------------------------ history

async function renderHistory() {
  const n = Object.keys(await getHistory()).length;
  $('histCount').textContent = n.toLocaleString() + ' jobs recorded';
  $('pushAll').disabled = !isConnected(cfg) || !n;
}

function histStatus(msg, kind) {
  $('histStatus').className = 'status-line' + (kind ? ' ' + kind : '');
  $('histStatus').textContent = msg;
}

$('pushAll').onclick = async () => {
  histStatus('Uploading…');
  try {
    const { saved, total } = await pushAll(cfg);
    cfg = await setConfig({ sync: { lastPushAt: Date.now(), lastError: '', pending: 0 } });
    histStatus('Uploaded ' + saved + ' of ' + total + ' records.', 'ok');
  } catch (e) {
    histStatus('Upload failed: ' + e.message, 'err');
  }
};

$('exportCsv').onclick = async () => {
  const h = await getHistory();
  const head = ['jobId', 'date', 'title', 'company', 'location', 'score', 'status', 'reason', 'url'];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = Object.entries(h).map(([id, r]) => [
    id, new Date(r.at).toISOString(), r.title, r.company, r.location, r.score, r.status, r.reason, r.url
  ].map(esc).join(','));
  const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jobdo-history-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('clearHist').onclick = async () => {
  if (!confirm('Clear the history on this computer? Jobs you already applied to could then be applied to again.')) return;
  await clearHistory();
  await renderHistory();
};

load();

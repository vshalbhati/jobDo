import { getConfig, setConfig, getRun, getLog, clearLog } from '../shared/storage.js';
import { describeNextRun } from '../shared/schedule.js';
import { isConnected, patchConfig, normalizeUrl } from '../shared/sync.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const cfg = await getConfig();
  const run = await getRun();

  $('dot').className = 'dot' + (run.active ? (run.paused ? ' dot paused' : ' on') : '');
  $('phase').textContent = run.active ? (run.phase || 'running') : (run.phase === 'finished' ? 'finished' : 'idle');
  $('job').textContent = run.current ? run.current.title + ' · ' + run.current.company : '';
  $('c-applied').textContent = run.applied;
  $('c-skipped').textContent = run.skipped;
  $('c-failed').textContent = run.failed;
  $('c-seen').textContent = run.seen;

  const today = new Date().toDateString();
  const used = cfg.stats.day === today ? cfg.stats.appliedToday : 0;
  $('today').textContent = 'Today: ' + used + ' of ' + cfg.safety.maxPerDay + ' · this run stops at ' + cfg.safety.maxPerRun +
    ' · ' + describeNextRun(cfg);

  $('dryRun').checked = !!cfg.safety.dryRun;
  $('review').checked = !!cfg.safety.reviewBeforeSubmit;
  $('start').classList.toggle('hidden', run.active);
  $('stop').classList.toggle('hidden', !run.active);

  $('resumeName').textContent = cfg.resume.fileName || 'no resume';
  const warn = $('warning');
  if (toggleError) {
    warn.textContent = toggleError;
    warn.classList.remove('hidden');
  } else if (!isConnected(cfg)) {
    warn.textContent = 'Sign in to your jobDo account first: press Account below.';
    warn.classList.remove('hidden');
  } else if (!cfg.resume.text) {
    warn.textContent = 'Upload your resume on the jobDo website before starting: press Settings below.';
    warn.classList.remove('hidden');
  } else if (cfg.safety.dryRun) {
    warn.textContent = 'Dry run is on: it will fill every form but never press Submit.';
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  renderLog(await getLog());
}

function renderLog(entries) {
  const ul = $('logList');
  ul.innerHTML = '';
  for (const e of entries.slice(-80).reverse()) {
    const li = document.createElement('li');
    li.className = e.level;
    const t = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = '<b>' + t + '</b> ' + escapeHtml(e.message);
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('start').onclick = async () => {
  $('start').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'START_RUN' });
  $('start').disabled = false;
  if (res && res.error) {
    const warn = $('warning');
    warn.textContent = res.error;
    warn.classList.remove('hidden');
  }
  render();
};

$('stop').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
  render();
};

// These two switches are settings like any other, so they are saved to the
// account; otherwise the next download from it would switch them back.
let toggleError = '';

async function toggle(field, value) {
  toggleError = '';
  const before = (await getConfig()).safety[field];
  const cfg = await setConfig({ safety: { [field]: value } });
  if (isConnected(cfg)) {
    try {
      await patchConfig(cfg, { safety: { [field]: value } });
    } catch (e) {
      await setConfig({ safety: { [field]: before } });
      toggleError = 'Not changed: could not save it to your account (' + e.message + ').';
    }
  }
  render();
}

$('dryRun').onchange = (e) => toggle('dryRun', e.target.checked);
$('review').onchange = (e) => toggle('reviewBeforeSubmit', e.target.checked);
$('clearLog').onclick = () => clearLog().then(render);
// Settings live on the website; the extension's own page is just the account.
$('options').onclick = async () => {
  const cfg = await getConfig();
  if (isConnected(cfg) && cfg.sync.webUrl) chrome.tabs.create({ url: normalizeUrl(cfg.sync.webUrl) + '/settings/' });
  else chrome.runtime.openOptionsPage();
  window.close();
};
$('account').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
$('dashboard').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'RUN_UPDATED' || msg.type === 'LOG_APPENDED')) render();
});

render();
setInterval(render, 2000);
// Opening the popup is a good moment to pick up changes made on the website.
chrome.runtime.sendMessage({ type: 'PULL_NOW' }).then(render, () => {});

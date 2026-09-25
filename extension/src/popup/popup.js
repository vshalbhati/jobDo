import { getConfig, setConfig, getRun, getLog, clearLog } from '../shared/storage.js';
import { describeNextRun } from '../shared/schedule.js';

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
  if (!cfg.resume.text) {
    warn.textContent = 'Upload your resume in Settings before starting.';
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

$('dryRun').onchange = (e) => setConfig({ safety: { dryRun: e.target.checked } }).then(render);
$('review').onchange = (e) => setConfig({ safety: { reviewBeforeSubmit: e.target.checked } }).then(render);
$('clearLog').onclick = () => clearLog().then(render);
$('options').onclick = () => chrome.runtime.openOptionsPage();
$('dashboard').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'RUN_UPDATED' || msg.type === 'LOG_APPENDED')) render();
});

render();
setInterval(render, 2000);

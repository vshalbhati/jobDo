import {
  MODE, loadHistory, loadRun, loadSummary, onChange,
  getTheme, setTheme, openSettings, signOut, loadThreshold, saveThreshold,
  loadResume, downloadResume
} from './source.js';
import { columnChart, stackedBar, barChart, heatmap } from './charts.js';

const $ = (id) => document.getElementById(id);

const STATUS = {
  applied:     { label: 'Submitted',     color: 'var(--status-good)',     ink: '#ffffff' },
  needs_manual:{ label: 'Handed to you', color: 'var(--status-warning)',  ink: '#0b0b0b' },
  failed:      { label: 'Failed',        color: 'var(--status-critical)', ink: '#ffffff' },
  dry_run:     { label: 'Dry run',       color: 'var(--status-neutral)',  ink: '#ffffff' },
  skipped:     { label: 'Skipped',       color: 'var(--status-neutral)',  ink: '#ffffff' }
};

// "Attempted" means the run actually opened the job and worked on a form.
// Skipped jobs were filtered out before that, so they would distort a rate.
const SITE_NAMES = { linkedin: 'LinkedIn', naukri: 'Naukri', indeed: 'Indeed' };

const ATTEMPTED = new Set(['applied', 'needs_manual', 'failed', 'dry_run']);

const state = {
  records: [],
  rangeDays: 30,
  source: 'all',
  site: 'all',
  search: '',
  status: '',
  sort: { key: 'at', dir: -1 },
  page: 0,
  pageSize: 50
};

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayKey = (d) => startOfDay(d).getTime();

// ------------------------------------------------------------------- loading

async function load() {
  const history = await loadHistory();
  state.records = Object.entries(history).map(([jobId, r]) => ({
    jobId,
    title: r.title || '(untitled)',
    company: r.company || '',
    location: r.location || '',
    url: r.url || ('https://www.linkedin.com/jobs/view/' + jobId + '/'),
    status: r.status || 'skipped',
    reason: r.reason || '',
    score: typeof r.score === 'number' ? r.score : null,
    source: r.source === 'portal' ? 'portal' : 'easy',
    site: r.site || 'linkedin',
    ats: r.ats || '',
    at: r.at || 0
  })).sort((a, b) => b.at - a.at);
  render();
}

function inRange(r) {
  if (!state.rangeDays) return true;
  return r.at >= Date.now() - state.rangeDays * DAY;
}

function filtered() {
  return state.records.filter((r) =>
    inRange(r)
    && (state.source === 'all' || r.source === state.source)
    && (state.site === 'all' || r.site === state.site));
}

// -------------------------------------------------------------------- render

function render() {
  const rows = filtered();
  renderHeadline(rows);
  renderTrend(rows);
  renderOutcome(rows);
  renderRoute(rows);
  renderCompanies(rows);
  renderScores(rows);
  renderCalendar();
  renderTable();
  $('filterNote').textContent = rows.length + ' of ' + state.records.length + ' records in view';
}

function renderHeadline(rows) {
  const applied = rows.filter((r) => r.status === 'applied');
  const attempts = rows.filter((r) => ATTEMPTED.has(r.status));
  const today = dayKey(Date.now());
  const appliedToday = applied.filter((r) => dayKey(r.at) === today).length;
  const appliedWeek = applied.filter((r) => r.at >= Date.now() - 7 * DAY).length;
  const companies = new Set(applied.map((r) => r.company).filter(Boolean));

  $('heroValue').textContent = applied.length.toLocaleString();
  $('heroSub').textContent = attempts.length
    ? 'out of ' + attempts.length + ' attempted' + rangeWords()
    : 'nothing attempted' + rangeWords();

  $('kToday').textContent = appliedToday;
  $('kTodayFoot').textContent = appliedToday ? 'submitted so far' : 'none yet today';

  $('kWeek').textContent = appliedWeek;
  $('kWeekFoot').textContent = (appliedWeek / 7).toFixed(1) + ' a day on average';

  const rate = attempts.length ? Math.round((applied.length / attempts.length) * 100) : 0;
  $('kRate').textContent = rate + '%';
  $('kRateFoot').textContent = 'of attempts went through';

  $('kCompanies').textContent = companies.size;
  $('kCompaniesFoot').textContent = 'distinct employers';
}

function rangeWords() {
  return state.rangeDays ? ' in the last ' + state.rangeDays + ' days' : ' all time';
}

function renderTrend(rows) {
  const days = state.rangeDays || Math.min(90, spanDays());
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) buckets.set(dayKey(Date.now() - i * DAY), 0);
  for (const r of rows) {
    if (r.status !== 'applied') continue;
    const k = dayKey(r.at);
    if (buckets.has(k)) buckets.set(k, buckets.get(k) + 1);
  }
  const data = [...buckets].map(([k, v]) => {
    const d = new Date(k);
    return {
      value: v,
      label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      tip: d.toDateString()
    };
  });
  $('trendSub').textContent = 'Last ' + days + ' days.';
  columnChart($('chartTrend'), data, { unit: 'submitted', emptyText: 'No applications submitted in this period.' });
}

function spanDays() {
  if (!state.records.length) return 30;
  const oldest = Math.min(...state.records.map((r) => r.at).filter(Boolean));
  return Math.max(7, Math.ceil((Date.now() - oldest) / DAY) + 1);
}

function renderOutcome(rows) {
  const order = ['applied', 'needs_manual', 'failed', 'dry_run', 'skipped'];
  const segments = order.map((k) => ({
    label: STATUS[k].label,
    color: STATUS[k].color,
    ink: STATUS[k].ink,
    value: rows.filter((r) => r.status === k).length
  }));
  stackedBar($('chartOutcome'), segments, { emptyText: 'No attempts recorded in this period.' });
}

function renderRoute(rows) {
  const attempts = rows.filter((r) => ATTEMPTED.has(r.status));
  stackedBar($('chartRoute'), [
    { label: 'Easy Apply', color: 'var(--series-1)', ink: '#ffffff', value: attempts.filter((r) => r.source === 'easy').length },
    { label: 'Company portal', color: 'var(--series-2)', ink: '#ffffff', value: attempts.filter((r) => r.source === 'portal').length }
  ], { emptyText: 'No attempts recorded in this period.' });
}

function renderCompanies(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.company || !ATTEMPTED.has(r.status)) continue;
    counts.set(r.company, (counts.get(r.company) || 0) + 1);
  }
  const data = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([label, value]) => ({ label, value }));
  barChart($('chartCompanies'), data, { unit: 'attempts', emptyText: 'No companies yet.' });
}

function renderScores(rows) {
  const scored = rows.filter((r) => typeof r.score === 'number');
  if (!scored.length) return barChart($('chartScores'), [], { emptyText: 'No match scores recorded yet.' });
  const bins = Array.from({ length: 10 }, (_, i) => ({
    value: 0,
    label: i * 10 + '',
    tip: 'Match score ' + i * 10 + '–' + (i * 10 + 9)
  }));
  for (const r of scored) bins[Math.min(9, Math.floor(r.score / 10))].value++;
  columnChart($('chartScores'), bins, { unit: 'jobs', height: 190 });
}

// The calendar always shows its own fixed window, so it is not driven by the
// range filter - its whole job is showing the shape of activity over time.
function renderCalendar() {
  const weeks = 18;
  const end = startOfDay(Date.now());
  const start = new Date(end.getTime() - (weeks * 7 - 1) * DAY);
  const shift = (start.getDay() + 6) % 7;              // back up to a Monday
  start.setDate(start.getDate() - shift);

  const counts = new Map();
  for (const r of state.records) {
    if (r.status !== 'applied') continue;
    if (state.source !== 'all' && r.source !== state.source) continue;
    if (state.site !== 'all' && r.site !== state.site) continue;
    const k = dayKey(r.at);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = new Date(d);
    days.push({ date, value: counts.get(dayKey(date)) || 0 });
  }
  heatmap($('chartCalendar'), days, { unit: 'submitted' });
}

// --------------------------------------------------------------------- table

function tableRows() {
  const q = state.search.trim().toLowerCase();
  let rows = filtered();
  if (state.status) rows = rows.filter((r) => r.status === state.status);
  if (q) rows = rows.filter((r) => (r.title + ' ' + r.company).toLowerCase().includes(q));
  const { key, dir } = state.sort;
  return rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

function renderTable() {
  const rows = tableRows();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, pages - 1);
  const slice = rows.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);

  const tbody = $('histTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of slice) {
    const tr = document.createElement('tr');

    const when = document.createElement('td');
    when.textContent = r.at ? new Date(r.at).toLocaleString([], {
      year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }) : '';

    const job = document.createElement('td');
    const a = document.createElement('a');
    a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = r.title;
    job.appendChild(a);

    const company = document.createElement('td');
    company.textContent = r.company;

    const route = document.createElement('td');
    const rspan = document.createElement('span');
    rspan.className = 'route ' + r.source;
    rspan.innerHTML = '<i></i>';
    rspan.appendChild(document.createTextNode(
      (SITE_NAMES[r.site] || r.site)
      + (r.source === 'portal' ? ' \u00b7 ' + (r.ats || 'company site') : '')));
    route.appendChild(rspan);

    const score = document.createElement('td');
    score.className = 'num';
    score.textContent = r.score ?? '';

    const status = document.createElement('td');
    const sspan = document.createElement('span');
    sspan.className = 'tag ' + r.status;
    sspan.innerHTML = '<i></i>';
    sspan.appendChild(document.createTextNode((STATUS[r.status] || {}).label || r.status));
    status.appendChild(sspan);

    const detail = document.createElement('td');
    detail.className = 'detail';
    detail.textContent = r.reason;

    tr.append(when, job, company, route, score, status, detail);
    tbody.appendChild(tr);
  }

  $('tableCount').textContent = rows.length
    ? rows.length.toLocaleString() + ' application' + (rows.length === 1 ? '' : 's')
    : 'Nothing matches these filters.';
  $('pageLabel').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
  $('prevPage').disabled = state.page === 0;
  $('nextPage').disabled = state.page >= pages - 1;
}

// ---------------------------------------------------------------- live strip

async function renderLive() {
  const run = await loadRun();
  const summary = await loadSummary().catch(() => null);
  const pill = $('livePill');
  pill.className = 'pill' + (run.active ? ' running' : '');
  pill.textContent = run.active ? (run.paused ? 'paused' : 'running') : (MODE === 'web' ? 'synced' : 'idle');

  const bits = [];
  if (run.active) {
    if (run.phase) bits.push(run.phase);
    if (run.current) bits.push(run.current.title + ' · ' + run.current.company);
    bits.push('this run: ' + run.applied + ' applied, ' + run.skipped + ' skipped, ' + run.failed + ' failed');
  } else if (summary && summary.mode === 'web') {
    bits.push(summary.applications.toLocaleString() + ' applications on this account');
    bits.push(summary.resume ? 'resume: ' + summary.resume.filename : 'no resume uploaded yet');
  } else if (summary) {
    bits.push('today ' + summary.appliedToday + ' of ' + summary.maxPerDay);
    if (summary.dryRun) bits.push('dry run is on');
  }
  $('liveText').textContent = bits.join('  —  ');

  if (MODE === 'web' && summary && summary.email) {
    $('who').textContent = summary.email;
    $('who').classList.remove('hidden');
    $('signout').classList.remove('hidden');
    $('openOptions').classList.add('hidden');
  }
}

// ------------------------------------------------------------------- wiring

function segHandler(seg, apply) {
  $(seg).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    for (const b of $(seg).querySelectorAll('button')) b.setAttribute('aria-selected', String(b === btn));
    apply(btn.dataset);
    state.page = 0;
    render();
  });
}

segHandler('rangeSeg', (d) => { state.rangeDays = Number(d.days); });
segHandler('sourceSeg', (d) => { state.source = d.source; });
segHandler('siteSeg', (d) => { state.site = d.site; });

$('search').addEventListener('input', (e) => { state.search = e.target.value; state.page = 0; renderTable(); });
$('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; state.page = 0; renderTable(); });
$('prevPage').onclick = () => { state.page--; renderTable(); };
$('nextPage').onclick = () => { state.page++; renderTable(); };

for (const th of document.querySelectorAll('th.sortable')) {
  th.onclick = () => {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === 'at' || key === 'score' ? -1 : 1) };
    for (const other of document.querySelectorAll('th.sortable')) other.className = 'sortable';
    th.className = 'sortable ' + (state.sort.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    renderTable();
  };
}

$('openOptions').onclick = openSettings;
$('signout').onclick = signOut;

// ------------------------------------------------------------------- resume

// Everything here came out of a resume someone uploaded, so it is only ever
// set as text, never as HTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function safeLink(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  const a = el('a', u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''));
  a.href = u;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function formatBytes(n) {
  if (!n) return '';
  return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
}

let currentResume = null;

async function initResume() {
  let resume;
  try { resume = await loadResume(); } catch { return; }   // leave the card hidden
  currentResume = resume;
  $('resumeCard').classList.remove('hidden');

  if (!resume) {
    $('resumeSub').textContent = 'What the ranker compares every job against.';
    $('resumeEmpty').textContent = MODE === 'web'
      ? 'No resume on this account yet. In the extension, connect your account in Settings → 8. Account & sync; ' +
        'your resume uploads automatically, and so does every change you save to your profile.'
      : 'No resume yet. Add one in Settings → 1. Resume.';
    $('resumeEmpty').classList.remove('hidden');
    return;
  }

  const p = resume.profile || {};
  $('resumeSub').textContent = [
    resume.filename,
    formatBytes(resume.size),
    resume.uploadedAt ? 'added ' + new Date(resume.uploadedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '',
    'what the ranker compares every job against'
  ].filter(Boolean).join(' · ');
  $('resumeDownload').classList.toggle('hidden', !resume.downloadable);

  const facts = $('resumeFacts');
  facts.replaceChildren();
  const fact = (label, value) => {
    if (value === null || value === undefined || value === '') return;
    facts.append(el('dt', label));
    const dd = el('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
    facts.append(dd);
  };
  fact('Name', [p.firstName, p.lastName].filter(Boolean).join(' '));
  fact('Current role', [p.currentTitle, p.currentCompany].filter(Boolean).join(' at '));
  fact('Experience', Number(p.defaultYears) > 0 ? p.defaultYears + (Number(p.defaultYears) === 1 ? ' year' : ' years') : '');
  fact('Education', p.education);
  fact('Location', [p.city, p.country].filter(Boolean).join(', '));
  fact('Email', p.email);
  fact('Phone', p.phone);
  fact('Notice period', Number(p.noticePeriodDays) > 0 ? p.noticePeriodDays + ' days' : '');
  fact('LinkedIn', safeLink(p.linkedin));
  fact('GitHub', safeLink(p.github));
  fact('Website', safeLink(p.website));
  if (!facts.children.length) fact('Profile', 'Nothing parsed yet');

  const titles = $('resumeTitles');
  titles.replaceChildren(...(p.titles || []).map((t) => el('span', t, 'chip')));
  if (!titles.children.length) titles.append(el('span', 'None found - add them in the extension\'s Settings.', 'none'));

  // Most experience first: that is what the ranker leans on hardest.
  const skills = Object.entries(p.skills || {})
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0) || a[0].localeCompare(b[0]));
  $('resumeSkillCount').textContent = skills.length ? '(' + skills.length + ')' : '';
  const box = $('resumeSkills');
  box.replaceChildren(...skills.map(([name, years]) => {
    const chip = el('span', name, 'chip');
    if (Number(years) > 0) chip.append(el('small', years + 'y'));
    return chip;
  }));
  if (!skills.length) box.append(el('span', 'None found - add them in the extension\'s Settings.', 'none'));

  $('resumeBody').classList.remove('hidden');
}

$('resumeDownload').onclick = async () => {
  if (!currentResume) return;
  $('resumeDownload').disabled = true;
  try {
    await downloadResume(currentResume);
  } catch (e) {
    $('resumeSub').textContent = 'Could not download it: ' + e.message;
  } finally {
    $('resumeDownload').disabled = false;
  }
};

// --------------------------------------------------------- ranking threshold

let savedThreshold = null;

async function initThreshold() {
  let value = null;
  try { value = await loadThreshold(); } catch { /* shown as hidden */ }
  if (typeof value !== 'number') return;
  savedThreshold = value;
  $('thresholdRange').value = value;
  $('thresholdVal').textContent = value;
  $('thresholdBox').classList.remove('hidden');
}

function thresholdNote(msg, isError) {
  $('thresholdNote').textContent = msg;
  $('thresholdNote').className = 'threshold-note' + (isError ? ' err' : '');
}

$('thresholdRange').oninput = (e) => {
  $('thresholdVal').textContent = e.target.value;
  $('thresholdSave').disabled = Number(e.target.value) === savedThreshold;
};

$('thresholdSave').onclick = async () => {
  const value = Number($('thresholdRange').value);
  $('thresholdSave').disabled = true;
  try {
    savedThreshold = await saveThreshold(value);
    thresholdNote('Saved. Jobs scoring below ' + savedThreshold + ' will be skipped from the next run on.');
  } catch (e) {
    $('thresholdSave').disabled = false;
    thresholdNote('Could not save: ' + e.message, true);
  }
};

$('exportCsv').onclick = () => {
  const rows = tableRows();
  const head = ['jobId', 'date', 'title', 'company', 'location', 'site', 'route', 'ats', 'score', 'status', 'reason', 'url'];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const body = rows.map((r) => [
    r.jobId, new Date(r.at).toISOString(), r.title, r.company, r.location,
    r.site, r.source, r.ats, r.score, r.status, r.reason, r.url
  ].map(esc).join(','));
  const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'applications-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('theme').onclick = async () => {
  const now = document.documentElement.dataset.theme;
  const next = now === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  await setTheme(next);
  render();     // charts read their colours from CSS variables
};

// In the extension the run writes to storage and the dashboard follows along
// without polling; on the web this is a slow poll for newly synced records.
onChange((what) => {
  if (what === 'history') load();
  else renderLive();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 160);
});

(async function init() {
  const theme = await getTheme();
  if (theme) document.documentElement.dataset.theme = theme;
  await load();
  await renderLive();
  await Promise.all([initThreshold(), initResume()]);
  // The extension has a run to follow; the web app only needs an occasional
  // refresh of the account line.
  setInterval(renderLive, MODE === 'extension' ? 4000 : 60000);
})();

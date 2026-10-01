// Your job list: links the extension applies to before it searches the job
// boards. Spreadsheets are read here in the browser (sheet.js); only the links
// go to the account. Favourite companies add to the same list: the server
// reads their careers boards on a schedule.
import { apiFetch, getTheme, setTheme, signOut } from '../app/source.js';
import { readSheet, readText, jobsFromRows } from './sheet.js';
import { SITES, jobFromUrl } from '../shared/sites.js';
import { detectAts } from '../shared/ats.js';
import { icon, hydrateIcons } from '../app/icons.js';

hydrateIcons();

const $ = (id) => document.getElementById(id);
const ADD_BATCH = 1000;        // what the server takes per request
const PREVIEW_ROWS = 8;

let tab = 'pending';
let counts = { pending: 0, done: 0 };
let preview = null;            // { jobs, source }

const json = (method, body) => ({
  method,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const RESULT_NAMES = {
  applied: 'Applied', needs_manual: 'Needs you', failed: 'Failed', skipped: 'Skipped', dry_run: 'Dry run'
};

// "LinkedIn", "Greenhouse", or the site's own name.
function where(url) {
  const job = jobFromUrl(url);
  if (job && SITES[job.site]) return SITES[job.site].name;
  const ats = detectAts(url);
  if (ats && ats.mode !== 'unknown') return ats.name;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};

function jobCell(item) {
  const a = el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', textContent: item.title || shortUrl(item.url) });
  const td = el('td', { className: 'job' }, a);
  if (item.title) td.append(el('small', { textContent: shortUrl(item.url) }));
  return td;
}

// ------------------------------------------------------------------ adding

async function readFile(file) {
  say('Reading ' + file.name + '…');
  try {
    const found = jobsFromRows(await readSheet(file));
    showPreview(found, file.name);
  } catch (e) {
    say('Could not read ' + file.name + ': ' + e.message, 'err');
  }
}

function say(msg, kind) {
  $('readMsg').className = 'status-line' + (kind ? ' ' + kind : '');
  $('readMsg').textContent = msg;
}

function showPreview(found, source) {
  if (!found.jobs.length) {
    preview = null;
    $('preview').classList.add('hidden');
    say('No job links found in ' + source + '.' + (found.noLink ? ' ' + found.noLink + ' rows had no link in them.' : ''), 'err');
    return;
  }
  say('');
  preview = { jobs: found.jobs, source };
  const extra = [
    found.repeats ? found.repeats + ' repeated' : '',
    found.noLink ? found.noLink + ' without a link' : ''
  ].filter(Boolean).join(', ');
  $('previewSummary').innerHTML = icon('check');
  $('previewSummary').append(
    el('b', { textContent: found.jobs.length + (found.jobs.length === 1 ? ' job' : ' jobs') }),
    ' found in ' + source + (extra ? ' (left out: ' + extra + ')' : '') + '.'
  );
  const rows = found.jobs.slice(0, PREVIEW_ROWS).map((j) =>
    el('tr', {}, jobCell(j), el('td', { className: 'company', textContent: j.company || '—' }), el('td', { className: 'where', textContent: where(j.url) })));
  $('previewRows').replaceChildren(...rows);
  const more = found.jobs.length - PREVIEW_ROWS;
  $('previewMore').textContent = more > 0 ? 'and ' + more + ' more.' : '';
  $('addJobs').lastChild.textContent = 'Add ' + (found.jobs.length === 1 ? 'it' : 'all ' + found.jobs.length) + ' to the list';
  $('preview').classList.remove('hidden');
}

async function addPreview() {
  if (!preview) return;
  const jobs = preview.jobs;
  $('addJobs').disabled = true;
  let added = 0;
  let already = 0;
  try {
    for (let i = 0; i < jobs.length; i += ADD_BATCH) {
      const out = await apiFetch('/queue', json('POST', { items: jobs.slice(i, i + ADD_BATCH) }));
      added += out.added;
      already += out.duplicates;
      counts = out.counts;
    }
    preview = null;
    $('preview').classList.add('hidden');
    $('paste').value = '';
    $('readPaste').disabled = true;
    say((added ? added + (added === 1 ? ' job' : ' jobs') + ' added to your list.' : 'Nothing new to add.') +
      (already ? ' ' + already + ' ' + (already === 1 ? 'was' : 'were') + ' on it already.' : ''), 'ok');
    tab = 'pending';
    await loadList();
  } catch (e) {
    say('Could not add them: ' + e.message + (added ? ' (' + added + ' were added before that)' : ''), 'err');
  } finally {
    $('addJobs').disabled = false;
  }
}

// -------------------------------------------------------------------- list

async function loadList() {
  const out = await apiFetch('/queue?status=' + tab);
  counts = out.counts;
  renderList(out.items);
}

function renderList(items) {
  for (const b of $('tabs').querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('nPending').textContent = counts.pending;
  $('nDone').textContent = counts.done;

  const heads = tab === 'pending' ? ['Job', 'Company', 'Where', 'Added', ''] : ['Job', 'Company', 'Result', 'Tried', ''];
  $('listHead').replaceChildren(...heads.map((h) => el('th', { textContent: h })));

  const rows = items.map((item) => {
    const when = new Date(tab === 'pending' ? item.addedAt : item.doneAt || item.addedAt);
    const actions = el('td', { className: 'x' });
    if (tab === 'done') {
      const again = el('button', { type: 'button', title: 'Put it back on the list to try again', className: 'again' });
      again.innerHTML = icon('refresh');
      again.onclick = () => act(() => apiFetch('/queue/' + item.id, json('PATCH', { status: 'pending' })), 'Back on the list for the next run.');
      actions.append(again);
    }
    const remove = el('button', { type: 'button', title: 'Remove from the list', ariaLabel: 'Remove' });
    remove.innerHTML = icon('x');
    remove.onclick = () => act(() => apiFetch('/queue/' + item.id, { method: 'DELETE' }), 'Removed.');
    actions.append(remove);

    const middle = tab === 'pending'
      ? el('td', { className: 'where', textContent: where(item.url) })
      : el('td', { className: 'result' },
        el('span', { className: 'tag ' + item.result }, el('i'), RESULT_NAMES[item.result] || item.result),
        item.reason ? el('small', { textContent: item.reason }) : null);
    return el('tr', {}, jobCell(item), el('td', { className: 'company', textContent: item.company || '—' }), middle,
      el('td', { className: 'when', textContent: when.toLocaleDateString([], { day: 'numeric', month: 'short' }) }), actions);
  });
  $('listRows').replaceChildren(...rows);

  $('listEmpty').classList.toggle('hidden', items.length > 0);
  $('listEmpty').textContent = tab === 'pending'
    ? 'Nothing waiting. Add jobs above and the next run starts with them.'
    : 'Nothing tried yet. Jobs land here once a run has been through them.';
  $('clear').classList.toggle('hidden', !items.length);
  $('clearLabel').textContent = tab === 'pending' ? 'Remove all waiting' : 'Clear done';
}

async function act(fn, done) {
  try {
    await fn();
    $('listMsg').className = 'status-line ok';
    $('listMsg').textContent = done;
    await loadList();
  } catch (e) {
    $('listMsg').className = 'status-line err';
    $('listMsg').textContent = e.message;
  }
}

// ------------------------------------------------------ favourite companies

const BOARD_NAMES = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday' };
let watch = null;
let scheduler = false;
let found = [];

const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const sameCompany = (a, b) => a.ats === b.ats && a.slug === b.slug;

async function loadWatch() {
  const out = await apiFetch('/companies');
  watch = out.watch;
  scheduler = out.scheduler;
  renderWatch();
}

function renderWatch() {
  const chips = watch.companies.map((c) => {
    const remove = el('button', { type: 'button', title: 'Stop checking ' + c.name, ariaLabel: 'Remove ' + c.name, textContent: '×' });
    remove.onclick = () => saveWatch({ companies: watch.companies.filter((x) => !sameCompany(x, c)) }, c.name + ' removed.');
    return el('span', { className: 'chip' }, c.name, el('small', { textContent: BOARD_NAMES[c.ats] || c.ats }), remove);
  });
  $('watchList').replaceChildren(...chips);
  $('watchEmpty').classList.toggle('hidden', watch.companies.length > 0);
  $('w-enabled').checked = watch.enabled;
  $('w-interval').value = watch.intervalHours;
  if (document.activeElement !== $('w-locations')) $('w-locations').value = watch.locations;
  $('checkNow').disabled = !watch.companies.length;
  renderFound();

  const parts = [];
  const r = watch.lastResult;
  if (watch.lastRunAt && r) {
    parts.push('Last checked ' + when(watch.lastRunAt) + ': ' +
      (r.added ? r.added + (r.added === 1 ? ' new match' : ' new matches') + ' added to your list' : 'nothing new') +
      (r.error ? ' (' + r.error + ')' : '') + '.');
  }
  let warn = false;
  if (watch.enabled && watch.companies.length) {
    if (!scheduler) {
      parts.push('This server is not set up to check on a schedule yet, so only Check now works for the moment.');
      warn = true;
    } else {
      parts.push('Next check ' + (watch.nextRunAt && watch.nextRunAt > Date.now() ? when(watch.nextRunAt) : 'within the next few minutes') + '.');
    }
  } else if (watch.companies.length) {
    parts.push('Automatic checks are off: only Check now looks for jobs.');
  }
  $('watchStatus').className = 'status-line' + (warn ? ' warn' : '');
  $('watchStatus').textContent = parts.join(' ');
}

function renderFound() {
  const items = found.map((f) => {
    const added = watch.companies.some((c) => sameCompany(c, f));
    const add = el('button', { type: 'button', className: 'ghost', disabled: added || watch.companies.length >= 30 });
    add.innerHTML = icon(added ? 'check' : 'plus');
    add.append(added ? 'Added' : 'Add');
    add.onclick = () => saveWatch({ companies: [...watch.companies, { name: f.name, ats: f.ats, slug: f.slug }] }, f.name + ' added.');
    return el('div', { className: 'found-item' },
      el('div', {}, el('b', { textContent: f.name }),
        el('small', { textContent: (BOARD_NAMES[f.ats] || f.ats) + ' · ' + f.jobs + (f.jobs === 1 ? ' open job' : ' open jobs') })),
      add);
  });
  $('found').replaceChildren(...items);
}

function watchSay(msg, kind) {
  $('watchMsg').className = 'status-line' + (kind ? ' ' + kind : '');
  $('watchMsg').textContent = msg;
}

async function saveWatch(patch, done = 'Saved.') {
  try {
    const out = await apiFetch('/companies', json('PUT', { ...patch, tz: localZone() }));
    watch = out.watch;
    scheduler = out.scheduler;
    renderWatch();
    watchSay(done, 'ok');
  } catch (e) {
    watchSay('Could not save: ' + e.message, 'err');
    renderWatch();
  }
}

async function find() {
  const query = $('findQuery').value.trim();
  if (!query) return;
  $('find').disabled = true;
  $('findMsg').className = 'status-line';
  $('findMsg').textContent = 'Looking for ' + query + '…';
  try {
    const out = await apiFetch('/companies/lookup', json('POST', { query }));
    found = out.found || [];
    renderFound();
    $('findMsg').className = 'status-line' + (found.length ? '' : ' warn');
    $('findMsg').textContent = out.hint || '';
  } catch (e) {
    $('findMsg').className = 'status-line err';
    $('findMsg').textContent = e.message;
  } finally {
    $('find').disabled = !$('findQuery').value.trim();
  }
}

async function checkNow() {
  const button = $('checkNow');
  button.disabled = true;
  button.lastChild.textContent = 'Checking…';
  watchSay('Reading ' + watch.companies.length + (watch.companies.length === 1 ? ' careers page' : ' careers pages') + ' and ranking what is new. This can take a minute.');
  try {
    const out = await apiFetch('/companies/check', json('POST', {}));
    watch = out.watch;
    renderWatch();
    renderCheck(out.result);
    const n = out.added.length;
    watchSay(out.result.error && !n ? out.result.error : n ? n + (n === 1 ? ' new match' : ' new matches') + ' added to your list.' : 'Nothing new to add.',
      out.result.error && !n ? 'err' : 'ok');
    tab = 'pending';
    await loadList();
  } catch (e) {
    watchSay('Could not check: ' + e.message, 'err');
  } finally {
    button.disabled = !watch.companies.length;
    button.lastChild.textContent = 'Check now';
  }
}

function renderCheck(result) {
  const rows = (result.companies || []).map((c) => el('tr', {},
    el('td', { textContent: c.name }),
    el('td', { className: 'num', textContent: c.error ? '—' : c.postings }),
    el('td', { className: 'num', textContent: c.error ? '—' : c.fresh }),
    el('td', { className: 'num', textContent: c.error ? '—' : c.added }),
    el('td', { className: 'problem', textContent: c.error || '' })));
  $('checkRows').replaceChildren(...rows);
  $('checkResult').classList.toggle('hidden', !rows.length);
}

$('findQuery').addEventListener('input', () => { $('find').disabled = !$('findQuery').value.trim(); });
$('findQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } });
$('find').onclick = find;
$('w-enabled').onchange = () => saveWatch({ enabled: $('w-enabled').checked },
  $('w-enabled').checked ? 'Automatic checks on.' : 'Automatic checks off.');
$('w-interval').onchange = () => {
  const n = Math.round(Number($('w-interval').value));
  if (!Number.isFinite(n) || n < 1 || n > 168) {
    watchSay('Pick a number of hours from 1 to 168 (a week).', 'err');
    $('w-interval').value = watch.intervalHours;
    return;
  }
  saveWatch({ intervalHours: n }, 'Checks every ' + n + (n === 1 ? ' hour.' : ' hours.'));
};
$('w-locations').onchange = () => saveWatch({ locations: $('w-locations').value.trim() });
$('checkNow').onclick = checkNow;

// ------------------------------------------------------------------- wiring

$('sheetFile').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) readFile(file);
};

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

$('paste').addEventListener('input', () => { $('readPaste').disabled = !$('paste').value.trim(); });
$('readPaste').onclick = () => showPreview(jobsFromRows(readText($('paste').value)), 'what you pasted');
$('addJobs').onclick = addPreview;
$('cancelPreview').onclick = () => { preview = null; $('preview').classList.add('hidden'); say(''); };

for (const b of $('tabs').querySelectorAll('button')) {
  b.onclick = () => { tab = b.dataset.tab; $('listMsg').textContent = ''; loadList().catch((e) => act(() => { throw e; })); };
}
$('clear').onclick = () => {
  const n = tab === 'pending' ? counts.pending : counts.done;
  if (tab === 'pending' && !confirm('Remove all ' + n + ' waiting jobs from your list?')) return;
  act(() => apiFetch('/queue?status=' + tab, { method: 'DELETE' }), tab === 'pending' ? 'List emptied.' : 'Cleared.');
};

$('signout').onclick = signOut;
$('theme').onclick = async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  await setTheme(next);
};

(async function init() {
  const theme = await getTheme();
  if (theme) document.documentElement.dataset.theme = theme;
  try {
    const me = await apiFetch('/me');
    $('who').innerHTML = icon('user');
    $('who').append(me.email);
    await Promise.all([loadList(), loadWatch()]);
  } catch (e) {
    $('loading').className = 'status-line err';
    $('loading').textContent = 'Could not load your job list: ' + e.message;
    return;
  }
  $('loading').classList.add('hidden');
  $('page').classList.remove('hidden');
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  followSections();
})();

// Marks the sidebar link of the section being read, as on the settings page.
function followSections() {
  const links = [...document.querySelectorAll('.settings-nav a')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const mark = () => {
    const line = window.innerHeight / 3;
    let current = sections[0];
    for (const sec of sections) if (sec.getBoundingClientRect().top <= line) current = sec;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1];
    for (const a of links) a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + current.id));
  };
  window.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('resize', mark);
  mark();
}

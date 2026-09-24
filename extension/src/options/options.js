import { getConfig, setConfig, getHistory, clearHistory, log } from '../shared/storage.js';
import { DEFAULT_RULES } from '../shared/defaults.js';
import { parseResumeText, searchKeywordsFrom } from '../shared/resume.js';
import { SITE_LIST, SITES } from '../shared/sites.js';
import { ATS_LIST } from '../shared/ats.js';
import { authenticate, whoAmI, pushAll, pushResume, normalizeUrl, originOf } from '../shared/sync.js';
import { extractText, fileToDataUrl } from './extract.js';

const $ = (id) => document.getElementById(id);
let cfg = null;

// ------------------------------------------------------------------ loading

async function load() {
  cfg = await getConfig();

  $('resumeStatus').textContent = cfg.resume.fileName
    ? cfg.resume.fileName + ' · ' + cfg.resume.text.length.toLocaleString() + ' characters · added ' + new Date(cfg.resume.uploadedAt).toLocaleDateString()
    : 'No resume yet.';
  $('resumeText').textContent = cfg.resume.text || '';
  for (const r of document.querySelectorAll('input[name=resumeStrategy]')) {
    r.checked = r.value === cfg.resume.strategy;
  }

  for (const k of ['firstName', 'lastName', 'email', 'phone', 'city', 'country', 'linkedin', 'github',
    'website', 'defaultYears', 'education', 'expectedSalary', 'currentSalary', 'noticePeriodDays',
    'currentTitle', 'currentCompany']) {
    $('p-' + k).value = cfg.profile[k] ?? '';
  }
  $('p-titles').value = (cfg.profile.titles || []).join('\n');
  renderSkills();

  $('s-keywords').value = cfg.search.keywords;
  $('s-location').value = cfg.search.location;
  $('s-extraQuery').value = cfg.search.extraQuery;
  $('s-datePosted').value = cfg.search.datePosted;
  $('s-sortBy').value = cfg.search.sortBy;
  $('s-geoId').value = cfg.search.geoId;
  setChecks('s-remote', cfg.search.remote);
  setChecks('s-experience', cfg.search.experience);

  $('m-minScore').value = cfg.match.minScore;
  $('minScoreVal').textContent = cfg.match.minScore;
  $('m-titleInclude').value = (cfg.match.titleInclude || []).join('\n');
  $('m-titleExclude').value = (cfg.match.titleExclude || []).join('\n');
  $('m-companyBlocklist').value = (cfg.match.companyBlocklist || []).join('\n');
  $('m-descriptionExclude').value = (cfg.match.descriptionExclude || []).join('\n');

  $('f-dryRun').checked = cfg.safety.dryRun;
  $('f-reviewBeforeSubmit').checked = cfg.safety.reviewBeforeSubmit;
  $('f-stopOnUnknownQuestion').checked = cfg.safety.stopOnUnknownQuestion;
  $('f-skipIfDescriptionMissing').checked = cfg.safety.skipIfDescriptionMissing;
  $('f-maxPerRun').value = cfg.safety.maxPerRun;
  $('f-maxPerDay').value = cfg.safety.maxPerDay;
  $('f-minDelay').value = Math.round(cfg.safety.minDelayMs / 1000);
  $('f-maxDelay').value = Math.round(cfg.safety.maxDelayMs / 1000);
  $('f-longBreakEvery').value = cfg.safety.longBreakEvery;
  $('f-longBreakMinutes').value = cfg.safety.longBreakMinutes;
  $('f-actionMin').value = cfg.safety.actionMinMs;
  $('f-actionMax').value = cfg.safety.actionMaxMs;

  $('pt-enabled').checked = cfg.portal.enabled;
  $('pt-closeTab').checked = cfg.portal.closeTabWhenDone;
  $('pt-submitUnknown').checked = cfg.portal.submitUnknown;
  $('pt-maxPerRun').value = cfg.portal.maxPerRun;
  $('pt-coverLetter').value = cfg.portal.coverLetter;

  renderBoards();
  renderAtsList();
  await renderPermission();
  await renderSync();
  renderRules();
  renderUnknowns();
  renderUrlPreview();
  await renderHistory();
}

function renderAtsList() {
  const box = $('atsList');
  box.innerHTML = '';
  for (const a of ATS_LIST) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.paddingRight = '12px';
    chip.style.background = a.mode === 'auto' ? '#e7f5ec' : '#fdf4e3';
    chip.style.borderColor = a.mode === 'auto' ? '#bfe0cb' : '#f0d9a8';
    chip.textContent = a.name + ' · ' + a.mode;
    box.appendChild(chip);
  }
}

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
  const ok = await chrome.permissions.request(ANY_SITE).catch(() => false);
  if (!ok) flash('Permission was not granted.');
  await renderPermission();
};

$('revokeSites').onclick = async () => {
  await chrome.permissions.remove(ANY_SITE).catch(() => {});
  await renderPermission();
};

function setChecks(containerId, values) {
  for (const cb of $(containerId).querySelectorAll('input[type=checkbox]')) {
    cb.checked = (values || []).includes(cb.value);
  }
}

function getChecks(containerId) {
  return Array.from($(containerId).querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value);
}

const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------- saving

async function save() {
  const patch = {
    resume: { strategy: document.querySelector('input[name=resumeStrategy]:checked').value },
    profile: {
      firstName: $('p-firstName').value.trim(),
      lastName: $('p-lastName').value.trim(),
      email: $('p-email').value.trim(),
      phone: $('p-phone').value.trim(),
      city: $('p-city').value.trim(),
      country: $('p-country').value.trim(),
      linkedin: $('p-linkedin').value.trim(),
      github: $('p-github').value.trim(),
      website: $('p-website').value.trim(),
      defaultYears: Number($('p-defaultYears').value) || 0,
      education: $('p-education').value.trim(),
      expectedSalary: $('p-expectedSalary').value.trim(),
      currentSalary: $('p-currentSalary').value.trim(),
      noticePeriodDays: Number($('p-noticePeriodDays').value) || 0,
      currentTitle: $('p-currentTitle').value.trim(),
      currentCompany: $('p-currentCompany').value.trim(),
      titles: lines($('p-titles').value),
      skills: collectSkills()
    },
    sites: collectSites(),
    search: {
      keywords: $('s-keywords').value.trim(),
      location: $('s-location').value.trim(),
      extraQuery: $('s-extraQuery').value.trim(),
      datePosted: $('s-datePosted').value,
      sortBy: $('s-sortBy').value,
      geoId: $('s-geoId').value.trim(),
      remote: getChecks('s-remote'),
      experience: getChecks('s-experience')
    },
    match: {
      minScore: Number($('m-minScore').value),
      titleInclude: lines($('m-titleInclude').value),
      titleExclude: lines($('m-titleExclude').value),
      companyBlocklist: lines($('m-companyBlocklist').value),
      descriptionExclude: lines($('m-descriptionExclude').value)
    },
    safety: {
      dryRun: $('f-dryRun').checked,
      reviewBeforeSubmit: $('f-reviewBeforeSubmit').checked,
      stopOnUnknownQuestion: $('f-stopOnUnknownQuestion').checked,
      skipIfDescriptionMissing: $('f-skipIfDescriptionMissing').checked,
      maxPerRun: Number($('f-maxPerRun').value) || 1,
      maxPerDay: Number($('f-maxPerDay').value) || 1,
      minDelayMs: Number($('f-minDelay').value) * 1000,
      maxDelayMs: Number($('f-maxDelay').value) * 1000,
      longBreakEvery: Number($('f-longBreakEvery').value) || 0,
      longBreakMinutes: Number($('f-longBreakMinutes').value) || 1,
      actionMinMs: Number($('f-actionMin').value) || 300,
      actionMaxMs: Number($('f-actionMax').value) || 1200
    },
    portal: {
      enabled: $('pt-enabled').checked,
      closeTabWhenDone: $('pt-closeTab').checked,
      submitUnknown: $('pt-submitUnknown').checked,
      maxPerRun: Number($('pt-maxPerRun').value) || 1,
      coverLetter: $('pt-coverLetter').value
    },
    answers: { rules: collectRules() }
  };
  if (patch.safety.maxDelayMs < patch.safety.minDelayMs) {
    patch.safety.maxDelayMs = patch.safety.minDelayMs + 5000;
  }
  cfg = await setConfig(patch);
  flash('Saved.');
  renderUrlPreview();
}

function flash(msg) {
  $('saveMsg').textContent = msg;
  setTimeout(() => { $('saveMsg').textContent = ''; }, 2500);
}

// ------------------------------------------------------------------- resume

$('resumeFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('resumeStatus');
  status.className = 'status-line';
  status.textContent = 'Reading ' + file.name + '...';
  try {
    const text = await extractText(file);
    if (text.trim().length < 120) throw new Error('Only ' + text.trim().length + ' characters came out - is this a scanned image? Export a text-based PDF.');
    const dataUrl = await fileToDataUrl(file);
    const parsed = parseResumeText(text);

    cfg = await setConfig({
      resume: { fileName: file.name, mime: file.type, dataUrl, text, uploadedAt: Date.now() },
      profile: parsed
    });
    // Only seed the search box if the user hasn't typed their own keywords.
    if (!cfg.search.keywords) {
      cfg = await setConfig({ search: { keywords: searchKeywordsFrom(parsed) } });
    }
    await log('info', 'Resume loaded: ' + file.name + ' (' + Object.keys(parsed.skills).length + ' skills, ~' + parsed.defaultYears + ' years)');
    await load();
    status.className = 'status-line ok';
    status.textContent = 'Parsed ' + file.name + ': found ' + Object.keys(parsed.skills).length +
      ' skills, ' + parsed.titles.length + ' titles, about ' + parsed.defaultYears + ' years of experience. Check the profile below.';
  } catch (err) {
    status.className = 'status-line err';
    status.textContent = 'Could not read it: ' + err.message;
  }
};

// ------------------------------------------------------------------- skills

function renderSkills() {
  const box = $('skills');
  box.innerHTML = '';
  const entries = Object.entries(cfg.profile.skills || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) box.innerHTML = '<span class="hint">No skills yet - upload a resume or add them below.</span>';
  for (const [name, years] of entries) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.skill = name;
    chip.innerHTML = '<span></span><input type="number" min="0" max="50" value="' + Number(years) + '"><button title="remove">&times;</button>';
    chip.querySelector('span').textContent = name;
    chip.querySelector('button').onclick = () => { chip.remove(); };
    box.appendChild(chip);
  }
}

function collectSkills() {
  const out = {};
  for (const chip of $('skills').querySelectorAll('.chip')) {
    out[chip.dataset.skill] = Number(chip.querySelector('input').value) || 0;
  }
  return out;
}

// Every skill inherits the resume's total years, so correcting that total by
// hand should be able to correct them all in one go.
$('applyYears').onclick = () => {
  const years = Number($('p-defaultYears').value) || 0;
  const skills = collectSkills();
  for (const k of Object.keys(skills)) skills[k] = years;
  cfg.profile.skills = skills;
  renderSkills();
  flash('Every skill set to ' + years + ' years - press Save to keep it.');
};

$('addSkill').onclick = () => {
  const name = $('newSkill').value.trim().toLowerCase();
  if (!name) return;
  cfg.profile.skills = { ...collectSkills(), [name]: Number($('newSkillYears').value) || 0 };
  $('newSkill').value = '';
  renderSkills();
};

// -------------------------------------------------------------------- rules

function renderRules() {
  const tbody = $('rulesTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const rule of cfg.answers.rules) {
    const tr = document.createElement('tr');
    if (rule.builtin) tr.className = 'builtin';
    tr.dataset.id = rule.id;
    tr.innerHTML =
      '<td><input type="checkbox" class="r-on"' + (rule.enabled ? ' checked' : '') + '></td>' +
      '<td><input class="r-pattern"></td>' +
      '<td><input class="r-answer" placeholder="(from profile)"></td>' +
      '<td class="x"><button title="delete">&times;</button></td>';
    tr.querySelector('.r-pattern').value = rule.pattern;
    tr.querySelector('.r-answer').value = rule.answer || '';
    tr.querySelector('button').onclick = () => tr.remove();
    tbody.appendChild(tr);
  }
}

function collectRules() {
  return Array.from($('rulesTable').querySelectorAll('tbody tr')).map((tr, i) => ({
    id: tr.dataset.id || 'u' + Date.now() + i,
    pattern: tr.querySelector('.r-pattern').value.trim(),
    answer: tr.querySelector('.r-answer').value,
    enabled: tr.querySelector('.r-on').checked,
    builtin: tr.classList.contains('builtin')
  })).filter((r) => r.pattern);
}

$('addRule').onclick = () => {
  const pattern = $('newPattern').value.trim();
  if (!pattern) return;
  try { new RegExp(pattern); } catch (e) { flash('Not a valid regex: ' + e.message); return; }
  cfg.answers.rules = [{ id: 'u' + Date.now(), pattern, answer: $('newAnswer').value, enabled: true, builtin: false },
    ...collectRules()];
  $('newPattern').value = ''; $('newAnswer').value = '';
  renderRules();
};

$('resetRules').onclick = async () => {
  const custom = collectRules().filter((r) => !r.builtin);
  cfg.answers.rules = [...custom, ...DEFAULT_RULES];
  renderRules();
  flash('Built-in rules restored - press Save to keep them.');
};

// ------------------------------------------------------- unanswered questions

function renderUnknowns() {
  const list = cfg.answers.unknownQuestions || [];
  $('unknownBox').classList.toggle('hidden', !list.length);
  const ul = $('unknownList');
  ul.innerHTML = '';
  for (const u of list.slice().reverse()) {
    const li = document.createElement('li');
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = u.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [u.job, u.kind, (u.options || []).join(' / ')].filter(Boolean).join(' · ');
    const btn = document.createElement('button');
    btn.className = 'ghost small';
    btn.textContent = 'Add a rule for this';
    btn.onclick = () => {
      // Escape the question so it becomes a literal pattern the user can relax.
      $('newPattern').value = u.label.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      $('newAnswer').focus();
      $('newAnswer').scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    li.append(q, meta, btn);
    ul.appendChild(li);
  }
}

// --------------------------------------------------------------- sync/account

async function renderSync() {
  const connected = !!(cfg.sync.enabled && cfg.sync.token);
  $('syncOff').classList.toggle('hidden', connected);
  $('syncOn').classList.toggle('hidden', !connected);
  $('sy-url').value = cfg.sync.serverUrl || '';
  $('sy-webUrl').value = cfg.sync.webUrl || '';
  $('sy-email').value = cfg.sync.email || '';
  $('sy-auto').checked = cfg.sync.autoPush !== false;

  if (!connected) { $('sy-status').textContent = ''; return; }

  $('sy-who').textContent = 'Checking ' + cfg.sync.serverUrl + '…';
  try {
    const me = await whoAmI(cfg);
    $('sy-who').className = 'status-line ok';
    $('sy-who').textContent = 'Signed in as ' + me.email + ' · ' +
      me.applications.toLocaleString() + ' applications stored · ' +
      (me.resume ? 'resume: ' + me.resume.filename : 'no resume uploaded');
    const err = cfg.sync.lastError;
    $('sy-status').className = 'status-line' + (err ? ' err' : '');
    $('sy-status').textContent = err
      ? 'Last upload failed: ' + err + ' — use "Sync everything now" to catch up.'
      : (cfg.sync.lastPushAt ? 'Last upload ' + new Date(cfg.sync.lastPushAt).toLocaleString() : '');
  } catch (e) {
    $('sy-who').className = 'status-line err';
    $('sy-who').textContent = e.status === 401
      ? 'The saved sign-in is no longer valid. Disconnect and connect again.'
      : 'Cannot reach the server: ' + e.message;
  }
}

function syncStatus(msg, kind) {
  $('sy-status').className = 'status-line' + (kind ? ' ' + kind : '');
  $('sy-status').textContent = msg;
}

// Reaching an arbitrary server needs host permission for that exact origin,
// which Chrome will only grant from a user gesture like this click.
async function connect(mode) {
  const serverUrl = normalizeUrl($('sy-url').value);
  const webUrl = normalizeUrl($('sy-webUrl').value);
  const email = $('sy-email').value.trim();
  const password = $('sy-password').value;
  if (!serverUrl || !email || !password) return syncStatus('Fill in all three fields.', 'err');

  const origin = originOf(serverUrl);
  if (!origin) return syncStatus('That server address is not a valid URL.', 'err');

  syncStatus('Asking for permission to reach ' + origin + '…');
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) return syncStatus('Permission for ' + origin + ' was declined.', 'err');

  syncStatus(mode === 'register' ? 'Creating the account…' : 'Signing in…');
  try {
    const session = await authenticate(serverUrl, email, password, mode);
    cfg = await setConfig({
      sync: {
        enabled: true, serverUrl, webUrl, email: session.email, token: session.token,
        refreshToken: session.refreshToken, expiresAt: session.expiresAt,
        lastError: '', pending: 0
      }
    });
    $('sy-password').value = '';
    await renderSync();
    syncStatus('Connected. Use "Sync everything now" to upload the history you already have.', 'ok');
  } catch (e) {
    syncStatus(e.message, 'err');
  }
}

$('sy-login').onclick = () => connect('login');
$('sy-register').onclick = () => connect('register');

$('sy-logout').onclick = async () => {
  cfg = await setConfig({ sync: { enabled: false, token: '', refreshToken: '', expiresAt: 0, lastError: '', pending: 0 } });
  await renderSync();
  syncStatus('Disconnected. Nothing was deleted from the server.');
};

$('sy-auto').onchange = async (e) => {
  cfg = await setConfig({ sync: { autoPush: e.target.checked } });
};

$('sy-pushAll').onclick = async () => {
  syncStatus('Uploading…');
  try {
    const { saved, total } = await pushAll(cfg);
    cfg = await setConfig({ sync: { lastPushAt: Date.now(), lastError: '', pending: 0 } });
    syncStatus('Uploaded ' + saved + ' of ' + total + ' records.', 'ok');
    await renderSync();
  } catch (e) {
    syncStatus('Upload failed: ' + e.message, 'err');
  }
};

$('sy-pushResume').onclick = async () => {
  syncStatus('Uploading the resume…');
  try {
    const res = await pushResume(cfg);
    syncStatus(res.unchanged ? 'That resume is already on the server.' : 'Resume uploaded.', 'ok');
    await renderSync();
  } catch (e) {
    syncStatus('Upload failed: ' + e.message, 'err');
  }
};

$('sy-open').onclick = () => {
  // The web app is deployed on its own origin, so it has its own address.
  const base = normalizeUrl(cfg.sync.webUrl || cfg.sync.serverUrl);
  chrome.tabs.create({ url: base + '/app/' });
};

// ------------------------------------------------------------------ history

async function renderHistory() {
  const h = await getHistory();
  const rows = Object.entries(h).sort((a, b) => b[1].at - a[1].at);
  $('histCount').textContent = rows.length + ' jobs recorded';
  const tbody = $('histTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const [id, r] of rows.slice(0, 300)) {
    const tr = document.createElement('tr');
    const link = 'https://www.linkedin.com/jobs/view/' + id + '/';
    tr.innerHTML = '<td></td><td><a target="_blank"></a></td><td></td><td></td><td></td><td></td>';
    const td = tr.children;
    td[0].textContent = new Date(r.at).toLocaleString();
    td[1].firstChild.href = link;
    td[1].firstChild.textContent = r.title || id;
    td[2].textContent = r.company || '';
    td[3].textContent = r.score ?? '';
    td[4].textContent = r.status || '';
    td[5].textContent = r.reason || '';
    tbody.appendChild(tr);
  }
}

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
  a.download = 'easy-apply-history-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
};

$('clearHist').onclick = async () => {
  if (!confirm('Clear the history? Jobs you already applied to could then be applied to again.')) return;
  await clearHistory();
  await renderHistory();
};

// ------------------------------------------------------------------ preview

// Notes that explain a board's quirks where the person is choosing it, rather
// than only in a README they may never open.
const BOARD_NOTES = {
  linkedin: 'Easy Apply is completed in-page. The only board that can filter the search to just those.',
  naukri: 'Apply is usually one click, but may open a chat questionnaire, which it answers from your rules.',
  indeed: 'Indeed Apply hands off to smartapply.indeed.com and is filled by the portal engine. Indeed watches for automation closely - it stops if challenged.'
};

function renderBoards() {
  const box = $('boards');
  box.innerHTML = '';
  for (const site of SITE_LIST) {
    const s = cfg.sites[site.id] || { enabled: false, maxPerRun: 10 };
    const row = document.createElement('div');
    row.className = 'board' + (s.enabled ? ' on' : '');
    row.dataset.site = site.id;

    const toggle = document.createElement('label');
    toggle.innerHTML = '<input type="checkbox" class="b-enabled"' + (s.enabled ? ' checked' : '') + '>';
    const name = document.createElement('span');
    name.className = 'board-name';
    name.textContent = site.name;
    toggle.appendChild(name);

    const note = document.createElement('span');
    note.className = 'board-note';
    note.textContent = BOARD_NOTES[site.id] || '';

    const cap = document.createElement('label');
    cap.innerHTML = 'max per run <input type="number" class="b-max" min="1" max="200" value="' + Number(s.maxPerRun || 10) + '">';

    row.append(toggle, note, cap);

    if (site.id === 'indeed') {
      const dom = document.createElement('label');
      dom.innerHTML = 'domain <select class="b-domain">' +
        site.domains.map((d) => '<option value="' + d + '"' + (d === s.domain ? ' selected' : '') + '>' + d + '</option>').join('') +
        '</select>';
      const auto = document.createElement('label');
      auto.innerHTML = '<input type="checkbox" class="b-auto"' + (s.autoSubmit ? ' checked' : '') + '> submit automatically';
      row.append(dom, auto);
    }

    row.addEventListener('change', () => {
      row.classList.toggle('on', row.querySelector('.b-enabled').checked);
      renderUrlPreview();
    });
    box.appendChild(row);
  }
}

function collectSites() {
  const out = {};
  for (const row of $('boards').querySelectorAll('.board')) {
    const id = row.dataset.site;
    out[id] = {
      ...(cfg.sites[id] || {}),
      enabled: row.querySelector('.b-enabled').checked,
      maxPerRun: Number(row.querySelector('.b-max').value) || 10
    };
    const domain = row.querySelector('.b-domain');
    if (domain) out[id].domain = domain.value;
    const auto = row.querySelector('.b-auto');
    if (auto) out[id].autoSubmit = auto.checked;
  }
  return out;
}

function renderUrlPreview() {
  const search = {
    keywords: $('s-keywords').value.trim(),
    location: $('s-location').value.trim(),
    extraQuery: $('s-extraQuery').value.trim(),
    datePosted: $('s-datePosted').value,
    sortBy: $('s-sortBy').value,
    geoId: $('s-geoId').value.trim(),
    remote: getChecks('s-remote'),
    experience: getChecks('s-experience')
  };
  const kw = search.keywords || searchKeywordsFrom(cfg.profile) || '(none)';
  const sites = collectSites();
  const box = $('urlPreview');
  box.innerHTML = '';

  const on = SITE_LIST.filter((s) => sites[s.id] && sites[s.id].enabled);
  $('boardsNote').textContent = on.length
    ? on.length + ' board' + (on.length === 1 ? '' : 's') + ' switched on'
    : 'No boards switched on - a run will not start.';

  for (const site of on) {
    // Company-portal mode needs the jobs that apply off-site in the results too.
    const quickOnly = site.supportsQuickApplyFilter && !$('pt-enabled').checked;
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = site.name + ': ';
    const code = document.createElement('code');
    code.textContent = site.searchUrl(search, kw, 0, quickOnly, cfg.profile, sites[site.id]);
    row.append(label, code);
    box.appendChild(row);
  }
}

$('pt-enabled').addEventListener('change', renderUrlPreview);

for (const el of document.querySelectorAll('#search input, #search select')) {
  el.addEventListener('change', renderUrlPreview);
  el.addEventListener('input', renderUrlPreview);
}
$('m-minScore').oninput = (e) => { $('minScoreVal').textContent = e.target.value; };
$('save').onclick = save;

load();

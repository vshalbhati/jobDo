// Every jobDo setting, edited here and saved to the account. The extension
// downloads the result before each run; it no longer has settings of its own.
import { apiFetch, getTheme, setTheme, signOut } from '../app/source.js';
import { DEFAULT_RULES, defaultConfig, mergeConfig } from '../shared/defaults.js';
import { parseResumeText, searchKeywordsFrom } from '../shared/resume.js';
import { SITE_LIST } from '../shared/sites.js';
import { ATS_LIST } from '../shared/ats.js';
import { extractText, fileToDataUrl } from './extract.js';

const $ = (id) => document.getElementById(id);

// Uploads travel as base64 inside JSON, and the API's host caps a request at
// 4.5 MB; 3 MB of file is what fits.
const MAX_RESUME_BYTES = 3 * 1024 * 1024;

let cfg = null;       // defaults, overlaid with the account's settings
let resume = null;    // the account's current resume, or null
let unknown = [];     // questions a run could not answer
let dirty = false;

const json = (method, body) => ({
  method,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// ------------------------------------------------------------------ loading

async function fetchAccount() {
  const [conf, current, me] = await Promise.all([
    apiFetch('/config'),
    apiFetch('/resumes/current').catch((e) => { if (e.status === 404) return null; throw e; }),
    apiFetch('/me')
  ]);
  const base = defaultConfig();
  cfg = mergeConfig(base, conf.config);
  cfg.profile = mergeConfig(base.profile, (current && current.profile) || {});
  resume = current;
  unknown = conf.unknownQuestions || [];
  $('who').textContent = me.email;
}

function renderAll() {
  renderResume();
  renderProfile();

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
  $('r-poolFactor').value = cfg.rank.poolFactor;
  $('r-maxPool').value = cfg.rank.maxPool;
  $('m-titleInclude').value = (cfg.match.titleInclude || []).join('\n');
  $('m-titleExclude').value = (cfg.match.titleExclude || []).join('\n');
  $('m-companyBlocklist').value = (cfg.match.companyBlocklist || []).join('\n');
  $('m-descriptionExclude').value = (cfg.match.descriptionExclude || []).join('\n');

  $('sc-enabled').checked = !!cfg.schedule.enabled;
  $('sc-time').value = cfg.schedule.time || '14:00';
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
  renderRules();
  renderUnknowns();
  renderUrlPreview();
}

function renderResume() {
  for (const r of document.querySelectorAll('input[name=resumeStrategy]')) {
    r.checked = r.value === (cfg.resume.strategy || 'saved');
  }
  $('resumeCurrent').className = 'status-line' + (resume ? ' ok' : ' warn');
  $('resumeCurrent').textContent = resume
    ? 'On your account: ' + resume.filename + ' · ' + (resume.text || '').length.toLocaleString() + ' characters · added ' +
      new Date(resume.uploadedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : 'No resume on your account yet. Runs will not start until you upload one.';
  $('resumePickLabel').textContent = resume ? 'Replace resume' : 'Upload a resume';
  $('resumeText').textContent = (resume && resume.text) || '';
}

const PROFILE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'country', 'linkedin', 'github',
  'website', 'defaultYears', 'education', 'expectedSalary', 'currentSalary', 'noticePeriodDays',
  'currentTitle', 'currentCompany'];

function renderProfile() {
  for (const k of PROFILE_FIELDS) $('p-' + k).value = cfg.profile[k] ?? '';
  $('p-titles').value = (cfg.profile.titles || []).join('\n');
  renderSkills();
  // The profile is stored with the resume, so there is nowhere to save it yet.
  const locked = !resume;
  $('profileLocked').classList.toggle('hidden', !locked);
  for (const el of $('profile').querySelectorAll('input, textarea, button')) el.disabled = locked;
}

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

function collect() {
  const minDelayMs = Number($('f-minDelay').value) * 1000;
  let maxDelayMs = Number($('f-maxDelay').value) * 1000;
  if (maxDelayMs < minDelayMs) maxDelayMs = minDelayMs + 5000;
  return {
    profile: {
      ...cfg.profile,
      ...Object.fromEntries(PROFILE_FIELDS.map((k) => [k, $('p-' + k).value.trim()])),
      defaultYears: Number($('p-defaultYears').value) || 0,
      noticePeriodDays: Number($('p-noticePeriodDays').value) || 0,
      titles: lines($('p-titles').value),
      skills: collectSkills()
    },
    config: {
      resume: { strategy: (document.querySelector('input[name=resumeStrategy]:checked') || {}).value || 'saved' },
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
      rank: {
        poolFactor: Math.max(1, Number($('r-poolFactor').value) || 3),
        maxPool: Math.max(5, Math.round(Number($('r-maxPool').value) || 150))
      },
      schedule: {
        enabled: $('sc-enabled').checked,
        time: /^\d{1,2}:\d{2}$/.test($('sc-time').value) ? $('sc-time').value : '14:00'
      },
      safety: {
        dryRun: $('f-dryRun').checked,
        reviewBeforeSubmit: $('f-reviewBeforeSubmit').checked,
        stopOnUnknownQuestion: $('f-stopOnUnknownQuestion').checked,
        skipIfDescriptionMissing: $('f-skipIfDescriptionMissing').checked,
        maxPerRun: Number($('f-maxPerRun').value) || 1,
        maxPerDay: Number($('f-maxPerDay').value) || 1,
        minDelayMs,
        maxDelayMs,
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
    }
  };
}

async function save() {
  const { profile, config } = collect();
  $('save').disabled = true;
  flash('Saving…');
  try {
    const saved = await apiFetch('/config', json('PATCH', { config }));
    if (resume) await apiFetch('/resumes/current/profile', json('PUT', { profile }));
    cfg = mergeConfig(mergeConfig(defaultConfig(), saved.config), { profile });
    if (resume) resume.profile = profile;
    await dismissAnswered(config.answers.rules);
    dirty = false;
    flash('Saved. The extension picks this up before its next run.');
    renderUrlPreview();
  } catch (e) {
    $('save').disabled = false;
    flash('Could not save: ' + e.message, true);
  }
}

function flash(msg, isError) {
  $('saveMsg').textContent = msg;
  $('saveMsg').className = isError ? 'err' : '';
}

function markDirty() {
  if (!cfg) return;
  dirty = true;
  $('save').disabled = false;
  flash('');
}

// --------------------------------------------------------------------- resume

$('resumeFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const status = $('resumeStatus');
  const say = (msg, kind) => { status.className = 'status-line' + (kind ? ' ' + kind : ''); status.textContent = msg; };

  if (file.size > MAX_RESUME_BYTES) return say('That file is ' + (file.size / 1048576).toFixed(1) + ' MB; the limit is 3 MB. Export a smaller PDF.', 'err');
  if (dirty && !confirm('A new resume replaces the profile below. Unsaved changes elsewhere on this page are kept; continue?')) return;

  say('Reading ' + file.name + '…');
  try {
    const text = await extractText(file);
    if (text.trim().length < 120) {
      throw new Error('only ' + text.trim().length + ' characters came out. Is it a scanned image? Export a text-based PDF.');
    }
    const parsed = parseResumeText(text);
    say('Uploading ' + file.name + '…');
    await apiFetch('/resume', json('POST', {
      filename: file.name, mime: file.type || 'application/octet-stream',
      data: await fileToDataUrl(file), text, profile: parsed
    }));
    // A blank keyword box means "build it from the resume" - seed it once.
    if (!cfg.search.keywords && !$('s-keywords').value.trim()) {
      const keywords = searchKeywordsFrom(parsed);
      await apiFetch('/config', json('PATCH', { config: { search: { keywords } } }));
      $('s-keywords').value = keywords;
      cfg.search.keywords = keywords;
    }
    resume = await apiFetch('/resumes/current');
    cfg.profile = mergeConfig(defaultConfig().profile, resume.profile || {});
    renderResume();
    renderProfile();
    renderUrlPreview();
    say('Read ' + file.name + ': ' + Object.keys(parsed.skills).length + ' skills, ' + parsed.titles.length +
      ' titles, about ' + parsed.defaultYears + ' years of experience. It is on your account now; check the profile below.', 'ok');
  } catch (err) {
    say('Could not use it: ' + err.message, 'err');
  }
};

// ------------------------------------------------------------------- skills

function renderSkills() {
  const box = $('skills');
  box.replaceChildren();
  const entries = Object.entries(cfg.profile.skills || {}).sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    const none = document.createElement('span');
    none.className = 'hint';
    none.textContent = 'No skills yet: upload a resume or add them below.';
    box.append(none);
  }
  for (const [name, years] of entries) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.skill = name;
    const label = document.createElement('span');
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'number'; input.min = '0'; input.max = '50'; input.value = String(Number(years) || 0);
    input.setAttribute('aria-label', 'Years of ' + name);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.title = 'Remove'; remove.textContent = '×';
    remove.onclick = () => { chip.remove(); markDirty(); };
    chip.append(label, input, remove);
    box.append(chip);
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
  markDirty();
};

$('addSkill').onclick = () => {
  const name = $('newSkill').value.trim().toLowerCase();
  if (!name) return;
  cfg.profile.skills = { ...collectSkills(), [name]: Number($('newSkillYears').value) || 0 };
  $('newSkill').value = '';
  renderSkills();
  markDirty();
};

// -------------------------------------------------------------------- rules

function renderRules() {
  const tbody = $('rulesTable').querySelector('tbody');
  tbody.replaceChildren();
  for (const rule of cfg.answers.rules) {
    const tr = document.createElement('tr');
    if (rule.builtin) tr.className = 'builtin';
    tr.dataset.id = rule.id;
    tr.innerHTML =
      '<td><input type="checkbox" class="r-on" aria-label="Rule on"></td>' +
      '<td><input class="r-pattern" aria-label="Question pattern"></td>' +
      '<td><input class="r-answer" placeholder="(from profile)" aria-label="Answer"></td>' +
      '<td class="x"><button type="button" title="Delete">&times;</button></td>';
    tr.querySelector('.r-on').checked = !!rule.enabled;
    tr.querySelector('.r-pattern').value = rule.pattern;
    tr.querySelector('.r-answer').value = rule.answer || '';
    tr.querySelector('button').onclick = () => { tr.remove(); markDirty(); };
    tbody.append(tr);
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
  try { new RegExp(pattern); } catch (e) { flash('Not a valid regular expression: ' + e.message, true); return; }
  cfg.answers.rules = [{ id: 'u' + Date.now(), pattern, answer: $('newAnswer').value, enabled: true, builtin: false },
    ...collectRules()];
  $('newPattern').value = '';
  $('newAnswer').value = '';
  renderRules();
  markDirty();
};

$('resetRules').onclick = () => {
  const custom = collectRules().filter((r) => !r.builtin);
  cfg.answers.rules = [...custom, ...DEFAULT_RULES];
  renderRules();
  markDirty();
};

// ------------------------------------------------------- unanswered questions

function renderUnknowns() {
  $('unknownBox').classList.toggle('hidden', !unknown.length);
  const ul = $('unknownList');
  ul.replaceChildren();
  for (const u of unknown.slice().reverse()) {
    const li = document.createElement('li');
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = u.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [u.job, u.kind, (u.options || []).join(' / ')].filter(Boolean).join(' · ');
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'ghost'; add.textContent = 'Add a rule for this';
    add.onclick = () => {
      // Escaped, so it starts as a literal match the user can then relax.
      $('newPattern').value = u.label.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      $('newAnswer').focus();
      $('newAnswer').scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const dismiss = document.createElement('button');
    dismiss.type = 'button'; dismiss.className = 'ghost'; dismiss.textContent = 'Dismiss';
    dismiss.onclick = async () => {
      const out = await apiFetch('/unknown-questions?label=' + encodeURIComponent(u.label), { method: 'DELETE' });
      unknown = out.unknownQuestions;
      renderUnknowns();
    };
    li.append(q, meta, add, dismiss);
    ul.append(li);
  }
}

// After a save, questions that a rule now answers are no longer outstanding.
async function dismissAnswered(rules) {
  const answered = unknown.filter((u) => rules.some((r) => {
    if (!r.enabled) return false;
    try { return new RegExp(r.pattern, 'i').test(u.label); } catch { return false; }
  }));
  for (const u of answered) {
    const out = await apiFetch('/unknown-questions?label=' + encodeURIComponent(u.label), { method: 'DELETE' });
    unknown = out.unknownQuestions;
  }
  renderUnknowns();
}

// ------------------------------------------------------------------ boards

// Notes that explain a board's quirks where the person is choosing it, rather
// than only in a README they may never open.
const BOARD_NOTES = {
  linkedin: 'Easy Apply is completed in-page. The only board that can filter the search to just those.',
  naukri: 'Apply is usually one click, but may open a chat questionnaire, which it answers from your rules.',
  indeed: 'Indeed Apply hands off to smartapply.indeed.com and is filled by the company-site engine. Indeed watches for automation closely - it stops if challenged.'
};

function renderBoards() {
  const box = $('boards');
  box.replaceChildren();
  for (const site of SITE_LIST) {
    const s = cfg.sites[site.id] || { enabled: false, maxPerRun: 10 };
    const row = document.createElement('div');
    row.className = 'board' + (s.enabled ? ' on' : '');
    row.dataset.site = site.id;

    const toggle = document.createElement('label');
    const on = document.createElement('input');
    on.type = 'checkbox'; on.className = 'b-enabled'; on.checked = !!s.enabled;
    const name = document.createElement('span');
    name.className = 'board-name';
    name.textContent = site.name;
    toggle.append(on, name);

    const note = document.createElement('span');
    note.className = 'board-note';
    note.textContent = BOARD_NOTES[site.id] || '';

    const cap = document.createElement('label');
    const max = document.createElement('input');
    max.type = 'number'; max.className = 'b-max'; max.min = '1'; max.max = '200'; max.value = String(Number(s.maxPerRun || 10));
    cap.append('max per run ', max);
    row.append(toggle, note, cap);

    if (site.id === 'indeed') {
      const dom = document.createElement('label');
      const select = document.createElement('select');
      select.className = 'b-domain';
      for (const d of site.domains) select.append(new Option(d, d, false, d === s.domain));
      dom.append('domain ', select);
      const auto = document.createElement('label');
      const autoBox = document.createElement('input');
      autoBox.type = 'checkbox'; autoBox.className = 'b-auto'; autoBox.checked = !!s.autoSubmit;
      auto.append(autoBox, ' submit automatically');
      row.append(dom, auto);
    }

    row.addEventListener('change', () => {
      row.classList.toggle('on', row.querySelector('.b-enabled').checked);
      renderUrlPreview();
    });
    box.append(row);
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

function renderAtsList() {
  $('atsList').replaceChildren(...ATS_LIST.map((a) => {
    const chip = document.createElement('span');
    chip.className = 'chip static';
    chip.textContent = a.name + ' · ' + a.mode;
    return chip;
  }));
}

function renderUrlPreview() {
  if (!cfg) return;
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
  const on = SITE_LIST.filter((s) => sites[s.id] && sites[s.id].enabled);
  $('boardsNote').textContent = on.length
    ? on.length + ' board' + (on.length === 1 ? '' : 's') + ' switched on'
    : 'No boards switched on - a run will not start.';

  $('urlPreview').replaceChildren(...on.map((site) => {
    // Company-site mode needs the jobs that apply off-site in the results too.
    const quickOnly = site.supportsQuickApplyFilter && !$('pt-enabled').checked;
    const url = site.searchUrl(search, kw, 0, quickOnly, cfg.profile, sites[site.id]);
    const row = document.createElement('div');
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const code = document.createElement('code');
    code.textContent = url;
    link.append(code);
    row.append(site.name + ': ', link);
    return row;
  }));
}

// ------------------------------------------------------------------- wiring

// Typing into the "add a skill / add a rule" boxes is not a change until the
// Add button is pressed, and picking a resume saves itself: neither counts.
const NOT_EDITS = new Set(['resumeFile', 'newSkill', 'newSkillYears', 'newPattern', 'newAnswer']);
for (const type of ['input', 'change']) {
  $('form').addEventListener(type, (e) => {
    if (NOT_EDITS.has(e.target.id)) return;
    markDirty();
    if (e.target.closest('#search') || e.target.id === 'pt-enabled') renderUrlPreview();
  });
}
$('m-minScore').addEventListener('input', (e) => { $('minScoreVal').textContent = e.target.value; });
$('save').onclick = save;
$('signout').onclick = signOut;
$('theme').onclick = async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  await setTheme(next);
};

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

(async function init() {
  const theme = await getTheme();
  if (theme) document.documentElement.dataset.theme = theme;
  try {
    await fetchAccount();
  } catch (e) {
    $('loading').className = 'status-line err';
    $('loading').textContent = 'Could not load your settings: ' + e.message;
    return;
  }
  renderAll();
  $('loading').classList.add('hidden');
  $('form').classList.remove('hidden');
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();

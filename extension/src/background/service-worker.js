import { getConfig, setConfig, getHistory, recordApplication, log, setRun, getRun, resetRun } from '../shared/storage.js';
import { scoreJob } from '../shared/matcher.js';
import { searchKeywordsFrom } from '../shared/resume.js';
import { detectAts, isLinkedInRedirect } from '../shared/ats.js';
import { SITES, siteForUrl } from '../shared/sites.js';
import { autoPush } from '../shared/sync.js';

const CONTENT_FILES = [
  'src/content/selectors.js',
  'src/content/dom.js',
  'src/content/answer-engine.js',
  'src/content/scrape.js',
  'src/content/easy-apply.js',
  'src/content/sites/registry.js',
  'src/content/sites/linkedin.js',
  'src/content/sites/naukri.js',
  'src/content/sites/indeed.js',
  'src/content/main.js'
];

const PORTAL_FILES = [
  'src/content/dom.js',
  'src/content/answer-engine.js',
  'src/content/portal/portal-fill.js',
  'src/content/portal/portal-main.js'
];

// MV3 kills an idle service worker after ~30s. The loop survives that two ways:
// it messages the content script at least every 15s (which resets the idle
// timer), and a watchdog alarm restarts it from persisted state if it dies.
let loopRunning = false;
let stopRequested = false;

const MAX_PAGES = 40;           // per board; they stop paginating well before this
const PREFILTER_LENIENCY = 0.6; // title-only scores run low, so relax the bar

chrome.runtime.onInstalled.addListener(async () => {
  await setConfig({});
  await resetRun();
  chrome.alarms.create('lea-watchdog', { periodInMinutes: 1 });
  log('info', 'Extension installed. Open Options and upload your resume to get started.');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('lea-watchdog', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'lea-watchdog') return;
  const run = await getRun();
  if (run.active && !loopRunning) {
    log('warn', 'Run loop was interrupted; resuming.');
    runLoop().catch((e) => log('error', 'resume failed: ' + e.message));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (type === 'CS_LOG') { log(msg.level, msg.message); return false; }
  if (type === 'START_RUN') {
    startRun().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (type === 'STOP_RUN') {
    stopRun().then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (type === 'GET_STATE') {
    Promise.all([getConfig(), getRun(), getHistory()])
      .then(([cfg, run, history]) => sendResponse({ cfg, run, historyCount: Object.keys(history).length }));
    return true;
  }
  return false;
});

// --------------------------------------------------------------- run control

function enabledSites(cfg) {
  return Object.keys(SITES).filter((id) => cfg.sites[id] && cfg.sites[id].enabled);
}

async function startRun() {
  const cfg = await getConfig();
  if (!cfg.resume.text) throw new Error('Upload a resume on the Options page first.');

  const sites = enabledSites(cfg);
  if (!sites.length) throw new Error('No job boards are switched on. Pick at least one in Settings.');

  const run = await getRun();
  if (run.active) return { ok: true, already: true };

  const tabId = await ensureTab(null, SITES[sites[0]]);
  stopRequested = false;
  await setRun({
    active: true, paused: false, applied: 0, seen: 0, skipped: 0, failed: 0,
    page: 0, startedAt: Date.now(), phase: 'starting', current: null, tabId,
    queue: [], portalApplied: 0, searchUrl: '',
    sites, siteId: sites[0], perSite: {}
  });
  await setConfig({ enabled: true });
  log('info', 'Run started on ' + sites.map((s) => SITES[s].name).join(', ') +
    (cfg.safety.dryRun ? ' (DRY RUN - nothing will be submitted)' : ''));
  runLoop().catch((e) => log('error', 'run loop crashed: ' + e.message));
  return { ok: true };
}

async function stopRun() {
  stopRequested = true;
  await setRun({ active: false, phase: 'stopped' });
  await setConfig({ enabled: false });
  const run = await getRun();
  if (run.tabId) send(run.tabId, { type: 'ABORT' }).catch(() => {});
  log('info', 'Run stopped.');
  return { ok: true };
}

// ------------------------------------------------------------------ the loop

async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  let consecutiveErrors = 0;
  try {
    for (;;) {
     try {
      const cfg = await getConfig();
      let run = await getRun();
      if (!run.active || stopRequested) break;

      if (run.applied >= cfg.safety.maxPerRun) {
        log('info', 'Reached maxPerRun (' + cfg.safety.maxPerRun + ').');
        break;
      }
      if (await dailyCapReached(cfg)) {
        log('info', 'Reached maxPerDay (' + cfg.safety.maxPerDay + ').');
        break;
      }
      if (!run.siteId) { log('info', 'All boards done.'); break; }

      const site = SITES[run.siteId];
      const siteCfg = cfg.sites[run.siteId] || {};
      const doneHere = (run.perSite && run.perSite[run.siteId]) || 0;

      if (doneHere >= (siteCfg.maxPerRun || 10)) {
        log('info', site.name + ': per-run limit of ' + siteCfg.maxPerRun + ' reached.');
        run = await nextSite(run);
        continue;
      }
      if (run.page > MAX_PAGES) {
        log('info', site.name + ': walked ' + MAX_PAGES + ' pages; moving on.');
        run = await nextSite(run);
        continue;
      }

      const tabId = await ensureTab(run.tabId, site);
      if (tabId !== run.tabId) run = await setRun({ tabId });

      // --- refill the queue -------------------------------------------------
      if (!run.queue || !run.queue.length) {
        const filled = await fillQueue(cfg, run, tabId, site);
        if (!filled) { run = await nextSite(run); continue; }
        run = await getRun();
        if (!run.queue.length) continue;   // page filtered out entirely
      }

      // --- take one job -----------------------------------------------------
      const queue = run.queue.slice();
      const job = queue.shift();
      await setRun({ queue, current: job, phase: site.name + ': opening job', seen: run.seen + 1 });

      const outcome = await processJob(job, cfg, tabId, site);
      run = await getRun();
      const counts = {
        applied: run.applied + (outcome.status === 'applied' ? 1 : 0),
        skipped: run.skipped + (['skipped', 'dry_run', 'needs_manual'].includes(outcome.status) ? 1 : 0),
        failed: run.failed + (outcome.status === 'failed' ? 1 : 0)
      };
      const perSite = { ...(run.perSite || {}) };
      perSite[run.siteId] = (perSite[run.siteId] || 0) + (outcome.status === 'applied' ? 1 : 0);
      await setRun({ ...counts, perSite, current: null });

      const entry = {
        title: job.title, company: job.company, location: job.location,
        url: job.url, status: outcome.status, reason: outcome.reason, score: job.score,
        source: outcome.source || 'easy',
        ats: outcome.source === 'portal' ? (run.lastAts || '') : '',
        site: job.site || run.siteId,
        at: Date.now()
      };
      await recordApplication(historyKey(job, run.siteId), entry);
      await autoPush(historyKey(job, run.siteId), entry);
      if (outcome.status === 'applied') await bumpDaily();
      if (outcome.unknowns && outcome.unknowns.length) await recordUnknowns(outcome.unknowns, job);

      log(outcome.status === 'failed' ? 'error' : 'info',
        site.name + ' ' + outcome.status.toUpperCase() + ': ' + job.title + ' @ ' + job.company + ' - ' + outcome.reason);

      // --- pace ourselves ---------------------------------------------------
      if (outcome.status === 'applied' && cfg.safety.longBreakEvery
          && counts.applied % cfg.safety.longBreakEvery === 0) {
        const mins = cfg.safety.longBreakMinutes;
        log('info', 'Taking a ' + mins + ' minute break after ' + counts.applied + ' applications.');
        await setRun({ phase: 'on a break', paused: true });
        await longSleep(mins * 60 * 1000, tabId);
        await setRun({ paused: false });
      } else {
        const wait = rand(cfg.safety.minDelayMs, cfg.safety.maxDelayMs);
        await setRun({ phase: 'waiting ' + Math.round(wait / 1000) + 's' });
        await longSleep(wait, tabId);
      }
      consecutiveErrors = 0;
     } catch (e) {
      consecutiveErrors++;
      log('error', 'iteration failed (' + consecutiveErrors + '/3): ' + (e && e.message ? e.message : String(e)));
      if (consecutiveErrors >= 3) break;
      await sleep(5000);
     }
    }
  } finally {
    loopRunning = false;
    const run = await getRun();
    if (run.active) {
      await setRun({ active: false, phase: 'finished' });
      await setConfig({ enabled: false });
      log('info', 'Run finished. Applied ' + run.applied + ', skipped ' + run.skipped + ', failed ' + run.failed + '.');
    }
  }
}

// Job ids are only unique within a board, so history is keyed by both.
const historyKey = (job, siteId) => (job.site || siteId || 'linkedin') + ':' + job.jobId;

async function nextSite(run) {
  const remaining = (run.sites || []).filter((s) => s !== run.siteId);
  const siteId = remaining[0] || null;
  if (siteId) log('info', 'Moving on to ' + SITES[siteId].name + '.');
  return setRun({ sites: remaining, siteId, page: 0, queue: [] });
}

async function fillQueue(cfg, run, tabId, site) {
  const keywords = cfg.search.keywords || searchKeywordsFrom(cfg.profile);
  if (!keywords) { log('error', 'No search keywords and none could be derived from the resume.'); return false; }

  const siteCfg = cfg.sites[site.id] || {};
  const start = run.page * site.perPage;
  // Only LinkedIn can filter to in-page applications; elsewhere everything
  // comes back and the job page decides.
  const quickOnly = site.supportsQuickApplyFilter && !cfg.portal.enabled;
  const url = site.searchUrl(cfg.search, keywords, start, quickOnly, cfg.profile, siteCfg);

  await setRun({ phase: site.name + ': loading results page ' + (run.page + 1) });
  log('info', site.name + ' page ' + (run.page + 1) + ': ' + url);

  await navigate(tabId, url);
  const res = await send(tabId, { type: 'COLLECT_JOBS' }, 90000);
  if (!res || res.error) {
    log('error', site.name + ': could not read the results list - ' + (res && res.error));
    return false;
  }
  if (!res.jobs.length) { log('info', site.name + ': no jobs on this page.'); return false; }

  const history = await getHistory();
  const prefilter = { ...cfg.match, minScore: Math.round(cfg.match.minScore * PREFILTER_LENIENCY) };
  const queue = [];
  for (const j of res.jobs) {
    // History used to be keyed by bare job id, before there was more than one
    // board. Check the old key too so earlier LinkedIn applications still count.
    const prior = history[historyKey(j, site.id)] || (site.id === 'linkedin' ? history[j.jobId] : null);
    if (prior && prior.status !== 'dry_run') continue;
    if (j.alreadyApplied) continue;
    if (quickOnly && cfg.match.requireEasyApply && !j.quickApply) continue;
    const s = scoreJob(j, cfg.profile, prefilter);
    if (!s.ok) continue;
    queue.push({ ...j, site: j.site || site.id, score: s.score });
  }
  queue.sort((a, b) => b.score - a.score);
  log('info', site.name + ': ' + res.jobs.length + ' jobs on page, ' + queue.length + ' worth opening.');

  await setRun({ queue, page: run.page + 1, searchUrl: url });
  if (!queue.length && !res.hasNext) { log('info', site.name + ': no more pages.'); return false; }
  return true;
}

async function processJob(job, cfg, tabId, site) {
  // LinkedIn shows jobs in a side pane, so a card is clicked. The other boards
  // have real job pages, so the tab is navigated instead - more reliable than
  // clicking into a list that re-renders under us.
  let opened;
  if (site.openStrategy === 'navigate') {
    if (!job.url) return { status: 'failed', reason: 'no job URL on the card' };
    await navigate(tabId, job.url, { waitForList: false });
    opened = await send(tabId, { type: 'READ_JOB', job }, 40000);
  } else {
    opened = await send(tabId, { type: 'OPEN_JOB', job }, 40000);
  }
  if (!opened || !opened.ok) return { status: 'failed', reason: (opened && opened.reason) || 'could not open job' };
  if (opened.alreadyApplied) return { status: 'skipped', reason: 'already applied' };

  const full = {
    ...job,
    title: opened.title || job.title,
    company: opened.company || job.company,
    description: opened.description
  };
  if (!full.description && cfg.safety.skipIfDescriptionMissing) {
    return { status: 'skipped', reason: 'description did not load' };
  }

  const s = scoreJob(full, cfg.profile, cfg.match);
  if (!s.ok) return { status: 'skipped', reason: 'match ' + s.reason };
  log('info', 'MATCH ' + s.score + ': ' + full.title + ' @ ' + full.company + ' (' + s.reason + ')');
  await setRun({ phase: site.name + ': applying', current: { ...full, description: undefined, score: s.score } });

  // Indeed Apply leaves the site for smartapply.indeed.com, so it is driven by
  // the portal engine on that page rather than here.
  if (site.id === 'indeed' && opened.hasQuickApply) {
    const r = await applyViaPortal(full, cfg, tabId, { trigger: { type: 'APPLY_JOB', job: full, cfg: slimCfg(cfg) } });
    return { ...r, source: 'portal' };
  }

  if (!opened.hasQuickApply) {
    if (!cfg.portal.enabled) {
      return { status: 'skipped', reason: 'applies on the company site (portal mode is off)' };
    }
    const run = await getRun();
    if ((run.portalApplied || 0) >= cfg.portal.maxPerRun) {
      return { status: 'skipped', reason: 'company-portal budget for this run is used up' };
    }
    const r = await applyViaPortal(full, cfg, tabId);
    return { ...r, source: 'portal' };
  }

  const result = await send(tabId, { type: 'APPLY_JOB', job: full, cfg: slimCfg(cfg) }, 6 * 60 * 1000);
  if (!result) return { status: 'failed', reason: 'content script did not answer', source: 'easy' };
  return { ...result, source: 'easy' };
}

// The resume's base64 is only worth shipping across when we intend to upload it.
const slimCfg = (cfg) => (cfg.resume.strategy === 'upload'
  ? cfg
  : { ...cfg, resume: { ...cfg.resume, dataUrl: '', text: '' } });

// ------------------------------------------------------- company portal (2)

async function applyViaPortal(job, cfg, boardTabId, opts = {}) {
  const trigger = opts.trigger || { type: 'CLICK_APPLY' };
  await setRun({ phase: 'opening company site' });

  const boardTab = await chrome.tabs.get(boardTabId).catch(() => null);
  const windowId = boardTab ? boardTab.windowId : undefined;
  const watcher = watchForNewTab(boardTabId, windowId, 30000);

  const clicked = await send(boardTabId, trigger, 60000);
  const started = trigger.type === 'CLICK_APPLY'
    ? !!(clicked && clicked.ok)
    : !!(clicked && clicked.status === 'handoff');

  if (!started) {
    watcher.cancel();
    // A dry run on Indeed stops before the hand-off, which is a result, not a failure.
    if (clicked && clicked.status) return clicked;
    return { status: 'skipped', reason: (clicked && clicked.reason) || 'could not start the application' };
  }

  let portalTabId = null;
  let borrowedBoardTab = false;
  let keepTab = false;
  const opened = await watcher.promise;
  if (opened) {
    portalTabId = opened.id;
  } else {
    const now = await chrome.tabs.get(boardTabId).catch(() => null);
    if (now && !siteForUrl(now.url || '')) {
      portalTabId = boardTabId;
      borrowedBoardTab = true;
    }
  }
  if (!portalTabId) return { status: 'failed', reason: 'the company site never opened' };

  try {
    const url = await settleUrl(portalTabId);
    if (!url) return { status: 'failed', reason: 'company site did not finish loading' };

    const ats = detectAts(url);
    // Indeed's own apply flow is assisted unless you have explicitly allowed it.
    if (ats.id === 'indeed-smartapply' && cfg.sites.indeed && cfg.sites.indeed.autoSubmit) {
      ats.mode = 'auto';
    }
    await setRun({ lastAts: ats.name });
    log('info', 'Company site: ' + ats.name + ' (' + ats.mode + ') - ' + url.slice(0, 120));

    if (ats.mode === 'unknown' && !(await canInject(url))) {
      keepTab = true;
      return {
        status: 'needs_manual',
        reason: 'unrecognised career site (' + ats.host + '); allow unknown sites in Settings to let it fill these in',
        keepTab: true
      };
    }

    await ensurePortalScript(portalTabId);
    const ready = await send(portalTabId, { type: 'PORTAL_PING' }, 8000);
    if (!ready || !ready.ok) {
      keepTab = true;
      return { status: 'needs_manual', reason: 'could not run on ' + ats.host, keepTab: true };
    }

    const slim = { ...cfg, resume: { ...cfg.resume, text: '' } };
    const result = await send(portalTabId, { type: 'PORTAL_APPLY', job, cfg: slim, ats }, 6 * 60 * 1000);
    if (!result || result.error) {
      keepTab = true;
      return { status: 'failed', reason: 'portal script did not answer: ' + (result && result.error), keepTab: true };
    }

    keepTab = !!result.keepTab;
    const run = await getRun();
    await setRun({ portalApplied: (run.portalApplied || 0) + 1 });
    return result;
  } finally {
    await closePortalTab(portalTabId, borrowedBoardTab, keepTab, boardTabId, cfg);
  }
}

async function closePortalTab(portalTabId, borrowed, keep, boardTabId, cfg) {
  const run = await getRun();
  if (borrowed) {
    if (run.searchUrl) await chrome.tabs.update(boardTabId, { url: run.searchUrl }).catch(() => {});
    return;
  }
  if (!keep && cfg.portal.closeTabWhenDone) {
    await chrome.tabs.remove(portalTabId).catch(() => {});
  }
  await chrome.tabs.update(boardTabId, { active: true }).catch(() => {});
}

function watchForNewTab(openerTabId, windowId, timeoutMs) {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  const onCreated = (tab) => {
    if (tab.openerTabId === openerTabId || (windowId !== undefined && tab.windowId === windowId)) {
      cleanup();
      settle(tab);
    }
  };
  const timer = setTimeout(() => { cleanup(); settle(null); }, timeoutMs);
  function cleanup() {
    clearTimeout(timer);
    chrome.tabs.onCreated.removeListener(onCreated);
  }
  chrome.tabs.onCreated.addListener(onCreated);
  return { promise, cancel: () => { cleanup(); settle(null); } };
}

async function settleUrl(tabId, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  let stable = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    const url = tab.url || tab.pendingUrl || '';
    if (url && !isLinkedInRedirect(url) && !/^(about|chrome):/.test(url)) {
      if (url === stable && tab.status === 'complete' && Date.now() - stableSince > 1200) return url;
      if (url !== stable) { stable = url; stableSince = Date.now(); }
    }
    await sleep(700);
  }
  return stable || null;
}

async function canInject(url) {
  try {
    return await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] });
  } catch { return false; }
}

async function ensurePortalScript(tabId) {
  const pong = await send(tabId, { type: 'PORTAL_PING' }, 2500);
  if (pong && pong.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: PORTAL_FILES }).catch(() => {});
  await sleep(800);
}

async function recordUnknowns(unknowns, job) {
  const cfg = await getConfig();
  const existing = cfg.answers.unknownQuestions || [];
  for (const u of unknowns) {
    if (existing.some((e) => e.label === u.label)) continue;
    existing.push({
      label: u.label, kind: u.kind, options: u.options || [],
      job: job.title + ' @ ' + job.company, at: Date.now()
    });
  }
  await setConfig({ answers: { unknownQuestions: existing.slice(-60) } });
}

// ------------------------------------------------------------------- plumbing

async function ensureTab(preferredId, site) {
  if (preferredId) {
    const tab = await chrome.tabs.get(preferredId).catch(() => null);
    if (tab) return tab.id;          // reuse whatever tab the run is driving
  }
  const pattern = site.matches[0];
  const [existing] = await chrome.tabs.query({ url: pattern });
  if (existing) { await chrome.tabs.update(existing.id, { active: true }); return existing.id; }
  const created = await chrome.tabs.create({ url: site.home, active: true });
  await waitForComplete(created.id);
  return created.id;
}

async function navigate(tabId, url, opts = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== url) {
    await chrome.tabs.update(tabId, { url });
    await waitForComplete(tabId);
  }
  await ensureContentScript(tabId);
  if (opts.waitForList === false) { await sleep(900); return; }
  for (let i = 0; i < 20; i++) {
    const pong = await send(tabId, { type: 'PING' }, 5000).catch(() => null);
    if (pong && pong.ready) return;
    await sleep(1000);
  }
}

function waitForComplete(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(t); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    const t = setTimeout(done, 45000);
    chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === 'complete') done(); }).catch(done);
  });
}

async function ensureContentScript(tabId) {
  const pong = await send(tabId, { type: 'PING' }, 2500).catch(() => null);
  if (pong && pong.ok) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }).catch(() => {});
  await sleep(600);
}

function send(tabId, msg, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + msg.type)), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg).then(
      (res) => { clearTimeout(t); resolve(res); },
      (err) => { clearTimeout(t); reject(err); }
    );
  }).catch((e) => ({ error: e.message }));
}

async function longSleep(ms, tabId) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stopRequested) return;
    const run = await getRun();
    if (!run.active) return;
    await sleep(Math.min(12000, until - Date.now()));
    if (tabId) await send(tabId, { type: 'PING' }, 4000).catch(() => {});
  }
}

async function dailyCapReached(cfg) {
  const today = new Date().toDateString();
  if (cfg.stats.day !== today) { await setConfig({ stats: { day: today, appliedToday: 0 } }); return false; }
  return cfg.stats.appliedToday >= cfg.safety.maxPerDay;
}

async function bumpDaily() {
  const cfg = await getConfig();
  const today = new Date().toDateString();
  const count = cfg.stats.day === today ? cfg.stats.appliedToday + 1 : 1;
  await setConfig({ stats: { day: today, appliedToday: count } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (a, b) => Math.floor(a + Math.random() * Math.max(1, b - a));

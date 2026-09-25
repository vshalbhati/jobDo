import { getConfig, setConfig, getHistory, recordApplication, log, setRun, getRun, resetRun } from '../shared/storage.js';
import { scoreJob, hardSkip } from '../shared/matcher.js';
import { searchKeywordsFrom } from '../shared/resume.js';
import { detectAts, isLinkedInRedirect } from '../shared/ats.js';
import { SITES, siteForUrl } from '../shared/sites.js';
import { autoPush, autoPushMany, isConnected, rankRemote } from '../shared/sync.js';
import { isDue, scheduledAt } from '../shared/schedule.js';

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
// The same once-a-minute alarm starts the daily run.
let loopRunning = false;
let stopRequested = false;

const WATCHDOG = 'lea-watchdog';
const MAX_PAGES = 40;               // per board; they stop paginating well before this
const PREFILTER_MIN = 20;           // title-only score a card needs before its description is read
const RANK_BATCH = 15;              // postings per ranking request
const DESCRIPTION_LIMIT = 12000;    // characters of a description kept for ranking
const READ_PAUSE_MS = [1500, 4000]; // between reading two postings

// The daily run looks only at fresh postings, newest first: applying early is
// the point of it.
const FRESH_SEARCH = { datePosted: 'r86400', sortBy: 'DD' };

chrome.runtime.onInstalled.addListener(async () => {
  await setConfig({});
  await resetRun();
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  // Installing or updating after today's run time should not start a run
  // on the spot; the schedule picks up from the next one.
  const cfg = await getConfig();
  if (isDue(cfg)) await setConfig({ schedule: { lastRunDay: new Date().toDateString() } });
  log('info', 'Extension installed. Open Options and upload your resume to get started.');
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const run = await getRun();
  if (run.active && !loopRunning) {
    log('warn', 'Run loop was interrupted; resuming.');
    runLoop().catch((e) => log('error', 'resume failed: ' + e.message));
  } else if (!run.active) {
    await maybeStartDailyRun();
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

// ------------------------------------------------------------ the daily run

let startingDaily = false;

// Due from the scheduled time until midnight, so a day when Chrome was closed
// at 2 PM still gets its run as soon as Chrome opens. A manual run in
// progress just delays it: the watchdog asks again every minute.
async function maybeStartDailyRun() {
  if (startingDaily) return;
  startingDaily = true;
  try {
    const cfg = await getConfig();
    const now = new Date();
    if (!isDue(cfg, now)) return;
    // Marked first, so a run that cannot start is not retried every minute
    // for the rest of the day.
    await setConfig({ schedule: { lastRunDay: now.toDateString() } });
    const late = Math.round((now - scheduledAt(cfg, now)) / 60000);
    log('info', 'Daily run: jobs posted in the last 24 hours' +
      (late > 5 ? ' (catching up, ' + formatMinutes(late) + ' after the scheduled time)' : '') + '.');
    await startRun({ scheduled: true });
  } catch (e) {
    log('error', 'The daily run could not start: ' + e.message);
  } finally {
    startingDaily = false;
  }
}

const formatMinutes = (m) => (m < 90 ? m + ' min' : Math.round(m / 60) + ' h');

// --------------------------------------------------------------- run control

function enabledSites(cfg) {
  return Object.keys(SITES).filter((id) => cfg.sites[id] && cfg.sites[id].enabled);
}

// Everything a board needs to start from scratch: scan its results, rank
// them, then apply best-first.
const FRESH_BOARD = {
  page: 0, queue: [], stage: 'scan', pending: [], scored: [], ranked: [], scanDone: false
};

async function startRun({ scheduled = false } = {}) {
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
    startedAt: Date.now(), phase: 'starting', current: null, tabId,
    portalApplied: 0, searchUrl: '', sites, siteId: sites[0], perSite: {},
    scheduled, threshold: null, rankMode: '', warnedLocal: false,
    ...FRESH_BOARD
  });
  await setConfig({ enabled: true });
  log('info', (scheduled ? 'Daily run' : 'Run') + ' started on ' + sites.map((s) => SITES[s].name).join(', ') +
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
//
// Each board goes through three stages, all persisted so the watchdog can
// resume any of them:
//   scan   read the full description of up to poolTarget() postings
//   rank   (in batches, while scanning) score them with the ranker
//   apply  work through those at or above the threshold, highest first
// Reading more jobs than it will apply to is the point: it is how the
// applications go to the best matches rather than the first ones found.

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

      const tabId = await ensureTab(run.tabId, site);
      if (tabId !== run.tabId) run = await setRun({ tabId });

      if (run.stage === 'apply') {
        const more = await applyNext(cfg, run, tabId, site);
        if (!more) await nextSite(run);
      } else {
        await scanStep(cfg, run, tabId, site, siteCfg);
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
  return setRun({ sites: remaining, siteId, ...FRESH_BOARD });
}

// How many postings to read on this board before choosing: a multiple of
// what the run can still apply to here, within the configured ceiling.
function poolTarget(cfg, run, siteCfg) {
  const doneHere = (run.perSite && run.perSite[run.siteId]) || 0;
  const today = cfg.stats.day === new Date().toDateString() ? cfg.stats.appliedToday : 0;
  const budget = Math.max(1, Math.min(
    (siteCfg.maxPerRun || 10) - doneHere,
    cfg.safety.maxPerRun - run.applied,
    cfg.safety.maxPerDay - today
  ));
  const factor = Math.max(1, Number(cfg.rank.poolFactor) || 3);
  return Math.max(1, Math.min(Number(cfg.rank.maxPool) || 150, Math.ceil(budget * factor)));
}

// ------------------------------------------------------------------ scanning

async function scanStep(cfg, run, tabId, site, siteCfg) {
  const target = poolTarget(cfg, run, siteCfg);
  const pending = run.pending || [];
  const scored = run.scored || [];
  const enough = scored.length + pending.length >= target;

  // Ranked in batches as the pool fills, so descriptions never pile up in storage.
  if (pending.length >= RANK_BATCH || (pending.length && (run.scanDone || enough))) {
    await rankPending(cfg, run, site);
    return;
  }
  if (run.scanDone || enough) {
    await startApplying(run, site);
    return;
  }
  if (run.page > MAX_PAGES) {
    log('info', site.name + ': walked ' + MAX_PAGES + ' pages.');
    await setRun({ scanDone: true });
    return;
  }
  if (!run.queue || !run.queue.length) {
    const filled = await fillQueue(cfg, run, tabId, site);
    if (!filled) await setRun({ scanDone: true });
    return;
  }

  const queue = run.queue.slice();
  const job = queue.shift();
  const n = scored.length + pending.length + 1;
  await setRun({ queue, current: job, seen: run.seen + 1, phase: site.name + ': reading job ' + n + ' of up to ' + target });

  const opened = await openJob(job, tabId, site, false);
  const read = { ...job, title: opened.title || job.title, company: opened.company || job.company, description: opened.description || '' };
  let skip = null;
  if (!opened.ok) {
    // Not recorded: a posting that would not open is worth another try next run.
    log('warn', site.name + ': could not read ' + job.title + ' @ ' + job.company + ' - ' + opened.reason);
  } else if (opened.alreadyApplied) {
    skip = 'already applied';
  } else if (!opened.hasQuickApply && !cfg.portal.enabled) {
    skip = 'applies on the company site (portal mode is off)';
  } else if (!read.description && cfg.safety.skipIfDescriptionMissing) {
    skip = 'description did not load';
  } else {
    skip = hardSkip(read, cfg.profile, cfg.match);
  }

  if (skip) {
    await recordSkips([[read, skip, null]], run.siteId);
    const now = await getRun();
    await setRun({ skipped: now.skipped + 1 });
  } else if (opened.ok) {
    const entry = {
      ...job,
      title: read.title, company: read.company,
      description: read.description.slice(0, DESCRIPTION_LIMIT),
      hasQuickApply: !!opened.hasQuickApply,
      // Where it was found, so the apply stage can get back to it.
      pageUrl: run.searchUrl
    };
    const now = await getRun();
    await setRun({ pending: [...(now.pending || []), entry] });
  }
  await setRun({ current: null });
  await longSleep(rand(READ_PAUSE_MS[0], READ_PAUSE_MS[1]), tabId);
}

function searchFor(cfg, run) {
  return run.scheduled ? { ...cfg.search, ...FRESH_SEARCH } : cfg.search;
}

async function fillQueue(cfg, run, tabId, site) {
  const keywords = cfg.search.keywords || searchKeywordsFrom(cfg.profile);
  if (!keywords) { log('error', 'No search keywords and none could be derived from the resume.'); return false; }

  const siteCfg = cfg.sites[site.id] || {};
  const start = run.page * site.perPage;
  // Only LinkedIn can filter to in-page applications; elsewhere everything
  // comes back and the job page decides.
  const quickOnly = site.supportsQuickApplyFilter && !cfg.portal.enabled;
  const url = site.searchUrl(searchFor(cfg, run), keywords, start, quickOnly, cfg.profile, siteCfg);

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
  const queue = [];
  for (const j of res.jobs) {
    // History used to be keyed by bare job id, before there was more than one
    // board. Check the old key too so earlier LinkedIn applications still count.
    const prior = history[historyKey(j, site.id)] || (site.id === 'linkedin' ? history[j.jobId] : null);
    if (prior && prior.status !== 'dry_run') continue;
    if (j.alreadyApplied) continue;
    if (quickOnly && cfg.match.requireEasyApply && !j.quickApply) continue;
    // A cheap title check before paying to read the description; the ranker
    // makes the real decision.
    const s = scoreJob(j, cfg.profile, { ...cfg.match, minScore: PREFILTER_MIN });
    if (!s.ok) continue;
    queue.push({ ...j, site: j.site || site.id, score: s.score });
  }
  queue.sort((a, b) => b.score - a.score);
  log('info', site.name + ': ' + res.jobs.length + ' jobs on page, ' + queue.length + ' worth reading.');

  await setRun({ queue, page: run.page + 1, searchUrl: url });
  if (!queue.length && !res.hasNext) { log('info', site.name + ': no more pages.'); return false; }
  return true;
}

// ------------------------------------------------------------------- ranking

async function rankPending(cfg, run, site) {
  const batch = run.pending || [];
  await setRun({ phase: site.name + ': ranking ' + batch.length + ' jobs' });
  const ranker = await rankerFor(cfg, run, batch);

  const scored = [...(run.scored || [])];
  const below = [];
  for (const job of batch) {
    const r = ranker.get(job);
    const { description, ...slim } = job;
    scored.push({ ...slim, score: r.score, verdict: r.verdict, rankNote: r.summary });
    if (r.verdict !== 'apply') below.push([job, 'ranked ' + r.summary, r.score]);
  }
  // Below the bar is final: recorded now, so the next run does not read them again.
  await recordSkips(below, run.siteId);

  const now = await getRun();
  await setRun({
    pending: [], scored,
    threshold: ranker.threshold, rankMode: ranker.mode,
    skipped: now.skipped + below.length
  });
  const passing = scored.filter((j) => j.verdict === 'apply').length;
  log('info', site.name + ': scored ' + batch.length + ' with the ' + (ranker.mode === 'server' ? 'ranker' : 'built-in scorer') +
    ' - ' + (batch.length - below.length) + ' at or above ' + ranker.threshold + ' (' + passing + ' so far).');
}

// The server's ranker when this browser is connected to an account, the
// built-in keyword scorer otherwise, or when the server cannot be reached.
async function rankerFor(cfg, run, batch) {
  if (cfg.rank.useServer !== false && isConnected(cfg)) {
    try {
      const out = await rankRemote(cfg, batch.map((j) => ({
        id: String(j.jobId), title: j.title, company: j.company, location: j.location || '', description: j.description
      })));
      // Keep the local copy of the account's threshold current, for the
      // Settings page and for the fallback.
      if (out.threshold !== cfg.match.minScore) await setConfig({ match: { minScore: out.threshold } });
      const byId = new Map((out.results || []).map((r) => [String(r.id), r]));
      const local = localRanker(cfg, out.threshold);
      return {
        mode: 'server',
        threshold: out.threshold,
        get: (j) => byId.get(String(j.jobId)) || local.get(j)
      };
    } catch (e) {
      log('warn', 'Ranking service unavailable (' + e.message + '); using the built-in scorer for this batch.');
    }
  } else if (!run.warnedLocal) {
    log('warn', 'Not connected to a jobDo account, so jobs are scored by the built-in keyword scorer. ' +
      'Connect in Settings → Account & sync to use the ranker.');
    await setRun({ warnedLocal: true });
  }
  return localRanker(cfg, cfg.match.minScore);
}

function localRanker(cfg, threshold) {
  return {
    mode: 'local',
    threshold,
    get: (j) => {
      const s = scoreJob(j, cfg.profile, { ...cfg.match, minScore: threshold });
      return { score: s.score, verdict: s.ok ? 'apply' : 'skip', summary: s.score + ' ' + (s.ok ? 'apply' : 'skip') + ': ' + s.reason };
    }
  };
}

async function startApplying(run, site) {
  const scored = run.scored || [];
  const ranked = scored.filter((j) => j.verdict === 'apply').sort((a, b) => b.score - a.score);
  if (!scored.length) {
    log('info', site.name + ': no new postings to consider.');
  } else if (!ranked.length) {
    log('info', site.name + ': read ' + scored.length + ' postings; none scored ' + run.threshold + ' or more.');
  } else {
    const top = ranked.slice(0, 8).map((j) => j.score).join(', ') + (ranked.length > 8 ? ', …' : '');
    log('info', site.name + ': read ' + scored.length + ' postings; ' + ranked.length + ' clear the bar of ' +
      run.threshold + '. Applying best first (' + top + ').');
  }
  await setRun({ stage: 'apply', ranked, scored: [], queue: [], current: null });
}

// -------------------------------------------------------------------- apply

// Returns false when there is nothing left to apply to on this board.
async function applyNext(cfg, run, tabId, site) {
  if (!run.ranked || !run.ranked.length) return false;
  const ranked = run.ranked.slice();
  const job = ranked.shift();
  await setRun({ ranked, current: job, phase: site.name + ': opening a ' + job.score + '-point match' });

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
    site.name + ' ' + outcome.status.toUpperCase() + ' (' + job.score + '): ' + job.title + ' @ ' + job.company + ' - ' + outcome.reason);

  // --- pace ourselves -------------------------------------------------------
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
  return true;
}

// Writes skipped postings to history and uploads them in one request.
// items: [[job, reason, score]]
async function recordSkips(items, siteId) {
  if (!items.length) return;
  const pushed = [];
  for (const [job, reason, score] of items) {
    const key = historyKey(job, siteId);
    const entry = {
      title: job.title, company: job.company, location: job.location, url: job.url,
      status: 'skipped', reason, score: typeof score === 'number' ? score : null,
      source: 'easy', ats: '', site: job.site || siteId, at: Date.now()
    };
    await recordApplication(key, entry);
    pushed.push([key, entry]);
  }
  await autoPushMany(pushed);
}

// Opens a posting and reads it. On LinkedIn a job opens in the side pane of
// the results page; reopening one found earlier in the run loads its results
// page with ?currentJobId= so the pane shows it even if the list has moved.
async function openJob(job, tabId, site, reopen) {
  let opened;
  if (site.openStrategy === 'navigate') {
    if (!job.url) return { ok: false, reason: 'no job URL on the card' };
    await navigate(tabId, job.url, { waitForList: false });
    opened = await send(tabId, { type: 'READ_JOB', job }, 40000);
  } else {
    if (reopen && job.pageUrl) await navigate(tabId, withCurrentJob(job.pageUrl, job.jobId));
    opened = await send(tabId, { type: 'OPEN_JOB', job }, 40000);
  }
  if (!opened || !opened.ok) return { ok: false, reason: (opened && opened.reason) || 'could not open job' };
  return opened;
}

function withCurrentJob(pageUrl, jobId) {
  try {
    const u = new URL(pageUrl);
    u.searchParams.set('currentJobId', String(jobId));
    return u.toString();
  } catch {
    return pageUrl;
  }
}

async function processJob(job, cfg, tabId, site) {
  const opened = await openJob(job, tabId, site, true);
  if (!opened.ok) return { status: 'failed', reason: opened.reason };
  if (opened.alreadyApplied) return { status: 'skipped', reason: 'already applied' };

  const full = {
    ...job,
    title: opened.title || job.title,
    company: opened.company || job.company,
    description: opened.description
  };
  log('info', 'APPLYING (' + job.score + '): ' + full.title + ' @ ' + full.company + (job.rankNote ? ' - ' + job.rankNote : ''));
  await setRun({ phase: site.name + ': applying', current: { ...full, description: undefined, score: job.score } });

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

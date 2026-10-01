// The favourite-companies check, for one account: read each company's careers
// board, keep the postings it has not considered before, narrow them to your
// target titles and places, rank those against your resume, and put the good
// matches on your job list. The extension then applies to them in Chrome.
//
// `repo` is the account's data, either as the signed-in user (the website's
// "Check now", under row level security) or from the scheduler's admin access,
// scoped to the one account. Both have the same shape.
import { fetchPostings, postingDetail } from './companies.js';
import { rankerConfigured, rankJobs } from './ranker.js';

const MAX_RANKED = 120;         // postings ranked per check, newest first
const RANK_BATCH = 50;          // what the ranker takes per request
const MAX_DETAILS = 30;         // Workday postings whose text is fetched per check
const MAX_UNRANKED_ADDS = 20;   // without a ranker: title matches added per check
const READ_AT_ONCE = 5;         // careers boards read at the same time
export const MAX_COMPANIES = 30;

// fn over items, at most `limit` at a time -> [{ value } | { error }] in order.
async function inParallel(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { value: await fn(items[i]) }; } catch (error) { out[i] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Words that say nothing about which job it is.
const GENERIC = new Set(('engineer engineering developer development senior sr junior jr lead staff principal ' +
  'associate specialist i ii iii iv v and of for in at the a an to with').split(' '));

const normalise = (s) => ' ' + String(s || '').toLowerCase()
  .replace(/back[\s-]?end/g, 'backend').replace(/front[\s-]?end/g, 'frontend')
  .replace(/full[\s-]?stack/g, 'fullstack').replace(/dev[\s-]?ops/g, 'devops')
  .replace(/[^a-z0-9+#]+/g, ' ').trim() + ' ';

// Each target title as the words that matter in it: "Senior Backend
// Engineer" -> [backend]. A posting matches when its title has all the words
// of one of them.
export function titleTargets(profile = {}, config = {}) {
  const titles = [...(profile.titles || []), ...String((config.search && config.search.keywords) || '').split(/[,;\n]/)];
  const out = [];
  for (const t of titles) {
    const words = normalise(t).trim().split(' ').filter((w) => w && !GENERIC.has(w));
    if (words.length && !out.some((o) => o.join(' ') === words.join(' '))) out.push(words);
  }
  return out;
}

export function titleMatches(title, targets, exclude = []) {
  const t = normalise(title);
  if (exclude.some((x) => x && t.includes(normalise(x)))) return false;
  if (!targets.length) return true;
  return targets.some((words) => words.every((w) => t.includes(' ' + w + ' ')));
}

export function placeMatches(location, places) {
  if (!places.length) return true;
  const l = String(location || '').toLowerCase();
  return places.some((p) => l.includes(p));
}

export const placesFrom = (text) => String(text || '').split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

// -> { result, added: [queue items], skipped: reason | '' }
export async function checkCompanies(repo, { now = Date.now() } = {}) {
  const watch = await repo.watch.get();
  const companies = (watch.companies || []).slice(0, MAX_COMPANIES);
  const result = { at: now, companies: [], added: 0, ranked: 0, error: '' };
  const finish = async (added = []) => {
    result.added = added.length;
    await repo.watch.update({
      lastRunAt: now,
      nextRunAt: now + watch.intervalHours * 3600000,
      lastResult: result
    });
    return { result, added, watch };
  };

  if (!companies.length) { result.error = 'No companies to check.'; return finish(); }
  const [resume, settings] = await Promise.all([repo.resumes.current(), repo.settings.get()]);
  if (!resume) { result.error = 'There is no resume on the account to match postings against.'; return finish(); }
  const profile = resume.profile || {};
  const cfg = settings.config || {};
  const targets = titleTargets(profile, cfg);
  const exclude = (cfg.match && cfg.match.titleExclude) || [];
  const places = placesFrom(watch.locations);
  // Workday is searched by these words rather than read whole.
  const searchTerms = targets.map((w) => w.join(' ')).slice(0, 3);

  // Read the boards a few at a time (a big one takes several seconds); one
  // that fails is reported, not fatal.
  let candidates = [];
  const considered = [];
  const rows = companies.map((c) => ({ name: c.name, ats: c.ats, postings: 0, fresh: 0, matched: 0, added: 0, error: '' }));
  result.companies = rows;
  const read = await inParallel(companies, READ_AT_ONCE, (company) => fetchPostings(company, searchTerms, now));
  for (let i = 0; i < companies.length; i++) {
    const row = rows[i];
    if (read[i].error) { row.error = read[i].error.message; continue; }
    const postings = read[i].value;
    row.postings = postings.length;
    const fresh = new Set(await repo.seen.unseen(postings.map((p) => p.key)));
    const freshPostings = postings.filter((p) => fresh.has(p.key));
    row.fresh = freshPostings.length;
    for (const p of freshPostings) {
      if (titleMatches(p.title, targets, exclude) && placeMatches(p.location, places)) {
        candidates.push({ ...p, company: companies[i], row });
      } else {
        considered.push(p.key);    // not a fit: never looked at again
      }
    }
  }

  // Newest first; what does not fit in this check waits for the next one.
  candidates.sort((a, b) => b.postedAt - a.postedAt);
  candidates = candidates.slice(0, MAX_RANKED);
  let details = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.needsDetail) continue;
    if (details++ >= MAX_DETAILS) { candidates = candidates.slice(0, i); break; }
    candidates[i] = { ...c, ...(await postingDetail(c.company, c).catch(() => c)) };
  }

  let picked = [];
  if (candidates.length && rankerConfigured()) {
    try {
      for (let i = 0; i < candidates.length; i += RANK_BATCH) {
        const batch = candidates.slice(i, i + RANK_BATCH);
        const out = await rankJobs({
          jobs: batch.map((c, n) => ({ id: String(i + n), title: c.title, company: c.company.name, location: c.location, description: c.description.slice(0, 40000) })),
          resumeText: String(resume.text_content || '').slice(0, 100000),
          profile,
          threshold: settings.minScore
        });
        const byId = new Map((out.results || []).map((r) => [String(r.id), r]));
        batch.forEach((c, n) => {
          const r = byId.get(String(i + n));
          considered.push(c.key);
          result.ranked++;
          if (r && r.verdict === 'apply') {
            picked.push({ ...c, score: r.score, note: 'ranked ' + r.score + (r.summary ? ': ' + String(r.summary).slice(0, 200) : '') });
          }
        });
      }
    } catch (e) {
      // What was not ranked stays unseen, so the next check ranks it.
      result.error = 'Ranking stopped part-way: ' + e.message;
    }
  } else if (candidates.length) {
    // No ranker on this server: the title match is all there is to go on.
    picked = candidates.slice(0, MAX_UNRANKED_ADDS).map((c) => ({ ...c, score: null, note: 'matches your job titles' }));
    for (const c of picked) considered.push(c.key);
  }

  for (const c of picked) c.row.matched++;
  const items = picked.map((c) => ({
    url: c.url, origin: 'company', title: c.title.slice(0, 300), company: c.company.name.slice(0, 200),
    location: c.location.slice(0, 200), score: c.score, note: c.note.slice(0, 300)
  }));
  const added = items.length ? await repo.queue.addReturning(items) : [];
  for (const a of added) {
    const c = picked.find((p) => p.url === a.url);
    if (c) c.row.added++;
  }
  await repo.seen.add(considered);
  return finish(added);
}

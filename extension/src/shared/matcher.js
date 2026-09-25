import { hasTerm } from './resume.js';

// Scores a job against the resume profile. Returns 0-100 plus the reasoning,
// which is written into the log so a bad threshold is easy to diagnose.
export function scoreJob(job, profile, matchCfg) {
  const title = (job.title || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();
  const reasons = [];

  const skip = hardSkip(job, profile, matchCfg);
  if (skip) return { ok: false, score: 0, reason: skip };

  const titleScore = scoreTitle(title, profile, reasons);
  const skillScore = desc ? scoreSkills(desc, profile, reasons) : null;
  const seniorityPenalty = scoreSeniority(title, profile, reasons);

  let score = skillScore === null
    ? titleScore                                   // description not loaded: title only
    : Math.round(titleScore * 0.45 + skillScore * 0.55);
  score = Math.max(0, Math.min(100, score - seniorityPenalty));

  const min = matchCfg.minScore ?? 35;
  return {
    ok: score >= min,
    score,
    reason: reasons.join('; ') + ' => ' + score + (score >= min ? '' : ' (below ' + min + ')')
  };
}

// Your own rules, which no score can override: blocked companies, excluded
// title and description words, required title words. Returns why the job is
// ruled out, or null. The ranker never sees a job that fails these.
export function hardSkip(job, profile, matchCfg) {
  const title = (job.title || '').toLowerCase();
  const company = (job.company || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();

  for (const bad of (matchCfg.companyBlocklist || [])) {
    if (bad && company.includes(bad.toLowerCase())) return 'company blocklisted: ' + bad;
  }
  for (const bad of (matchCfg.titleExclude || [])) {
    if (bad && title.includes(bad.toLowerCase())) return 'title excluded: ' + bad;
  }
  for (const bad of (matchCfg.descriptionExclude || [])) {
    if (bad && desc && desc.includes(bad.toLowerCase())) return 'description excluded: ' + bad;
  }
  const includes = (matchCfg.titleInclude || []).filter(Boolean);
  if (includes.length && !includes.some((w) => title.includes(w.toLowerCase()))) {
    return 'title missing all of: ' + includes.join(', ');
  }

  // An internship posting against a mid-career resume is never worth an
  // application, however well the keywords line up, so it is a hard skip
  // rather than a score penalty.
  const years = profile.defaultYears || 0;
  if (years >= 5 && /\b(intern|internship|trainee|fresher|apprentice)\b/.test(title)) {
    return 'entry-level posting vs ' + years + ' years of experience';
  }
  return null;
}

function scoreTitle(title, profile, reasons) {
  const myTitles = (profile.titles || []).map((t) => t.toLowerCase());
  if (!myTitles.length) { reasons.push('no resume titles'); return 50; }

  let best = 0, bestTitle = '';
  for (const mine of myTitles) {
    const a = new Set(tokens(mine));
    const b = new Set(tokens(title));
    if (!a.size || !b.size) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const overlap = shared / Math.min(a.size, b.size);
    if (overlap > best) { best = overlap; bestTitle = mine; }
  }
  reasons.push('title ' + Math.round(best * 100) + '% vs "' + bestTitle + '"');
  return Math.round(best * 100);
}

function scoreSkills(desc, profile, reasons) {
  const mine = Object.keys(profile.skills || {});
  if (!mine.length) { reasons.push('no resume skills'); return 50; }
  const hits = mine.filter((s) => hasTerm(desc, s));
  // 6 matching skills in a description is already a strong signal; cap there so
  // long keyword-stuffed postings don't dominate.
  const score = Math.round(Math.min(1, hits.length / 6) * 100);
  reasons.push('skills ' + hits.length + '/' + mine.length + (hits.length ? ' [' + hits.slice(0, 6).join(', ') + ']' : ''));
  return score;
}

// A 2-year resume against a "Principal Engineer, 12+ years" posting is a waste
// of an application; so is a 15-year resume against an internship.
function scoreSeniority(title, profile, reasons) {
  const years = profile.defaultYears || 0;
  const senior = /\b(principal|staff|distinguished|head of|chief|vp|vice president|director)\b/.test(title);
  const lead = /\b(senior|sr\.?|lead|manager|architect)\b/.test(title);
  const junior = /\b(intern|internship|trainee|graduate|entry[ -]level|junior|jr\.?|fresher)\b/.test(title);

  if (senior && years < 8) { reasons.push('senior title vs ' + years + 'y'); return 35; }
  if (lead && years < 4) { reasons.push('lead title vs ' + years + 'y'); return 20; }
  if (junior && years >= 5) { reasons.push('junior title vs ' + years + 'y'); return 30; }
  return 0;
}

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'at', 'to', 'with', 'i', 'ii', 'iii', 'iv', 'senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal']);

function tokens(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/[\s\-/]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Builds the LinkedIn jobs search URL. f_AL=true is the Easy Apply filter; it
// is dropped when company-portal mode is on, since that mode wants the jobs
// that send you to the employer's own site as well.
export function buildSearchUrl(search, keywords, start = 0, easyApplyOnly = true) {
  const u = new URL('https://www.linkedin.com/jobs/search/');
  const q = [keywords, search.extraQuery].filter(Boolean).join(' ').trim();
  if (q) u.searchParams.set('keywords', q);
  if (search.location) u.searchParams.set('location', search.location);
  if (search.geoId) u.searchParams.set('geoId', search.geoId);
  if (easyApplyOnly) u.searchParams.set('f_AL', 'true');
  if (search.datePosted) u.searchParams.set('f_TPR', search.datePosted);
  if (search.remote && search.remote.length) u.searchParams.set('f_WT', search.remote.join(','));
  if (search.experience && search.experience.length) u.searchParams.set('f_E', search.experience.join(','));
  if (search.sortBy) u.searchParams.set('sortBy', search.sortBy);
  if (start) u.searchParams.set('start', String(start));
  return u.toString();
}

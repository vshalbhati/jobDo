// The careers boards the favourite-companies check can read: the public JSON
// listings Greenhouse, Lever, Ashby and Workday publish for the companies that
// use them. No sign-in, nothing scraped. Companies with careers sites of their
// own (Google, Microsoft, Amazon, Apple, Meta) publish no such listing, so a
// server cannot read them; the website says so when one is entered.

const TIMEOUT_MS = 25000;         // a big Lever board (300+ postings with text) takes ~15 s
const MAX_POSTINGS = 2000;          // read per company per check
const WORKDAY_PAGE = 20;            // Workday's largest page
const WORKDAY_PAGES = 2;            // per search term

export const BOARDS = {
  greenhouse: { name: 'Greenhouse', slug: /^[a-z0-9][a-z0-9-]{0,80}$/ },
  lever: { name: 'Lever', slug: /^[a-z0-9][a-z0-9.-]{0,80}$/ },
  ashby: { name: 'Ashby', slug: /^[a-z0-9][a-z0-9.%-]{0,80}$/i },
  // "<tenant>.<wdN>/<site>", from a myworkdayjobs.com address
  workday: { name: 'Workday', slug: /^[a-z0-9-]{1,60}\.wd\d{1,3}\/[\w-]{1,100}$/i }
};

// Big employers people ask for, whose own sites cannot be read from a server.
const OWN_SITES = /^(google|alphabet|microsoft|amazon|aws|apple|meta|facebook|netflix|ibm|oracle|tcs|infosys|wipro|accenture|deloitte)$/i;

export const validCompany = (c) =>
  !!c && typeof c === 'object' && BOARDS[c.ats] && typeof c.slug === 'string' && BOARDS[c.ats].slug.test(c.slug);

// ------------------------------------------------------------------- http

async function request(url, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(new URL(url).hostname + ' answered ' + res.status);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(new URL(url).hostname + ' took too long to answer');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- reading

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => String(s || '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

// HTML to readable text: block ends become line breaks, tags go.
export function htmlText(html) {
  return decode(String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const pretty = (slug) => String(slug).split(/[-_.]/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function workdayParts(slug) {
  const [host, site] = slug.split('/');
  const [tenant, wd] = host.split('.');
  return { tenant, wd, site, origin: 'https://' + tenant + '.' + wd + '.myworkdayjobs.com' };
}

// "Posted Today", "Posted 3 Days Ago", "Posted 30+ Days Ago"
function workdayPosted(text, now) {
  const t = String(text || '').toLowerCase();
  if (/today/.test(t)) return now;
  if (/yesterday/.test(t)) return now - 86400000;
  const m = /(\d+)\+?\s*days?/.exec(t);
  return m ? now - Number(m[1]) * 86400000 : 0;
}

// -> [{ key, id, title, url, location, description, postedAt, needsDetail }]
// `terms` narrows Workday's search, which is the only board too big to read
// whole; the others return every posting.
export async function fetchPostings(company, terms = [], now = Date.now()) {
  const { ats, slug } = company;
  const key = (id) => ats + ':' + slug + ':' + id;

  if (ats === 'greenhouse') {
    const data = await request('https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(slug) + '/jobs?content=true');
    if (!data) throw new Error('no Greenhouse board called "' + slug + '"');
    return (data.jobs || []).slice(0, MAX_POSTINGS).map((j) => ({
      key: key(j.id), id: String(j.id), title: String(j.title || '').trim(),
      url: j.absolute_url || 'https://job-boards.greenhouse.io/' + slug + '/jobs/' + j.id,
      location: (j.location && j.location.name) || '',
      description: htmlText(decode(j.content)),
      postedAt: Date.parse(j.first_published || j.updated_at) || 0
    }));
  }

  if (ats === 'lever') {
    const data = await request('https://api.lever.co/v0/postings/' + encodeURIComponent(slug) + '?mode=json');
    if (!data) throw new Error('no Lever board called "' + slug + '"');
    return (Array.isArray(data) ? data : []).slice(0, MAX_POSTINGS).map((j) => ({
      key: key(j.id), id: String(j.id), title: String(j.text || '').trim(),
      url: j.hostedUrl || 'https://jobs.lever.co/' + slug + '/' + j.id,
      location: (j.categories && (j.categories.allLocations || [j.categories.location]).filter(Boolean).join('; ')) || '',
      description: [
        j.descriptionPlain,
        ...(j.lists || []).map((l) => (l.text ? l.text + '\n' : '') + htmlText(l.content)),
        j.additionalPlain
      ].filter(Boolean).join('\n\n').trim(),
      postedAt: Number(j.createdAt) || 0
    }));
  }

  if (ats === 'ashby') {
    const data = await request('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(slug) + '?includeCompensation=false');
    if (!data) throw new Error('no Ashby board called "' + slug + '"');
    return (data.jobs || []).filter((j) => j.isListed !== false).slice(0, MAX_POSTINGS).map((j) => ({
      key: key(j.id), id: String(j.id), title: String(j.title || '').trim(),
      url: j.jobUrl || 'https://jobs.ashbyhq.com/' + slug + '/' + j.id,
      location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join('; ') +
        (j.isRemote ? '; Remote' : ''),
      description: j.descriptionPlain || htmlText(j.descriptionHtml),
      postedAt: Date.parse(j.publishedAt) || 0
    }));
  }

  if (ats === 'workday') {
    const w = workdayParts(slug);
    const api = w.origin + '/wday/cxs/' + w.tenant + '/' + w.site;
    const searches = terms.length ? terms.slice(0, 3) : [''];
    const seen = new Map();
    for (const searchText of searches) {
      for (let page = 0; page < WORKDAY_PAGES; page++) {
        const data = await request(api + '/jobs', {
          method: 'POST', body: { appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText }
        });
        if (!data) throw new Error('no Workday site at ' + w.origin + '/' + w.site);
        for (const j of data.jobPostings || []) {
          if (!j.externalPath || seen.has(j.externalPath)) continue;
          seen.set(j.externalPath, {
            key: key(j.externalPath.split('_').pop() || j.externalPath), id: j.externalPath,
            title: String(j.title || '').trim(),
            url: w.origin + '/' + w.site + j.externalPath,
            location: j.locationsText || '',
            description: '', needsDetail: true,
            postedAt: workdayPosted(j.postedOn, now)
          });
        }
        if ((data.jobPostings || []).length < WORKDAY_PAGE) break;
      }
    }
    return [...seen.values()];
  }

  throw new Error('unknown careers board: ' + ats);
}

// Workday lists postings without their text; it is fetched only for the few
// that get as far as ranking.
export async function postingDetail(company, posting) {
  if (company.ats !== 'workday' || !posting.needsDetail) return posting;
  const w = workdayParts(company.slug);
  const data = await request(w.origin + '/wday/cxs/' + w.tenant + '/' + w.site + posting.id);
  const info = data && data.jobPostingInfo;
  if (!info) return posting;
  return {
    ...posting,
    description: htmlText(info.jobDescription),
    url: info.externalUrl || posting.url,
    location: info.location || posting.location,
    needsDetail: false
  };
}

// ------------------------------------------------------------------ lookup

// A careers address pasted in, read as { ats, slug }.
export function parseCareersUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split('/').filter(Boolean)[0] || '';
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const slug = (u.searchParams.get('for') || (first === 'embed' ? '' : first)).toLowerCase();
    return slug ? { ats: 'greenhouse', slug } : null;
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && first) return { ats: 'lever', slug: first.toLowerCase() };
  if (host === 'jobs.ashbyhq.com' && first) return { ats: 'ashby', slug: decodeURIComponent(first) };
  const wd = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const parts = u.pathname.split('/').filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '') ? parts[1] : parts[0];
    return site ? { ats: 'workday', slug: wd[1] + '.' + wd[2] + '/' + site } : null;
  }
  return null;
}

// What a board calls the company, and how many postings it has now.
async function probe(ats, slug) {
  try {
    if (ats === 'greenhouse') {
      const [board, jobs] = await Promise.all([
        request('https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(slug)),
        request('https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(slug) + '/jobs')
      ]);
      return board && jobs ? { ats, slug, name: board.name || pretty(slug), jobs: (jobs.jobs || []).length } : null;
    }
    if (ats === 'lever') {
      const jobs = await request('https://api.lever.co/v0/postings/' + encodeURIComponent(slug) + '?mode=json&limit=500');
      return Array.isArray(jobs) ? { ats, slug, name: pretty(slug), jobs: jobs.length } : null;
    }
    if (ats === 'ashby') {
      const data = await request('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(slug));
      return data && Array.isArray(data.jobs) ? { ats, slug, name: pretty(slug), jobs: data.jobs.length } : null;
    }
    if (ats === 'workday') {
      const w = workdayParts(slug);
      const data = await request(w.origin + '/wday/cxs/' + w.tenant + '/' + w.site + '/jobs', {
        method: 'POST', body: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }
      });
      return data ? { ats, slug, name: pretty(w.tenant), jobs: Number(data.total) || 0 } : null;
    }
  } catch {
    return null;
  }
  return null;
}

// A company name or a careers address -> the boards it was found on.
export async function lookupCompany(query) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { found: [], hint: 'Type a company name, or paste the address of its careers page.' };

  const parsed = parseCareersUrl(q);
  if (parsed) {
    const hit = validCompany(parsed) ? await probe(parsed.ats, parsed.slug) : null;
    return hit
      ? { found: [hit], hint: '' }
      : { found: [], hint: 'Could not read the job listing at that address.' };
  }
  if (/^https?:\/\//i.test(q)) {
    return {
      found: [],
      hint: 'That careers site is not one of the systems this can read (Greenhouse, Lever, Ashby, Workday). ' +
        'Add its job links to your list instead.'
    };
  }

  const base = q.toLowerCase().replace(/[^a-z0-9\s.-]/g, '').trim();
  const words = base.replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|technologies|labs|pvt|private|gmbh)\b\.?/g, '')
    .split(/[\s.-]+/).filter(Boolean);
  if (!words.length) return { found: [], hint: 'Type a company name, or paste the address of its careers page.' };
  if (OWN_SITES.test(words.join(''))) {
    return {
      found: [],
      hint: pretty(words.join('-')) + ' runs its own careers site, which a server cannot read. ' +
        'Add its job links to your list instead: the extension applies to those in Chrome.'
    };
  }
  const slugs = [...new Set([words.join(''), words.join('-'), words[0]])].slice(0, 3);
  const tries = [];
  for (const slug of slugs) for (const ats of ['greenhouse', 'lever', 'ashby']) {
    if (BOARDS[ats].slug.test(slug)) tries.push(probe(ats, slug));
  }
  const found = (await Promise.all(tries)).filter(Boolean);
  // The same company is often found under two spellings: keep one per board.
  const unique = [];
  for (const f of found.sort((a, b) => b.jobs - a.jobs)) {
    if (!unique.some((u) => u.ats === f.ats)) unique.push(f);
  }
  return {
    found: unique,
    hint: unique.length ? '' :
      'Not found on Greenhouse, Lever or Ashby under that name. Paste the address of its careers page instead ' +
      '(Workday sites end in myworkdayjobs.com).'
  };
}

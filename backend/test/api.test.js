// End-to-end tests against a real listener, using the in-memory providers so
// the suite needs no Supabase project and no network. The route code under
// test is exactly the code that runs in production; only the storage and auth
// backends are swapped, behind the same contract Supabase implements.
//
//   npm test
process.env.NODE_ENV = 'test';
process.env.PROVIDERS = 'memory';
process.env.CORS_ORIGINS = 'https://app.example.com,http://localhost:4173';
process.env.ALLOW_SIGNUP = 'true';
process.env.CRON_SECRET = 'test-cron-secret-0123456789abcdef';

// A stand-in for the Python ranker, so the suite needs neither Python nor the
// network. It scores a job 80 if its title contains "good" (any case), else 20, and
// remembers the last request so tests can see what the backend forwarded.
import http from 'node:http';
const stubRanker = { last: null, fail: false };
const rankerServer = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    if (stubRanker.fail) { s.writeHead(500).end('boom'); return; }
    if (q.headers['x-ranker-secret'] !== 'test-secret') { s.writeHead(401).end('{}'); return; }
    const body = JSON.parse(raw);
    stubRanker.last = body;
    const results = body.jobs.map((j) => {
      const score = /good/i.test(j.title) ? 80 : 20;
      return { id: j.id, score, verdict: score >= body.threshold ? 'apply' : 'skip', reasons: [] };
    });
    s.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 'stub', results }));
  });
});
await new Promise((r) => rankerServer.listen(0, '127.0.0.1', r));
process.env.RANKER_URL = 'http://127.0.0.1:' + rankerServer.address().port;
process.env.RANKER_SECRET = 'test-secret';

// A stand-in for Upstash's REST API: POST /pipeline with a JSON array of
// commands, answered with [{result}] or [{error}]. Only the commands the
// backend uses are implemented.
const fakeRedis = { store: new Map(), fail: false, requests: 0 };
const redisServer = http.createServer((q, s) => {
  let raw = '';
  q.on('data', (c) => { raw += c; });
  q.on('end', () => {
    fakeRedis.requests++;
    if (fakeRedis.fail) { s.writeHead(503).end('{"error":"down"}'); return; }
    if (q.url !== '/pipeline' || q.headers.authorization !== 'Bearer test-redis-token') {
      s.writeHead(401).end('{"error":"Unauthorized"}'); return;
    }
    const now = Date.now();
    const live = (k) => { const e = fakeRedis.store.get(k); if (e && e.exp && e.exp <= now) { fakeRedis.store.delete(k); return null; } return e || null; };
    const out = JSON.parse(raw).map(([cmd, ...a]) => {
      switch (cmd.toUpperCase()) {
        case 'PING': return { result: 'PONG' };
        case 'SET': {
          const [k, v, ...opt] = a;
          const up = opt.map((o) => o.toUpperCase());
          if (up.includes('NX') && live(k)) return { result: null };
          const ex = up.indexOf('EX');
          fakeRedis.store.set(k, { v, exp: ex >= 0 ? now + Number(opt[ex + 1]) * 1000 : 0 });
          return { result: 'OK' };
        }
        case 'INCR': { const e = live(a[0]) || { v: '0', exp: 0 }; e.v = String(Number(e.v) + 1); fakeRedis.store.set(a[0], e); return { result: Number(e.v) }; }
        case 'TTL': { const e = live(a[0]); return { result: !e ? -2 : e.exp ? Math.ceil((e.exp - now) / 1000) : -1 }; }
        case 'DEL': return { result: fakeRedis.store.delete(a[0]) ? 1 : 0 };
        default: return { error: 'ERR unknown command ' + cmd };
      }
    });
    s.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
});
await new Promise((r) => redisServer.listen(0, '127.0.0.1', r));
process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:' + redisServer.address().port;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';

const { app } = await import('../src/server.js');
const auth = await import('../src/auth.js');
// Clears both the shared (Redis) and the per-instance counts.
const resetRateLimits = () => { auth.resetRateLimits(); fakeRedis.store.clear(); };
const { setRequireConfirmation, confirmationCodeFor } = await import('../src/providers.memory.js');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (got !== undefined ? '  got: ' + JSON.stringify(got) : '')); }
};
const section = (s) => console.log('\n' + s);

const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;

async function req(method, path, { body, token, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const res = await fetch(base + path, {
    method, headers, redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
}

const cookiesFrom = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean));
const cookieHeader = (res) => cookiesFrom(res).map((c) => c.split(';')[0]).join('; ');

const PASSWORD = 'correct horse battery staple';

// ---------------------------------------------------------------------------
section('registration');
let r = await req('POST', '/api/auth/register', { body: { email: 'a@example.com', password: PASSWORD, client: 'extension' } });
ok('creates an account and returns tokens', r.status === 200 && !!r.data.token && !!r.data.refreshToken, r.data);
const tokenA = r.data.token;
const refreshA = r.data.refreshToken;
ok('the extension client gets no cookie', cookiesFrom(r).length === 0, cookiesFrom(r));

r = await req('POST', '/api/auth/register', { body: { email: 'A@Example.com', password: PASSWORD } });
ok('duplicate email is rejected, case-insensitively', r.status === 409, { status: r.status, data: r.data });

r = await req('POST', '/api/auth/register', { body: { email: 'bad', password: PASSWORD } });
ok('rejects a malformed email', r.status === 400, r.status);

r = await req('POST', '/api/auth/register', { body: { email: 'b@example.com', password: 'short' } });
ok('rejects a short password', r.status === 400 && /10 characters/.test(r.data.error), r.data);

section('login and sessions');
r = await req('POST', '/api/auth/login', { body: { email: 'a@example.com', password: PASSWORD, client: 'web' } });
ok('signs in', r.status === 200 && !!r.data.token);
const webCookie = cookieHeader(r);
const setCookies = cookiesFrom(r).join(' | ');
ok('the web client gets HttpOnly cookies', /HttpOnly/i.test(setCookies), setCookies);
ok('both an access and a refresh cookie are set', /sb-access/.test(setCookies) && /sb-refresh/.test(setCookies));
ok('cookies are SameSite=Lax by default', /SameSite=Lax/i.test(setCookies));

r = await req('POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'wrong password!!' } });
ok('rejects the wrong password', r.status === 401, r.status);
r = await req('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'whatever123' } });
ok('an unknown account gives the identical error', r.status === 401 && /wrong email or password/i.test(r.data.error), r.data);
resetRateLimits();

r = await req('GET', '/api/me');
ok('no credentials -> 401', r.status === 401, r.status);
r = await req('GET', '/api/me', { token: 'not-a-real-token' });
ok('a made-up bearer token -> 401', r.status === 401 && r.data.canRefresh === true, r.data);
r = await req('GET', '/api/me', { token: tokenA });
ok('a real bearer token works', r.status === 200 && r.data.email === 'a@example.com', r.data);
r = await req('GET', '/api/me', { cookie: webCookie });
ok('the cookie works too', r.status === 200, r.status);

section('token refresh (an access token expires long before a run finishes)');
r = await req('POST', '/api/auth/refresh', { body: { refresh_token: refreshA } });
ok('exchanges a refresh token for a new access token', r.status === 200 && !!r.data.token && r.data.token !== tokenA, r.data);
const refreshedToken = r.data.token;
const refreshA2 = r.data.refreshToken;
r = await req('GET', '/api/me', { token: refreshedToken });
ok('the refreshed token works', r.status === 200, r.status);
r = await req('POST', '/api/auth/refresh', { body: { refresh_token: refreshA } });
ok('a refresh token cannot be replayed', r.status === 401, r.status);
r = await req('POST', '/api/auth/refresh', { body: {} });
ok('refresh with no token -> 401', r.status === 401, r.status);

// ---------------------------------------------------------------------------
section('applications');
const now = Date.now();
const records = [
  { jobId: '1', title: 'Backend Engineer', company: 'Acme', status: 'applied', score: 80, source: 'easy', at: now },
  { jobId: '2', title: 'Platform Engineer', company: 'Acme', status: 'applied', score: 72, source: 'portal', ats: 'Greenhouse', at: now - 1000 },
  { jobId: '3', title: 'Data Engineer', company: 'Globex', status: 'needs_manual', score: 61, source: 'portal', ats: 'Workday', at: now - 2000 },
  { jobId: '4', title: 'Nurse', company: 'Mercy', status: 'skipped', score: 10, source: 'easy', at: now - 3000 }
];
r = await req('POST', '/api/applications', { token: refreshedToken, body: { records } });
ok('stores a batch', r.status === 200 && r.data.saved === 4, r.data);

r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [{ ...records[0], status: 'failed' }] } });
ok('re-sending the same job updates instead of duplicating', r.data.total === 4, r.data);

r = await req('GET', '/api/applications', { token: refreshedToken });
ok('lists them back', r.data.records.length === 4, r.data.records.length);
ok('the update took effect', r.data.records.find((x) => x.jobId === '1').status === 'failed');
ok('field names are what the dashboard expects',
  ['jobId', 'title', 'company', 'status', 'score', 'source', 'ats', 'at'].every((k) => k in r.data.records[0]),
  Object.keys(r.data.records[0]));
ok('newest first', r.data.records[0].at >= r.data.records[1].at);
ok('at is a millisecond timestamp', typeof r.data.records[0].at === 'number' && r.data.records[0].at > 1e12, r.data.records[0].at);

r = await req('GET', '/api/applications?since=' + (now - 1500), { token: refreshedToken });
ok('since= filters by time', r.data.records.length === 2, r.data.records.length);

r = await req('GET', '/api/stats', { token: refreshedToken });
ok('stats counts applied', r.data.applied === 1, r.data.applied);
ok('stats groups by company', r.data.topCompanies[0].company === 'Acme', r.data.topCompanies);

r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: 'nope' } });
ok('rejects a non-array payload', r.status === 400, r.status);
r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [{ title: 'no id' }] } });
ok('ignores a record with no jobId', r.data.saved === 0, r.data);
r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [{ jobId: '9', status: 'nonsense', score: 999, source: 'hack', at: now }] } });
ok('sanitises an unknown status, an out-of-range score and a bogus source', r.data.saved === 1, r.data);
r = await req('GET', '/api/applications', { token: refreshedToken });
const sanitised = r.data.records.find((x) => x.jobId === '9');
ok('  -> status fell back to skipped', sanitised.status === 'skipped', sanitised.status);
ok('  -> score was clamped to 100', sanitised.score === 100, sanitised.score);
ok('  -> source fell back to easy', sanitised.source === 'easy', sanitised.source);

// ---------------------------------------------------------------------------
section('job boards');
r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
  { jobId: 'shared-id', title: 'Naukri role', company: 'NaukriCo', status: 'applied', site: 'naukri', at: now },
  { jobId: 'shared-id', title: 'Indeed role', company: 'IndeedCo', status: 'applied', site: 'indeed', at: now },
  { jobId: 'bogus-site', title: 'X', company: 'Y', status: 'applied', site: 'monster', at: now }
] } });
ok('stores rows from several boards', r.data.saved === 3, r.data);

r = await req('GET', '/api/applications', { token: refreshedToken });
const shared = r.data.records.filter((x) => x.jobId === 'shared-id');
ok('the same job id on two boards stays two rows', shared.length === 2, shared);
ok('  and each keeps its own board', new Set(shared.map((x) => x.site)).size === 2, shared.map((x) => x.site));
ok('an unknown board falls back to linkedin',
  r.data.records.find((x) => x.jobId === 'bogus-site').site === 'linkedin',
  r.data.records.find((x) => x.jobId === 'bogus-site'));
ok('records with no board set default to linkedin',
  r.data.records.find((x) => x.jobId === '2').site === 'linkedin');

r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
  { jobId: 'shared-id', title: 'Naukri role v2', company: 'NaukriCo', status: 'failed', site: 'naukri', at: now }
] } });
r = await req('GET', '/api/applications', { token: refreshedToken });
const nk = r.data.records.find((x) => x.jobId === 'shared-id' && x.site === 'naukri');
const ind2 = r.data.records.find((x) => x.jobId === 'shared-id' && x.site === 'indeed');
ok('re-syncing updates only that board’s row', nk.status === 'failed' && ind2.status === 'applied',
  { naukri: nk.status, indeed: ind2.status });

r = await req('GET', '/api/stats', { token: refreshedToken });
ok('stats break down by board', Array.isArray(r.data.bySite) && r.data.bySite.length >= 2, r.data.bySite);

section('resumes');
const pdf = Buffer.from('%PDF-1.4 pretend resume contents');
r = await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'vishal.pdf', mime: 'application/pdf', data: pdf.toString('base64'), text: 'resume text', profile: { firstName: 'Vishal' } }
});
ok('accepts a resume', r.status === 200 && !!r.data.id, r.data);
const resumeId = r.data.id;

r = await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'vishal.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + pdf.toString('base64') }
});
ok('the identical file is recognised, not stored twice', r.data.unchanged === true, r.data);

r = await req('GET', '/api/resumes', { token: refreshedToken });
ok('lists one resume', r.data.resumes.length === 1, r.data.resumes.length);
ok('the listing carries no file bytes and no extracted text',
  !('content' in r.data.resumes[0]) && !('text_content' in r.data.resumes[0]), Object.keys(r.data.resumes[0]));

const dl = await fetch(base + '/api/resumes/' + resumeId + '/file', { headers: { Authorization: 'Bearer ' + refreshedToken } });
const got = Buffer.from(await dl.arrayBuffer());
ok('downloads the exact bytes back', got.equals(pdf), got.toString());
ok('served as an attachment with nosniff',
  /attachment/.test(dl.headers.get('content-disposition')) && dl.headers.get('x-content-type-options') === 'nosniff');

r = await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'evil"\r\nX-Injected: yes.pdf', mime: 'application/pdf', data: Buffer.from('x').toString('base64') }
});
const dl2 = await fetch(base + '/api/resumes/' + r.data.id + '/file', { headers: { Authorization: 'Bearer ' + refreshedToken } });
ok('a filename cannot inject a response header',
  !dl2.headers.get('x-injected') && !/[\r\n]/.test(dl2.headers.get('content-disposition')),
  dl2.headers.get('content-disposition'));

r = await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'x.html', mime: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') }
});
const dl3 = await fetch(base + '/api/resumes/' + r.data.id + '/file', { headers: { Authorization: 'Bearer ' + refreshedToken } });
ok('an unexpected mime type is not served back as html',
  !/text\/html/.test(dl3.headers.get('content-type')), dl3.headers.get('content-type'));

r = await req('POST', '/api/resume', { token: refreshedToken, body: { filename: 'x.pdf' } });
ok('rejects an upload with no data', r.status === 400, r.status);

r = await req('GET', '/api/resumes/current/profile', { token: refreshedToken });
ok('exposes the parsed profile', r.status === 200, r.status);
ok('  with the file details the dashboard shows', 'size' in r.data && 'mime' in r.data && !!r.data.filename, r.data);

section('profile edits reach the server');
const cvBytes = Buffer.from('%PDF-1.4 profile sync resume');
await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'cv.pdf', mime: 'application/pdf', data: cvBytes.toString('base64'), text: 'x', profile: { titles: ['Engineer'] } }
});
r = await req('PUT', '/api/resumes/current/profile', { token: refreshedToken, body: { profile: { titles: ['Senior Engineer'], skills: { react: 5 } } } });
ok('a corrected profile can be saved', r.status === 200, { status: r.status, data: r.data });
r = await req('GET', '/api/resumes/current/profile', { token: refreshedToken });
ok('  and is what the dashboard then reads', r.data.profile.titles[0] === 'Senior Engineer' && r.data.profile.skills.react === 5, r.data.profile);

r = await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'cv.pdf', mime: 'application/pdf', data: cvBytes.toString('base64'), text: 'x', profile: { titles: ['Staff Engineer'] } }
});
ok('re-sending the same file is not stored twice', r.data.unchanged === true, r.data);
r = await req('GET', '/api/resumes/current/profile', { token: refreshedToken });
ok('  but does bring its profile up to date', r.data.profile.titles[0] === 'Staff Engineer', r.data.profile);

for (const bad of [null, 'text', [1, 2]]) {
  r = await req('PUT', '/api/resumes/current/profile', { token: refreshedToken, body: { profile: bad } });
  ok('rejects profile ' + JSON.stringify(bad), r.status === 400, r.status);
}
r = await req('PUT', '/api/resumes/current/profile', { token: refreshedToken, body: { profile: { notes: 'x'.repeat(70000) } } });
ok('rejects an oversized profile', r.status === 413, r.status);
r = await req('PUT', '/api/resumes/current/profile', { body: { profile: {} } });
ok('saving a profile needs a sign-in', r.status === 401, r.status);

// ---------------------------------------------------------------------------
section('match ratings (what the ranker is checked against)');
const posting = 'Requirements\n- 3+ years of Java and Spring Boot.';
r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
  { jobId: 'naukri:r1', title: 'Java Developer', company: 'RateCo', status: 'applied', score: 81, site: 'naukri', at: now, description: posting },
  { jobId: 'naukri:r2', title: 'Duck Creek Developer', company: 'RateCo', status: 'applied', score: 64, site: 'naukri', at: now - 10, description: 'Duck Creek Policy' },
  { jobId: 'naukri:r3', title: 'Unrated', company: 'RateCo', status: 'skipped', score: 40, site: 'naukri', at: now - 20, description: 'x' }
] } });
ok('applications can carry the posting text', r.status === 200 && r.data.saved === 3, r.data);

r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:r1', site: 'naukri', feedback: 'good' } });
ok('rates a job as a good match', r.status === 200 && r.data.feedback === 'good', r.data);
r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:r2', site: 'naukri', feedback: 'bad' } });
ok('and another as a bad one', r.status === 200, r.data);
r = await req('GET', '/api/applications', { token: refreshedToken });
ok('the list shows each rating', r.data.records.find((x) => x.jobId === 'naukri:r1').feedback === 'good'
  && r.data.records.find((x) => x.jobId === 'naukri:r3').feedback === null, r.data.records.filter((x) => x.company === 'RateCo'));
ok('  but not the posting text, which would make the list heavy', !('description' in r.data.records[0]), Object.keys(r.data.records[0]));

r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:r1', site: 'naukri', feedback: 'meh' } });
ok('rejects a rating that is not good, bad or null', r.status === 400, r.status);
r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { site: 'naukri', feedback: 'good' } });
ok('rejects a rating with no job', r.status === 400, r.status);
r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:r1', site: 'indeed', feedback: 'good' } });
ok('the board is part of which job is meant', r.status === 404, r.status);
r = await req('PUT', '/api/feedback', { body: { jobId: 'naukri:r1', site: 'naukri', feedback: 'good' } });
ok('rating needs a sign-in', r.status === 401, r.status);

// The extension re-sends records from its own history (which keeps no
// posting text) and re-records a job it tries again.
await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
  { jobId: 'naukri:r1', title: 'Java Developer', company: 'RateCo', status: 'failed', score: 81, site: 'naukri', at: now }
] } });
r = await req('GET', '/api/feedback/export', { token: refreshedToken });
const r1 = r.data.jobs.find((x) => x.jobId === 'naukri:r1');
ok('a re-sent record without text keeps the saved posting', r1 && r1.description === posting, r1);
ok('  and keeps its rating', r1 && r1.feedback === 'good' && r1.status === 'failed', r1);

ok('the export holds only rated jobs', r.status === 200 && r.data.jobs.length === 2
  && !r.data.jobs.some((x) => x.jobId === 'naukri:r3'), r.data.jobs.map((x) => x.jobId));
ok('  with what the ranker needs to score them again',
  ['title', 'company', 'location', 'description', 'score', 'feedback', 'site'].every((k) => k in r1), r1 && Object.keys(r1));
ok('  and the resume and threshold they are ranked against',
  r.data.resume && typeof r.data.resume.text === 'string' && typeof r.data.threshold === 'number', { resume: !!r.data.resume, threshold: r.data.threshold });
ok('  offered as a download', /attachment/.test(r.headers.get('content-disposition') || ''), r.headers.get('content-disposition'));

r = await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
  { jobId: 'naukri:long', title: 'Long', company: 'RateCo', status: 'skipped', site: 'naukri', at: now, description: 'y'.repeat(20000) }
] } });
await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:long', site: 'naukri', feedback: 'bad' } });
r = await req('GET', '/api/feedback/export', { token: refreshedToken });
ok('a posting is kept to the length the ranker reads', r.data.jobs.find((x) => x.jobId === 'naukri:long').description.length === 12000);

r = await req('PUT', '/api/feedback', { token: refreshedToken, body: { jobId: 'naukri:r2', site: 'naukri', feedback: null } });
r = await req('GET', '/api/feedback/export', { token: refreshedToken });
ok('a rating can be taken back', r.data.jobs.every((x) => x.jobId !== 'naukri:r2'), r.data.jobs.map((x) => x.jobId));

r = await req('POST', '/api/auth/register', { body: { email: 'rater@example.com', password: PASSWORD, client: 'extension' } });
const tokenRater = r.data.token;
r = await req('PUT', '/api/feedback', { token: tokenRater, body: { jobId: 'naukri:r1', site: 'naukri', feedback: 'bad' } });
ok("cannot rate another account's application", r.status === 404, r.status);
r = await req('GET', '/api/feedback/export', { token: tokenRater });
ok("and exports none of another account's ratings", r.data.jobs.length === 0 && r.data.resume === null, r.data);
r = await req('GET', '/api/feedback/export', { token: refreshedToken });
ok('  while the owner still has theirs', r.data.jobs.find((x) => x.jobId === 'naukri:r1').feedback === 'good');

// ---------------------------------------------------------------------------
section('one account cannot reach another');
r = await req('POST', '/api/auth/register', { body: { email: 'b@example.com', password: PASSWORD, client: 'extension' } });
const tokenB = r.data.token;

r = await req('GET', '/api/applications', { token: tokenB });
ok('a new account starts empty', r.data.records.length === 0, r.data.records.length);
r = await req('GET', '/api/resumes', { token: tokenB });
ok('and sees no resumes', r.data.resumes.length === 0, r.data.resumes.length);
r = await req('GET', '/api/resumes/' + resumeId + '/file', { token: tokenB });
ok("cannot download another account's resume by id", r.status === 404, r.status);

await req('POST', '/api/applications', { token: tokenB, body: { records: [{ jobId: '1', title: 'B job', company: 'BCo', status: 'applied', at: now }] } });
r = await req('GET', '/api/applications', { token: refreshedToken });
ok('the same jobId under two accounts stays separate',
  r.data.records.find((x) => x.jobId === '1').company === 'Acme', r.data.records.find((x) => x.jobId === '1'));

const resumesBefore = (await req('GET', '/api/resumes', { token: refreshedToken })).data.resumes.length;
await req('DELETE', '/api/resumes/' + resumeId, { token: tokenB });
r = await req('GET', '/api/resumes', { token: refreshedToken });
ok("cannot delete another account's resume", r.data.resumes.length === resumesBefore, { before: resumesBefore, after: r.data.resumes.length });

// Counted rather than hardcoded, so adding cases above cannot quietly break it.
const beforeClear = (await req('GET', '/api/applications', { token: refreshedToken })).data.records.length;
r = await req('DELETE', '/api/applications?confirm=yes', { token: tokenB });
r = await req('GET', '/api/applications', { token: refreshedToken });
ok("clearing one account's history leaves the other intact",
  r.data.records.length === beforeClear && beforeClear > 0, { before: beforeClear, after: r.data.records.length });
r = await req('GET', '/api/applications', { token: tokenB });
ok('  and does clear the account that asked', r.data.records.length === 0, r.data.records.length);

section('settings (the ranking threshold lives on the account)');
r = await req('GET', '/api/settings', { token: refreshedToken });
ok('an account starts at the default threshold', r.status === 200 && r.data.minScore === 60, r.data);
r = await req('PUT', '/api/settings', { token: refreshedToken, body: { minScore: 75 } });
ok('the threshold can be changed', r.status === 200 && r.data.minScore === 75, r.data);
r = await req('GET', '/api/settings', { token: refreshedToken });
ok('  and the change is stored', r.data.minScore === 75, r.data);
for (const bad of [150, -1, 12.5, 'abc', null]) {
  r = await req('PUT', '/api/settings', { token: refreshedToken, body: { minScore: bad } });
  ok('rejects minScore ' + JSON.stringify(bad), r.status === 400, r.status);
}
r = await req('PUT', '/api/settings', { token: refreshedToken, body: {} });
ok('an empty update is rejected', r.status === 400, r.status);
r = await req('GET', '/api/settings', { token: tokenB });
ok("one account's threshold does not leak into another's", r.data.minScore === 60, r.data);
r = await req('PUT', '/api/settings', { body: { minScore: 10 } });
ok('changing settings needs a sign-in', r.status === 401, r.status);

section('ranking');
await req('POST', '/api/resume', {
  token: refreshedToken,
  body: { filename: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 ranking resume').toString('base64'),
    text: 'Software engineer, 4 years of React', profile: { defaultYears: 3 } }
});
const jobsToRank = [
  { id: 'j1', title: 'A good job', description: 'React' },
  { id: 'j2', title: 'A poor job', description: 'COBOL' }
];
r = await req('POST', '/api/rank', { body: { jobs: jobsToRank } });
ok('ranking needs a sign-in', r.status === 401, r.status);
r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: jobsToRank } });
ok('ranks a batch', r.status === 200 && r.data.results.length === 2, r.data);
ok("  using the account's threshold", r.data.threshold === 75 && stubRanker.last.threshold === 75, stubRanker.last && stubRanker.last.threshold);
ok('  and returns the verdicts', r.data.results[0].verdict === 'apply' && r.data.results[1].verdict === 'skip', r.data.results);
ok('  filling in the resume from the stored copy', !!stubRanker.last.candidate.resume_text, stubRanker.last.candidate);
ok('  signed with the shared secret (the stub rejects anything else)', r.status === 200);

r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: jobsToRank, resumeText: 'fresh text', profile: { defaultYears: 4 } } });
ok('a resume and profile sent with the request win over the stored ones',
  stubRanker.last.candidate.resume_text === 'fresh text' && stubRanker.last.candidate.profile.defaultYears === 4, stubRanker.last.candidate);

r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: [] } });
ok('an empty batch is rejected', r.status === 400, r.status);
r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })) } });
ok('an oversized batch is rejected', r.status === 413, r.status);
r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: [{ id: 'x', title: 't', description: 'd'.repeat(60000) }] } });
ok('an overlong description is clipped, not refused', r.status === 200 && stubRanker.last.jobs[0].description.length === 40000, r.status);
r = await req('POST', '/api/rank', { token: tokenB, body: { jobs: jobsToRank } });
ok('an account with no resume is told to upload one', r.status === 409, { status: r.status, data: r.data });

stubRanker.fail = true;
r = await req('POST', '/api/rank', { token: refreshedToken, body: { jobs: jobsToRank } });
ok('a broken ranker is reported as 502 with a readable message', r.status === 502 && /ranking service/i.test(r.data.error), { status: r.status, data: r.data });
stubRanker.fail = false;

r = await req('OPTIONS', '/api/settings', { origin: 'https://app.example.com' });
ok('preflight allows PUT', /PUT/.test(r.headers.get('access-control-allow-methods') || ''), r.headers.get('access-control-allow-methods'));

section('config (every setting lives on the account)');
r = await req('GET', '/api/config', { token: tokenB });
ok('a new account starts with empty settings and the default threshold',
  r.status === 200 && r.data.config.match.minScore === 60 && Array.isArray(r.data.unknownQuestions), r.data);

r = await req('PATCH', '/api/config', { token: tokenB, body: { config: {
  search: { keywords: 'react developer', location: 'Bengaluru' },
  safety: { dryRun: true, maxPerDay: 40 },
  sites: { linkedin: { enabled: true, maxPerRun: 15 } },
  answers: { rules: [{ id: 'u1', pattern: 'notice', answer: '30', enabled: true }] },
  match: { minScore: 70, titleExclude: ['intern'] }
} } });
ok('the web app saves settings', r.status === 200 && r.data.config.search.keywords === 'react developer', r.data);
ok('  the threshold goes to its own column', r.data.config.match.minScore === 70, r.data.config.match);
r = await req('GET', '/api/settings', { token: tokenB });
ok('  so the ranker and the old settings endpoint see it too', r.data.minScore === 70, r.data);

r = await req('PATCH', '/api/config', { token: tokenB, body: { config: { safety: { dryRun: false } } } });
ok('one switch can be flipped without losing the rest of its section',
  r.data.config.safety.dryRun === false && r.data.config.safety.maxPerDay === 40, r.data.config.safety);
ok('  or any other section', r.data.config.search.keywords === 'react developer' && r.data.config.match.minScore === 70, r.data.config);

r = await req('PATCH', '/api/config', { token: tokenB, body: { config: { answers: { unknownQuestions: [{ label: 'x' }] }, schedule: { time: '09:30', lastRunDay: 'Mon' } } } });
ok('per-browser state and reported questions cannot be written through config',
  !('unknownQuestions' in r.data.config.answers) && !('lastRunDay' in r.data.config.schedule) && r.data.config.schedule.time === '09:30', r.data.config);

for (const [name, body] of [
  ['a non-object', { config: 'x' }],
  ['an unknown section', { config: { hacks: {} } }],
  ['a section that is not an object', { config: { search: ['a'] } }],
  ['a bad threshold', { config: { match: { minScore: 101 } } }],
  ['a string threshold', { config: { match: { minScore: '70' } } }]
]) {
  r = await req('PATCH', '/api/config', { token: tokenB, body });
  ok('rejects ' + name, r.status === 400, { status: r.status, data: r.data });
}
r = await req('PATCH', '/api/config', { token: tokenB, body: { config: { portal: { coverLetter: 'x'.repeat(300000) } } } });
ok('rejects oversized settings', r.status === 413, r.status);
r = await req('GET', '/api/config', { token: refreshedToken });
ok("one account's settings never leak into another's", r.data.config.search === undefined, r.data.config.search);
r = await req('PATCH', '/api/config', { body: { config: { search: {} } } });
ok('changing settings needs a sign-in', r.status === 401, r.status);
r = await req('OPTIONS', '/api/config', { origin: 'https://app.example.com' });
ok('preflight allows PATCH', /PATCH/.test(r.headers.get('access-control-allow-methods') || ''), r.headers.get('access-control-allow-methods'));

section('questions a run could not answer');
r = await req('POST', '/api/unknown-questions', { token: tokenB, body: { questions: [
  { label: 'Are you willing to work weekends?', kind: 'radio', options: ['Yes', 'No'], job: 'Engineer @ Acme', at: 1 },
  { label: 'Are you willing to work weekends?', kind: 'radio' },
  { label: '  ' }
] } });
ok('the extension reports them, once each', r.status === 200 && r.data.unknownQuestions.length === 1, r.data);
r = await req('GET', '/api/config', { token: tokenB });
ok('  and the web app reads them with the settings', r.data.unknownQuestions[0].options[1] === 'No', r.data.unknownQuestions);
await req('POST', '/api/unknown-questions', { token: tokenB, body: { questions: [{ label: 'Second question?' }] } });
r = await req('DELETE', '/api/unknown-questions?label=' + encodeURIComponent('Are you willing to work weekends?'), { token: tokenB });
ok('one can be dismissed', r.data.unknownQuestions.length === 1 && r.data.unknownQuestions[0].label === 'Second question?', r.data);
r = await req('DELETE', '/api/unknown-questions', { token: tokenB });
ok('or all of them', r.data.unknownQuestions.length === 0, r.data);
r = await req('POST', '/api/unknown-questions', { token: tokenB, body: { questions: Array.from({ length: 21 }, (_, i) => ({ label: 'q' + i })) } });
ok('a flood is refused', r.status === 400, r.status);

section('the extension downloads the resume from the account');
r = await req('GET', '/api/resumes/current', { token: refreshedToken });
ok('with its text, profile and hash', r.status === 200 && typeof r.data.text === 'string' && !!r.data.sha256 && 'profile' in r.data, Object.keys(r.data));
r = await req('GET', '/api/resumes/current', { token: tokenB });
ok('an account without one gets 404', r.status === 404, r.status);

section('run reports by email');
{
  const { outbox } = await import('../src/mail.js');
  const { runReport } = await import('../src/report.js');
  r = await req('POST', '/api/auth/register', { body: { email: 'reporter@example.com', password: PASSWORD, client: 'extension' } });
  const tokenR = r.data.token;
  const startedAt = Date.now() - 60 * 60 * 1000;
  const endedAt = Date.now();
  const report = (body, token = tokenR) => req('POST', '/api/runs/report', { token, body: { startedAt, endedAt, tz: 'Asia/Kolkata', ending: 'maxPerRun', ...body } });

  r = await report({});
  ok('a run that recorded nothing sends nothing', r.status === 200 && r.data.sent === false && outbox.length === 0, r.data);

  await req('POST', '/api/applications', { token: tokenR, body: { records: [
    { jobId: 'a1', title: 'Backend Engineer', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/a1/', status: 'applied', score: 81, site: 'linkedin', at: startedAt + 1000 },
    { jobId: 'n1', title: 'Platform Engineer', company: 'Globex', url: 'https://boards.greenhouse.io/globex/jobs/1', status: 'needs_manual', reason: 'the form asks for a work sample', score: 74, site: 'linkedin', at: startedAt + 2000 },
    { jobId: 'f1', title: '<script>alert(1)</script>Ops', company: 'Initech', url: 'javascript:alert(1)', status: 'failed', reason: 'Submit clicked but the form did not close', site: 'naukri', at: startedAt + 3000 },
    { jobId: 's1', title: 'Junior Tester', company: 'Hooli', status: 'skipped', reason: 'ranked 30 skip', site: 'linkedin', at: startedAt + 4000 },
    { jobId: 'old', title: 'Old Job From Yesterday', company: 'Past', status: 'applied', site: 'linkedin', at: startedAt - 24 * 3600 * 1000 }
  ] } });
  await req('POST', '/api/applications', { token: refreshedToken, body: { records: [
    { jobId: 'theirs', title: 'Somebody Elses Job', company: 'Other', status: 'applied', site: 'linkedin', at: startedAt + 5000 }
  ] } });

  r = await report({});
  const mail = outbox[outbox.length - 1] || {};
  ok('the end of a run emails a report', r.status === 200 && r.data.sent === true && outbox.length === 1, r.data);
  ok('  to the account\'s own address', mail.to === 'reporter@example.com', mail.to);
  ok('  with the counts', r.data.counts && r.data.counts.applied === 1 && r.data.counts.needsYou === 1 && r.data.counts.failed === 1 && r.data.counts.skipped === 1, r.data.counts);
  ok('  and a subject that says what happened', mail.subject === 'jobDo: applied to 1 job, 1 needs you', mail.subject);
  ok('  listing each job with a link to it',
    /href="https:\/\/www\.linkedin\.com\/jobs\/view\/a1\/"[^>]*>Backend Engineer</.test(mail.html) && mail.html.includes('The form asks for a work sample'), mail.html.length);
  ok('  in the account\'s time zone, with how the run ended',
    mail.html.includes(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(startedAt)) &&
    mail.html.includes('reached its limit for one run'), mail.text.split('\n')[1]);
  ok('  only the jobs from that run', !mail.html.includes('Old Job From Yesterday'));
  ok('  and never another account\'s', !mail.html.includes('Somebody Elses Job') && !mail.text.includes('Somebody Elses Job'));
  ok('  page text is escaped and only web links are kept',
    !mail.html.includes('<script>') && mail.html.includes('&lt;script&gt;') && !/javascript:/i.test(mail.html), null);
  ok('  with a plain-text copy', mail.text.includes('Backend Engineer at Acme') && mail.text.includes('https://www.linkedin.com/jobs/view/a1/'), mail.text);

  const before = outbox.length;
  r = await report({ ending: '<b>pwned</b>', tz: 'Not/AZone' });
  ok('an unknown ending or time zone is ignored, not printed',
    r.data.sent === true && !outbox[outbox.length - 1].html.includes('pwned') && outbox[outbox.length - 1].html.includes(' UTC'), outbox.length - before);

  for (const [name, body] of [
    ['no start time', { startedAt: undefined }],
    ['a start after the end', { startedAt: endedAt + 1000 }],
    ['a start that is not a number', { startedAt: 'yesterday' }]
  ]) {
    r = await report(body);
    ok('rejects ' + name, r.status === 400, { status: r.status, data: r.data });
  }
  r = await req('POST', '/api/runs/report', { body: { startedAt, endedAt } });
  ok('a report needs a sign-in', r.status === 401, r.status);

  r = await req('PATCH', '/api/config', { token: tokenR, body: { config: { notify: { emailReport: false } } } });
  ok('reports can be switched off in settings', r.status === 200 && r.data.config.notify.emailReport === false, r.data.config.notify);
  const count = outbox.length;
  r = await report({});
  ok('  and then none is sent', r.data.sent === false && outbox.length === count && /switched off/.test(r.data.reason), r.data);
  await req('PATCH', '/api/config', { token: tokenR, body: { config: { notify: { emailReport: true } } } });

  for (let i = 0; i < 12; i++) r = await report({});
  ok('a flood of reports is cut off', r.status === 429, r.status);
  resetRateLimits();

  const dry = runReport({
    records: [{ title: 'A', status: 'dry_run', site: 'linkedin' }, { title: 'B', status: 'dry_run', site: 'indeed' }],
    startedAt, endedAt, tz: 'UTC', ending: 'done'
  });
  ok('a dry run says so', dry.subject === 'jobDo dry run: 2 jobs ready to send' && dry.html.includes('Ready to send'), dry.subject);
}

section('your job list (links applied to before the job boards)');
{
  r = await req('POST', '/api/auth/register', { body: { email: 'lister@example.com', password: PASSWORD, client: 'extension' } });
  const tokenL = r.data.token;
  r = await req('GET', '/api/queue', { token: tokenL });
  ok('a new account has an empty list', r.status === 200 && r.data.items.length === 0 && r.data.counts.pending === 0 && r.data.counts.done === 0, r.data);

  r = await req('POST', '/api/queue', { token: tokenL, body: { items: [
    { url: 'https://www.linkedin.com/jobs/view/123456/', title: 'Backend Engineer', company: 'Acme' },
    { url: '  https://jobs.lever.co/globex/abc  ', title: 'x'.repeat(400) },
    'https://boards.greenhouse.io/initech/jobs/9#app',
    { url: 'https://jobs.lever.co/globex/abc' },
    { url: 'javascript:alert(1)' },
    { url: 'not a link' },
    { url: 'ftp://example.com/job' },
    42
  ] } });
  ok('links are added', r.status === 200 && r.data.added === 3, r.data);
  ok('  repeats and non-links are counted, not added', r.data.duplicates === 1 && r.data.invalid === 4, r.data);
  ok('  and the counts come back', r.data.counts.pending === 3, r.data.counts);

  r = await req('GET', '/api/queue?status=pending', { token: tokenL });
  const items = r.data.items;
  ok('the list keeps the order they were added in', items.map((i) => i.url).join(' ') ===
    'https://www.linkedin.com/jobs/view/123456/ https://jobs.lever.co/globex/abc https://boards.greenhouse.io/initech/jobs/9', items.map((i) => i.url));
  ok('  trimmed, without #fragments, and with long text cut', items[1].title.length === 300 && items[0].company === 'Acme' && items[0].origin === 'list', items[1].title.length);

  r = await req('POST', '/api/queue', { token: tokenL, body: { items: ['https://www.linkedin.com/jobs/view/123456/'] } });
  ok('adding a link that is already there adds nothing', r.data.added === 0 && r.data.duplicates === 1 && r.data.counts.pending === 3, r.data);

  r = await req('PATCH', '/api/queue/' + items[0].id, { token: tokenL, body: { status: 'done', result: 'applied', reason: 'submitted' } });
  ok('the extension marks one done', r.status === 200 && r.data.item.status === 'done' && r.data.item.result === 'applied' && r.data.item.doneAt > 0, r.data);
  r = await req('GET', '/api/queue?status=pending', { token: tokenL });
  ok('  so it is no longer waiting', r.data.items.length === 2 && r.data.counts.done === 1, r.data.counts);
  r = await req('GET', '/api/queue?status=done', { token: tokenL });
  ok('  and shows among the done ones', r.data.items.length === 1 && r.data.items[0].reason === 'submitted', r.data.items);
  r = await req('PATCH', '/api/queue/' + items[0].id, { token: tokenL, body: { status: 'pending' } });
  ok('it can be put back to try again', r.status === 200 && r.data.item.status === 'pending' && r.data.item.result === '' && r.data.item.doneAt === null, r.data);

  for (const [name, body] of [
    ['an unknown result', { status: 'done', result: 'hacked' }],
    ['an unknown status', { status: 'deleted' }],
    ['no status', {}]
  ]) {
    r = await req('PATCH', '/api/queue/' + items[1].id, { token: tokenL, body });
    ok('rejects ' + name, r.status === 400, { status: r.status, data: r.data });
  }
  r = await req('PATCH', '/api/queue/not-a-uuid', { token: tokenL, body: { status: 'pending' } });
  ok('an id that is not one is simply not found', r.status === 404, r.status);

  r = await req('GET', '/api/queue', { token: refreshedToken });
  ok("another account never sees it", r.data.items.length === 0, r.data);
  r = await req('PATCH', '/api/queue/' + items[1].id, { token: refreshedToken, body: { status: 'done', result: 'applied' } });
  ok('  or changes it', r.status === 404, r.status);
  r = await req('DELETE', '/api/queue/' + items[1].id, { token: refreshedToken });
  ok('  or removes it', r.status === 404, r.status);
  r = await req('DELETE', '/api/queue?status=all', { token: refreshedToken });
  ok('  even by clearing its own list', r.data.removed === 0, r.data);

  r = await req('DELETE', '/api/queue/' + items[1].id, { token: tokenL });
  ok('one can be removed', r.status === 200 && r.data.counts.pending === 2, r.data);
  await req('PATCH', '/api/queue/' + items[2].id, { token: tokenL, body: { status: 'done', result: 'failed', reason: 'x' } });
  r = await req('DELETE', '/api/queue?status=done', { token: tokenL });
  ok('the finished ones can be cleared together', r.data.removed === 1 && r.data.counts.pending === 1 && r.data.counts.done === 0, r.data);
  r = await req('DELETE', '/api/queue', { token: tokenL });
  ok('clearing needs to say what', r.status === 400, r.status);

  r = await req('POST', '/api/queue', { token: tokenL, body: { items: Array.from({ length: 1001 }, (_, i) => 'https://example.com/' + i) } });
  ok('too many links at once is refused', r.status === 413, r.status);
  r = await req('POST', '/api/queue', { token: tokenL, body: { items: [] } });
  ok('so is an empty list', r.status === 400, r.status);
  r = await req('GET', '/api/queue');
  ok('the list needs a sign-in', r.status === 401, r.status);

  r = await req('POST', '/api/applications', { token: tokenL, body: { records: [
    { jobId: items[1].id, title: 'From the list', status: 'applied', site: 'direct', at: Date.now() }
  ] } });
  r = await req('GET', '/api/applications', { token: tokenL });
  ok("applications on a company's own site are kept as 'direct'", r.data.records[0] && r.data.records[0].site === 'direct', r.data.records);
}

section('favourite companies (read on a schedule, matches go on the job list)');
{
  const { outbox } = await import('../src/mail.js');
  // Stand-ins for the careers boards' public listings. Anything else goes to the real fetch.
  const day = 86400000;
  const gh = (id, title, place, ago) => ({
    id, title, absolute_url: 'https://boards.greenhouse.io/acme/jobs/' + id, location: { name: place },
    content: '&lt;p&gt;Java &amp;amp; Spring for ' + title + '&lt;/p&gt;', first_published: new Date(Date.now() - ago * day).toISOString()
  });
  const stub = {
    fail: new Set(),
    greenhouse: { acme: { name: 'Acme Corp', jobs: [
      gh(1, 'Good Backend Engineer', 'Bengaluru', 1),
      gh(2, 'Backend Engineer', 'Bengaluru', 2),
      gh(3, 'Sales Manager', 'Bengaluru', 1),
      gh(4, 'Good Back-end Engineer II', 'Berlin', 1)
    ] } },
    lever: { globex: [{ id: 'g-1', text: 'Good Senior Backend Engineer', hostedUrl: 'https://jobs.lever.co/globex/g-1',
      categories: { location: 'Remote' }, descriptionPlain: 'Build APIs.', lists: [{ text: 'Requirements', content: '<li>Java</li>' }], createdAt: Date.now() - day }] },
    workday: { postings: [{ title: 'Good Backend Developer', externalPath: '/job/Bengaluru/Good-Backend-Developer_JR1', locationsText: 'Bengaluru', postedOn: 'Posted Today' }] }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname === 'boards-api.greenhouse.io') {
      if (stub.fail.has('greenhouse')) return json({}, 500);
      const m = /^\/v1\/boards\/([^/]+)(\/jobs)?$/.exec(u.pathname);
      const b = m && stub.greenhouse[m[1]];
      if (!b) return json({ status: 404 }, 404);
      return m[2] ? json({ jobs: b.jobs }) : json({ name: b.name, content: '' });
    }
    if (u.hostname === 'api.lever.co') {
      if (stub.fail.has('lever')) return json({}, 500);
      const b = stub.lever[u.pathname.split('/')[3]];
      return b ? json(b) : json({ ok: false, error: 'Document not found' }, 404);
    }
    if (u.hostname === 'api.ashbyhq.com') return new Response('Not Found', { status: 404 });
    if (u.hostname === 'nvidia.wd5.myworkdayjobs.com') {
      if (u.pathname === '/wday/cxs/nvidia/External/jobs') return json({ total: stub.workday.postings.length, jobPostings: stub.workday.postings });
      if (u.pathname.startsWith('/wday/cxs/nvidia/External/job/')) {
        return json({ jobPostingInfo: { jobDescription: '<p>Backend work in Java.</p>', externalUrl: 'https://nvidia.wd5.myworkdayjobs.com/External' + u.pathname.slice('/wday/cxs/nvidia/External'.length), location: 'Bengaluru' } });
      }
      return json({}, 404);
    }
    return realFetch(url, opts);
  };

  r = await req('POST', '/api/auth/register', { body: { email: 'fan@example.com', password: PASSWORD, client: 'extension' } });
  const tokenF = r.data.token;
  r = await req('GET', '/api/companies', { token: tokenF });
  ok('an account starts with no companies, switched off, every 24 hours',
    r.status === 200 && r.data.watch.companies.length === 0 && r.data.watch.enabled === false && r.data.watch.intervalHours === 24 && r.data.scheduler === true, r.data);

  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'Acme Corp' } });
  ok('a company is found by name on the board that lists it', r.status === 200 && r.data.found.length === 1 &&
    r.data.found[0].ats === 'greenhouse' && r.data.found[0].slug === 'acme' && r.data.found[0].name === 'Acme Corp' && r.data.found[0].jobs === 4, r.data);
  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'https://jobs.lever.co/globex/g-1' } });
  ok('  or by the address of its careers page', r.data.found.length === 1 && r.data.found[0].ats === 'lever' && r.data.found[0].slug === 'globex', r.data);
  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'https://nvidia.wd5.myworkdayjobs.com/en-US/External/details/x' } });
  ok('  Workday sites by their address', r.data.found.length === 1 && r.data.found[0].ats === 'workday' && r.data.found[0].slug === 'nvidia.wd5/External', r.data);
  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'Google' } });
  ok('a company with its own careers site says it cannot be read', r.data.found.length === 0 && /own careers site/.test(r.data.hint), r.data);
  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'https://careers.example.com/jobs' } });
  ok('  as does a careers site on another system', r.data.found.length === 0 && /not one of the systems/.test(r.data.hint), r.data);
  r = await req('POST', '/api/companies/lookup', { token: tokenF, body: { query: 'Nosuchcompany' } });
  ok('  and a name found nowhere says what to do instead', r.data.found.length === 0 && /Paste the address/.test(r.data.hint), r.data);

  const companies = [
    { name: 'Acme Corp', ats: 'greenhouse', slug: 'acme' },
    { name: 'Globex', ats: 'lever', slug: 'globex' },
    { name: 'NVIDIA', ats: 'workday', slug: 'nvidia.wd5/External' }
  ];
  for (const [name, body] of [
    ['an unknown careers board', { companies: [{ name: 'X', ats: 'monster', slug: 'x' }] }],
    ['a slug that is not one', { companies: [{ name: 'X', ats: 'lever', slug: '../../admin' }] }],
    ['too many companies', { companies: Array.from({ length: 31 }, (_, i) => ({ name: 'c' + i, ats: 'lever', slug: 'c' + i })) }],
    ['an interval of 0 hours', { intervalHours: 0 }],
    ['an interval over a week', { intervalHours: 169 }],
    ['an interval as text', { intervalHours: '24' }],
    ['nothing at all', {}]
  ]) {
    r = await req('PUT', '/api/companies', { token: tokenF, body });
    ok('rejects ' + name, r.status === 400, { status: r.status, data: r.data });
  }
  r = await req('PUT', '/api/companies', { token: tokenF, body: { companies: [...companies, companies[0]], intervalHours: 12, locations: 'Bengaluru, Remote', tz: 'Asia/Kolkata' } });
  ok('the companies, interval and places are saved, without repeats',
    r.status === 200 && r.data.watch.companies.length === 3 && r.data.watch.intervalHours === 12 && r.data.watch.locations === 'Bengaluru, Remote' && r.data.watch.tz === 'Asia/Kolkata', r.data.watch);
  ok('  and stay switched off until switched on', r.data.watch.enabled === false && r.data.watch.nextRunAt === null, r.data.watch);

  r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('a check without a resume says why', r.status === 200 && /no resume/.test(r.data.result.error) && r.data.added.length === 0, r.data.result);
  await req('POST', '/api/resume', { token: tokenF, body: {
    filename: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF fan').toString('base64'),
    text: 'Backend engineer. Java, Spring.', profile: { titles: ['Senior Backend Engineer'] }
  } });

  r = await req('POST', '/api/companies/check', { token: tokenF });
  const res1 = r.data.result;
  const addedTitles = (r.data.added || []).map((a) => a.title).sort();
  ok('"Check now" puts the good matches on the job list',
    r.status === 200 && addedTitles.join('|') === 'Good Backend Developer|Good Backend Engineer|Good Senior Backend Engineer', { status: r.status, addedTitles, res1 });
  ok('  ranking only postings with a target title, in a wanted place',
    res1.ranked === 4 && res1.companies[0].postings === 4 && res1.companies[0].added === 1, res1);
  ok('  sending the ranker the posting text and the resume',
    /Java & Spring/.test(JSON.stringify(stubRanker.last.jobs)) && stubRanker.last.candidate.resume_text.startsWith('Backend engineer'), stubRanker.last && stubRanker.last.jobs.map((j) => j.title));
  ok('  Workday postings get their text and address from the posting itself',
    (r.data.added || []).some((a) => a.url === 'https://nvidia.wd5.myworkdayjobs.com/External/job/Bengaluru/Good-Backend-Developer_JR1'), r.data.added);
  r = await req('GET', '/api/queue?status=pending', { token: tokenF });
  const fromCompanies = r.data.items.filter((i) => i.origin === 'company');
  ok('the job list has them, marked as found at a company, with their score',
    fromCompanies.length === 3 && fromCompanies.every((i) => i.score === 80 && /^ranked 80/.test(i.note)) && fromCompanies.some((i) => i.company === 'Acme Corp' && i.location === 'Bengaluru'), r.data.items);
  r = await req('GET', '/api/companies', { token: tokenF });
  ok('the last check is kept with the settings', r.data.watch.lastRunAt > 0 && r.data.watch.lastResult.added === 3, r.data.watch);

  r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('a second check considers only postings it has not seen', r.data.added.length === 0 && r.data.result.ranked === 0 &&
    r.data.result.companies.every((c) => c.fresh === 0), r.data.result);

  stub.greenhouse.acme.jobs.push(gh(5, 'Good Backend Engineer, Payments', 'Remote', 0));
  r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('  so a new posting is all it adds', r.data.added.length === 1 && r.data.added[0].title === 'Good Backend Engineer, Payments' && r.data.result.ranked === 1, r.data);

  stub.fail.add('lever');
  stub.greenhouse.acme.jobs.push(gh(6, 'Good Backend Engineer, Risk', 'Bengaluru', 0));
  stubRanker.fail = true;
  r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('a board that cannot be read is reported, and the rest still checked',
    /answered 500/.test(r.data.result.companies[1].error) && r.data.result.companies[0].fresh === 1, r.data.result.companies);
  ok('  and a ranker that is down adds nothing', /Ranking stopped/.test(r.data.result.error) && r.data.added.length === 0, r.data.result);
  stubRanker.fail = false;
  stub.fail.delete('lever');
  resetRateLimits();
  r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('  but leaves those postings to be ranked next time', r.data.added.length === 1 && r.data.added[0].title === 'Good Backend Engineer, Risk', r.data);

  for (let i = 0; i < 6; i++) r = await req('POST', '/api/companies/check', { token: tokenF });
  ok('"Check now" cannot be pressed without end', r.status === 429, r.status);
  resetRateLimits();

  // ---- the scheduler
  r = await req('POST', '/api/cron/companies', { body: {} });
  ok('the scheduled check needs the cron secret', r.status === 401, r.status);
  const cron = (secret) => fetch(base + '/api/cron/companies', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: '{}' })
    .then(async (x) => ({ status: x.status, data: await x.json() }));
  r = await cron('wrong-secret-wrong-secret-wrong');
  ok('  the right one', r.status === 401, r.status);
  r = await cron(process.env.CRON_SECRET);
  ok('  and with it, does nothing while no account has it switched on', r.status === 200 && r.data.due === 0, r.data);

  r = await req('POST', '/api/auth/register', { body: { email: 'fan2@example.com', password: PASSWORD, client: 'extension' } });
  const tokenG = r.data.token;
  await req('POST', '/api/resume', { token: tokenG, body: {
    filename: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF fan2').toString('base64'),
    text: 'Backend engineer.', profile: { titles: ['Backend Engineer'] }
  } });
  r = await req('PUT', '/api/companies', { token: tokenG, body: { companies: [companies[0]], enabled: true, intervalHours: 6, tz: 'Asia/Kolkata' } });
  ok('switching it on makes the first check due straight away', r.data.watch.enabled && r.data.watch.nextRunAt <= Date.now(), r.data.watch);
  await req('PUT', '/api/companies', { token: tokenF, body: { enabled: true } });

  const sentBefore = outbox.length;
  r = await cron(process.env.CRON_SECRET);
  ok('the scheduler checks every account that is due', r.status === 200 && r.data.due === 2 && r.data.checked === 2 && r.data.failed === 0, r.data);
  const mails = outbox.slice(sentBefore);
  ok('  emailing the account that got new matches', mails.length === 1 && mails[0].to === 'fan2@example.com', mails.map((m) => m.to));
  ok('  with what was added and a link to the job list',
    /new matches at Acme Corp/.test(mails[0].subject) && mails[0].html.includes('Good Backend Engineer, Risk') && mails[0].html.includes('/jobs/') && !mails[0].html.includes('Globex'), mails[0] && mails[0].subject);
  ok('  and not the account that had nothing new', !mails.some((m) => m.to === 'fan@example.com'));
  r = await req('GET', '/api/queue?status=pending', { token: tokenG });
  ok("  each account's matches go on its own list", r.data.items.length > 0 && r.data.items.every((i) => i.company === 'Acme Corp'), r.data.items.map((i) => i.company));
  r = await req('GET', '/api/companies', { token: tokenG });
  ok('  and the next check is due an interval later', r.data.watch.nextRunAt > Date.now() + 5 * 3600000, r.data.watch.nextRunAt - Date.now());
  r = await cron(process.env.CRON_SECRET);
  ok('a second call straight after finds nothing due', r.data.due === 0, r.data);

  await req('PATCH', '/api/config', { token: tokenG, body: { config: { notify: { emailReport: false } } } });
  stub.greenhouse.acme.jobs.push(gh(7, 'Good Backend Engineer, Data', 'Bengaluru', 0));
  await req('PUT', '/api/companies', { token: tokenG, body: { enabled: false } });
  await req('PUT', '/api/companies', { token: tokenG, body: { enabled: true } });
  const quietBefore = outbox.length;
  r = await cron(process.env.CRON_SECRET);
  ok('reports switched off: matches are added without an email', r.data.added === 1 && outbox.length === quietBefore, { data: r.data, sent: outbox.length - quietBefore });

  r = await req('GET', '/api/companies');
  ok('the companies need a sign-in', r.status === 401, r.status);
  r = await req('GET', '/api/companies', { token: refreshedToken });
  ok("another account's companies are never seen", r.data.watch.companies.length === 0, r.data.watch);
  globalThis.fetch = realFetch;
}

section('logout');
r = await req('POST', '/api/auth/logout', { token: tokenB });
ok('logout succeeds', r.status === 200);
ok('logout clears the cookies', /Max-Age=0/.test(cookiesFrom(r).join(' ')), cookiesFrom(r));
r = await req('GET', '/api/me', { token: tokenB });
ok('the token stops working', r.status === 401, r.status);
r = await req('GET', '/api/me', { token: refreshedToken });
ok("and the other account's session is untouched", r.status === 200);

// ---------------------------------------------------------------------------
section('unconfirmed accounts (Supabase with email confirmation on)');
setRequireConfirmation(true);
r = await req('POST', '/api/auth/register', { body: { email: 'unconfirmed@example.com', password: PASSWORD, client: 'web' } });
ok('register answers 202 rather than pretending to sign you in', r.status === 202 && r.data.pendingConfirmation === true, r.data);
ok('  and says what to do', /confirm/i.test(r.data.message || ''), r.data.message);

r = await req('POST', '/api/auth/login', { body: { email: 'unconfirmed@example.com', password: PASSWORD, client: 'web' } });
ok('signing in reports the real reason, not "wrong password"',
  r.status === 403 && r.data.needsConfirmation === true, { status: r.status, data: r.data });
ok('  and the message mentions confirmation', /confirm/i.test(r.data.error || ''), r.data.error);

r = await req('POST', '/api/auth/login', { body: { email: 'unconfirmed@example.com', password: 'the-wrong-password' } });
ok('a wrong password on an unconfirmed account still says nothing',
  r.status === 401 && !r.data.needsConfirmation, { status: r.status, data: r.data });

section('confirming an account with the emailed code');
const firstCode = confirmationCodeFor('unconfirmed@example.com');
ok('signing up sends a 6-digit code', /^\d{6}$/.test(firstCode || ''), firstCode);

r = await req('POST', '/api/auth/verify', { body: { email: 'unconfirmed@example.com', code: 'abc', client: 'web' } });
ok('a code that is not digits is refused before it is tried', r.status === 400 && /6 digits/.test(r.data.error), r.data);
const wrongCode = firstCode === '000000' ? '111111' : '000000';
r = await req('POST', '/api/auth/verify', { body: { email: 'unconfirmed@example.com', code: wrongCode, client: 'web' } });
ok('a wrong code is refused', r.status === 400 && /wrong or has expired/.test(r.data.error), r.data);
r = await req('POST', '/api/auth/verify', { body: { email: 'nobody-at-all@example.com', code: '123456', client: 'web' } });
ok('  with the same answer for an address that has no account', r.status === 400 && /wrong or has expired/.test(r.data.error), r.data);

r = await req('POST', '/api/auth/resend-confirmation', { body: { email: 'unconfirmed@example.com' } });
ok('"send a new code" is accepted', r.status === 200 && r.data.ok === true && /new code/.test(r.data.message), r.data);
r = await req('POST', '/api/auth/resend-confirmation', { body: { email: 'nobody-at-all@example.com' } });
ok('  and answers identically for an unknown address', r.status === 200 && r.data.ok === true, r.data);
const secondCode = confirmationCodeFor('unconfirmed@example.com');
if (secondCode !== firstCode) {
  r = await req('POST', '/api/auth/verify', { body: { email: 'unconfirmed@example.com', code: firstCode, client: 'web' } });
  ok('  and the old code stops working', r.status === 400, r.data);
}

r = await req('POST', '/api/auth/verify', { body: { email: 'Unconfirmed@Example.com', code: ' ' + secondCode.slice(0, 3) + ' ' + secondCode.slice(3), client: 'web' } });
ok('the right code confirms the account and signs in at once', r.status === 200 && !!r.data.token, { status: r.status, data: r.data });
ok('  with the session cookies for the website', /sb-access/.test(cookiesFrom(r).join(' ')), cookiesFrom(r));
r = await req('POST', '/api/auth/verify', { body: { email: 'unconfirmed@example.com', code: secondCode, client: 'web' } });
ok('  and the code cannot be used twice', r.status === 400, r.data);
r = await req('POST', '/api/auth/login', { body: { email: 'unconfirmed@example.com', password: PASSWORD, client: 'web' } });
ok('once confirmed, the same credentials work', r.status === 200 && !!r.data.token, { status: r.status, data: r.data });

r = await req('POST', '/api/auth/register', { body: { email: 'from-extension@example.com', password: PASSWORD, client: 'extension' } });
r = await req('POST', '/api/auth/verify', { body: { email: 'from-extension@example.com', code: confirmationCodeFor('from-extension@example.com'), client: 'extension' } });
ok('the extension gets its tokens in the body, and no cookie', r.status === 200 && !!r.data.refreshToken && cookiesFrom(r).length === 0, { data: r.data, cookies: cookiesFrom(r) });

await req('POST', '/api/auth/register', { body: { email: 'guesser@example.com', password: PASSWORD } });
let last;
for (let i = 0; i < 11; i++) {
  last = await req('POST', '/api/auth/verify', { body: { email: 'guesser@example.com', code: String(100000 + i), client: 'web' } });
}
ok('guessing codes is cut off after 10 tries', last.status === 429 && !!last.headers.get('retry-after'), { status: last.status, data: last.data });
r = await req('POST', '/api/auth/verify', { body: { email: 'guesser@example.com', code: confirmationCodeFor('guesser@example.com'), client: 'web' } });
ok('  even the right code is refused until the wait is over', r.status === 429, r.status);
setRequireConfirmation(false);
resetRateLimits();

section('CORS (the frontend is on its own origin)');
r = await req('GET', '/api/health', { origin: 'https://app.example.com' });
ok('an allowed origin is echoed back exactly',
  r.headers.get('access-control-allow-origin') === 'https://app.example.com',
  r.headers.get('access-control-allow-origin'));
ok('with credentials enabled', r.headers.get('access-control-allow-credentials') === 'true');
ok('and Vary: Origin so caches do not mix responses', /Origin/.test(r.headers.get('vary') || ''), r.headers.get('vary'));

r = await req('GET', '/api/health', { origin: 'https://evil.example.com' });
ok('an unknown origin gets no CORS headers', !r.headers.get('access-control-allow-origin'),
  r.headers.get('access-control-allow-origin'));

r = await req('GET', '/api/health', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
ok('a chrome extension origin is allowed', !!r.headers.get('access-control-allow-origin'));
r = await req('GET', '/api/health', { origin: 'chrome-extension://short' });
ok('a malformed extension origin is not', !r.headers.get('access-control-allow-origin'));

r = await req('OPTIONS', '/api/applications', { origin: 'https://app.example.com' });
ok('preflight is answered', r.status === 204 && !!r.headers.get('access-control-allow-methods'), r.status);

section('misc');
r = await req('GET', '/api/health');
ok('health reports which providers are live', r.data.ok === true && r.data.providers === 'memory', r.data);
ok('health reports whether ranking is set up', r.data.ranking === true, r.data);
r = await req('GET', '/api/nope');
ok('unknown route -> 404 json', r.status === 404 && !!r.data.error, r.status);

const badJson = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
});
ok('malformed JSON -> 400, not a stack trace', badJson.status === 400, badJson.status);

section('rate limiting (shared through Redis)');
r = await req('GET', '/api/health');
ok('health confirms Redis is answering', r.data.rateLimits === 'redis', r.data.rateLimits);

resetRateLimits();
const failLogin = (email) => req('POST', '/api/auth/login', { body: { email, password: 'wrong-password-x' } });
let limited = false;
for (let i = 0; i < 12; i++) {
  const res = await failLogin('ratelimit@example.com');
  if (res.status === 429) { limited = true; ok('  and says when to retry', Number(res.headers.get('retry-after')) > 0, res.headers.get('retry-after')); break; }
}
ok('repeated failed logins get rate limited', limited);
const keys = [...fakeRedis.store.keys()];
ok('the count lives in Redis, so every instance sees it', keys.length === 1 && keys[0].startsWith('jobdo:rl:'), keys);
ok('  under a hashed key, never the email address', !keys.some((k) => /ratelimit|example/.test(k)), keys);
ok('  and it expires with the window', fakeRedis.store.get(keys[0]).exp > Date.now(), fakeRedis.store.get(keys[0]));

// A second server instance shares nothing in memory: simulate it by wiping
// this instance's own counts. The limit must still hold.
auth.resetRateLimits();
r = await failLogin('ratelimit@example.com');
ok('the limit survives an instance that has never seen these attempts', r.status === 429, r.status);

resetRateLimits();
await req('POST', '/api/auth/register', { body: { email: 'limited-then-ok@example.com', password: PASSWORD, client: 'extension' } });
for (let i = 0; i < 3; i++) await failLogin('limited-then-ok@example.com');
r = await req('POST', '/api/auth/login', { body: { email: 'limited-then-ok@example.com', password: PASSWORD, client: 'extension' } });
ok('a successful login clears the count in Redis', r.status === 200 && fakeRedis.store.size === 0, { status: r.status, keys: fakeRedis.store.size });

resetRateLimits();
fakeRedis.fail = true;
r = await req('GET', '/api/health');
ok('health reports Redis being down', /^memory \(Redis unreachable/.test(r.data.rateLimits), r.data.rateLimits);
limited = false;
for (let i = 0; i < 12; i++) {
  const res = await failLogin('redis-down@example.com');
  if (res.status === 429) { limited = true; break; }
}
ok('with Redis down, logins still work and are still limited per instance', limited);
fakeRedis.fail = false;
resetRateLimits();

section('bad Redis settings never take the server down');
// Config is read at startup, so each case runs in a fresh process.
const { execFileSync } = await import('node:child_process');
const configFor = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  "const { config, validateConfig } = await import('./src/config.js');" +
  'console.log(JSON.stringify({ url: config.redisUrl, token: config.redisToken, problem: config.redisProblem, fatal: validateConfig() }));'
], { env: { ...process.env, PROVIDERS: 'memory', KV_REST_API_URL: '', KV_REST_API_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());

let c = configFor({ UPSTASH_REDIS_REST_URL: '"https://x.upstash.io"', UPSTASH_REDIS_REST_TOKEN: '"tok"' });
ok('quotes pasted from a .env snippet are removed', c.url === 'https://x.upstash.io' && c.token === 'tok' && !c.problem, c);
c = configFor({ UPSTASH_REDIS_REST_URL: 'redis://default:pw@x.upstash.io:6379', UPSTASH_REDIS_REST_TOKEN: 'tok' });
ok('a redis:// URL switches Redis off with a reason', c.url === '' && /REST URL/.test(c.problem), c);
ok('  and is not a startup error', c.fatal.length === 0, c.fatal);
c = configFor({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: '' });
ok('a missing token switches Redis off, not the server', c.url === '' && /TOKEN/.test(c.problem) && c.fatal.length === 0, c);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
server.close();
rankerServer.close();
redisServer.close();
process.exit(fail ? 1 : 0);

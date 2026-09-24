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

const { app } = await import('../src/server.js');
const { resetRateLimits } = await import('../src/auth.js');
const { setRequireConfirmation } = await import('../src/providers.memory.js');

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

await req('DELETE', '/api/resumes/' + resumeId, { token: tokenB });
r = await req('GET', '/api/resumes', { token: refreshedToken });
ok("cannot delete another account's resume", r.data.resumes.length === 3, r.data.resumes.length);

// Counted rather than hardcoded, so adding cases above cannot quietly break it.
const beforeClear = (await req('GET', '/api/applications', { token: refreshedToken })).data.records.length;
r = await req('DELETE', '/api/applications?confirm=yes', { token: tokenB });
r = await req('GET', '/api/applications', { token: refreshedToken });
ok("clearing one account's history leaves the other intact",
  r.data.records.length === beforeClear && beforeClear > 0, { before: beforeClear, after: r.data.records.length });
r = await req('GET', '/api/applications', { token: tokenB });
ok('  and does clear the account that asked', r.data.records.length === 0, r.data.records.length);

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

r = await req('POST', '/api/auth/resend-confirmation', { body: { email: 'unconfirmed@example.com' } });
ok('resend confirmation is accepted', r.status === 200 && r.data.ok === true, r.data);
r = await req('POST', '/api/auth/resend-confirmation', { body: { email: 'nobody-at-all@example.com' } });
ok('  and answers identically for an unknown address', r.status === 200 && r.data.ok === true, r.data);

r = await req('POST', '/api/auth/login', { body: { email: 'unconfirmed@example.com', password: PASSWORD, client: 'web' } });
ok('once confirmed, the same credentials work', r.status === 200 && !!r.data.token, { status: r.status, data: r.data });
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
r = await req('GET', '/api/nope');
ok('unknown route -> 404 json', r.status === 404 && !!r.data.error, r.status);

const badJson = await fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops'
});
ok('malformed JSON -> 400, not a stack trace', badJson.status === 400, badJson.status);

section('rate limiting');
let limited = false;
for (let i = 0; i < 12; i++) {
  const res = await req('POST', '/api/auth/login', { body: { email: 'ratelimit@example.com', password: 'wrong-password-x' } });
  if (res.status === 429) { limited = true; break; }
}
ok('repeated failed logins get rate limited', limited);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
server.close();
process.exit(fail ? 1 : 0);

// All environment handling in one place, validated at boot so a missing key is
// a clear startup error rather than a confusing 500 later.

const bool = (v, dflt = false) => (v === undefined ? dflt : /^(1|true|yes)$/i.test(String(v)));

// Values copied from a .env snippet often keep their quotes ("https://...").
const unquote = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export const config = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || '0.0.0.0',

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',

  // Which origins may call the API with credentials. Chrome extension origins
  // are allowed separately and always.
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),

  // 'lax' works when the frontend and API share a site (including different
  // ports on localhost). A split deployment across two domains is cross-site
  // and needs 'none', which browsers only accept together with Secure.
  cookieSameSite: (process.env.COOKIE_SAMESITE || 'lax').toLowerCase(),
  cookieDomain: process.env.COOKIE_DOMAIN || '',
  cookieSecure: bool(process.env.COOKIE_SECURE, (process.env.COOKIE_SAMESITE || '').toLowerCase() === 'none'),

  allowSignup: bool(process.env.ALLOW_SIGNUP, true),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  // Tests and local experiments run against in-memory providers so the suite
  // needs no Supabase project and no network.
  providers: (process.env.PROVIDERS || (process.env.NODE_ENV === 'test' ? 'memory' : 'supabase')).toLowerCase(),

  // The Python ranking service in ranker/. Optional: without it /api/rank
  // answers 503 and the extension falls back to its own keyword scorer.
  rankerUrl: unquote(process.env.RANKER_URL).replace(/\/+$/, ''),
  rankerSecret: process.env.RANKER_SECRET || '',
  rankerTimeoutMs: Number(process.env.RANKER_TIMEOUT_MS) || 25000,

  // Ranking threshold for an account that has never set one.
  defaultMinScore: 60,

  // Upstash Redis (REST), shared by every serverless instance: login rate
  // limits live here. Optional; without it each instance counts on its own.
  // The KV_* names are what Vercel's Upstash integration sets.
  redisUrl: unquote(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL).replace(/\/+$/, ''),
  redisToken: unquote(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
  redisTimeoutMs: Number(process.env.REDIS_TIMEOUT_MS) || 1500,
  redisProblem: '',   // set below when the Redis settings are unusable

  maxResumeBytes: 8 * 1024 * 1024,
  maxBatch: 2000,
  // Characters of a posting kept with an application: the same amount the
  // extension sends the ranker.
  maxDescription: 12000
};

export function validateConfig() {
  const problems = [];
  if (config.providers === 'supabase') {
    if (!config.supabaseUrl) problems.push('SUPABASE_URL is not set.');
    if (!config.supabaseAnonKey) problems.push('SUPABASE_ANON_KEY is not set.');
    if (config.supabaseUrl && !/^https?:\/\//.test(config.supabaseUrl)) {
      problems.push('SUPABASE_URL must start with https://');
    }
  }
  if (config.cookieSameSite === 'none' && !config.cookieSecure) {
    problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browsers reject it otherwise).');
  }
  if (config.rankerUrl && !/^https?:\/\//.test(config.rankerUrl)) {
    problems.push('RANKER_URL must start with https://');
  }
  if (config.rankerUrl && !config.rankerSecret) {
    problems.push('RANKER_SECRET must be set when RANKER_URL is (the same value as on the ranker).');
  }
  if (!['lax', 'none', 'strict'].includes(config.cookieSameSite)) {
    problems.push('COOKIE_SAMESITE must be lax, none or strict.');
  }
  return problems;
}

// Redis is an optimisation, so a bad Redis setting must never stop the server
// from starting: it switches Redis off, and /api/health says why.
function checkRedis() {
  if (!config.redisUrl && !config.redisToken) return '';
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.redisUrl)) {
    return 'UPSTASH_REDIS_REST_URL must be the REST URL, starting with https:// (not the redis:// one)';
  }
  if (!config.redisToken) return 'UPSTASH_REDIS_REST_TOKEN is not set';
  return '';
}
config.redisProblem = checkRedis();
if (config.redisProblem) {
  console.error('Redis switched off: ' + config.redisProblem);
  config.redisUrl = '';
  config.redisToken = '';
}

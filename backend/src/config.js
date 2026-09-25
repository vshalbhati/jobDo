// All environment handling in one place, validated at boot so a missing key is
// a clear startup error rather than a confusing 500 later.

const bool = (v, dflt = false) => (v === undefined ? dflt : /^(1|true|yes)$/i.test(String(v)));

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
  rankerUrl: (process.env.RANKER_URL || '').trim().replace(/\/+$/, ''),
  rankerSecret: process.env.RANKER_SECRET || '',
  rankerTimeoutMs: Number(process.env.RANKER_TIMEOUT_MS) || 25000,

  // Ranking threshold for an account that has never set one.
  defaultMinScore: 60,

  // Upstash Redis (REST), shared by every serverless instance: login rate
  // limits live here. Optional; without it each instance counts on its own.
  // The KV_* names are what Vercel's Upstash integration sets.
  redisUrl: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim().replace(/\/+$/, ''),
  redisToken: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim(),
  redisTimeoutMs: Number(process.env.REDIS_TIMEOUT_MS) || 1500,

  maxResumeBytes: 8 * 1024 * 1024,
  maxBatch: 2000
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
  if (config.redisUrl && !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.redisUrl)) {
    problems.push('UPSTASH_REDIS_REST_URL must start with https:// (use the REST URL, not the redis:// one).');
  }
  if (config.redisUrl && !config.redisToken) {
    problems.push('UPSTASH_REDIS_REST_TOKEN must be set when UPSTASH_REDIS_REST_URL is.');
  }
  if (!['lax', 'none', 'strict'].includes(config.cookieSameSite)) {
    problems.push('COOKIE_SAMESITE must be lax, none or strict.');
  }
  return problems;
}

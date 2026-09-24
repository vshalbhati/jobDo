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
  if (!['lax', 'none', 'strict'].includes(config.cookieSameSite)) {
    problems.push('COOKIE_SAMESITE must be lax, none or strict.');
  }
  return problems;
}

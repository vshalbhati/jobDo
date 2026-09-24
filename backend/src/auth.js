// Provider selection, cookies and the request guard.
import { config } from './config.js';

const providers = config.providers === 'memory'
  ? await import('./providers.memory.js')
  : await import('./providers.supabase.js');

export const auth = providers.auth;
export const repoFor = providers.repoFor;

const ACCESS_COOKIE = 'sb-access';
const REFRESH_COOKIE = 'sb-refresh';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAgeSeconds) {
  const bits = [
    name + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'SameSite=' + (config.cookieSameSite === 'none' ? 'None'
      : config.cookieSameSite === 'strict' ? 'Strict' : 'Lax'),
    'Max-Age=' + maxAgeSeconds
  ];
  if (config.cookieSecure) bits.push('Secure');
  if (config.cookieDomain) bits.push('Domain=' + config.cookieDomain);
  return bits.join('; ');
}

// Tokens live in HttpOnly cookies for the web app, so script on the page -
// including anything injected through an XSS - cannot read them.
export function setAuthCookies(res, session) {
  if (!session) return;
  res.append('Set-Cookie', cookie(ACCESS_COOKIE, session.access_token, session.expires_in || 3600));
  if (session.refresh_token) {
    res.append('Set-Cookie', cookie(REFRESH_COOKIE, session.refresh_token, 30 * 24 * 3600));
  }
}

export function clearAuthCookies(res) {
  res.append('Set-Cookie', cookie(ACCESS_COOKIE, '', 0));
  res.append('Set-Cookie', cookie(REFRESH_COOKIE, '', 0));
}

export function accessTokenFrom(req) {
  const header = req.get('authorization') || '';
  if (/^bearer /i.test(header)) return header.slice(7).trim();
  return parseCookies(req.get('cookie'))[ACCESS_COOKIE] || '';
}

export function refreshTokenFrom(req) {
  return (req.body && req.body.refresh_token)
    || parseCookies(req.get('cookie'))[REFRESH_COOKIE]
    || '';
}

export async function requireAuth(req, res, next) {
  try {
    const token = accessTokenFrom(req);
    if (!token) return res.status(401).json({ error: 'not signed in' });

    const user = await auth.getUser(token);
    // 401 specifically means "try refreshing"; clients distinguish it from 403.
    if (!user) return res.status(401).json({ error: 'session expired', canRefresh: true });

    req.user = user;
    req.accessToken = token;
    // Every query from here runs as this user, so row level security applies.
    req.repo = repoFor(user, token);
    next();
  } catch (e) { next(e); }
}

// ------------------------------------------------------------- rate limiting

const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function rateLimit(key) {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter((t) => now - t < WINDOW);
  hits.push(now);
  attempts.set(key, hits);
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (!v.some((t) => now - t < WINDOW)) attempts.delete(k);
  }
  return { allowed: hits.length <= MAX_ATTEMPTS, retryAfter: Math.ceil((WINDOW - (now - hits[0])) / 1000) };
}

export const clearRateLimit = (key) => attempts.delete(key);
export const resetRateLimits = () => attempts.clear();

// ---------------------------------------------------------------- validation

export function validateEmail(email) {
  const e = String(email || '').trim();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e.toLowerCase();
}

export function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 10) return 'Password must be at least 10 characters.';
  if (p.length > 200) return 'Password is too long.';
  return null;
}

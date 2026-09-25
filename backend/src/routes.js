import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import {
  auth, requireAuth, setAuthCookies, clearAuthCookies, accessTokenFrom, refreshTokenFrom,
  rateLimit, clearRateLimit, validateEmail, validatePassword
} from './auth.js';
import { rankerConfigured, rankJobs } from './ranker.js';

export const api = express.Router();

// ---------------------------------------------------------------------- auth

api.post('/auth/register', async (req, res, next) => {
  try {
    if (!config.allowSignup) return res.status(403).json({ error: 'Sign-ups are closed on this server.' });
    const email = validateEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'That does not look like an email address.' });
    const bad = validatePassword(req.body.password);
    if (bad) return res.status(400).json({ error: bad });

    const { user, session } = await auth.signUp(email, req.body.password);

    // With email confirmation switched on, Supabase creates the user but
    // issues no session until they click the link.
    if (!session) {
      return res.status(202).json({
        pendingConfirmation: true,
        email,
        message: 'Check your email to confirm the account, then sign in.'
      });
    }
    return sendSession(req, res, user, session);
  } catch (e) {
    if (/already registered|already exists/i.test(e.message)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    next(e);
  }
});

api.post('/auth/login', async (req, res, next) => {
  try {
    const email = validateEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'Enter your email address.' });

    const key = (req.ip || 'unknown') + '|' + email;
    const limit = await rateLimit(key);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({
        error: 'Too many attempts. Try again in ' + Math.ceil(limit.retryAfter / 60) + ' minutes.'
      });
    }

    let result;
    try {
      result = await auth.signIn(email, String(req.body.password || ''));
    } catch (e) {
      // An unconfirmed account is a different problem with a different fix, and
      // saying so leaks nothing: the provider only reports it once the password
      // has already been accepted.
      if (isUnconfirmed(e)) {
        return res.status(403).json({
          error: 'That account still needs its email confirmed. Check your inbox for the link.',
          needsConfirmation: true,
          email
        });
      }
      // For anything else, never say which half was wrong.
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    await clearRateLimit(key);
    return sendSession(req, res, result.user, result.session);
  } catch (e) { next(e); }
});

api.post('/auth/refresh', async (req, res) => {
  const token = refreshTokenFrom(req);
  if (!token) return res.status(401).json({ error: 'No refresh token supplied.' });
  try {
    const { user, session } = await auth.refresh(token);
    return sendSession(req, res, user, session);
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ error: 'Could not refresh the session. Sign in again.' });
  }
});

function sendSession(req, res, user, session) {
  const isExtension = req.body && req.body.client === 'extension';
  // The browser gets HttpOnly cookies; the extension gets the tokens in the
  // body, because a cookie from a chrome-extension:// page is not workable.
  if (!isExtension) setAuthCookies(res, session);
  res.json({
    email: user.email,
    token: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in || 3600
  });
}

api.post('/auth/logout', async (req, res) => {
  const token = accessTokenFrom(req);
  if (token) await auth.signOut(token);
  clearAuthCookies(res);
  res.json({ ok: true });
});

const isUnconfirmed = (e) =>
  e && (e.code === 'email_not_confirmed' || /email not confirmed/i.test(e.message || ''));

api.post('/auth/resend-confirmation', async (req, res, next) => {
  try {
    const email = validateEmail(req.body.email);
    // Same answer either way, so this cannot be used to discover who has an account.
    if (email && auth.resendConfirmation) {
      await auth.resendConfirmation(email, req.body.redirectTo || '').catch(() => {});
    }
    res.json({ ok: true, message: 'If that account is waiting on confirmation, another email is on its way.' });
  } catch (e) { next(e); }
});

api.post('/auth/reset-password', async (req, res, next) => {
  try {
    const email = validateEmail(req.body.email);
    // Always the same answer, so this cannot be used to discover who has an account.
    if (email) await auth.resetPassword(email, req.body.redirectTo || '').catch(() => {});
    res.json({ ok: true, message: 'If that account exists, a reset link is on its way.' });
  } catch (e) { next(e); }
});

api.get('/me', requireAuth, async (req, res, next) => {
  try {
    const current = await req.repo.resumes.current();
    res.json({
      email: req.user.email,
      applications: await req.repo.applications.count(),
      resume: current ? {
        id: current.id, filename: current.filename,
        size: current.size, uploadedAt: current.uploaded_at
      } : null
    });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------- applications

api.post('/applications', requireAuth, async (req, res, next) => {
  try {
    const records = Array.isArray(req.body.records) ? req.body.records : null;
    if (!records) return res.status(400).json({ error: 'Expected { records: [...] }.' });
    if (records.length > config.maxBatch) {
      return res.status(413).json({ error: 'Send at most ' + config.maxBatch + ' records per request.' });
    }
    const saved = await req.repo.applications.upsertMany(records);
    res.json({ saved, total: await req.repo.applications.count() });
  } catch (e) { next(e); }
});

api.get('/applications', requireAuth, async (req, res, next) => {
  try {
    const records = await req.repo.applications.list({
      since: Number(req.query.since) || 0,
      limit: Math.min(Number(req.query.limit) || 50000, 50000),
      offset: Number(req.query.offset) || 0
    });
    res.json({ records, total: await req.repo.applications.count() });
  } catch (e) { next(e); }
});

api.get('/stats', requireAuth, async (req, res, next) => {
  try {
    res.json(await req.repo.applications.stats(Number(req.query.since) || 0));
  } catch (e) { next(e); }
});

api.delete('/applications', requireAuth, async (req, res, next) => {
  try {
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({ error: 'Add ?confirm=yes to delete every application.' });
    }
    await req.repo.applications.deleteAll();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- resumes

api.post('/resume', requireAuth, async (req, res, next) => {
  try {
    const raw = String(req.body.data || '');
    if (!raw) return res.status(400).json({ error: 'No file data supplied.' });

    const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'File is empty.' });
    if (buffer.length > config.maxResumeBytes) {
      return res.status(413).json({ error: 'Resume must be under 8 MB.' });
    }

    const result = await req.repo.resumes.add({
      filename: safeName(req.body.filename),
      mime: allowedMime(req.body.mime),
      buffer,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      text: typeof req.body.text === 'string' ? req.body.text : '',
      profile: req.body.profile && typeof req.body.profile === 'object' ? req.body.profile : null
    });
    res.json(result);
  } catch (e) { next(e); }
});

api.get('/resumes', requireAuth, async (req, res, next) => {
  try {
    res.json({ resumes: await req.repo.resumes.list() });
  } catch (e) { next(e); }
});

api.get('/resumes/:id/file', requireAuth, async (req, res, next) => {
  try {
    const file = await req.repo.resumes.download(req.params.id);
    if (!file) return res.status(404).json({ error: 'No such resume.' });
    res.set('Content-Type', file.mime || 'application/octet-stream');
    // Quoted and sanitised: this value lands in a header and must not be able
    // to introduce one.
    res.set('Content-Disposition', 'attachment; filename="' + safeName(file.filename) + '"');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(file.buffer);
  } catch (e) { next(e); }
});

api.get('/resumes/current/profile', requireAuth, async (req, res, next) => {
  try {
    const row = await req.repo.resumes.current();
    if (!row) return res.status(404).json({ error: 'No resume uploaded yet.' });
    res.json({
      id: row.id, filename: row.filename, uploadedAt: row.uploaded_at,
      mime: row.mime, size: row.size,
      profile: row.profile || null,
      textLength: (row.text_content || '').length
    });
  } catch (e) { next(e); }
});

// The extension sends the profile again whenever it is edited in Settings,
// so the web dashboard shows what the ranker is actually comparing against.
api.put('/resumes/current/profile', requireAuth, async (req, res, next) => {
  try {
    const profile = req.body.profile;
    if (!isPlainObject(profile)) return res.status(400).json({ error: 'Expected { profile: {...} }.' });
    if (JSON.stringify(profile).length > 64 * 1024) {
      return res.status(413).json({ error: 'That profile is too large.' });
    }
    const saved = await req.repo.resumes.updateProfile(profile);
    if (!saved) return res.status(404).json({ error: 'No resume uploaded yet.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

api.delete('/resumes/:id', requireAuth, async (req, res, next) => {
  try {
    await req.repo.resumes.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ settings

// Per-account settings, shared by the extension and the web dashboard.
api.get('/settings', requireAuth, async (req, res, next) => {
  try {
    res.json(await req.repo.settings.get());
  } catch (e) { next(e); }
});

api.put('/settings', requireAuth, async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.minScore !== undefined) {
      const v = req.body.minScore;
      // Number(null) and Number('') are 0, which is not what anyone meant.
      const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'minScore must be a whole number from 0 to 100.' });
      }
      patch.minScore = n;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
    res.json(await req.repo.settings.update(patch));
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- ranking

const MAX_RANK_BATCH = 50;

// Scores a batch of postings against the caller's resume, using the caller's
// threshold. The extension sends its current profile and resume text, which
// may carry hand corrections the stored copy lacks; the stored resume fills
// in whatever it leaves out.
api.post('/rank', requireAuth, async (req, res, next) => {
  try {
    if (!rankerConfigured()) {
      return res.status(503).json({ error: 'Ranking is not set up on this server (RANKER_URL is empty).' });
    }
    const jobs = Array.isArray(req.body.jobs) ? req.body.jobs : null;
    if (!jobs || !jobs.length) return res.status(400).json({ error: 'Expected { jobs: [...] }.' });
    if (jobs.length > MAX_RANK_BATCH) {
      return res.status(413).json({ error: 'Send at most ' + MAX_RANK_BATCH + ' jobs per request.' });
    }

    let resumeText = typeof req.body.resumeText === 'string' ? req.body.resumeText : '';
    let profile = isPlainObject(req.body.profile) ? req.body.profile : null;
    if (!resumeText || !profile) {
      const stored = await req.repo.resumes.current();
      if (stored) {
        resumeText = resumeText || stored.text_content || '';
        profile = profile || stored.profile || null;
      }
    }
    if (!resumeText && !profile) {
      return res.status(409).json({ error: 'There is no resume on this account yet. Upload one first.' });
    }

    const { minScore } = await req.repo.settings.get();
    const out = await rankJobs({
      jobs: jobs.map(cleanJob),
      resumeText: resumeText.slice(0, 100000),
      profile: profile || {},
      threshold: minScore
    });
    res.json({ threshold: minScore, version: out.version, results: out.results || [] });
  } catch (e) {
    if (e.expose) return res.status(e.status || 502).json({ error: e.message });
    next(e);
  }
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
const cleanJob = (j) => ({
  id: clip(j && j.id, 200),
  title: clip(j && j.title, 400),
  company: clip(j && j.company, 300),
  location: clip(j && j.location, 300),
  description: clip(j && j.description, 40000)
});

const MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain'
]);
const allowedMime = (m) => (MIMES.has(m) ? m : 'application/octet-stream');

function safeName(name) {
  return String(name || 'resume')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.() -]/g, '_')
    .slice(0, 120) || 'resume';
}

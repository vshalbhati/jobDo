import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import {
  auth, admin, requireAuth, setAuthCookies, clearAuthCookies, accessTokenFrom, refreshTokenFrom,
  rateLimit, clearRateLimit, validateEmail, validatePassword
} from './auth.js';
import { rankerConfigured, rankJobs } from './ranker.js';
import { mailConfigured, sendMail } from './mail.js';
import { runReport, companyReport, validZone } from './report.js';
import { BOARDS, validCompany, lookupCompany } from './companies.js';
import { checkCompanies, MAX_COMPANIES } from './watch.js';

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
    // issues no session until the code it emailed comes back (/auth/verify).
    if (!session) {
      return res.status(202).json({
        pendingConfirmation: true,
        email,
        message: 'We sent a code to ' + email + '. Enter it to confirm your email and finish creating the account.'
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
          error: 'That account still needs its email confirmed. Enter the code from your email, or send a new one.',
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
    res.json({ ok: true, message: 'If that account is waiting on confirmation, a new code is on its way.' });
  } catch (e) { next(e); }
});

// The code from the confirmation email. It confirms the address and signs in
// at once, so the account is ready the moment the code is accepted. Wrong
// codes count against the same limit as wrong passwords, so a six-digit code
// cannot be guessed; the answer is the same whether or not the account exists.
api.post('/auth/verify', async (req, res, next) => {
  try {
    const email = validateEmail(req.body.email);
    const code = String(req.body.code || '').replace(/\s+/g, '');
    if (!email || !/^\d{6,10}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the code from the email: it is 6 digits.' });
    }

    const key = 'verify|' + (req.ip || 'unknown') + '|' + email;
    const limit = await rateLimit(key);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({
        error: 'Too many wrong codes. Try again in ' + Math.ceil(limit.retryAfter / 60) + ' minutes, or send a new code.'
      });
    }

    let result;
    try {
      result = await auth.verifySignup(email, code);
    } catch {
      return res.status(400).json({ error: 'That code is wrong or has expired. Check it, or send a new one.' });
    }
    await clearRateLimit(key);
    return sendSession(req, res, result.user, result.session);
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

// ------------------------------------------------------------ match ratings
//
// Your verdict on whether a job was a good match, set from the dashboard. It
// is what the ranker is checked against: ranker/evaluate.py replays the
// export below through the current ranker and reports where they disagree.

const RATINGS = new Set(['good', 'bad']);

api.put('/feedback', requireAuth, async (req, res, next) => {
  try {
    const { jobId, site, feedback } = req.body || {};
    if (typeof jobId !== 'string' || !jobId) return res.status(400).json({ error: 'Expected { jobId, site, feedback }.' });
    if (feedback !== null && !RATINGS.has(feedback)) {
      return res.status(400).json({ error: 'feedback must be "good", "bad" or null.' });
    }
    const found = await req.repo.applications.setFeedback(jobId, site, feedback);
    if (!found) return res.status(404).json({ error: 'No such application on this account.' });
    res.json({ jobId, site, feedback });
  } catch (e) { next(e); }
});

// Everything needed to score the rated jobs again: the postings, your
// verdicts, and the resume and threshold they are ranked against.
api.get('/feedback/export', requireAuth, async (req, res, next) => {
  try {
    const [jobs, resume, settings] = await Promise.all([
      req.repo.applications.rated(),
      req.repo.resumes.current(),
      req.repo.settings.get()
    ]);
    res.set('Content-Disposition', 'attachment; filename="jobdo-ratings.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      threshold: settings.minScore,
      resume: resume ? { text: resume.text_content || '', profile: resume.profile || {} } : null,
      jobs
    });
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

// Everything the extension needs to run: the profile it types into forms, the
// text the ranker reads, and the file's hash so it only downloads the file
// again (from /resumes/:id/file) when it has changed.
api.get('/resumes/current', requireAuth, async (req, res, next) => {
  try {
    const row = await req.repo.resumes.current();
    if (!row) return res.status(404).json({ error: 'No resume uploaded yet.' });
    res.json({
      id: row.id, filename: row.filename, mime: row.mime, size: row.size, sha256: row.sha256,
      uploadedAt: row.uploaded_at, profile: row.profile || null, text: row.text_content || ''
    });
  } catch (e) { next(e); }
});

// The web app saves the profile here whenever it is edited, so the extension
// and the dashboard see exactly what the ranker compares jobs against.
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
    const { minScore, updatedAt } = await req.repo.settings.get();
    res.json({ minScore, updatedAt });
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
    const { minScore, updatedAt } = await req.repo.settings.update(patch);
    res.json({ minScore, updatedAt });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------- config

// Every setting the web app edits and the extension runs on, as one document
// per account. A PATCH replaces only the fields it names within the sections
// it names, so the extension can flip one switch (dry run) without
// overwriting what the web app saved a minute earlier.
const CONFIG_SECTIONS = new Set(['sites', 'search', 'match', 'rank', 'schedule', 'safety', 'portal', 'answers', 'resume', 'notify']);
const MAX_CONFIG_BYTES = 256 * 1024;

// The threshold has its own column (the ranker reads it), but to the clients
// it is simply match.minScore.
const configView = (s) => ({
  config: { ...s.config, match: { ...(s.config.match || {}), minScore: s.minScore } },
  unknownQuestions: s.unknownQuestions,
  updatedAt: s.updatedAt
});

api.get('/config', requireAuth, async (req, res, next) => {
  try {
    res.json(configView(await req.repo.settings.get()));
  } catch (e) { next(e); }
});

api.patch('/config', requireAuth, async (req, res, next) => {
  try {
    const patch = req.body.config;
    if (!isPlainObject(patch)) return res.status(400).json({ error: 'Expected { config: {...} }.' });

    const current = await req.repo.settings.get();
    const config = { ...current.config };
    let minScore;
    for (const [section, value] of Object.entries(patch)) {
      if (!CONFIG_SECTIONS.has(section)) {
        return res.status(400).json({ error: 'Unknown settings section: ' + section });
      }
      if (!isPlainObject(value)) return res.status(400).json({ error: section + ' must be an object.' });
      const merged = { ...(isPlainObject(config[section]) ? config[section] : {}), ...value };
      if (section === 'match' && 'minScore' in value) minScore = value.minScore;
      delete merged.minScore;          // lives in its own column
      delete merged.unknownQuestions;  // has its own endpoint
      delete merged.lastRunDay;        // per-browser state, never shared
      config[section] = merged;
    }
    if (JSON.stringify(config).length > MAX_CONFIG_BYTES) {
      return res.status(413).json({ error: 'Those settings are too large.' });
    }

    const update = { config };
    if (minScore !== undefined) {
      const n = typeof minScore === 'number' ? minScore : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'match.minScore must be a whole number from 0 to 100.' });
      }
      update.minScore = n;
    }
    res.json(configView(await req.repo.settings.update(update)));
  } catch (e) { next(e); }
});

// Questions a run could not answer. The extension reports them; the web app
// shows them so they can be turned into answer rules, and dismisses them.
const MAX_UNKNOWN = 60;

api.post('/unknown-questions', requireAuth, async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body.questions) ? req.body.questions : null;
    if (!incoming || incoming.length > 20) return res.status(400).json({ error: 'Expected { questions: [...] }, at most 20.' });
    const current = await req.repo.settings.get();
    const list = current.unknownQuestions.slice();
    for (const q of incoming) {
      const label = clip(q && q.label, 500).trim();
      if (!label || list.some((x) => x.label === label)) continue;
      list.push({
        label,
        kind: clip(q.kind, 40),
        options: Array.isArray(q.options) ? q.options.slice(0, 30).map((o) => clip(o, 200)) : [],
        job: clip(q.job, 300),
        at: Number(q.at) || Date.now()
      });
    }
    const saved = await req.repo.settings.update({ unknownQuestions: list.slice(-MAX_UNKNOWN) });
    res.json({ unknownQuestions: saved.unknownQuestions });
  } catch (e) { next(e); }
});

api.delete('/unknown-questions', requireAuth, async (req, res, next) => {
  try {
    const label = String(req.query.label || '');
    const current = await req.repo.settings.get();
    const list = label ? current.unknownQuestions.filter((q) => q.label !== label) : [];
    const saved = await req.repo.settings.update({ unknownQuestions: list });
    res.json({ unknownQuestions: saved.unknownQuestions });
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ job list
//
// Links the extension applies to before it searches the job boards: uploaded
// from a spreadsheet on the website, or found by the favourite-companies check.

const MAX_QUEUE_ADD = 1000;      // links in one request
const MAX_PENDING = 2000;        // links waiting at once
const QUEUE_STATUSES = new Set(['pending', 'done']);
const RESULTS = new Set(['applied', 'needs_manual', 'failed', 'dry_run', 'skipped']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A web address, without its #fragment; '' for anything else.
function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 2000) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    u.hash = '';
    return u.href.length <= 2000 ? u.href : '';
  } catch {
    return '';
  }
}

api.get('/queue', requireAuth, async (req, res, next) => {
  try {
    const status = QUEUE_STATUSES.has(req.query.status) ? req.query.status : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), MAX_PENDING);
    const [items, counts] = await Promise.all([req.repo.queue.list({ status, limit }), req.repo.queue.counts()]);
    res.json({ items, counts });
  } catch (e) { next(e); }
});

api.post('/queue', requireAuth, async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body.items) ? req.body.items : null;
    if (!incoming || !incoming.length) return res.status(400).json({ error: 'Expected { items: [{ url, title, company }] }.' });
    if (incoming.length > MAX_QUEUE_ADD) {
      return res.status(413).json({ error: 'Add at most ' + MAX_QUEUE_ADD + ' links at a time.' });
    }
    const items = [];
    const seen = new Set();
    let invalid = 0;
    for (const it of incoming) {
      const o = isPlainObject(it) ? it : { url: it };
      const url = cleanUrl(o.url);
      if (!url) { invalid++; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({
        url, origin: 'list',
        title: clip(o.title, 300).trim(), company: clip(o.company, 200).trim(), location: clip(o.location, 200).trim()
      });
    }
    const { pending } = await req.repo.queue.counts();
    if (pending + items.length > MAX_PENDING) {
      return res.status(413).json({
        error: 'Your list holds up to ' + MAX_PENDING + ' waiting jobs and already has ' + pending + '. Remove some, or add fewer.'
      });
    }
    const added = items.length ? await req.repo.queue.add(items) : 0;
    res.json({ added, duplicates: incoming.length - invalid - added, invalid, counts: await req.repo.queue.counts() });
  } catch (e) { next(e); }
});

// The extension marks a job done once it has been tried; the website puts a
// done one back on the list to try again.
api.patch('/queue/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'No such job on your list.' });
    const { status, result, reason } = req.body || {};
    let patch;
    if (status === 'pending') patch = { status };
    else if (status === 'done' && RESULTS.has(result)) patch = { status, result, reason: clip(reason, 500) };
    else return res.status(400).json({ error: 'Expected { status: "done", result, reason } or { status: "pending" }.' });
    const item = await req.repo.queue.update(req.params.id, patch);
    if (!item) return res.status(404).json({ error: 'No such job on your list.' });
    res.json({ item });
  } catch (e) { next(e); }
});

api.delete('/queue/:id', requireAuth, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !(await req.repo.queue.remove(req.params.id))) {
      return res.status(404).json({ error: 'No such job on your list.' });
    }
    res.json({ ok: true, counts: await req.repo.queue.counts() });
  } catch (e) { next(e); }
});

// ?status=done clears what has been tried, ?status=pending what has not, and
// ?status=all everything.
api.delete('/queue', requireAuth, async (req, res, next) => {
  try {
    const status = req.query.status;
    if (status !== 'all' && !QUEUE_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Add ?status=done, ?status=pending or ?status=all.' });
    }
    const removed = await req.repo.queue.clear(status === 'all' ? undefined : status);
    res.json({ removed, counts: await req.repo.queue.counts() });
  } catch (e) { next(e); }
});

// ------------------------------------------------------- favourite companies
//
// The server reads these companies' careers boards on a schedule and puts the
// postings that match your resume on your job list; the extension applies.

const schedulerReady = () => !!(config.cronSecret && admin && admin.configured());

api.get('/companies', requireAuth, async (req, res, next) => {
  try {
    res.json({ watch: await req.repo.watch.get(), scheduler: schedulerReady(), boards: Object.keys(BOARDS) });
  } catch (e) { next(e); }
});

api.put('/companies', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.companies !== undefined) {
      if (!Array.isArray(b.companies) || b.companies.length > MAX_COMPANIES) {
        return res.status(400).json({ error: 'Expected up to ' + MAX_COMPANIES + ' companies.' });
      }
      const list = [];
      for (const c of b.companies) {
        if (!validCompany(c)) return res.status(400).json({ error: 'Not a company this can check: ' + clip(c && (c.name || c.slug), 80) });
        if (list.some((x) => x.ats === c.ats && x.slug === c.slug)) continue;
        list.push({ name: clip(c.name, 100).trim() || c.slug, ats: c.ats, slug: c.slug });
      }
      patch.companies = list;
    }
    if (b.intervalHours !== undefined) {
      const n = b.intervalHours;
      if (!Number.isInteger(n) || n < 1 || n > 168) {
        return res.status(400).json({ error: 'intervalHours must be a whole number of hours from 1 to 168.' });
      }
      patch.intervalHours = n;
    }
    if (b.enabled !== undefined) patch.enabled = b.enabled === true;
    if (b.locations !== undefined) patch.locations = clip(b.locations, 500).trim();
    if (b.tz !== undefined) patch.tz = validZone(String(b.tz)) === String(b.tz) ? clip(b.tz, 60) : '';
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });

    // Switched on: the first check is due straight away. A new interval
    // counts from the last check. Switched off, nothing is due.
    const current = await req.repo.watch.get();
    const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
    if (!enabled) patch.nextRunAt = null;
    else if (!current.enabled) patch.nextRunAt = Date.now();
    else if (patch.intervalHours && patch.intervalHours !== current.intervalHours) {
      patch.nextRunAt = Math.max(Date.now(), (current.lastRunAt || 0) + patch.intervalHours * 3600000);
    }
    res.json({ watch: await req.repo.watch.update(patch), scheduler: schedulerReady(), boards: Object.keys(BOARDS) });
  } catch (e) { next(e); }
});

// A company name, or the address of its careers page -> where its jobs are listed.
api.post('/companies/lookup', requireAuth, async (req, res, next) => {
  try {
    const limit = await rateLimit('lookup|' + req.user.id, 40);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Too many searches. Try again in a few minutes.' });
    }
    res.json(await lookupCompany(req.body && req.body.query));
  } catch (e) { next(e); }
});

// "Check now" on the website: the same check the scheduler runs, as the
// signed-in user. The results are on the page, so no email.
api.post('/companies/check', requireAuth, async (req, res, next) => {
  try {
    const limit = await rateLimit('check|' + req.user.id, 6);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Checked a lot just now. Try again in ' + Math.ceil(limit.retryAfter / 60) + ' minutes.' });
    }
    const out = await checkCompanies(req.repo);
    res.json({ result: out.result, added: out.added, watch: await req.repo.watch.get() });
  } catch (e) {
    if (e.expose) return res.status(e.status || 502).json({ error: e.message });
    next(e);
  }
});

const CRON_BUDGET_MS = 45000;    // stop starting new accounts after this
const CRON_BATCH = 25;           // accounts looked at per call

// Called by Supabase pg_cron every few minutes (see README.md, "Favourite
// companies"). Checks the accounts that are due, within one call's time.
api.post('/cron/companies', async (req, res, next) => {
  try {
    if (!schedulerReady()) return res.status(503).json({ error: 'The scheduled check is not set up on this server.' });
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(config.cronSecret).digest();
    if (!given || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Not allowed.' });

    const started = Date.now();
    const due = await admin.dueAccounts(started, CRON_BATCH);
    let checked = 0, added = 0, failed = 0, emailed = 0;
    for (const uid of due) {
      if (Date.now() - started > CRON_BUDGET_MS) break;
      const repo = admin.repoFor(uid);
      try {
        // Claimed first: an account whose check keeps failing waits its
        // interval like any other, rather than being retried every call.
        const watch = await repo.watch.get();
        await repo.watch.update({ nextRunAt: Date.now() + watch.intervalHours * 3600000 });
        const out = await checkCompanies(repo);
        checked++;
        added += out.added.length;
        if (await emailCompanyReport(repo, out)) emailed++;
      } catch (e) {
        failed++;
        console.error('A favourite-companies check failed: ' + e.message);
      }
    }
    res.json({ due: due.length, checked, failed, added, emailed });
  } catch (e) { next(e); }
});

async function emailCompanyReport(repo, out) {
  const { config: settings } = await repo.settings.get();
  if ((settings.notify && settings.notify.emailReport === false) || !mailConfigured()) return false;
  const report = companyReport({ result: out.result, added: out.added, tz: out.watch.tz });
  if (!report) return false;
  const to = await repo.email();
  if (!to) return false;
  await sendMail({ to, subject: report.subject, html: report.html, text: report.text });
  return true;
}

// ------------------------------------------------------------------- reports

const REPORT_WINDOW_MS = 48 * 3600 * 1000;   // longer than any run

// Sent by the extension when a run ends. The email goes to the account's own
// address and lists the account's own records from that run, so a client can
// choose when a report goes out but not what it says or where it goes.
api.post('/runs/report', requireAuth, async (req, res, next) => {
  try {
    const endedAt = Math.min(Number(req.body.endedAt) || Date.now(), Date.now());
    let startedAt = Number(req.body.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > endedAt) {
      return res.status(400).json({ error: 'Expected { startedAt, endedAt } in milliseconds.' });
    }
    startedAt = Math.max(startedAt, endedAt - REPORT_WINDOW_MS);

    const { config: settings } = await req.repo.settings.get();
    if (settings.notify && settings.notify.emailReport === false) {
      return res.json({ sent: false, reason: 'Run reports are switched off in Settings.' });
    }
    if (!mailConfigured()) {
      return res.status(503).json({ error: 'Email is not set up on this server (SMTP_HOST, SMTP_USER, SMTP_PASS).' });
    }

    const records = (await req.repo.applications.list({ since: startedAt, limit: 5000 }))
      .filter((r) => r.at <= endedAt + 60000);
    const report = runReport({ records, startedAt, endedAt, tz: String(req.body.tz || ''), ending: req.body.ending });
    if (!report) return res.json({ sent: false, reason: 'Nothing was recorded during that run.' });

    // Ten a quarter of an hour is far more than runs end, and stops a
    // misbehaving client filling the inbox.
    const limit = await rateLimit('report|' + req.user.id);
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'Too many reports. Try again later.' });
    }
    await sendMail({ to: req.user.email, subject: report.subject, html: report.html, text: report.text });
    res.json({ sent: true, to: req.user.email, counts: report.counts });
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

// In-memory stand-ins for Supabase, implementing the same contract as
// providers.supabase.js. The test suite runs the real route code against these,
// so the API's behaviour - auth guards, validation, per-account isolation,
// upsert semantics - is covered without needing a Supabase project or network.
//
// Not for production: PROVIDERS defaults to 'supabase' unless NODE_ENV=test.
import crypto from 'node:crypto';
import { config } from './config.js';

const usersByEmail = new Map();   // email -> { id, email, password }
const usersById = new Map();
const tokens = new Map();         // access token -> { userId, expiresAt }
const refreshTokens = new Map();  // refresh token -> userId
const rows = [];                  // applications
const resumeRows = [];            // resumes
const files = new Map();          // storage path -> Buffer
const settingsRows = new Map();   // user id -> { min_score, updated_at }
const queueRows = [];             // job_queue
const watchRows = new Map();      // user id -> company_watch
const seenRows = new Map();       // user id -> Set of posting keys

// Mirrors the Supabase project setting: when confirmation is required, signUp
// creates the user but signIn refuses until the email is confirmed.
let requireConfirmation = false;
export function setRequireConfirmation(v) { requireConfirmation = !!v; }

// The confirmation code Supabase would have emailed, for tests to read back.
export function confirmationCodeFor(email) {
  const user = usersByEmail.get(String(email).toLowerCase());
  return user ? user.code || null : null;
}

const CODE_TTL_MS = 3600_000;   // Supabase's default OTP lifetime
const newCode = (user) => {
  user.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  user.codeSentAt = Date.now();
};

export function resetMemory() {
  usersByEmail.clear(); usersById.clear(); tokens.clear(); refreshTokens.clear();
  rows.length = 0; resumeRows.length = 0; files.clear(); settingsRows.clear(); queueRows.length = 0;
  watchRows.clear(); seenRows.clear();
}

const err = (message, status) => { const e = new Error(message); e.status = status; return e; };

function issue(userId) {
  const access = crypto.randomBytes(24).toString('base64url');
  const refresh = crypto.randomBytes(24).toString('base64url');
  tokens.set(access, { userId, expiresAt: Date.now() + 3600_000 });
  refreshTokens.set(refresh, userId);
  return { access_token: access, refresh_token: refresh, expires_in: 3600 };
}

export const auth = {
  async signUp(email, password) {
    const key = email.toLowerCase();
    if (usersByEmail.has(key)) throw err('An account with that email already exists.', 422);
    const user = { id: crypto.randomUUID(), email: key, password, confirmed: !requireConfirmation };
    if (!user.confirmed) newCode(user);
    usersByEmail.set(key, user);
    usersById.set(user.id, user);
    // No session until the email is confirmed - exactly what Supabase does.
    if (!user.confirmed) return { user: { id: user.id, email: user.email }, session: null };
    return { user: { id: user.id, email: user.email }, session: issue(user.id) };
  },

  async signIn(email, password) {
    const user = usersByEmail.get(String(email).toLowerCase());
    if (!user || user.password !== password) throw err('Wrong email or password.', 400);
    // Reported only after the password has been accepted, so it gives nothing
    // away to someone guessing.
    if (!user.confirmed) {
      const e = err('Email not confirmed', 400);
      e.code = 'email_not_confirmed';
      throw e;
    }
    return { user: { id: user.id, email: user.email }, session: issue(user.id) };
  },

  async refresh(refreshToken) {
    const userId = refreshTokens.get(refreshToken);
    if (!userId) throw err('Could not refresh the session.', 400);
    refreshTokens.delete(refreshToken);
    const user = usersById.get(userId);
    return { user: { id: user.id, email: user.email }, session: issue(userId) };
  },

  async signOut(accessToken) {
    tokens.delete(accessToken);
  },

  async getUser(accessToken) {
    const entry = tokens.get(accessToken);
    if (!entry || entry.expiresAt < Date.now()) return null;
    const user = usersById.get(entry.userId);
    return user ? { id: user.id, email: user.email } : null;
  },

  async resetPassword() { /* nothing to send in memory */ },

  // A new code replaces the old one, as Supabase's does.
  async resendConfirmation(email) {
    const user = usersByEmail.get(String(email).toLowerCase());
    if (user && !user.confirmed) newCode(user);
  },

  async verifySignup(email, code) {
    const user = usersByEmail.get(String(email).toLowerCase());
    const valid = user && !user.confirmed && user.code && user.code === String(code) &&
      Date.now() - user.codeSentAt < CODE_TTL_MS;
    if (!valid) {
      const e = err('Token has expired or is invalid', 403);
      e.code = 'otp_expired';
      throw e;
    }
    user.confirmed = true;
    delete user.code;
    return { user: { id: user.id, email: user.email }, session: issue(user.id) };
  }
};

export function repoFor(user) {
  const uid = user.id;
  const mine = (list) => list.filter((r) => r.user_id === uid);

  return {
    applications: {
      async upsertMany(records) {
        let n = 0;
        for (const r of records) {
          if (!r || !r.jobId) continue;
          const row = {
            user_id: uid, job_id: String(r.jobId),
            title: str(r.title), company: str(r.company), location: str(r.location), url: str(r.url),
            status: status(r.status), reason: str(r.reason), score: score(r.score),
            source: r.source === 'portal' ? 'portal' : 'easy', ats: str(r.ats),
            site: site(r.site),
            applied_at: Number(r.at) || Date.now()
          };
          // Unique per (user, board, job): the same job id can exist on two boards.
          const at = rows.findIndex((x) => x.user_id === uid && x.job_id === row.job_id && x.site === row.site);
          const prev = at >= 0 ? rows[at] : {};
          // As in Postgres: a record without a description keeps the saved
          // one, and the rating is never touched by a sync.
          row.description = description(r.description) || prev.description || '';
          row.feedback = prev.feedback || null;
          row.feedback_at = prev.feedback_at || null;
          if (at >= 0) rows[at] = row; else rows.push(row);
          n++;
        }
        return n;
      },

      async setFeedback(jobId, boardId, value) {
        const row = mine(rows).find((x) => x.job_id === String(jobId) && x.site === site(boardId));
        if (!row) return false;
        row.feedback = value;
        row.feedback_at = value ? Date.now() : null;
        return true;
      },

      async rated() {
        return mine(rows)
          .filter((r) => r.feedback)
          .sort((a, b) => b.applied_at - a.applied_at)
          .map((r) => ({ ...toRecord(r), description: r.description, feedbackAt: r.feedback_at }));
      },

      async list({ since = 0, limit = 50000, offset = 0 } = {}) {
        return mine(rows)
          .filter((r) => r.applied_at >= since)
          .sort((a, b) => b.applied_at - a.applied_at)
          .slice(offset, offset + limit)
          .map(toRecord);
      },

      async count() { return mine(rows).length; },

      async stats(since = 0) {
        const list = mine(rows).filter((r) => r.applied_at >= since);
        const group = (key) => {
          const m = new Map();
          for (const r of list) m.set(r[key], (m.get(r[key]) || 0) + 1);
          return [...m].map(([k, n]) => ({ [key]: k, n })).sort((a, b) => b.n - a.n);
        };
        const bySite = group('site');
        return {
          bySite,
          total: list.length,
          applied: list.filter((r) => r.status === 'applied').length,
          byStatus: group('status'),
          bySource: group('source'),
          topCompanies: group('company').filter((c) => c.company).slice(0, 10)
        };
      },

      async deleteAll() {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === uid) rows.splice(i, 1);
      }
    },

    resumes: {
      async add({ filename, mime, buffer, sha256, text, profile }) {
        const existing = await this.current();
        if (existing && existing.sha256 === sha256) {
          if (profile) await this.updateProfile(profile);
          return { id: existing.id, unchanged: true };
        }
        const path = uid + '/' + crypto.randomUUID() + '-' + filename;
        files.set(path, buffer);
        for (const r of mine(resumeRows)) r.is_current = false;
        const row = {
          id: crypto.randomUUID(), user_id: uid, filename, mime,
          size: buffer.length, sha256, storage_path: path,
          text_content: text || '', profile: profile || null,
          uploaded_at: Date.now(), is_current: true
        };
        resumeRows.push(row);
        return { id: row.id, size: buffer.length, sha256 };
      },

      async list() {
        return mine(resumeRows)
          .sort((a, b) => b.uploaded_at - a.uploaded_at)
          .map(({ id, filename, mime, size, sha256, uploaded_at, is_current }) =>
            ({ id, filename, mime, size, sha256, uploaded_at, is_current }));
      },

      async current() { return mine(resumeRows).find((r) => r.is_current) || null; },

      async updateProfile(profile) {
        const row = await this.current();
        if (!row) return false;
        row.profile = profile;
        return true;
      },

      async download(id) {
        const row = mine(resumeRows).find((r) => r.id === id);
        if (!row) return null;
        return { filename: row.filename, mime: row.mime, buffer: files.get(row.storage_path) };
      },

      async remove(id) {
        const i = resumeRows.findIndex((r) => r.id === id && r.user_id === uid);
        if (i >= 0) { files.delete(resumeRows[i].storage_path); resumeRows.splice(i, 1); }
      }
    },

    queue: {
      async list({ status: wanted, limit = 500 } = {}) {
        return mine(queueRows)
          .filter((r) => !wanted || r.status === wanted)
          .sort((a, b) => (wanted === 'done' ? b.done_at - a.done_at : a.added_at - b.added_at))
          .slice(0, limit)
          .map(toQueueItem);
      },

      async counts() {
        const list = mine(queueRows);
        return {
          pending: list.filter((r) => r.status === 'pending').length,
          done: list.filter((r) => r.status === 'done').length
        };
      },

      async add(items) {
        return queueAdd(uid, items).length;
      },

      async addReturning(items) {
        return queueAdd(uid, items);
      },

      async update(id, patch) {
        const row = mine(queueRows).find((r) => r.id === id);
        if (!row) return null;
        Object.assign(row, patch.status === 'done'
          ? { status: 'done', result: str(patch.result), reason: str(patch.reason), done_at: Date.now() }
          : { status: 'pending', result: '', reason: '', done_at: null });
        return toQueueItem(row);
      },

      async remove(id) {
        const i = queueRows.findIndex((r) => r.id === id && r.user_id === uid);
        if (i < 0) return false;
        queueRows.splice(i, 1);
        return true;
      },

      async clear(wanted) {
        let n = 0;
        for (let i = queueRows.length - 1; i >= 0; i--) {
          const r = queueRows[i];
          if (r.user_id === uid && (!wanted || r.status === wanted)) { queueRows.splice(i, 1); n++; }
        }
        return n;
      }
    },

    ...watchRepo(uid),

    settings: {
      async get() {
        return view(settingsRows.get(uid));
      },

      async update(patch) {
        const r = settingsRows.get(uid) || { min_score: config.defaultMinScore, config: {}, unknown_questions: [] };
        if (patch.minScore !== undefined) r.min_score = patch.minScore;
        // Stored as copies, as Postgres would: later edits to the caller's
        // objects must not leak into what was saved.
        if (patch.config !== undefined) r.config = structuredClone(patch.config);
        if (patch.unknownQuestions !== undefined) r.unknown_questions = structuredClone(patch.unknownQuestions);
        r.updated_at = new Date().toISOString();
        settingsRows.set(uid, r);
        return view(r);
      }
    }
  };
}

const view = (r) => ({
  minScore: r ? r.min_score : config.defaultMinScore,
  config: r ? structuredClone(r.config) : {},
  unknownQuestions: r ? structuredClone(r.unknown_questions) : [],
  updatedAt: r ? r.updated_at : null
});

const toRecord = (r) => ({
  jobId: r.job_id, title: r.title, company: r.company, location: r.location, url: r.url,
  status: r.status, reason: r.reason, score: r.score, source: r.source, ats: r.ats,
  site: r.site || 'linkedin', at: r.applied_at, feedback: r.feedback || null
});
function queueAdd(uid, items) {
  const added = [];
  for (const i of items) {
    if (queueRows.some((r) => r.user_id === uid && r.url === i.url)) continue;
    const row = {
      id: crypto.randomUUID(), user_id: uid, url: i.url,
      title: str(i.title), company: str(i.company), location: str(i.location),
      origin: i.origin === 'company' ? 'company' : 'list',
      status: 'pending', result: '', reason: '', score: score(i.score), note: str(i.note),
      added_at: Date.now() + added.length, done_at: null
    };
    queueRows.push(row);
    added.push(toQueueItem(row));
  }
  return added;
}

const WATCH_DEFAULTS = {
  enabled: false, intervalHours: 24, companies: [], locations: '', tz: '',
  nextRunAt: null, lastRunAt: null, lastResult: null
};

function watchRepo(uid) {
  return {
    watch: {
      async get() { return structuredClone(watchRows.get(uid) || WATCH_DEFAULTS); },
      async update(patch) {
        const row = { ...(watchRows.get(uid) || WATCH_DEFAULTS) };
        for (const k of Object.keys(WATCH_DEFAULTS)) if (patch[k] !== undefined) row[k] = structuredClone(patch[k]);
        watchRows.set(uid, row);
        return structuredClone(row);
      }
    },
    seen: {
      async unseen(keys) {
        const known = seenRows.get(uid) || new Set();
        return keys.filter((k) => !known.has(k));
      },
      async add(keys) {
        const known = seenRows.get(uid) || new Set();
        for (const k of keys) known.add(k);
        seenRows.set(uid, known);
      }
    }
  };
}

// The scheduler's access: every account, as Supabase's service_role has.
export const admin = {
  configured: () => true,

  async dueAccounts(now, limit) {
    return [...watchRows.entries()]
      .filter(([, w]) => w.enabled && (!w.nextRunAt || w.nextRunAt <= now))
      .sort(([, a], [, b]) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
      .slice(0, limit)
      .map(([uid]) => uid);
  },

  repoFor(uid) {
    const user = usersById.get(uid);
    const full = repoFor({ id: uid, email: user ? user.email : '' });
    return {
      ...watchRepo(uid),
      queue: { addReturning: full.queue.addReturning },
      resumes: { current: full.resumes.current },
      settings: { get: full.settings.get },
      async email() { return user ? user.email : ''; }
    };
  }
};

const toQueueItem = (r) => ({
  id: r.id, url: r.url, title: r.title, company: r.company, location: r.location,
  origin: r.origin, status: r.status, result: r.result, reason: r.reason,
  score: r.score, note: r.note, addedAt: r.added_at, doneAt: r.done_at
});
const str = (v) => (v === undefined || v === null ? '' : String(v));
const description =(v) => str(v).slice(0, config.maxDescription).trim();
const score = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const VALID = new Set(['applied', 'needs_manual', 'failed', 'dry_run', 'skipped']);
const status = (v) => (VALID.has(v) ? v : 'skipped');
const SITES = new Set(['linkedin', 'naukri', 'indeed', 'direct']);
const site = (v) => (SITES.has(v) ? v : 'linkedin');

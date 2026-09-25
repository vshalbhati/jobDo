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

// Mirrors the Supabase project setting: when confirmation is required, signUp
// creates the user but signIn refuses until the email is confirmed.
let requireConfirmation = false;
export function setRequireConfirmation(v) { requireConfirmation = !!v; }

export function resetMemory() {
  usersByEmail.clear(); usersById.clear(); tokens.clear(); refreshTokens.clear();
  rows.length = 0; resumeRows.length = 0; files.clear(); settingsRows.clear();
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

  async resendConfirmation(email) {
    const user = usersByEmail.get(String(email).toLowerCase());
    if (user) user.confirmed = true;   // stands in for clicking the link
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
          if (at >= 0) rows[at] = row; else rows.push(row);
          n++;
        }
        return n;
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
        if (existing && existing.sha256 === sha256) return { id: existing.id, unchanged: true };
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

    settings: {
      async get() {
        const r = settingsRows.get(uid);
        return { minScore: r ? r.min_score : config.defaultMinScore, updatedAt: r ? r.updated_at : null };
      },

      async update(patch) {
        const r = settingsRows.get(uid) || { min_score: config.defaultMinScore };
        if (patch.minScore !== undefined) r.min_score = patch.minScore;
        r.updated_at = new Date().toISOString();
        settingsRows.set(uid, r);
        return { minScore: r.min_score, updatedAt: r.updated_at };
      }
    }
  };
}

const toRecord = (r) => ({
  jobId: r.job_id, title: r.title, company: r.company, location: r.location, url: r.url,
  status: r.status, reason: r.reason, score: r.score, source: r.source, ats: r.ats,
  site: r.site || 'linkedin', at: r.applied_at
});
const str = (v) => (v === undefined || v === null ? '' : String(v));
const score = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const VALID = new Set(['applied', 'needs_manual', 'failed', 'dry_run', 'skipped']);
const status = (v) => (VALID.has(v) ? v : 'skipped');
const SITES = new Set(['linkedin', 'naukri', 'indeed']);
const site = (v) => (SITES.has(v) ? v : 'linkedin');

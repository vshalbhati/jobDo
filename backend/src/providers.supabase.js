// Supabase-backed auth and data access.
//
// Every database call is made with a client carrying the caller's own access
// token, so Row Level Security applies to it. The service role key is never
// used, and is not even required to run this server - a bug here cannot read
// another account's rows, because Postgres will not return them.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { config } from './config.js';

const BUCKET = 'resumes';

const clientOpts = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
};

function anonClient() {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, clientOpts);
}

function userClient(accessToken) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    ...clientOpts,
    global: { headers: { Authorization: 'Bearer ' + accessToken } }
  });
}

const fail = (error, fallback) => {
  const e = new Error((error && error.message) || fallback);
  if (error && error.status) e.status = error.status;
  // Supabase distinguishes "wrong password" from states like
  // "email_not_confirmed"; callers need that distinction to say something
  // useful, so the code travels with the error.
  if (error && error.code) e.code = error.code;
  return e;
};

// ---------------------------------------------------------------------- auth

export const auth = {
  async signUp(email, password) {
    const { data, error } = await anonClient().auth.signUp({ email, password });
    if (error) throw fail(error, 'Could not create the account.');
    return { user: data.user, session: data.session };
  },

  async signIn(email, password) {
    const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
    if (error) throw fail(error, 'Wrong email or password.');
    return { user: data.user, session: data.session };
  },

  async refresh(refreshToken) {
    const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw fail(error, 'Could not refresh the session.');
    return { user: data.user, session: data.session };
  },

  async signOut(accessToken) {
    // Errors here are not worth surfacing: the client is discarding the token
    // either way, and a already-expired token is not a failure to log out.
    await userClient(accessToken).auth.signOut().catch(() => {});
  },

  async getUser(accessToken) {
    const { data, error } = await anonClient().auth.getUser(accessToken);
    if (error || !data || !data.user) return null;
    return data.user;
  },

  async resetPassword(email, redirectTo) {
    const { error } = await anonClient().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw fail(error, 'Could not send the reset email.');
  },

  async resendConfirmation(email, redirectTo) {
    const { error } = await anonClient().auth.resend({
      type: 'signup', email, options: redirectTo ? { emailRedirectTo: redirectTo } : undefined
    });
    if (error) throw fail(error, 'Could not resend the confirmation email.');
  }
};

// ---------------------------------------------------------------------- data

export function repoFor(user, accessToken) {
  const db = userClient(accessToken);
  const uid = user.id;

  return {
    applications: {
      async upsertMany(records) {
        const rows = records
          .filter((r) => r && r.jobId)
          .map((r) => ({
            user_id: uid,
            job_id: String(r.jobId),
            title: str(r.title), company: str(r.company), location: str(r.location), url: str(r.url),
            status: status(r.status), reason: str(r.reason), score: score(r.score),
            source: r.source === 'portal' ? 'portal' : 'easy', ats: str(r.ats),
            site: site(r.site),
            applied_at: iso(r.at),
            synced_at: new Date().toISOString()
          }));
        if (!rows.length) return 0;
        const { error } = await db.from('applications')
          .upsert(rows, { onConflict: 'user_id,site,job_id' });
        if (error) throw fail(error, 'Could not save the applications.');
        return rows.length;
      },

      async list({ since = 0, limit = 50000, offset = 0 } = {}) {
        const { data, error } = await db.from('applications')
          .select('job_id,title,company,location,url,status,reason,score,source,ats,site,applied_at')
          .gte('applied_at', iso(since))
          .order('applied_at', { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) throw fail(error, 'Could not read the applications.');
        return (data || []).map(toRecord);
      },

      async count() {
        const { count, error } = await db.from('applications')
          .select('id', { count: 'exact', head: true });
        if (error) throw fail(error, 'Could not count the applications.');
        return count || 0;
      },

      async stats(since = 0) {
        const { data, error } = await db.rpc('application_stats', { since: iso(since) });
        if (error) throw fail(error, 'Could not compute the statistics.');
        return data;
      },

      async deleteAll() {
        const { error } = await db.from('applications').delete().eq('user_id', uid);
        if (error) throw fail(error, 'Could not delete the applications.');
      }
    },

    resumes: {
      async add({ filename, mime, buffer, sha256, text, profile }) {
        const existing = await this.current();
        if (existing && existing.sha256 === sha256) {
          // Same file, but the profile parsed from it may have been corrected
          // since: keep the stored copy current.
          if (profile) await this.updateProfile(profile);
          return { id: existing.id, unchanged: true };
        }

        // The first path segment must be the user id: the storage policy keys
        // off exactly that.
        const path = uid + '/' + crypto.randomUUID() + '-' + filename;
        const up = await db.storage.from(BUCKET)
          .upload(path, buffer, { contentType: mime, upsert: false });
        if (up.error) throw fail(up.error, 'Could not upload the file.');

        // Clear the old flag first: a partial unique index allows only one
        // current resume per account and would otherwise reject the insert.
        await db.from('resumes').update({ is_current: false }).eq('user_id', uid).eq('is_current', true);

        const { data, error } = await db.from('resumes').insert({
          user_id: uid, filename, mime, size: buffer.length, sha256,
          storage_path: path, text_content: text || '', profile: profile || null,
          is_current: true
        }).select('id').single();

        if (error) {
          await db.storage.from(BUCKET).remove([path]).catch(() => {});
          throw fail(error, 'Could not record the resume.');
        }
        return { id: data.id, size: buffer.length, sha256 };
      },

      async list() {
        const { data, error } = await db.from('resumes')
          .select('id,filename,mime,size,sha256,uploaded_at,is_current')
          .order('uploaded_at', { ascending: false });
        if (error) throw fail(error, 'Could not list the resumes.');
        return data || [];
      },

      async current() {
        const { data, error } = await db.from('resumes')
          .select('*').eq('is_current', true).maybeSingle();
        if (error) throw fail(error, 'Could not read the current resume.');
        return data || null;
      },

      // The profile is edited by hand in the extension after parsing, so it
      // changes far more often than the file. Returns false with no resume.
      async updateProfile(profile) {
        const { data, error } = await db.from('resumes')
          .update({ profile }).eq('user_id', uid).eq('is_current', true).select('id');
        if (error) throw fail(error, 'Could not save the profile.');
        return !!(data && data.length);
      },

      async download(id) {
        const { data: row, error } = await db.from('resumes')
          .select('filename,mime,storage_path').eq('id', id).maybeSingle();
        if (error) throw fail(error, 'Could not find that resume.');
        if (!row) return null;
        const dl = await db.storage.from(BUCKET).download(row.storage_path);
        if (dl.error) throw fail(dl.error, 'Could not download the file.');
        return {
          filename: row.filename,
          mime: row.mime,
          buffer: Buffer.from(await dl.data.arrayBuffer())
        };
      },

      async remove(id) {
        const { data: row } = await db.from('resumes')
          .select('storage_path').eq('id', id).maybeSingle();
        const { error } = await db.from('resumes').delete().eq('id', id);
        if (error) throw fail(error, 'Could not delete the resume.');
        if (row) await db.storage.from(BUCKET).remove([row.storage_path]).catch(() => {});
      }
    },

    settings: {
      // No row yet means the defaults: rows are created on first save.
      async get() {
        const { data, error } = await db.from('user_settings')
          .select('min_score,updated_at').eq('user_id', uid).maybeSingle();
        if (error) throw fail(error, 'Could not read your settings.');
        return toSettings(data);
      },

      async update(patch) {
        const row = { user_id: uid, updated_at: new Date().toISOString() };
        if (patch.minScore !== undefined) row.min_score = patch.minScore;
        const { data, error } = await db.from('user_settings')
          .upsert(row, { onConflict: 'user_id' })
          .select('min_score,updated_at').single();
        if (error) throw fail(error, 'Could not save your settings.');
        return toSettings(data);
      }
    }
  };
}

const toSettings = (r) => ({
  minScore: r && Number.isInteger(r.min_score) ? r.min_score : config.defaultMinScore,
  updatedAt: r ? r.updated_at : null
});

// The shape the dashboard already expects, so the UI needs no translation layer.
const toRecord = (r) => ({
  jobId: r.job_id,
  title: r.title, company: r.company, location: r.location, url: r.url,
  status: r.status, reason: r.reason, score: r.score,
  source: r.source, ats: r.ats, site: r.site || 'linkedin',
  at: Date.parse(r.applied_at)
});

const str = (v) => (v === undefined || v === null ? '' : String(v));
const score = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const iso = (v) => new Date(Number(v) || 0).toISOString();
const VALID = new Set(['applied', 'needs_manual', 'failed', 'dry_run', 'skipped']);
const status = (v) => (VALID.has(v) ? v : 'skipped');
const SITES = new Set(['linkedin', 'naukri', 'indeed']);
const site = (v) => (SITES.has(v) ? v : 'linkedin');

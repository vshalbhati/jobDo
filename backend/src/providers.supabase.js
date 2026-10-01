// Supabase-backed auth and data access.
//
// Every database call a user makes goes through a client carrying that user's
// own access token, so Row Level Security applies to it - a bug here cannot
// read another account's rows, because Postgres will not return them.
//
// The one exception is the scheduled favourite-companies check (admin, at the
// end), which runs for many accounts with nobody signed in. It uses the
// service_role key, which bypasses RLS, so every query it makes names the
// account explicitly, and it can do only what the check needs.
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
    // With email confirmation on, a sign-up for an address that already has
    // a confirmed account gets a stand-in user with no identities and no
    // email - so the code the person would wait for never comes.
    if (!data.session && data.user && Array.isArray(data.user.identities) && !data.user.identities.length) {
      throw fail({ message: 'User already registered' }, 'User already registered');
    }
    return { user: data.user, session: data.session };
  },

  // The code from the confirmation email ({{ .Token }} in Supabase's "Confirm
  // signup" template). Confirms the address and signs in, in one step.
  async verifySignup(email, code) {
    const { data, error } = await anonClient().auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) throw fail(error, 'That code is wrong or has expired.');
    if (!data || !data.session) throw fail(null, 'That code is wrong or has expired.');
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
            synced_at: new Date().toISOString(),
            ...(description(r.description) ? { description: description(r.description) } : {})
          }));
        if (!rows.length) return 0;
        // A bulk upsert writes every column any row names, and a row without
        // it would write the default. Records re-sent from the extension's
        // history carry no description, so they go separately and leave the
        // saved one alone. Feedback is never in either: only you set it.
        const withText = rows.filter((x) => 'description' in x);
        const without = rows.filter((x) => !('description' in x));
        for (const batch of [withText, without]) {
          if (!batch.length) continue;
          const { error } = await db.from('applications')
            .upsert(batch, { onConflict: 'user_id,site,job_id' });
          if (error) throw fail(error, 'Could not save the applications.');
        }
        return rows.length;
      },

      // Returns false when there is no such application.
      async setFeedback(jobId, boardId, value) {
        const { data, error } = await db.from('applications')
          .update({ feedback: value, feedback_at: value ? new Date().toISOString() : null })
          .eq('job_id', String(jobId)).eq('site', site(boardId))
          .select('job_id');
        if (error) throw fail(error, 'Could not save the rating.');
        return !!(data && data.length);
      },

      // Every rated application with the posting it was rated on.
      async rated() {
        const { data, error } = await db.from('applications')
          .select('job_id,title,company,location,url,status,reason,score,source,ats,site,applied_at,description,feedback,feedback_at')
          .not('feedback', 'is', null)
          .order('applied_at', { ascending: false });
        if (error) throw fail(error, 'Could not read the ratings.');
        return (data || []).map((r) => ({
          ...toRecord(r), description: r.description || '', feedbackAt: Date.parse(r.feedback_at) || null
        }));
      },

      async list({ since = 0, limit = 50000, offset = 0 } = {}) {
        const { data, error } = await db.from('applications')
          .select('job_id,title,company,location,url,status,reason,score,source,ats,site,applied_at,feedback')
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

    // Your job list: links the extension applies to before the job boards.
    queue: {
      async list({ status: wanted, limit = 500 } = {}) {
        let q = db.from('job_queue').select(QUEUE_COLUMNS);
        if (wanted) q = q.eq('status', wanted);
        q = wanted === 'done'
          ? q.order('done_at', { ascending: false })
          : q.order('added_at', { ascending: true });
        const { data, error } = await q.limit(limit);
        if (error) throw fail(error, 'Could not read your job list.');
        return (data || []).map(toQueueItem);
      },

      async counts() {
        const n = async (s) => {
          const { count, error } = await db.from('job_queue')
            .select('id', { count: 'exact', head: true }).eq('status', s);
          if (error) throw fail(error, 'Could not count your job list.');
          return count || 0;
        };
        const [pending, done] = await Promise.all([n('pending'), n('done')]);
        return { pending, done };
      },

      // A link already on the list is left as it is. Returns how many were new.
      async add(items) {
        return (await queueAdd(db, uid, items)).length;
      },

      // The same, returning the new items themselves.
      async addReturning(items) {
        return queueAdd(db, uid, items);
      },

      // { status: 'done', result, reason } or { status: 'pending' } to try again.
      async update(id, patch) {
        const { data, error } = await db.from('job_queue')
          .update(queuePatch(patch)).eq('id', id).select(QUEUE_COLUMNS);
        if (error) throw fail(error, 'Could not update your job list.');
        return data && data[0] ? toQueueItem(data[0]) : null;
      },

      async remove(id) {
        const { data, error } = await db.from('job_queue').delete().eq('id', id).select('id');
        if (error) throw fail(error, 'Could not remove that job.');
        return !!(data && data.length);
      },

      async clear(wanted) {
        let q = db.from('job_queue').delete().eq('user_id', uid);
        if (wanted) q = q.eq('status', wanted);
        const { data, error } = await q.select('id');
        if (error) throw fail(error, 'Could not clear your job list.');
        return (data || []).length;
      }
    },

    // Favourite companies, and the postings already considered for them.
    ...watchRepo(db, uid),

    settings: {
      // No row yet means the defaults: rows are created on first save.
      async get() {
        const { data, error } = await db.from('user_settings')
          .select(SETTINGS_COLUMNS).eq('user_id', uid).maybeSingle();
        if (error) throw fail(error, 'Could not read your settings.');
        return toSettings(data);
      },

      // Only the fields present in the patch are written.
      async update(patch) {
        const row = { user_id: uid, updated_at: new Date().toISOString() };
        if (patch.minScore !== undefined) row.min_score = patch.minScore;
        if (patch.config !== undefined) row.config = patch.config;
        if (patch.unknownQuestions !== undefined) row.unknown_questions = patch.unknownQuestions;
        const { data, error } = await db.from('user_settings')
          .upsert(row, { onConflict: 'user_id' })
          .select(SETTINGS_COLUMNS).single();
        if (error) throw fail(error, 'Could not save your settings.');
        return toSettings(data);
      }
    }
  };
}

const SETTINGS_COLUMNS = 'min_score,config,unknown_questions,updated_at';
const QUEUE_COLUMNS = 'id,url,title,company,location,origin,status,result,reason,score,note,added_at,done_at';

async function queueAdd(db, uid, items) {
  if (!items.length) return [];
  const { data, error } = await db.from('job_queue')
    .upsert(items.map((i) => queueRow(uid, i)), { onConflict: 'user_id,url', ignoreDuplicates: true })
    .select(QUEUE_COLUMNS);
  if (error) throw fail(error, 'Could not add to your job list.');
  return (data || []).map(toQueueItem);
}

// Every query names the account, so these are safe with the service_role
// client too.
function watchRepo(db, uid) {
  return {
    watch: {
      async get() {
        const { data, error } = await db.from('company_watch').select(WATCH_COLUMNS).eq('user_id', uid).maybeSingle();
        if (error) throw fail(error, 'Could not read your favourite companies.');
        return toWatch(data);
      },

      async update(patch) {
        const row = { user_id: uid, updated_at: new Date().toISOString() };
        if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
        if (patch.intervalHours !== undefined) row.interval_hours = patch.intervalHours;
        if (patch.companies !== undefined) row.companies = patch.companies;
        if (patch.locations !== undefined) row.locations = patch.locations;
        if (patch.tz !== undefined) row.tz = patch.tz;
        if (patch.nextRunAt !== undefined) row.next_run_at = patch.nextRunAt ? new Date(patch.nextRunAt).toISOString() : null;
        if (patch.lastRunAt !== undefined) row.last_run_at = patch.lastRunAt ? new Date(patch.lastRunAt).toISOString() : null;
        if (patch.lastResult !== undefined) row.last_result = patch.lastResult;
        const { data, error } = await db.from('company_watch')
          .upsert(row, { onConflict: 'user_id' }).select(WATCH_COLUMNS).single();
        if (error) throw fail(error, 'Could not save your favourite companies.');
        return toWatch(data);
      }
    },

    seen: {
      // The keys among these that have not been considered before.
      async unseen(keys) {
        const known = new Set();
        for (let i = 0; i < keys.length; i += 200) {
          const { data, error } = await db.from('company_seen')
            .select('posting').eq('user_id', uid).in('posting', keys.slice(i, i + 200));
          if (error) throw fail(error, 'Could not read which postings were seen.');
          for (const r of data || []) known.add(r.posting);
        }
        return keys.filter((k) => !known.has(k));
      },

      async add(keys) {
        for (let i = 0; i < keys.length; i += 500) {
          const { error } = await db.from('company_seen')
            .upsert(keys.slice(i, i + 500).map((posting) => ({ user_id: uid, posting })),
              { onConflict: 'user_id,posting', ignoreDuplicates: true });
          if (error) throw fail(error, 'Could not record the postings seen.');
        }
      }
    }
  };
}

const WATCH_COLUMNS = 'enabled,interval_hours,companies,locations,tz,next_run_at,last_run_at,last_result';
const toWatch = (r) => ({
  enabled: !!(r && r.enabled),
  intervalHours: (r && r.interval_hours) || 24,
  companies: r && Array.isArray(r.companies) ? r.companies : [],
  locations: (r && r.locations) || '',
  tz: (r && r.tz) || '',
  nextRunAt: r && r.next_run_at ? Date.parse(r.next_run_at) : null,
  lastRunAt: r && r.last_run_at ? Date.parse(r.last_run_at) : null,
  lastResult: (r && r.last_result) || null
});

const queueRow = (uid, i) => ({
  user_id: uid, url: i.url,
  title: str(i.title), company: str(i.company), location: str(i.location),
  origin: i.origin === 'company' ? 'company' : 'list',
  score: score(i.score), note: str(i.note)
});

const queuePatch = (p) => (p.status === 'done'
  ? { status: 'done', result: str(p.result), reason: str(p.reason), done_at: new Date().toISOString() }
  : { status: 'pending', result: '', reason: '', done_at: null });

const toQueueItem = (r) => ({
  id: r.id, url: r.url, title: r.title, company: r.company, location: r.location,
  origin: r.origin, status: r.status, result: r.result, reason: r.reason,
  score: r.score, note: r.note,
  addedAt: Date.parse(r.added_at) || 0, doneAt: r.done_at ? Date.parse(r.done_at) : null
});

const toSettings = (r) => ({
  minScore: r && Number.isInteger(r.min_score) ? r.min_score : config.defaultMinScore,
  config: r && r.config && typeof r.config === 'object' ? r.config : {},
  unknownQuestions: r && Array.isArray(r.unknown_questions) ? r.unknown_questions : [],
  updatedAt: r ? r.updated_at : null
});

// The shape the dashboard already expects, so the UI needs no translation layer.
const toRecord = (r) => ({
  jobId: r.job_id,
  title: r.title, company: r.company, location: r.location, url: r.url,
  status: r.status, reason: r.reason, score: r.score,
  source: r.source, ats: r.ats, site: r.site || 'linkedin',
  at: Date.parse(r.applied_at),
  feedback: r.feedback || null
});

const str = (v) => (v === undefined || v === null ? '' : String(v));
const description = (v) => str(v).slice(0, config.maxDescription).trim();
const score = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
const iso = (v) => new Date(Number(v) || 0).toISOString();
const VALID = new Set(['applied', 'needs_manual', 'failed', 'dry_run', 'skipped']);
const status = (v) => (VALID.has(v) ? v : 'skipped');
const SITES = new Set(['linkedin', 'naukri', 'indeed', 'direct']);
const site = (v) => (SITES.has(v) ? v : 'linkedin');

// ------------------------------------------------- the scheduled check (admin)

let service = null;
function serviceClient() {
  if (!config.supabaseServiceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.');
  service = service || createClient(config.supabaseUrl, config.supabaseServiceRoleKey, clientOpts);
  return service;
}

export const admin = {
  configured: () => !!config.supabaseServiceRoleKey,

  // Accounts whose check is switched on and due, longest-waiting first.
  async dueAccounts(now, limit) {
    const { data, error } = await serviceClient().from('company_watch')
      .select('user_id').eq('enabled', true)
      .or('next_run_at.is.null,next_run_at.lte.' + new Date(now).toISOString())
      .order('next_run_at', { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) throw fail(error, 'Could not read the accounts that are due.');
    return (data || []).map((r) => r.user_id);
  },

  // What the check needs of one account, and nothing more. Every query names it.
  repoFor(uid) {
    const db = serviceClient();
    return {
      ...watchRepo(db, uid),
      queue: { addReturning: (items) => queueAdd(db, uid, items) },
      resumes: {
        async current() {
          const { data, error } = await db.from('resumes')
            .select('text_content,profile').eq('user_id', uid).eq('is_current', true).maybeSingle();
          if (error) throw fail(error, 'Could not read the resume.');
          return data || null;
        }
      },
      settings: {
        async get() {
          const { data, error } = await db.from('user_settings')
            .select(SETTINGS_COLUMNS).eq('user_id', uid).maybeSingle();
          if (error) throw fail(error, 'Could not read the settings.');
          return toSettings(data);
        }
      },
      async email() {
        const { data, error } = await db.auth.admin.getUserById(uid);
        if (error) throw fail(error, 'Could not read the account.');
        return (data && data.user && data.user.email) || '';
      }
    };
  }
};

// Verifies a real Supabase project is set up correctly.
//
//   npm run check:supabase
//
// Optionally, for an end-to-end storage test that actually proves the bucket
// and its policies work, sign in as one of your own accounts:
//
//   CHECK_EMAIL=you@example.com CHECK_PASSWORD=... npm run check:supabase
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set (copy .env.example to .env).');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
let failed = 0;
const ok = (label, good, detail) => {
  console.log((good ? '  ok   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  if (!good) failed++;
};
// Some things genuinely cannot be determined from outside. Say so rather than
// guessing, which is worse than not checking.
const unknown = (label, detail) => console.log('  ?    ' + label + (detail ? '  ' + detail : ''));

console.log('Checking ' + url + '\n');

const health = await fetch(url + '/auth/v1/health', { headers: { apikey: key } })
  .then((r) => r.ok).catch(() => false);
ok('auth service reachable', health);

// An anonymous read must come back empty rather than erroring: that is RLS
// doing its job. Rows here would mean the table is readable by anyone.
for (const table of ['applications', 'resumes']) {
  const { data, error } = await db.from(table).select('id').limit(1);
  if (error && /does not exist|schema cache/i.test(error.message)) {
    ok('table "' + table + '" exists', false, '- run supabase/migrations/0001_init.sql');
  } else if (error) {
    ok('table "' + table + '" readable check', false, '- ' + error.message);
  } else {
    ok('table "' + table + '" exists and is protected by RLS', (data || []).length === 0,
      (data || []).length ? '- ANONYMOUS READ RETURNED ROWS, RLS IS NOT ON' : '');
  }
}

const { error: rpcError } = await db.rpc('application_stats', { since: new Date(0).toISOString() });
ok('application_stats() function installed', !rpcError || !/does not exist/i.test(rpcError.message),
  rpcError ? '- ' + rpcError.message : '');

// --------------------------------------------------------------------- storage

const email = process.env.CHECK_EMAIL;
const password = process.env.CHECK_PASSWORD;

if (!email || !password) {
  // storage.buckets is itself behind RLS, so an anonymous listing is empty
  // whether or not the bucket exists, and the REST API answers "Bucket not
  // found" in both cases by design. Nothing here can tell them apart.
  unknown('storage bucket "resumes"', '- cannot be checked without signing in');
  console.log('        Either run:  CHECK_EMAIL=you@example.com CHECK_PASSWORD=... npm run check:supabase');
  console.log('        or in the SQL editor:  select id, public from storage.buckets where id = \'resumes\';');
} else {
  const { data: session, error: signInError } = await db.auth.signInWithPassword({ email, password });
  if (signInError) {
    ok('sign in as ' + email, false, '- ' + signInError.message);
  } else {
    ok('sign in as ' + email, true);
    const uid = session.user.id;
    const probe = uid + '/.healthcheck-' + Date.now() + '.txt';
    const body = new Blob([ 'ok' ], { type: 'text/plain' });

    const up = await db.storage.from('resumes').upload(probe, body, { contentType: 'text/plain' });
    if (up.error) {
      const missing = /not found|does not exist/i.test(up.error.message);
      ok('storage bucket "resumes" exists and accepts uploads', false,
        '- ' + up.error.message + (missing ? ' (run the migration)' : ' (check the storage policy)'));
    } else {
      ok('storage bucket "resumes" exists and accepts uploads', true);

      const dl = await db.storage.from('resumes').download(probe);
      ok('the uploaded file reads back', !dl.error && !!dl.data, dl.error ? '- ' + dl.error.message : '');

      // A private bucket must refuse an unauthenticated fetch of the public URL.
      const pub = db.storage.from('resumes').getPublicUrl(probe).data.publicUrl;
      const reachable = await fetch(pub).then((r) => r.ok).catch(() => false);
      ok('the bucket is private', !reachable,
        reachable ? '- IT IS PUBLIC; anyone with the URL could read resumes' : '');

      // Writing outside your own folder must be refused by the storage policy.
      const trespass = await db.storage.from('resumes')
        .upload('00000000-0000-0000-0000-000000000000/evil.txt', body);
      ok('cannot write into another account\'s folder', !!trespass.error,
        trespass.error ? '' : '- THE STORAGE POLICY IS NOT ENFORCING THE USER ID PREFIX');

      await db.storage.from('resumes').remove([probe]);
    }
    await db.auth.signOut();
  }
}

console.log('');
if (failed) console.log(failed + ' check(s) failed.');
else console.log('Everything that can be checked from here looks right.');
process.exit(failed ? 1 : 0);

-- Schema for the Easy Apply app.
--
-- Isolation between accounts is enforced by Row Level Security in Postgres,
-- not by the API layer. Every policy compares auth.uid() to the row's user_id,
-- so even a mistake in the backend cannot return another account's rows.
--
-- Apply with the Supabase CLI:   supabase db push
-- or paste into the SQL editor in the Supabase dashboard.

-- ---------------------------------------------------------------- applications

create table if not exists public.applications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  job_id      text not null,
  title       text not null default '',
  company     text not null default '',
  location    text not null default '',
  url         text not null default '',
  status      text not null default 'skipped',
  reason      text not null default '',
  score       integer,
  source      text not null default 'easy',
  ats         text not null default '',
  applied_at  timestamptz not null,
  synced_at   timestamptz not null default now(),

  -- One row per job per account: this is what makes re-syncing a run safe.
  constraint applications_user_job_unique unique (user_id, job_id),
  constraint applications_status_check check (
    status in ('applied', 'needs_manual', 'failed', 'dry_run', 'skipped')
  ),
  constraint applications_source_check check (source in ('easy', 'portal')),
  constraint applications_score_check check (score is null or (score >= 0 and score <= 100))
);

create index if not exists applications_user_time_idx
  on public.applications (user_id, applied_at desc);
create index if not exists applications_user_status_idx
  on public.applications (user_id, status);
create index if not exists applications_user_company_idx
  on public.applications (user_id, company);

alter table public.applications enable row level security;

drop policy if exists "applications are private to their owner" on public.applications;
create policy "applications are private to their owner"
  on public.applications
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------------- resumes

create table if not exists public.resumes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  filename     text not null,
  mime         text not null default 'application/octet-stream',
  size         integer not null,
  sha256       text not null,
  storage_path text not null,          -- object key inside the 'resumes' bucket
  text_content text,                   -- extracted plain text
  profile      jsonb,                  -- the parsed profile the extension built
  uploaded_at  timestamptz not null default now(),
  is_current   boolean not null default false
);

create index if not exists resumes_user_idx on public.resumes (user_id, uploaded_at desc);

-- At most one current resume per account, enforced by the database rather than
-- by whichever code path happens to write last.
create unique index if not exists resumes_one_current_per_user
  on public.resumes (user_id) where is_current;

alter table public.resumes enable row level security;

drop policy if exists "resumes are private to their owner" on public.resumes;
create policy "resumes are private to their owner"
  on public.resumes
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------- resume storage

-- Private bucket. Files are addressed as <user_id>/<uuid>-<filename>, and the
-- policies below key off that first path segment.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes', 'resumes', false, 8388608,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain'
  ]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "resume files are private to their owner" on storage.objects;
create policy "resume files are private to their owner"
  on storage.objects
  for all
  to authenticated
  using (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'resumes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ------------------------------------------------------------------ analytics

-- Aggregates for the dashboard, computed in Postgres instead of by shipping
-- every row to the browser. security invoker keeps RLS in force.
create or replace function public.application_stats(since timestamptz default '-infinity')
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'total',   (select count(*) from applications a where a.applied_at >= since),
    'applied', (select count(*) from applications a where a.applied_at >= since and a.status = 'applied'),
    'byStatus', coalesce((
      select json_agg(x) from (
        select status, count(*) as n from applications a
        where a.applied_at >= since group by status order by n desc
      ) x), '[]'::json),
    'bySource', coalesce((
      select json_agg(x) from (
        select source, count(*) as n from applications a
        where a.applied_at >= since group by source
      ) x), '[]'::json),
    'topCompanies', coalesce((
      select json_agg(x) from (
        select company, count(*) as n from applications a
        where a.applied_at >= since and company <> ''
        group by company order by n desc limit 10
      ) x), '[]'::json)
  );
$$;

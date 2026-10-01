-- Favourite companies: the server reads their careers boards on a schedule,
-- ranks new postings against your resume, and puts the good matches on your
-- job list (0006) for the extension to apply to.
--
-- Safe to run on a database that already has 0001-0006 applied. The schedule
-- itself (pg_cron calling the API) is set up separately: see README.md,
-- "Favourite companies".

create table if not exists public.company_watch (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enabled        boolean not null default false,
  interval_hours integer not null default 24,
  companies      jsonb not null default '[]'::jsonb,   -- [{ name, ats, slug }]
  locations      text not null default '',             -- only postings in these places; '' = anywhere
  tz             text not null default '',             -- for the times in the email
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  last_result    jsonb,
  updated_at     timestamptz not null default now(),

  constraint company_watch_interval_check check (interval_hours between 1 and 168),
  constraint company_watch_companies_check check (jsonb_typeof(companies) = 'array')
);

-- What the scheduler looks for: switched on and due.
create index if not exists company_watch_due_idx
  on public.company_watch (next_run_at) where enabled;

alter table public.company_watch enable row level security;

drop policy if exists "company watch is private to its owner" on public.company_watch;
create policy "company watch is private to its owner"
  on public.company_watch
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Postings already considered, so each check only ranks what is new.
create table if not exists public.company_seen (
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  posting  text not null,                 -- '<board>:<company>:<posting id>'
  seen_at  timestamptz not null default now(),
  primary key (user_id, posting)
);

alter table public.company_seen enable row level security;

drop policy if exists "seen postings are private to their owner" on public.company_seen;
create policy "seen postings are private to their owner"
  on public.company_seen
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Your job list: links the extension applies to before it searches the job
-- boards. Filled from a spreadsheet you upload on the website ('list'), and
-- later by the favourite-companies check ('company').
--
-- Safe to run on a database that already has 0001-0005 applied.

create table if not exists public.job_queue (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  url       text not null,
  title     text not null default '',
  company   text not null default '',
  location  text not null default '',
  origin    text not null default 'list',
  status    text not null default 'pending',
  result    text not null default '',     -- the application's status, once done
  reason    text not null default '',
  score     integer,
  note      text not null default '',     -- why it was picked (company finds)
  added_at  timestamptz not null default now(),
  done_at   timestamptz,

  -- A link is on the list once; adding it again is a no-op.
  constraint job_queue_user_url_unique unique (user_id, url),
  constraint job_queue_origin_check check (origin in ('list', 'company')),
  constraint job_queue_status_check check (status in ('pending', 'done')),
  constraint job_queue_score_check check (score is null or (score >= 0 and score <= 100)),
  constraint job_queue_url_check check (url ~* '^https?://' and length(url) <= 2000)
);

create index if not exists job_queue_user_status_idx
  on public.job_queue (user_id, status, added_at);

alter table public.job_queue enable row level security;

drop policy if exists "the job list is private to its owner" on public.job_queue;
create policy "the job list is private to its owner"
  on public.job_queue
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Applications made from the list to a company's own site belong to no job
-- board; they are recorded under 'direct'.
alter table public.applications drop constraint if exists applications_site_check;
alter table public.applications
  add constraint applications_site_check check (site in ('linkedin', 'naukri', 'indeed', 'direct'));

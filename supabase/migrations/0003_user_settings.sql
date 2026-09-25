-- Per-account settings that follow you between the extension and the web app.
--
-- min_score is the ranking threshold: the ranker scores every job 0-100 and
-- anything below this is never applied to.
--
-- Safe to run on a database that already has 0001 and 0002 applied.

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  min_score  integer not null default 60,
  updated_at timestamptz not null default now(),

  constraint user_settings_min_score_check check (min_score between 0 and 100)
);

alter table public.user_settings enable row level security;

drop policy if exists "settings are private to their owner" on public.user_settings;
create policy "settings are private to their owner"
  on public.user_settings
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

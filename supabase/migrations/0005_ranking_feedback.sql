-- What the ranker needs to be checked against reality.
--
--   description   the posting text the ranker scored, as the extension read it.
--                 Without it a rated job cannot be scored again by a newer
--                 ranker, so there would be nothing to compare.
--   feedback      your own verdict on the match: 'good' (worth applying to) or
--                 'bad' (not). Set from the dashboard, never by a run.
--   feedback_at   when you gave it.
--
-- Postgres compresses long text on its own, so a few KB of posting costs
-- rather less than that on disk.
--
-- Safe to run on a database that already has 0001-0004 applied.

alter table public.applications
  add column if not exists description text not null default '',
  add column if not exists feedback text,
  add column if not exists feedback_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'applications_feedback_check') then
    alter table public.applications
      add constraint applications_feedback_check check (feedback is null or feedback in ('good', 'bad'));
  end if;
end $$;

-- The export reads only rated rows.
create index if not exists applications_user_feedback_idx
  on public.applications (user_id) where feedback is not null;

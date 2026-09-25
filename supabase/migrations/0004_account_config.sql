-- Every setting lives on the account now: the web app edits it, the extension
-- downloads it before each run and does what it says.
--
--   config             search, job boards, matching, schedule, safety, company
--                      portals, answer rules, resume strategy - one JSON
--                      document, section by section. The ranking threshold
--                      stays in min_score.
--   unknown_questions  questions a run could not answer, reported by the
--                      extension so they can be turned into rules on the web.
--
-- Safe to run on a database that already has 0001-0003 applied.

alter table public.user_settings
  add column if not exists config jsonb not null default '{}'::jsonb,
  add column if not exists unknown_questions jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_settings_config_is_object') then
    alter table public.user_settings
      add constraint user_settings_config_is_object check (jsonb_typeof(config) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_settings_unknown_is_array') then
    alter table public.user_settings
      add constraint user_settings_unknown_is_array check (jsonb_typeof(unknown_questions) = 'array');
  end if;
end $$;

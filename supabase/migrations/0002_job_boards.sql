-- Adds the job board an application came from.
--
-- Before this, every application was a LinkedIn one, so existing rows default
-- to 'linkedin' and nothing needs backfilling by hand.
--
-- Safe to run on a database that already has 0001 applied.

alter table public.applications
  add column if not exists site text not null default 'linkedin';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_site_check'
  ) then
    alter table public.applications
      add constraint applications_site_check check (site in ('linkedin', 'naukri', 'indeed'));
  end if;
end $$;

create index if not exists applications_user_site_idx
  on public.applications (user_id, site);

-- job_id is only unique within a board, so the uniqueness key has to include
-- it. Rebuilt rather than altered, since a unique constraint cannot be widened
-- in place.
alter table public.applications
  drop constraint if exists applications_user_job_unique;

create unique index if not exists applications_user_site_job_unique
  on public.applications (user_id, site, job_id);

-- The stats function gains a board breakdown.
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
    'bySite', coalesce((
      select json_agg(x) from (
        select site, count(*) as n from applications a
        where a.applied_at >= since group by site order by n desc
      ) x), '[]'::json),
    'topCompanies', coalesce((
      select json_agg(x) from (
        select company, count(*) as n from applications a
        where a.applied_at >= since and company <> ''
        group by company order by n desc limit 10
      ) x), '[]'::json)
  );
$$;

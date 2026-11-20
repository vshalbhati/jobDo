-- Emailing the hiring team from your own Gmail.
--
--   applications.contact_emails  addresses the job posting itself gave
--                                ("send your CV to hr@acme.com"), comma
--                                separated, at most three. Filled by the
--                                backend from the posting text; never typed in.
--   applications.emailed_at /    when you mailed them from the dashboard, and
--   applications.emailed_to      which address.
--
--   user_mailbox                 your Gmail address and its app password, which
--                                the backend sends that mail with. The password
--                                is sealed by the backend (AES-256-GCM, with
--                                MAIL_SECRET_KEY, a key that exists only in the
--                                backend's environment) before it is stored, so
--                                this table never holds it readable: not to the
--                                database, a backup, or anyone with SQL access.
--                                It is bound to your account, so a sealed value
--                                copied to another account does not open.
--
-- Safe to run on a database that already has 0001-0007 applied.

alter table public.applications
  add column if not exists contact_emails text not null default '',
  add column if not exists emailed_at timestamptz,
  add column if not exists emailed_to text not null default '';

-- Postings already saved: take the first address in each. New ones are read
-- by the backend, which also understands "hr [at] acme [dot] com".
with found as (
  select id,
         lower(substring(description from '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')) as email
  from public.applications
  where contact_emails = '' and description like '%@%'
)
update public.applications a
set contact_emails = f.email
from found f
where a.id = f.id
  and f.email is not null
  and f.email !~ '(no-?reply|do-?not-?reply|example\.(com|org|net)|\.(png|jpe?g|gif|svg|webp)$)';

create table if not exists public.user_mailbox (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  address     text not null,
  secret      text not null,                 -- v1.<iv>.<tag>.<ciphertext>, sealed by the backend
  subject     text not null default '',
  body        text not null default '',
  verified_at timestamptz,
  updated_at  timestamptz not null default now(),
  constraint user_mailbox_address_check check (char_length(address) between 3 and 254),
  constraint user_mailbox_secret_check  check (secret like 'v1.%'),
  constraint user_mailbox_subject_check check (char_length(subject) <= 200),
  constraint user_mailbox_body_check    check (char_length(body) <= 5000)
);

alter table public.user_mailbox enable row level security;

drop policy if exists "own mailbox: read"   on public.user_mailbox;
drop policy if exists "own mailbox: insert" on public.user_mailbox;
drop policy if exists "own mailbox: update" on public.user_mailbox;
drop policy if exists "own mailbox: delete" on public.user_mailbox;

create policy "own mailbox: read"   on public.user_mailbox for select using (auth.uid() = user_id);
create policy "own mailbox: insert" on public.user_mailbox for insert with check (auth.uid() = user_id);
create policy "own mailbox: update" on public.user_mailbox for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own mailbox: delete" on public.user_mailbox for delete using (auth.uid() = user_id);

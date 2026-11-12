-- DigiMenu — migration 0012: real admin users, with rights.
--
-- Until now the operator console was one shared ADMIN_TOKEN: whoever held the
-- string was the admin, anonymously. This gives admins an identity — a Supabase
-- user (email + password, changeable from the console, resettable by email) and
-- a row here saying what that person may do.
--
-- Rights are deliberately small and additive:
--
--   view        see the restaurant list
--   export      download it as CSV
--   pay_view    see what each restaurant paid and its reference
--   pay_entry   record a payment, stop an account, connect a domain
--   admins      create and remove other admins, and set their rights
--
-- The shared ADMIN_TOKEN keeps working as a break-glass fallback for the CLI,
-- so a lost admin account can never lock the operator out of their own product.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

create table if not exists public.admin_users (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,

  -- what the admin types at the door: "dmin" for @dmin. Stored without the @,
  -- lowercased, unique. The email stays behind it and is only ever used to
  -- send a temporary password — never to sign in.
  username    text not null,
  email       text not null,
  name        text,                 -- what the audit line says: "@dmin"
  perms       text[] not null default '{view}',

  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null,
  last_seen   timestamptz
);

alter table public.admin_users drop constraint if exists admin_users_perms_check;
alter table public.admin_users add constraint admin_users_perms_check
  check (perms <@ array['view', 'export', 'pay_view', 'pay_entry', 'admins']);

create index if not exists admin_users_user_idx on public.admin_users (user_id);

-- one person, one id: "dmin" cannot be handed to two admins
create unique index if not exists admin_users_username_key
  on public.admin_users (lower(username));

create unique index if not exists admin_users_email_key
  on public.admin_users (lower(email));

alter table public.admin_users drop constraint if exists admin_users_username_check;
alter table public.admin_users add constraint admin_users_username_check
  check (username ~ '^[a-z0-9][a-z0-9._-]{1,23}$');

-- Service key only. The API reads this through the caller's token; nothing in
-- a browser can grant itself a right.
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

notify pgrst, 'reload schema';

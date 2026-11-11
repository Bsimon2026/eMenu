-- DigiMenu — migration 0008: staff logins under the restaurant's own address.
--
-- The owner creates a person with a NAME and a PASSWORD, inside his own panel.
-- No email, no invitation, nothing to verify: he writes the two fields, hands
-- them over himself, and that is the whole onboarding.
--
-- How a name can be a login at all: Supabase authenticates with an email and a
-- password, and nothing else. So the server turns (handle + name) into a
-- synthetic, undeliverable address —
--
--     owner of spice-route creates "ali"  ->  ali@spice-route.staff.digimenu.internal
--
-- The handle is baked into the address by the SERVER, never typed by the person
-- signing in. "ali" at spice-route and "ali" at another restaurant are two
-- different addresses, so a name can only ever open the menu of the restaurant
-- whose address it was created under. That is the isolation requirement, and it
-- is enforced at the identity layer rather than by a check somebody could skip.
--
-- This table is the rest of it: which restaurant a login belongs to, and what
-- it is allowed to do.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

create table if not exists public.restaurant_members (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- what the owner typed, and what the person types at the staff door
  username      text not null check (username ~ '^[a-z0-9][a-z0-9._-]{1,23}$'),

  -- 'menu'   edit dishes and the guest page, upload photos
  -- 'orders' read and advance orders, mark dishes sold out
  -- publishing, the plan and the team itself stay with the owner
  role          text not null default 'orders' check (role in ('menu', 'orders')),

  created_at    timestamptz not null default now()
);

-- one name per restaurant: "ali" may exist in ten restaurants, once in each
create unique index if not exists members_name_per_restaurant
  on public.restaurant_members (restaurant_id, lower(username));

-- one login, one restaurant: a person is never a member twice
create unique index if not exists members_one_restaurant
  on public.restaurant_members (user_id);

create index if not exists members_restaurant_idx
  on public.restaurant_members (restaurant_id);

-- Service key only. The API resolves every request through the caller's token
-- and the service key; nothing reaches this table from a browser, so there is
-- no policy to write and no policy to get wrong.
alter table public.restaurant_members enable row level security;
revoke all on public.restaurant_members from anon, authenticated;

notify pgrst, 'reload schema';

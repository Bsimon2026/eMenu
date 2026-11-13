-- DigiMenu — migration 0019: discount codes.
--
-- A code gives a percentage off, optionally capped in money, and can be used
-- once per customer — "once" keyed on the phone number, because that is the
-- only identity a guest has here. The cap is what stops a 30% code from
-- gutting a large delivery order.
--
-- Orders learn four columns: what the food cost before anything, what was
-- taken off, the delivery charge the restaurant added, and the final payable.
-- `total` stays the final payable so every existing reader stays correct.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

create table if not exists public.discounts (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  code          text not null,
  percent       numeric(5,2) not null check (percent > 0 and percent <= 100),
  max_amount    numeric(10,2) check (max_amount is null or max_amount > 0),
  min_order     numeric(10,2) not null default 0 check (min_order >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create unique index if not exists discounts_code_key
  on public.discounts (restaurant_id, upper(code));

create table if not exists public.discount_redemptions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  discount_id   uuid not null references public.discounts (id) on delete cascade,
  code          text not null,
  phone         text not null,                    -- digits only
  order_id      uuid references public.orders (id) on delete set null,
  amount        numeric(10,2) not null,
  created_at    timestamptz not null default now()
);

-- once per customer, per code
create unique index if not exists discount_redemptions_once
  on public.discount_redemptions (discount_id, phone);
create index if not exists discount_redemptions_order
  on public.discount_redemptions (order_id);

alter table public.orders
  add column if not exists subtotal        numeric(10,2),
  add column if not exists delivery_fee    numeric(10,2) not null default 0,
  add column if not exists discount_code   text,
  add column if not exists discount_amount numeric(10,2) not null default 0;

alter table public.discounts enable row level security;
alter table public.discount_redemptions enable row level security;
revoke all on public.discounts from anon, authenticated;
revoke all on public.discount_redemptions from anon, authenticated;

notify pgrst, 'reload schema';

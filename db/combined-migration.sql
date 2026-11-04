-- ============================================================
-- schema.sql
-- ============================================================
-- DigiMenu — Supabase schema (phase 1)
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- Auth is Supabase's own (auth.users). Every restaurant belongs to one owner;
-- staff and service code reach it through RLS, never through a shared key.
--
-- Conventions
--   money        numeric(10,2) in AED (exact, no floats)
--   phone        E.164 with the leading +, e.g. +971525757079
--   timestamps   timestamptz, always UTC

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- restaurants
create table if not exists restaurants (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,

  name            text not null check (length(btrim(name)) between 2 and 80),
  owner_name      text,
  handle          text not null check (handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),

  -- how the menu takes orders
  purposes        text[] not null default '{Dine In,Take Away}'
                  check (purposes <@ array['Dine In','Take Away','Delivery']),

  -- orders land here; this is the number the guest's WhatsApp opens
  whatsapp_e164   text not null check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  order_email     text not null check (order_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'),

  -- publishing gate: nothing is public until these exist
  logo_url        text,
  licence_url     text,
  maps_url        text,

  status          text not null default 'trial' check (status in ('trial','published','suspended')),
  city            text default 'Abu Dhabi',
  accent          text default '#f7941d',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  published_at    timestamptz
);

-- the address printed on every QR: one restaurant per handle, for ever
create unique index if not exists restaurants_handle_key on restaurants (lower(handle));
create index if not exists restaurants_owner_idx on restaurants (owner_id);

-- ------------------------------------------------------------------- the menu
create table if not exists menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  position      int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists menu_categories_restaurant_idx on menu_categories (restaurant_id, position);

create table if not exists menu_items (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants (id) on delete cascade,
  category_id   uuid not null references menu_categories (id) on delete cascade,

  name          text not null check (length(btrim(name)) between 1 and 120),
  description   text,
  price         numeric(10,2) not null check (price >= 0),
  was_price     numeric(10,2) check (was_price >= 0),

  image_url     text,
  diet          text check (diet in ('veg','nonveg')) ,
  sold_out      boolean not null default false,   -- the switch staff use mid-service
  has_choices   boolean not null default false,
  position      int not null default 0,

  source        text default 'manual' check (source in ('manual','photo','talabat','noon','deliveroo','spreadsheet')),
  source_id     text,                              -- the platform's own id, for re-import

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists menu_items_restaurant_idx on menu_items (restaurant_id, category_id, position);
create unique index if not exists menu_items_source_key
  on menu_items (restaurant_id, source, source_id)
  where source_id is not null;

-- --------------------------------------------------------------------- orders
create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants (id) on delete cascade,

  mode          text not null check (mode in ('Dine In','Take Away','Delivery')),
  table_no      text,
  pickup_at     timestamptz,
  address       text,

  guest_name    text not null,
  guest_phone   text,
  total         numeric(10,2) not null check (total >= 0),

  -- the record is created when the guest is handed to WhatsApp, not when they
  -- press send. Do not report these as confirmed sales.
  status        text not null default 'awaiting_confirmation'
                check (status in ('awaiting_confirmation','confirmed','cancelled','abandoned')),
  emailed_at    timestamptz,
  email_error   text,

  created_at    timestamptz not null default now()
);

create index if not exists orders_restaurant_created_idx on orders (restaurant_id, created_at desc);

create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders (id) on delete cascade,
  menu_item_id uuid references menu_items (id) on delete set null,
  name         text not null,                    -- copied: menus change, receipts must not
  unit_price   numeric(10,2) not null check (unit_price >= 0),
  qty          int not null check (qty > 0)
);

create index if not exists order_items_order_idx on order_items (order_id);

-- -------------------------------------------------------------------- imports
create table if not exists imports (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants (id) on delete cascade,
  source        text not null check (source in ('photo','pdf','talabat','noon','deliveroo','spreadsheet','manual')),
  source_url    text,
  status        text not null default 'pending'
                check (status in ('pending','parsed','applied','failed')),
  item_count    int default 0,
  error_code    text,
  error_message text,
  payload       jsonb,                            -- what the reader returned, for audit
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists imports_restaurant_idx on imports (restaurant_id, created_at desc);

-- --------------------------------------------------------------- updated_at
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists restaurants_touch on restaurants;
create trigger restaurants_touch before update on restaurants
  for each row execute function touch_updated_at();

drop trigger if exists menu_items_touch on menu_items;
create trigger menu_items_touch before update on menu_items
  for each row execute function touch_updated_at();

-- ----------------------------------------------------------------------- RLS
alter table restaurants     enable row level security;
alter table menu_categories enable row level security;
alter table menu_items      enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table imports         enable row level security;

-- an owner sees and edits only their restaurant
drop policy if exists restaurants_owner_all on restaurants;
create policy restaurants_owner_all on restaurants
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- the public guest menu: published restaurants only, read only
drop policy if exists restaurants_public_read on restaurants;
create policy restaurants_public_read on restaurants
  for select using (status = 'published');

drop policy if exists categories_owner_all on menu_categories;
create policy categories_owner_all on menu_categories
  for all using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  ) with check (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  );

drop policy if exists categories_public_read on menu_categories;
create policy categories_public_read on menu_categories
  for select using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.status = 'published')
  );

drop policy if exists items_owner_all on menu_items;
create policy items_owner_all on menu_items
  for all using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  ) with check (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  );

drop policy if exists items_public_read on menu_items;
create policy items_public_read on menu_items
  for select using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.status = 'published')
  );

-- orders are written by the guest (anonymous) and read by the owner
drop policy if exists orders_public_insert on orders;
create policy orders_public_insert on orders
  for insert with check (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.status = 'published')
  );

drop policy if exists orders_owner_read on orders;
create policy orders_owner_read on orders
  for select using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  );

drop policy if exists orders_owner_update on orders;
create policy orders_owner_update on orders
  for update using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  );

drop policy if exists order_items_public_insert on order_items;
create policy order_items_public_insert on order_items
  for insert with check (
    exists (
      select 1 from orders o
      join restaurants r on r.id = o.restaurant_id
      where o.id = order_id and r.status = 'published'
    )
  );

drop policy if exists order_items_owner_read on order_items;
create policy order_items_owner_read on order_items
  for select using (
    exists (
      select 1 from orders o
      join restaurants r on r.id = o.restaurant_id
      where o.id = order_id and r.owner_id = auth.uid()
    )
  );

drop policy if exists imports_owner_all on imports;
create policy imports_owner_all on imports
  for all using (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  ) with check (
    exists (select 1 from restaurants r where r.id = restaurant_id and r.owner_id = auth.uid())
  );

-- ============================================================
-- 0002_public_surface.sql
-- ============================================================
-- DigiMenu — migration 0002: close the public surface
--
-- Problem this fixes:
--   RLS filters ROWS, not COLUMNS. `restaurants_public_read` lets anyone read a
--   published restaurant, which also exposed order_email, licence_url and
--   owner_id to the anon key. Verified: an anon select returned them.
--
-- Fix: constrain what anon may SELECT at the column level. RLS keeps filtering
-- rows (published only); grants narrow the columns. Nothing else changes:
-- owners still read and write their own row in full through `authenticated`.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

-- ---------------------------------------------------------------------------
-- 1. the public restaurant row: only what a guest page needs
-- ---------------------------------------------------------------------------
revoke select on public.restaurants from anon;

grant select (
  id,
  name,
  handle,
  purposes,
  whatsapp_e164,   -- public by design: it is the number the guest messages
  logo_url,
  maps_url,
  status,
  city,
  accent
) on public.restaurants to anon;

-- licence_url, order_email and owner_id are now unreadable with the anon key.
-- They stay readable to the owning restaurant through `authenticated`.

-- ---------------------------------------------------------------------------
-- 2. menu data: fine as-is (nothing private), but be explicit rather than
--    relying on the default grant
-- ---------------------------------------------------------------------------
grant select on public.menu_categories to anon;
grant select on public.menu_items to anon;

-- ---------------------------------------------------------------------------
-- 3. guests may create an order but must never read one back
--    (no select policy on orders for anon — already true; stated here so a
--    future edit does not "helpfully" add one)
-- ---------------------------------------------------------------------------
-- NOTE for the API: insert orders WITHOUT `Prefer: return=representation`.
-- PostgREST turns that into INSERT .. RETURNING, which needs a SELECT policy
-- and will fail with 42501 even though the insert itself is allowed.

-- ---------------------------------------------------------------------------
-- 4. make PostgREST pick up the new grants immediately
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ============================================================
-- 0003_published_helper.sql
-- ============================================================
-- DigiMenu — migration 0003: policies that do not read the locked table
--
-- Why this exists:
--   0002 revoked anon's table-wide SELECT on `restaurants` and re-granted only
--   the public columns. The menu policies were written as subqueries:
--     exists (select 1 from restaurants r where r.id = restaurant_id and r.status = 'published')
--   A subquery inside a policy is evaluated as the calling role, which no longer
--   holds table-level SELECT on `restaurants`. Result, verified:
--     anon select menu_items -> 401 "permission denied for table restaurants"
--
--   Fix: one security-definer helper that answers "is this restaurant published?"
--   with the function owner's rights. It returns a boolean and reveals nothing
--   else about the row.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

create or replace function public.restaurant_is_published(rid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.restaurants r
    where r.id = rid and r.status = 'published'
  );
$$;

-- anyone may ask the question, nobody may rewrite the function
revoke all on function public.restaurant_is_published(uuid) from public;
grant execute on function public.restaurant_is_published(uuid) to anon, authenticated;

-- ---------------------------------------------------------------- menu reads
drop policy if exists categories_public_read on public.menu_categories;
create policy categories_public_read on public.menu_categories
  for select using (public.restaurant_is_published(restaurant_id));

drop policy if exists items_public_read on public.menu_items;
create policy items_public_read on public.menu_items
  for select using (public.restaurant_is_published(restaurant_id));

-- --------------------------------------------------------------- guest writes
drop policy if exists orders_public_insert on public.orders;
create policy orders_public_insert on public.orders
  for insert with check (public.restaurant_is_published(restaurant_id));

drop policy if exists order_items_public_insert on public.order_items;
create policy order_items_public_insert on public.order_items
  for insert with check (
    exists (
      select 1 from public.orders o
      where o.id = order_id and public.restaurant_is_published(o.restaurant_id)
    )
  );

-- the anonymous `restaurant_is_published` probe is harmless (boolean only), but
-- do not let anyone enumerate handles through it: it takes an id, never a slug.

notify pgrst, 'reload schema';

-- ============================================================
-- 0004_public_identity.sql
-- ============================================================
-- DigiMenu — migration 0004: the restaurant's public identity
--
-- What this adds:
--   currency      the restaurant picks it once; every price on the menu, in the
--                 cart, in the WhatsApp message and on the review screen uses it
--   tagline       one line under the name on the guest landing page
--   address_line  the street address shown with the map link
--   instagram / facebook / tiktok / website   social handles for the guest page
--   cover_url     a wide photo for the guest hero, if they have one
--
-- None of these are readable with the anon key: 0002 granted anon a fixed list
-- of columns, and these are not in it. The guest page receives them from
-- /api/menu, which reads server-side and shapes the response.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

alter table public.restaurants
  add column if not exists currency     text not null default 'AED',
  add column if not exists tagline      text,
  add column if not exists address_line text,
  add column if not exists instagram    text,
  add column if not exists facebook     text,
  add column if not exists tiktok       text,
  add column if not exists website      text,
  add column if not exists cover_url    text;

-- currency must be an ISO code, not free text: the UI maps it to a symbol
alter table public.restaurants
  drop constraint if exists restaurants_currency_shape;
alter table public.restaurants
  add constraint restaurants_currency_shape
  check (currency ~ '^[A-Z]{3}$');

-- a handle is stored bare ("ushna.abudhabi"), not as a URL
alter table public.restaurants
  drop constraint if exists restaurants_social_shape;
alter table public.restaurants
  add constraint restaurants_social_shape
  check (
    (instagram is null or length(instagram) <= 60) and
    (facebook  is null or length(facebook)  <= 60) and
    (tiktok    is null or length(tiktok)    <= 60) and
    (website   is null or website ~ '^https?://')
  );

notify pgrst, 'reload schema';

-- ============================================================
-- 0005_item_categories.sql
-- ============================================================
-- DigiMenu — migration 0005: one dish, several categories
--
-- Until now menu_items.category_id said a dish belonged to exactly one
-- category. Restaurants need a dish in "Offers" AND in "Grills", so membership
-- becomes a join table.
--
-- menu_items.category_id is kept as the dish's primary category (nothing that
-- already works breaks, and the column stays NOT NULL), while extra
-- memberships live in menu_item_categories. A dish with no extra rows behaves
-- exactly as before.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

create table if not exists public.menu_item_categories (
  item_id     uuid not null references public.menu_items (id)     on delete cascade,
  category_id uuid not null references public.menu_categories (id) on delete cascade,
  position    int  not null default 0,
  primary key (item_id, category_id)
);

create index if not exists menu_item_categories_cat_idx
  on public.menu_item_categories (category_id, position);

-- every existing dish keeps its current category
insert into public.menu_item_categories (item_id, category_id, position)
select id, category_id, position
from public.menu_items
on conflict (item_id, category_id) do nothing;

-- ---------------------------------------------------------------- access
-- The guest page never reads this table directly: /api/menu reads it with the
-- service key. Only the owning restaurant may change it.
alter table public.menu_item_categories enable row level security;

drop policy if exists item_categories_owner_all on public.menu_item_categories;
create policy item_categories_owner_all on public.menu_item_categories
  for all
  using (
    exists (
      select 1
      from public.menu_items i
      join public.restaurants r on r.id = i.restaurant_id
      where i.id = item_id and r.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.menu_items i
      join public.restaurants r on r.id = i.restaurant_id
      where i.id = item_id and r.owner_id = auth.uid()
    )
  );

revoke all on public.menu_item_categories from anon;
grant select, insert, update, delete on public.menu_item_categories to authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- 0006_featured_categories.sql
-- ============================================================
-- DigiMenu — migration 0006: promo categories that come first
--
-- "Best Sellers", "Today's Offer", "Chef's Special" are not menu sections in
-- the same sense as Starters — they are shelves the restaurant wants a guest to
-- see before anything else. A flagged category is served first and marked on
-- the guest page; the owner decides, per category.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.
-- Safe to run after 0005, or together with it.

alter table public.menu_categories
  add column if not exists is_featured boolean not null default false;

-- featured categories sort ahead of the rest, then by the owner's own order
create index if not exists menu_categories_featured_idx
  on public.menu_categories (restaurant_id, is_featured desc, position);

notify pgrst, 'reload schema';

-- ============================================================
-- 0007_plans.sql
-- ============================================================
-- 0007 — plans, the paywall, and the fields Stripe will fill later.
--
-- Manual for now: an operator records that money arrived, which sets paid_through.
-- When Stripe is connected it writes the same columns, so nothing downstream
-- has to change — only who sets them.

alter table restaurants
  add column if not exists plan           text not null default 'qr',      -- 'qr' | 'order'
  add column if not exists billing        text not null default 'monthly', -- 'monthly' | 'yearly'
  add column if not exists paid_through   date,                            -- null = never paid
  add column if not exists paid_amount    numeric(10, 2),
  add column if not exists pay_ref        text,                            -- transfer ref, cash note, later stripe id
  add column if not exists pay_method     text not null default 'manual',  -- 'manual' | 'stripe'
  add column if not exists activated_at   timestamptz,
  add column if not exists addon_site     boolean not null default false,  -- landing page + domain + email add-on
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text;

-- a plan that is not one of the two is a bug, not a variant
alter table restaurants drop constraint if exists restaurants_plan_check;
alter table restaurants add constraint restaurants_plan_check check (plan in ('qr', 'order'));

alter table restaurants drop constraint if exists restaurants_billing_check;
alter table restaurants add constraint restaurants_billing_check check (billing in ('monthly', 'yearly'));

create index if not exists restaurants_paid_idx on restaurants (paid_through);

notify pgrst, 'reload schema';

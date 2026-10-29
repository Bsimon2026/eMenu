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

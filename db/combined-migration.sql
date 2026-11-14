-- DigiMenu — the whole database, from empty.
--
-- GENERATED FILE: do not edit. Built by db/build-combined.sh from
-- schema.sql plus every db/000N_*.sql in order. Run it once on a new
-- Supabase project; on an existing one, run only the migrations it lacks.
--
-- Built: 2026-11-14T07:20:28Z

-- =========================================================== schema.sql
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


-- ==================================================== 0002_public_surface.sql
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

-- ==================================================== 0003_published_helper.sql
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

-- ==================================================== 0004_public_identity.sql
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

-- ==================================================== 0005_item_categories.sql
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

-- ==================================================== 0006_featured_categories.sql
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

-- ==================================================== 0007_plans.sql
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

-- ==================================================== 0008_members.sql
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

-- ==================================================== 0009_marketing.sql
--
-- Every restaurant picks its own sender:
--
--   'free'   the owner's own WhatsApp, one tap per guest (wa.me). No account,
--            no fee, no ban risk — and a human is in the loop, which is what
--            keeps the number that takes the orders safe.
--   'cloud'  WhatsApp Cloud API. The server sends, paced, unattended. Needs a
--            WhatsApp Business account, an approved template and a per-message
--            fee — which is why it is a switch, not the default.
--
-- Both paths write the same row here, so switching later changes only who does
-- the sending: the queue, the tracking and the feedback do not move.
--

alter table restaurants
  add column if not exists sender_mode        text not null default 'free',
  add column if not exists wa_phone_number_id text,      -- Cloud API: the sender
  add column if not exists wa_access_token    text,      -- Cloud API: bearer, secret
  add column if not exists wa_template        text,      -- approved template name
  add column if not exists wa_template_lang   text default 'en',
  add column if not exists google_review_url  text;      -- where a happy guest is sent

alter table restaurants drop constraint if exists restaurants_sender_check;
alter table restaurants add constraint restaurants_sender_check
  check (sender_mode in ('free', 'cloud'));

-- ---------------------------------------------------------------- the asks
create table if not exists public.review_requests (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id      uuid references public.orders (id) on delete set null,

  phone         text not null,          -- normalised: digits only, with country code
  phone_raw     text,                   -- exactly what the guest typed
  guest_name    text,
  token         text not null unique,   -- what the feedback link carries

  -- queued → opened (free: the chat was opened) → sent | failed | skipped
  status        text not null default 'queued'
                check (status in ('queued', 'opened', 'sent', 'failed', 'skipped')),
  error         text,
  sent_at       timestamptz,
  opened_at     timestamptz,

  rating        int check (rating between 1 and 5),
  comment       text,
  created_at    timestamptz not null default now()
);

-- one ask per order, so pressing the button twice cannot double-message anyone
create unique index if not exists review_requests_per_order
  on public.review_requests (restaurant_id, order_id)
  where order_id is not null;

create index if not exists review_requests_phone_idx
  on public.review_requests (restaurant_id, phone);
create index if not exists review_requests_status_idx
  on public.review_requests (restaurant_id, status);
create index if not exists review_requests_token_idx
  on public.review_requests (token);

-- Service key only: the queue is written by the API, the feedback is recorded
-- through the API, and a guest's phone number is never readable from a browser.
alter table public.review_requests enable row level security;
revoke all on public.review_requests from anon, authenticated;

notify pgrst, 'reload schema';

-- ==================================================== 0010_domains.sql
--
-- One project, many domains. A customer points their domain at the same Vercel
-- deployment and the deployment works out which restaurant it is from the Host
-- header — no second website, no second database, no second deploy.
--
--   restaurant.com  ──CNAME/A──▶  cname.vercel-dns.com / 76.76.21.21
--                                  └─ Host: restaurant.com → this row → that menu
--
-- custom_domain is stored bare and lowercase, without www: a request from
-- www.restaurant.com is looked up as restaurant.com.
--
-- domain_status is what Vercel says, not what we wish:
--   'pending'  added to the project, DNS not pointing here yet
--   'live'     verified and the certificate is issued
--

alter table restaurants
  add column if not exists custom_domain    text,
  add column if not exists domain_status    text,
  add column if not exists domain_added_at  timestamptz,
  add column if not exists domain_error     text;

-- one domain belongs to one restaurant, for ever
create unique index if not exists restaurants_domain_key
  on public.restaurants (lower(custom_domain))
  where custom_domain is not null;

alter table restaurants drop constraint if exists restaurants_domain_status_check;
alter table restaurants add constraint restaurants_domain_status_check
  check (domain_status is null or domain_status in ('pending', 'live', 'error'));

-- the guest page looks a restaurant up by its domain on every visit
create index if not exists restaurants_domain_idx
  on public.restaurants (lower(custom_domain));

notify pgrst, 'reload schema';

-- ==================================================== 0011_trial.sql
--
-- A new restaurant gets seven days with everything switched on — publishing,
-- the guest page, ordering — and no card. After that the paywall is exactly what
-- it was: the menu stays built and private until a payment exists, which the
-- operator records from the admin panel when the money actually arrives.
--
-- Two columns, because "in a trial" and "has paid" are different facts:
--
--   trial_ends            the last day the trial is good for
--   trial_granted_at      when it was given, so it can only ever be given once
--
-- A restaurant is live while paid_through >= today OR trial_ends >= today.
--

alter table restaurants
  add column if not exists trial_ends       date,
  add column if not exists trial_granted_at timestamptz;

-- nothing else to change: the paywall reads paid_through, and
-- restaurant.js/api/menu.js now check the trial alongside it.

-- Backfill: anything that already exists and has never paid keeps its current
-- state. Existing live restaurants get no trial (they are on a paid period);
-- trial rows already created before this migration get their seven days.
update restaurants
   set trial_ends = (now() at time zone 'utc')::date + 7,
       trial_granted_at = now()
 where trial_ends is null
   and trial_granted_at is null
   and paid_through is null;

notify pgrst, 'reload schema';

-- ==================================================== 0012_admin.sql
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

-- ==================================================== 0013_payments.sql
--
-- Until now a payment was a side effect: recording one overwrote paid_through
-- and the previous amount was simply gone. That is fine for "is this account
-- live" and useless for "what did this customer ever pay us".
--
-- payments is an append-only record. paid_through on the restaurant stays the
-- fast answer to "is it live"; this table is the answer to "show me".
--
-- The marketing add-on is a separate thing you sell: $149 to set up and $8.50 a
-- month, recorded as its own line so it can be seen, refunded or stopped
-- without touching the menu subscription.
--

alter table restaurants
  add column if not exists addon_marketing boolean not null default false;

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,

  amount         numeric(10, 2) not null check (amount >= 0),
  currency       text not null default 'USD',

  plan           text,                       -- 'qr' | 'order' | null for a pure add-on
  billing        text,                       -- 'monthly' | 'yearly' | 'one-off'
  kind           text not null default 'subscription'
                 check (kind in ('subscription', 'setup', 'addon')),
  addon          text,                       -- 'marketing' when kind = 'addon'

  period_start   date,
  period_end     date,                       -- the paid_through it produced
  method         text not null default 'manual'
                 check (method in ('manual', 'cash', 'transfer', 'card', 'stripe')),
  reference      text,
  note           text,

  recorded_by    text,                       -- "@dmin", or "ADMIN_TOKEN"
  created_at     timestamptz not null default now()
);

create index if not exists payments_restaurant_idx
  on public.payments (restaurant_id, created_at desc);

-- Service key only: money is written and read by the API, never by a browser.
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;

notify pgrst, 'reload schema';

-- ==================================================== 0015_menu_i18n.sql
--
-- The model writes a draft; the owner edits it, or publishes it as it is.
-- Nothing here marks a translation published on its own — a dish called
-- "Chicken 65" comes back from a translator as something no Arabic menu
-- would print, which is why publishing is a human act.
--

alter table restaurants
  add column if not exists locales text[] not null default array['en'],
  add column if not exists default_locale text not null default 'en';

create table if not exists public.menu_category_translations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_id   uuid not null references public.menu_categories (id) on delete cascade,
  locale        text not null,
  name          text,
  status        text not null default 'draft' check (status in ('draft', 'published')),
  source        text not null default 'machine' check (source in ('machine', 'owner')),
  updated_at    timestamptz not null default now(),
  unique (category_id, locale)
);

create table if not exists public.menu_item_translations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  item_id       uuid not null references public.menu_items (id) on delete cascade,
  locale        text not null,
  name          text,
  description   text,
  status        text not null default 'draft' check (status in ('draft', 'published')),
  source        text not null default 'machine' check (source in ('machine', 'owner')),
  updated_at    timestamptz not null default now(),
  unique (item_id, locale)
);

create index if not exists menu_item_translations_rest
  on public.menu_item_translations (restaurant_id, locale, status);
create index if not exists menu_category_translations_rest
  on public.menu_category_translations (restaurant_id, locale, status);

-- Service key only: a guest reads Arabic through the menu API, never directly.
alter table public.menu_category_translations enable row level security;
alter table public.menu_item_translations enable row level security;
revoke all on public.menu_category_translations from anon, authenticated;
revoke all on public.menu_item_translations from anon, authenticated;

notify pgrst, 'reload schema';

-- ==================================================== 0016_archive_orders.sql
--
-- A duplicate from a double tap, a test the owner ran, a guest who rang back to
-- cancel: none of those should sit in the breakfast list forever, and none of
-- them should be deleted either — the record is the only proof of what was
-- ordered. Archiving hides it from the shift and keeps it on file.
--

alter table orders
  add column if not exists archived_at   timestamptz,
  add column if not exists archive_reason text;

create index if not exists orders_archived
  on public.orders (restaurant_id, archived_at);

notify pgrst, 'reload schema';

-- ==================================================== 0017_order_number.sql
--
-- A restaurant can take orders on the number in its own pocket, or on the
-- WhatsApp Business API number it connected. The API number is what makes the
-- free-for-24-hours series possible: the guest's own order message opens the
-- window, and everything we send after it is not a paid template.
--
-- wa_order_e164 is that API number, typed once. Empty means "orders go to the
-- restaurant's own WhatsApp", which is what every account does today.
--

alter table restaurants
  add column if not exists wa_order_e164 text;

notify pgrst, 'reload schema';

-- ==================================================== 0018_wa_messages.sql
--
-- Every inbound message from a guest, and every message we send, in one table.
-- The inbound row is the important one: it is the only evidence that the
-- 24-hour window is open, and the time it arrived is when the clock started.
--

create table if not exists public.wa_messages (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid references public.restaurants (id) on delete cascade,
  order_id         uuid references public.orders (id) on delete set null,
  wamid            text unique,                  -- Meta's id; the dedupe handle
  direction        text not null default 'in' check (direction in ('in', 'out')),
  phone_number_id  text,
  customer_number  text,                         -- digits only, may be empty for a BSUID identity
  bsuid            text,
  type             text,                         -- text | button | thankyou | accept | ready ...
  body             text,
  verified         boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists wa_messages_rest_time
  on public.wa_messages (restaurant_id, created_at desc);
create index if not exists wa_messages_lookup
  on public.wa_messages (restaurant_id, customer_number, created_at desc);
create index if not exists wa_messages_order
  on public.wa_messages (order_id, created_at desc);

-- Service key only: a guest's conversation is never readable from a browser.
alter table public.wa_messages enable row level security;
revoke all on public.wa_messages from anon, authenticated;

notify pgrst, 'reload schema';

-- ==================================================== 0019_discounts.sql
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

-- ==================================================== 0020_order_email.sql
-- The guest's email address, so the order confirmation can be mailed to them.
-- Name, mobile and email are all required on the guest form from now on.
alter table orders add column if not exists email text;

-- look an order up by the address it was confirmed to
create index if not exists orders_email_idx on orders (lower(email));

-- ==================================================== 0020_plan_pro.sql
--
-- "Ordering Unlimited" is plan = 'pro' (api/superadmin.js PLANS), but the check
-- constraint written in 0007 still says plan in ('qr','order'). Every attempt to
-- put a customer on it fails with 23514, so the plan could be priced, listed and
-- sold and never actually applied. api/menu.js already treats 'pro' as an
-- ordering plan; this is the half the database was missing.
--

alter table public.restaurants drop constraint if exists restaurants_plan_check;
alter table public.restaurants
  add constraint restaurants_plan_check check (plan in ('qr', 'order', 'pro'));

notify pgrst, 'reload schema';

-- DigiMenu — migration 0015: Arabic menu text, written once and reviewed.
--
-- The model writes a draft; the owner edits it, or publishes it as it is.
-- Nothing here marks a translation published on its own — a dish called
-- "Chicken 65" comes back from a translator as something no Arabic menu
-- would print, which is why publishing is a human act.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

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

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

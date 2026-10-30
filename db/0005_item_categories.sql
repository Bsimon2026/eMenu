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

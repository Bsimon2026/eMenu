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

-- 0024 · a waiter is a role, not a workaround
--
-- 0008 defined the staff roles as menu | orders, and the check constraint on
-- restaurant_members.role is what actually decides: a 'tablet' membership was
-- refused by Postgres (23514) while the code happily offered it, which is the
-- same class of bug as 0007's plan list.
--
--   menu    edit dishes, prices, photos, the guest page
--   orders  read orders, advance them, flip sold out — and take tablet orders
--   tablet  a waiter: take the order at the table on the tablet, nothing else.
--           No dashboard, no order history to scroll at home.
--
-- Until this runs, creating a "Tablet orders" login answers NO_TABLET_ROLE and
-- says to use "Orders only", which can already take tablet orders.

alter table restaurant_members drop constraint if exists restaurant_members_role_check;

alter table restaurant_members
  add constraint restaurant_members_role_check
  check (role in ('menu', 'orders', 'tablet'));

comment on column restaurant_members.role is
  'menu = edits the menu; orders = reads and advances orders; tablet = a waiter who only takes dine-in orders on the tablet.';

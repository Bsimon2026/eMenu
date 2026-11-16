-- 0025 — a table is a tab, and the tab is paid
--
-- A waiter does not take one order per table and walk away. They open a table,
-- add to it during the meal, and close it when the bill is paid. Before this
-- column the tablet could only send a fresh order every time, so "how much is
-- table 9 at" had no answer anywhere in the product.
--
-- One column is enough: a tab is the set of tablet orders for one table number
-- that have not been closed yet. Closing stamps them all in the same statement,
-- and the next order at that table starts a new tab. Nothing about a guest's own
-- QR order is touched — those are not the waiter's tab.
--
-- Safe to run twice, and safe to run while the site is live.

alter table orders add column if not exists tab_closed_at timestamptz;

comment on column orders.tab_closed_at is
  'When the waiter closed the bill for this table. Null = the tab is still open.';

-- the tablet asks for open tabs on every order, and the close is the same filter
create index if not exists orders_open_tabs
  on orders (restaurant_id, table_no, created_at)
  where tab_closed_at is null and source = 'tablet';

-- What the rollback would be, if it ever has to happen:
--   drop index if exists orders_open_tabs;
--   alter table orders drop column if exists tab_closed_at;

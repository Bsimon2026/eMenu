-- DigiMenu — migration 0016: archiving an order, with the reason kept.
--
-- A duplicate from a double tap, a test the owner ran, a guest who rang back to
-- cancel: none of those should sit in the breakfast list forever, and none of
-- them should be deleted either — the record is the only proof of what was
-- ordered. Archiving hides it from the shift and keeps it on file.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table orders
  add column if not exists archived_at   timestamptz,
  add column if not exists archive_reason text;

create index if not exists orders_archived
  on public.orders (restaurant_id, archived_at);

notify pgrst, 'reload schema';

-- One order per submit attempt.
--
-- The client sends a key with the order. A second request carrying the same key
-- is answered with the row the first one created, so a double tap, a retried
-- request or a flaky connection can never book the same meal twice. The older
-- guard (same phone and total within two minutes) reads then writes, so two
-- simultaneous requests both pass it — this closes that race.
alter table orders add column if not exists submit_key text;

create unique index if not exists orders_submit_key_idx
  on orders (submit_key)
  where submit_key is not null;

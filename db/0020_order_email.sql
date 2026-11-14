-- The guest's email address, so the order confirmation can be mailed to them.
-- Name, mobile and email are all required on the guest form from now on.
alter table orders add column if not exists email text;

-- look an order up by the address it was confirmed to
create index if not exists orders_email_idx on orders (lower(email));

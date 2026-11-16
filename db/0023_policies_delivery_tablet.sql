-- 0023 · the guest page's own paperwork, the delivery fence, and the staff tablet
--
-- Three things a restaurant needs before it can run an ad onto its own page,
-- quote a delivery, or take an order at the counter:
--
--   · terms_md / privacy_md — the restaurant's own Terms and Privacy Policy.
--     Ads need a landing page with a policy on it, and a platform's policy is
--     not the restaurant's: whoever sells the food has to say so in their own
--     words. Markdown, because it is written in a textarea and rendered once.
--
--   · delivery_radius_km + lat / lng — how far they will deliver, and from
--     where. The fence is drawn from the coordinates taken out of the map link
--     they already gave us (maps_url), so nobody has to type a latitude.
--
--   · orders.source — 'guest' or 'tablet'. A tablet order is taken by staff at
--     the table: it is a real order in the same ledger, and it must never send
--     or expect a WhatsApp message.
--
-- Codes survive the migration landing on either side of a deploy: every write
-- below is guarded, and the handlers fall back to the narrower select when these
-- columns are not there yet.

alter table restaurants
  add column if not exists terms_md          text,
  add column if not exists privacy_md        text,
  add column if not exists delivery_radius_km numeric,
  add column if not exists lat               double precision,
  add column if not exists lng               double precision;

alter table orders
  add column if not exists source text not null default 'guest';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_source_check') then
    alter table orders add constraint orders_source_check check (source in ('guest', 'tablet'));
  end if;
end $$;

-- the panel reads the tablet's orders apart from the guest's, newest first
create index if not exists orders_source_recent
  on orders (restaurant_id, source, created_at desc);

comment on column restaurants.delivery_radius_km is
  'How far this restaurant delivers, in km, measured from lat/lng. Null means no fence: the address is confirmed on the phone.';
comment on column restaurants.lat is
  'Taken from the map link (maps_url) when the owner saves it. Never typed by hand.';
comment on column orders.source is
  'guest = ordered by the customer on their own phone; tablet = taken by staff on the restaurant tablet. Tablet orders send no WhatsApp message.';

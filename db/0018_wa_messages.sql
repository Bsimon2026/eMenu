-- DigiMenu — migration 0018: the WhatsApp inbox.
--
-- Every inbound message from a guest, and every message we send, in one table.
-- The inbound row is the important one: it is the only evidence that the
-- 24-hour window is open, and the time it arrived is when the clock started.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

create table if not exists public.wa_messages (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid references public.restaurants (id) on delete cascade,
  order_id         uuid references public.orders (id) on delete set null,
  wamid            text unique,                  -- Meta's id; the dedupe handle
  direction        text not null default 'in' check (direction in ('in', 'out')),
  phone_number_id  text,
  customer_number  text,                         -- digits only, may be empty for a BSUID identity
  bsuid            text,
  type             text,                         -- text | button | thankyou | accept | ready ...
  body             text,
  verified         boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists wa_messages_rest_time
  on public.wa_messages (restaurant_id, created_at desc);
create index if not exists wa_messages_lookup
  on public.wa_messages (restaurant_id, customer_number, created_at desc);
create index if not exists wa_messages_order
  on public.wa_messages (order_id, created_at desc);

-- Service key only: a guest's conversation is never readable from a browser.
alter table public.wa_messages enable row level security;
revoke all on public.wa_messages from anon, authenticated;

notify pgrst, 'reload schema';

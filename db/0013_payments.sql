-- DigiMenu — migration 0013: the money ledger, and the marketing add-on.
--
-- Until now a payment was a side effect: recording one overwrote paid_through
-- and the previous amount was simply gone. That is fine for "is this account
-- live" and useless for "what did this customer ever pay us".
--
-- payments is an append-only record. paid_through on the restaurant stays the
-- fast answer to "is it live"; this table is the answer to "show me".
--
-- The marketing add-on is a separate thing you sell: $149 to set up and $8.50 a
-- month, recorded as its own line so it can be seen, refunded or stopped
-- without touching the menu subscription.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table restaurants
  add column if not exists addon_marketing boolean not null default false;

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,

  amount         numeric(10, 2) not null check (amount >= 0),
  currency       text not null default 'USD',

  plan           text,                       -- 'qr' | 'order' | null for a pure add-on
  billing        text,                       -- 'monthly' | 'yearly' | 'one-off'
  kind           text not null default 'subscription'
                 check (kind in ('subscription', 'setup', 'addon')),
  addon          text,                       -- 'marketing' when kind = 'addon'

  period_start   date,
  period_end     date,                       -- the paid_through it produced
  method         text not null default 'manual'
                 check (method in ('manual', 'cash', 'transfer', 'card', 'stripe')),
  reference      text,
  note           text,

  recorded_by    text,                       -- "@dmin", or "ADMIN_TOKEN"
  created_at     timestamptz not null default now()
);

create index if not exists payments_restaurant_idx
  on public.payments (restaurant_id, created_at desc);

-- Service key only: money is written and read by the API, never by a browser.
alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;

notify pgrst, 'reload schema';

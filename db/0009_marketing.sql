-- DigiMenu — migration 0009: marketing, and a choice of how a message leaves.
--
-- Every restaurant picks its own sender:
--
--   'free'   the owner's own WhatsApp, one tap per guest (wa.me). No account,
--            no fee, no ban risk — and a human is in the loop, which is what
--            keeps the number that takes the orders safe.
--   'cloud'  WhatsApp Cloud API. The server sends, paced, unattended. Needs a
--            WhatsApp Business account, an approved template and a per-message
--            fee — which is why it is a switch, not the default.
--
-- Both paths write the same row here, so switching later changes only who does
-- the sending: the queue, the tracking and the feedback do not move.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table restaurants
  add column if not exists sender_mode        text not null default 'free',
  add column if not exists wa_phone_number_id text,      -- Cloud API: the sender
  add column if not exists wa_access_token    text,      -- Cloud API: bearer, secret
  add column if not exists wa_template        text,      -- approved template name
  add column if not exists wa_template_lang   text default 'en',
  add column if not exists google_review_url  text;      -- where a happy guest is sent

alter table restaurants drop constraint if exists restaurants_sender_check;
alter table restaurants add constraint restaurants_sender_check
  check (sender_mode in ('free', 'cloud'));

-- ---------------------------------------------------------------- the asks
create table if not exists public.review_requests (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  order_id      uuid references public.orders (id) on delete set null,

  phone         text not null,          -- normalised: digits only, with country code
  phone_raw     text,                   -- exactly what the guest typed
  guest_name    text,
  token         text not null unique,   -- what the feedback link carries

  -- queued → opened (free: the chat was opened) → sent | failed | skipped
  status        text not null default 'queued'
                check (status in ('queued', 'opened', 'sent', 'failed', 'skipped')),
  error         text,
  sent_at       timestamptz,
  opened_at     timestamptz,

  rating        int check (rating between 1 and 5),
  comment       text,
  created_at    timestamptz not null default now()
);

-- one ask per order, so pressing the button twice cannot double-message anyone
create unique index if not exists review_requests_per_order
  on public.review_requests (restaurant_id, order_id)
  where order_id is not null;

create index if not exists review_requests_phone_idx
  on public.review_requests (restaurant_id, phone);
create index if not exists review_requests_status_idx
  on public.review_requests (restaurant_id, status);
create index if not exists review_requests_token_idx
  on public.review_requests (token);

-- Service key only: the queue is written by the API, the feedback is recorded
-- through the API, and a guest's phone number is never readable from a browser.
alter table public.review_requests enable row level security;
revoke all on public.review_requests from anon, authenticated;

notify pgrst, 'reload schema';

-- 0007 — plans, the paywall, and the fields Stripe will fill later.
--
-- Manual for now: an operator records that money arrived, which sets paid_through.
-- When Stripe is connected it writes the same columns, so nothing downstream
-- has to change — only who sets them.

alter table restaurants
  add column if not exists plan           text not null default 'qr',      -- 'qr' | 'order'
  add column if not exists billing        text not null default 'monthly', -- 'monthly' | 'yearly'
  add column if not exists paid_through   date,                            -- null = never paid
  add column if not exists paid_amount    numeric(10, 2),
  add column if not exists pay_ref        text,                            -- transfer ref, cash note, later stripe id
  add column if not exists pay_method     text not null default 'manual',  -- 'manual' | 'stripe'
  add column if not exists activated_at   timestamptz,
  add column if not exists addon_site     boolean not null default false,  -- landing page + domain + email add-on
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text;

-- a plan that is not one of the two is a bug, not a variant
alter table restaurants drop constraint if exists restaurants_plan_check;
alter table restaurants add constraint restaurants_plan_check check (plan in ('qr', 'order'));

alter table restaurants drop constraint if exists restaurants_billing_check;
alter table restaurants add constraint restaurants_billing_check check (billing in ('monthly', 'yearly'));

create index if not exists restaurants_paid_idx on restaurants (paid_through);

notify pgrst, 'reload schema';

-- DigiMenu — migration 0020: the database accepts the plan we sell.
--
-- "Ordering Unlimited" is plan = 'pro' (api/superadmin.js PLANS), but the check
-- constraint written in 0007 still says plan in ('qr','order'). Every attempt to
-- put a customer on it fails with 23514, so the plan could be priced, listed and
-- sold and never actually applied. api/menu.js already treats 'pro' as an
-- ordering plan; this is the half the database was missing.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table public.restaurants drop constraint if exists restaurants_plan_check;
alter table public.restaurants
  add constraint restaurants_plan_check check (plan in ('qr', 'order', 'pro'));

notify pgrst, 'reload schema';

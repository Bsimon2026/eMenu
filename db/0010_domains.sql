-- DigiMenu — migration 0010: a restaurant's own domain.
--
-- One project, many domains. A customer points their domain at the same Vercel
-- deployment and the deployment works out which restaurant it is from the Host
-- header — no second website, no second database, no second deploy.
--
--   restaurant.com  ──CNAME/A──▶  cname.vercel-dns.com / 76.76.21.21
--                                  └─ Host: restaurant.com → this row → that menu
--
-- custom_domain is stored bare and lowercase, without www: a request from
-- www.restaurant.com is looked up as restaurant.com.
--
-- domain_status is what Vercel says, not what we wish:
--   'pending'  added to the project, DNS not pointing here yet
--   'live'     verified and the certificate is issued
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table restaurants
  add column if not exists custom_domain    text,
  add column if not exists domain_status    text,
  add column if not exists domain_added_at  timestamptz,
  add column if not exists domain_error     text;

-- one domain belongs to one restaurant, for ever
create unique index if not exists restaurants_domain_key
  on public.restaurants (lower(custom_domain))
  where custom_domain is not null;

alter table restaurants drop constraint if exists restaurants_domain_status_check;
alter table restaurants add constraint restaurants_domain_status_check
  check (domain_status is null or domain_status in ('pending', 'live', 'error'));

-- the guest page looks a restaurant up by its domain on every visit
create index if not exists restaurants_domain_idx
  on public.restaurants (lower(custom_domain));

notify pgrst, 'reload schema';

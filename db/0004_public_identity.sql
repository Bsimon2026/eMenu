-- DigiMenu — migration 0004: the restaurant's public identity
--
-- What this adds:
--   currency      the restaurant picks it once; every price on the menu, in the
--                 cart, in the WhatsApp message and on the review screen uses it
--   tagline       one line under the name on the guest landing page
--   address_line  the street address shown with the map link
--   instagram / facebook / tiktok / website   social handles for the guest page
--   cover_url     a wide photo for the guest hero, if they have one
--
-- None of these are readable with the anon key: 0002 granted anon a fixed list
-- of columns, and these are not in it. The guest page receives them from
-- /api/menu, which reads server-side and shapes the response.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

alter table public.restaurants
  add column if not exists currency     text not null default 'AED',
  add column if not exists tagline      text,
  add column if not exists address_line text,
  add column if not exists instagram    text,
  add column if not exists facebook     text,
  add column if not exists tiktok       text,
  add column if not exists website      text,
  add column if not exists cover_url    text;

-- currency must be an ISO code, not free text: the UI maps it to a symbol
alter table public.restaurants
  drop constraint if exists restaurants_currency_shape;
alter table public.restaurants
  add constraint restaurants_currency_shape
  check (currency ~ '^[A-Z]{3}$');

-- a handle is stored bare ("ushna.abudhabi"), not as a URL
alter table public.restaurants
  drop constraint if exists restaurants_social_shape;
alter table public.restaurants
  add constraint restaurants_social_shape
  check (
    (instagram is null or length(instagram) <= 60) and
    (facebook  is null or length(facebook)  <= 60) and
    (tiktok    is null or length(tiktok)    <= 60) and
    (website   is null or website ~ '^https?://')
  );

notify pgrst, 'reload schema';

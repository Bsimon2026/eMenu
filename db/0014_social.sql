-- DigiMenu — migration 0014: posting a dish to the restaurant's own social.
--
-- The product is small on purpose. A restaurant photographs a dish, we render
-- it into a branded poster, they approve it, and it goes out to the accounts
-- they have connected. No scheduling, no calendar, no analytics, no team
-- inbox — those are Postiz's job and they are not what a restaurant needs.
--
-- Three tables, because a post can half-succeed and that has to be visible:
--
--   social_accounts      one row per connected account, per restaurant
--   social_posts         one row per approved poster + the caption
--   social_post_results  one row per channel per post — Instagram can land
--                        while TikTok refuses the aspect ratio, and a single
--                        red toast would hide which one failed and why
--
-- Run in Supabase → SQL Editor → New query → paste → Run.

-- ----------------------------------------------------------------- accounts ---
-- The token is a live key to somebody's business page, so it is stored
-- encrypted (AES-256-GCM, key in SOCIAL_TOKEN_KEY) and the column is never
-- selected by anything that the browser can read. Losing these rows costs the
-- restaurant a reconnect, not a compromise.
create table if not exists public.social_accounts (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,

  provider    text not null
              check (provider in ('instagram', 'facebook', 'x', 'gbp')),

  account_name text,            -- what the owner recognises: "@spiceroute"
  account_ref  text not null,   -- the platform's own id for that account
  parent_ref   text,            -- the Facebook Page behind an Instagram account

  access_token text not null,   -- AES-256-GCM: iv.tag.ciphertext
  -- X and Google tokens die on the clock and have to be renewed with this;
  -- Meta's Page and Instagram tokens do not expire, so it stays null there.
  refresh_token text,
  expires_at   timestamptz,     -- null = does not expire (Page and IG tokens)
  scopes       text,

  status     text not null default 'active'
             check (status in ('active', 'expired', 'revoked')),
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- connecting the same page twice updates the row instead of piling up
  -- duplicates that the fan-out would then post to twice
  unique (restaurant_id, provider, account_ref)
);

create index if not exists social_accounts_rest_idx
  on public.social_accounts (restaurant_id, provider);

-- -------------------------------------------------------------------- posts ---
create table if not exists public.social_posts (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_by    uuid,

  -- the uploaded photo, kept so the poster can be re-rendered at another
  -- aspect ratio later without asking the owner to find the original again
  source_url text,
  -- the approved poster. Public HTTPS and JPEG, because Instagram fetches it
  -- by URL and accepts nothing else.
  image_url  text not null,

  caption    text not null,
  item_name  text,              -- the dish, when the poster came from the menu

  -- draft → published | partial | failed. Partial is the normal failure:
  -- some channels took it and some did not.
  status     text not null default 'draft'
             check (status in ('draft', 'published', 'partial', 'failed')),

  created_at   timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists social_posts_rest_idx
  on public.social_posts (restaurant_id, created_at desc);

-- ------------------------------------------------------------------ results ---
create table if not exists public.social_post_results (
  id       uuid primary key default gen_random_uuid(),
  post_id  uuid not null references public.social_posts (id) on delete cascade,

  provider    text not null,
  account_ref text,

  status      text not null default 'queued'
              check (status in ('queued', 'sent', 'failed')),
  remote_id   text,             -- the platform's post id, for deletion
  permalink   text,             -- where to look at it
  error       text,             -- the platform's own words, not a paraphrase

  updated_at timestamptz not null default now(),

  unique (post_id, provider, account_ref)
);

create index if not exists social_results_post_idx
  on public.social_post_results (post_id);

-- Service key only. A token that can post as somebody's restaurant must not be
-- reachable from any browser session, so RLS is on and every role is revoked —
-- the API is the only way in.
alter table public.social_accounts     enable row level security;
alter table public.social_posts        enable row level security;
alter table public.social_post_results enable row level security;

revoke all on public.social_accounts     from anon, authenticated;
revoke all on public.social_posts        from anon, authenticated;
revoke all on public.social_post_results from anon, authenticated;

notify pgrst, 'reload schema';

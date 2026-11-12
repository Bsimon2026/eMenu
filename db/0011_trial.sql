-- DigiMenu — migration 0011: seven free days.
--
-- A new restaurant gets seven days with everything switched on — publishing,
-- the guest page, ordering — and no card. After that the paywall is exactly what
-- it was: the menu stays built and private until a payment exists, which the
-- operator records from the admin panel when the money actually arrives.
--
-- Two columns, because "in a trial" and "has paid" are different facts:
--
--   trial_ends            the last day the trial is good for
--   trial_granted_at      when it was given, so it can only ever be given once
--
-- A restaurant is live while paid_through >= today OR trial_ends >= today.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table restaurants
  add column if not exists trial_ends       date,
  add column if not exists trial_granted_at timestamptz;

-- nothing else to change: the paywall reads paid_through, and
-- restaurant.js/api/menu.js now check the trial alongside it.

-- Backfill: anything that already exists and has never paid keeps its current
-- state. Existing live restaurants get no trial (they are on a paid period);
-- trial rows already created before this migration get their seven days.
update restaurants
   set trial_ends = (now() at time zone 'utc')::date + 7,
       trial_granted_at = now()
 where trial_ends is null
   and trial_granted_at is null
   and paid_through is null;

notify pgrst, 'reload schema';

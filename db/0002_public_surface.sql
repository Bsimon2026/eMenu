-- DigiMenu — migration 0002: close the public surface
--
-- Problem this fixes:
--   RLS filters ROWS, not COLUMNS. `restaurants_public_read` lets anyone read a
--   published restaurant, which also exposed order_email, licence_url and
--   owner_id to the anon key. Verified: an anon select returned them.
--
-- Fix: constrain what anon may SELECT at the column level. RLS keeps filtering
-- rows (published only); grants narrow the columns. Nothing else changes:
-- owners still read and write their own row in full through `authenticated`.
--
-- Run in SQL Editor. `Success. No rows returned` is the pass.

-- ---------------------------------------------------------------------------
-- 1. the public restaurant row: only what a guest page needs
-- ---------------------------------------------------------------------------
revoke select on public.restaurants from anon;

grant select (
  id,
  name,
  handle,
  purposes,
  whatsapp_e164,   -- public by design: it is the number the guest messages
  logo_url,
  maps_url,
  status,
  city,
  accent
) on public.restaurants to anon;

-- licence_url, order_email and owner_id are now unreadable with the anon key.
-- They stay readable to the owning restaurant through `authenticated`.

-- ---------------------------------------------------------------------------
-- 2. menu data: fine as-is (nothing private), but be explicit rather than
--    relying on the default grant
-- ---------------------------------------------------------------------------
grant select on public.menu_categories to anon;
grant select on public.menu_items to anon;

-- ---------------------------------------------------------------------------
-- 3. guests may create an order but must never read one back
--    (no select policy on orders for anon — already true; stated here so a
--    future edit does not "helpfully" add one)
-- ---------------------------------------------------------------------------
-- NOTE for the API: insert orders WITHOUT `Prefer: return=representation`.
-- PostgREST turns that into INSERT .. RETURNING, which needs a SELECT policy
-- and will fail with 42501 even though the insert itself is allowed.

-- ---------------------------------------------------------------------------
-- 4. make PostgREST pick up the new grants immediately
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

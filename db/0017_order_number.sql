-- DigiMenu — migration 0017: which number takes an order.
--
-- A restaurant can take orders on the number in its own pocket, or on the
-- WhatsApp Business API number it connected. The API number is what makes the
-- free-for-24-hours series possible: the guest's own order message opens the
-- window, and everything we send after it is not a paid template.
--
-- wa_order_e164 is that API number, typed once. Empty means "orders go to the
-- restaurant's own WhatsApp", which is what every account does today.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- "Success. No rows returned" is the pass.

alter table restaurants
  add column if not exists wa_order_e164 text;

notify pgrst, 'reload schema';

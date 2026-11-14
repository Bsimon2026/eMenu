-- The guest page's look, chosen by the owner.
--
-- One jsonb blob rather than three columns: the knobs a restaurant can turn are
-- the ones the page already supports, and adding a fourth should not need a
-- migration of its own.
--
-- Shape:
--   { "ground": "dark" | "light" | "clay",
--     "ink":    "soft" | "strong",
--     "font":   "serif" | "grotesk" | "satoshi" }
--
-- Anything unrecognised is ignored by the API and the page falls back to the
-- charcoal ground, so a value written by a newer build cannot break an older
-- menu.

alter table restaurants
  add column if not exists theme jsonb not null default '{}'::jsonb;

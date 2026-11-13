#!/usr/bin/env bash
# Rebuild db/combined-migration.sql from schema.sql + every numbered migration.
#
# Why this exists: combined-migration.sql is what a brand-new database is built
# from — a new Supabase project, a rebuild after a disaster, or anyone cloning
# this repo. It drifted once already: it was missing migrations 0015 to 0019, so
# a fresh install produced a DigiMenu with no Arabic, no archive, no inbox and no
# discount codes, while the live one had all of them. A new restaurant would have
# joined a product that silently lacked half its features.
#
# Run this after adding any db/000N_*.sql, and commit both files together.
set -euo pipefail
cd "$(dirname "$0")"

OUT="combined-migration.sql"
TMP="combined-migration.sql.tmp"

{
  echo "-- DigiMenu — the whole database, from empty."
  echo "--"
  echo "-- GENERATED FILE: do not edit. Built by db/build-combined.sh from"
  echo "-- schema.sql plus every db/000N_*.sql in order. Run it once on a new"
  echo "-- Supabase project; on an existing one, run only the migrations it lacks."
  echo "--"
  echo "-- Built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "-- =========================================================== schema.sql"
  cat schema.sql
  echo

  for f in $(ls 0*.sql | sort); do
    echo
    echo "-- ==================================================== $f"
    sed -e '/^-- DigiMenu — migration/d' \
        -e '/^-- Run in Supabase/d' \
        -e '/^-- "Success. No rows returned"/d' \
        -e '/^-- new query → paste → Run/d' "$f"
  done
} > "$TMP"

mv "$TMP" "$OUT"

echo "built $OUT"
echo "  migrations: $(ls 0*.sql | wc -l | tr -d ' ')"
for marker in wa_messages discounts discount_redemptions archived_at wa_order_e164 menu_item_translations restaurants_plan_check; do
  printf '  %-26s %s\n' "$marker" "$(grep -c "$marker" "$OUT")"
done

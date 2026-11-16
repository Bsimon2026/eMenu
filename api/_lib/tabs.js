/**
 * A table is a tab.
 *
 *   GET  /api/order?tabs=1&handle=<handle>   the open bills, with running totals
 *   POST /api/order {handle, source:"tablet", closeTab:"9"}   the bill is paid
 *
 * A waiter does not take one order and walk away: they open a table, add to it
 * during the meal, and close it when the bill is paid. A tab here is the set of
 * tablet orders for one table number that have not been closed
 * (`orders.tab_closed_at` is null, migration 0025) — so closing is one update and
 * the next order at that table starts a new tab. Guest QR orders are not part of
 * it: those go straight to the kitchen and belong to whoever scanned.
 *
 * `can(role,"tablet")` is exactly the right gate for both halves: owner, orders
 * and tablet have it; a menu-only login does not. Reading the *order book* stays
 * owner/orders-only — a waiter closing their own table's bill must not be able to
 * read every guest's phone number.
 */
const { rest, userFromToken, actorRestaurant, bearer, can } = require("./db");

const SAFE_TABLE = /^[\w\- ]{1,16}$/; /* "9", "P1", "Bar 2", "Terrace 4" */

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

/** The signed-in staff member and their restaurant, or a reply already sent. */
async function who(req, handle) {
  const user = await userFromToken(bearer(req));
  if (!user) return { code: 401, body: { ok: false, code: "NO_SESSION", message: "Sign in again on the tablet — that session has expired." } };

  const actor = await actorRestaurant(user, "id,handle,currency");
  const restaurant = actor && actor.restaurant;
  if (!restaurant) return { code: 403, body: { ok: false, code: "NO_RESTAURANT", message: "This login has no restaurant yet." } };
  if (handle && String(restaurant.handle || "").toLowerCase() !== handle) {
    return { code: 403, body: { ok: false, code: "NOT_YOURS", message: "Those bills belong to another restaurant." } };
  }
  if (!can(actor.role, "tablet")) {
    return { code: 403, body: { ok: false, code: "ROLE", message: "This login can edit the menu, but not take or close orders at a table." } };
  }
  return { restaurant: restaurant, role: actor.role };
}

/* Migration 0025 may not have been run yet. Reads then fall back to "every tablet
   order is still open" so the tablet keeps working, and closing says what is
   missing instead of failing in a way nobody can act on. */
function missingColumn(d) {
  return d && (d.code === "42703" || /tab_closed_at/.test(String(d.message || "")));
}

async function openRows(restaurantId) {
  const base = "orders?restaurant_id=eq." + encodeURIComponent(restaurantId) +
    "&source=eq.tablet&status=neq.cancelled&order=created_at.asc&limit=500";
  const withCol = await rest(base + "&tab_closed_at=is.null&select=id,table_no,total,created_at", {});
  if (withCol.ok) return { rows: withCol.data || [], closeReady: true };
  if (withCol.status === 400 && missingColumn(withCol.data)) {
    const plain = await rest(base + "&select=id,table_no,total,created_at", {});
    return { rows: (plain.ok && plain.data) || [], closeReady: false };
  }
  return { rows: [], closeReady: false, failed: true };
}

module.exports.listTabs = async function listTabs(req, res) {
  const handle = clean(req.query.handle, 40).toLowerCase();
  const me = await who(req, handle);
  if (me.code) return res.status(me.code).json(me.body);

  const found = await openRows(me.restaurant.id);
  if (found.failed) {
    return res.status(503).json({ ok: false, code: "READ_FAILED", message: "The bills could not be read. Try again." });
  }

  /* one tab per table number: how many orders, what they add up to, when opened */
  const byTable = new Map();
  for (const o of found.rows) {
    const table = clean(o.table_no, 16);
    if (!table) continue;
    const t = byTable.get(table) || { table: table, orders: 0, total: 0, opened: o.created_at, last: o.created_at };
    t.orders += 1;
    t.total = Math.round((t.total + (Number(o.total) || 0)) * 100) / 100;
    if (o.created_at < t.opened) t.opened = o.created_at;
    if (o.created_at > t.last) t.last = o.created_at;
    byTable.set(table, t);
  }
  const tabs = Array.from(byTable.values()).sort(function (a, b) {
    return String(a.table).localeCompare(String(b.table), undefined, { numeric: true });
  });

  return res.status(200).json({
    ok: true, handle: me.restaurant.handle, role: me.role,
    currency: me.restaurant.currency || "AED",
    closeReady: found.closeReady, tabs: tabs
  });
};

/** POST body asked for a close rather than an order. */
module.exports.close = async function close(req, res, body) {
  const handle = clean(body.handle, 40).toLowerCase();
  const me = await who(req, handle);
  if (me.code) return res.status(me.code).json(me.body);

  const table = clean(body.closeTab, 16);
  if (!SAFE_TABLE.test(table)) {
    return res.status(400).json({ ok: false, code: "BAD_TABLE", message: "Which table was paid?" });
  }

  const filter = "orders?restaurant_id=eq." + encodeURIComponent(me.restaurant.id) +
    "&source=eq.tablet&status=neq.cancelled&table_no=eq." + encodeURIComponent(table) +
    "&tab_closed_at=is.null";

  const done = await rest(filter, {
    method: "PATCH",
    body: { tab_closed_at: new Date().toISOString() },
    prefer: "return=representation"
  });

  if (!done.ok) {
    if (done.status === 400 && missingColumn(done.data)) {
      return res.status(503).json({
        ok: false, code: "NEEDS_MIGRATION",
        message: "Closing a bill needs the database to know about tabs. Run db/0025_table_tabs.sql once."
      });
    }
    return res.status(502).json({ ok: false, code: "CLOSE_FAILED", message: "That bill could not be closed. Try again." });
  }

  const rows = Array.isArray(done.data) ? done.data : [];
  if (!rows.length) {
    return res.status(404).json({ ok: false, code: "NO_TAB", message: "Table " + table + " has no open bill — someone may have closed it already." });
  }

  const total = rows.reduce(function (s, o) { return s + (Number(o.total) || 0); }, 0);
  return res.status(200).json({
    ok: true, table: table, closed: rows.length,
    total: Math.round(total * 100) / 100,
    currency: me.restaurant.currency || "AED"
  });
};

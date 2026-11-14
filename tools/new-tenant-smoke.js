/**
 * New-tenant smoke: does a brand-new restaurant actually take an order?
 *
 * Every restaurant starts as `plan: "qr"` on a seven-day trial. That state was
 * refused by POST /api/order while /api/menu said ordering was on, so a new
 * tenant's guest saw "Order received" and the panel stayed empty. It took a
 * customer to find it. This script creates exactly that tenant, places an order
 * the way a guest does, and requires it to land — then takes the tenant away.
 *
 * Run:  node --env-file=.env tools/new-tenant-smoke.js [baseUrl]
 *       npm run smoke:new-tenant
 *
 * Env:  SUPABASE_URL, SUPABASE_SECRET_KEY (from .env; the service key is only
 *       used to create and delete the throwaway tenant, never to place the order).
 */

const fs = require("fs");
const path = require("path");

const BASE = (process.argv[2] || process.env.SMOKE_BASE || "https://digimenu.indubaicity.com").replace(/\/+$/, "");
const SUPABASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY || "";
const HANDLE = "smoke-" + Date.now().toString(36);
const EMAIL = HANDLE + "@example.com";

const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || !detail ? "" : "\n      " + detail));
}

async function sb(p, opts) {
  const r = await fetch(SUPABASE + "/rest/v1/" + p, { headers: H, ...(opts || {}) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function api(p, body, token) {
  const r = await fetch(BASE + p, {
    method: body ? "POST" : "GET",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: r.status, data };
}

async function main() {
  if (!SUPABASE || !KEY) {
    console.error("SUPABASE_URL / SUPABASE_SECRET_KEY missing — run with: node --env-file=.env tools/new-tenant-smoke.js");
    process.exit(2);
  }
  console.log("target:", BASE);
  console.log("tenant:", HANDLE);

  const created = await fetch(SUPABASE + "/auth/v1/admin/users", {
    method: "POST", headers: H,
    body: JSON.stringify({ email: EMAIL, password: "Smoke!" + Date.now(), email_confirm: true })
  });
  const user = await created.json();
  if (!user.id) throw new Error("could not create the test user: " + JSON.stringify(user).slice(0, 200));

  const link = await fetch(SUPABASE + "/auth/v1/admin/generate_link", {
    method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", email: EMAIL })
  });
  const lj = await link.json();
  const verified = await fetch(SUPABASE + "/auth/v1/verify", {
    method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", token_hash: lj.hashed_token })
  });
  const session = await verified.json();
  if (!session.access_token) throw new Error("could not mint a session");

  /* the state every real signup lands in: qr plan, seven-day trial */
  const trialEnds = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const made = await api("/api/restaurant", {
    name: "Smoke Kitchen",
    handle: HANDLE,
    whatsapp_e164: "+971500000999",
    purposes: ["Dine In", "Take Away"]
  }, session.access_token);
  check("tenant created (qr plan, on trial)", made.status === 200, JSON.stringify(made.data).slice(0, 200));
  const restaurantId = made.data && made.data.restaurant && made.data.restaurant.id;
  if (!restaurantId) throw new Error("no restaurant row");

  const row = await sb("restaurants?id=eq." + restaurantId + "&select=plan,paid_through,trial_ends");
  const r0 = (row.body || [])[0] || {};
  check("row is qr + trial, paid_through null", r0.plan === "qr" && !r0.paid_through && Boolean(r0.trial_ends),
    JSON.stringify(r0));

  /* published, so the guest-facing endpoints will answer at all (an operator
     publishes through the dashboard, which also needs the documents) */
  await sb("restaurants?id=eq." + restaurantId, { method: "PATCH", body: JSON.stringify({ status: "published" }) });

  /* the guest page must offer ordering for that same state (the flag rides
     inside restaurant — that is what menu.js reads) */
  const menu = await api("/api/menu?handle=" + HANDLE);
  const orderFlag = menu.data && menu.data.restaurant && menu.data.restaurant.ordering;
  check("/api/menu says ordering is on", menu.status === 200 && orderFlag === true,
    JSON.stringify({ status: menu.status, ordering: orderFlag, code: menu.data && menu.data.code }));

  const order = await api("/api/order", {
    handle: HANDLE,
    mode: "Dine In",
    table: "3",
    name: "Smoke Guest",
    phone: "+971500000888",
    email: "smoke-guest@example.com",
    submitKey: "smoke-" + Date.now(),
    items: [{ name: "Smoke Kebab", qty: 1, price: 25 }],
    total: 25
  });
  check("guest order is written", order.status === 200 && order.data.ok === true && Boolean(order.data.orderId),
    JSON.stringify(order.data).slice(0, 240));
  const orderId = order.data && order.data.orderId;

  const feed = await api("/api/orders", null, session.access_token);
  const listed = feed.status === 200 && (feed.data.orders || []).some((o) => o.id === orderId);
  check("the order shows in the owner's panel feed", listed,
    JSON.stringify({ status: feed.status, count: (feed.data.orders || []).length }));

  if (orderId) {
    const again = await sb("orders?id=eq." + orderId + "&select=id,status,total");
    check("the row exists in the table", ((again.body || [])[0] || {}).id === orderId, JSON.stringify(again.body));
  }

  /* and the other direction: a menu-only plan past its trial must refuse */
  const past = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await sb("restaurants?id=eq." + restaurantId, {
    method: "PATCH", body: JSON.stringify({ trial_ends: past, paid_through: null, plan: "qr" })
  });
  const refused = await api("/api/order", {
    handle: HANDLE, mode: "Dine In", table: "3", name: "Smoke Guest 2",
    phone: "+971500000888", email: "smoke-guest@example.com",
    items: [{ name: "Smoke Kebab", qty: 1, price: 25 }], total: 25
  });
  check("after the trial, a qr plan is refused", refused.status === 403 && refused.data.code === "ORDERING_NOT_INCLUDED",
    JSON.stringify(refused.data).slice(0, 200));

  /* teardown: rows, then the row, then the login */
  const orders = await sb("orders?restaurant_id=eq." + restaurantId + "&select=id");
  for (const o of orders.body || []) {
    await sb("order_items?order_id=eq." + o.id, { method: "DELETE" });
    await sb("wa_messages?order_id=eq." + o.id, { method: "DELETE" });
  }
  for (const t of ["orders", "menu_items", "menu_categories", "restaurant_members"]) {
    await sb(t + "?restaurant_id=eq." + restaurantId, { method: "DELETE" });
  }
  await sb("restaurants?id=eq." + restaurantId, { method: "DELETE" });
  await fetch(SUPABASE + "/auth/v1/admin/users/" + user.id, { method: "DELETE", headers: H });

  const gone = await sb("restaurants?handle=eq." + HANDLE + "&select=id");
  check("test tenant removed", (gone.body || []).length === 0, JSON.stringify(gone.body));

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + (failed.length ? failed.length + " FAILED" : "all " + results.length + " checks passed"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke aborted:", e && e.message);
  process.exit(1);
});

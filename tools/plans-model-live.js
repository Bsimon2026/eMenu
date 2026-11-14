/**
 * The whole plan model, live, on a throwaway tenant:
 *   1. qr plan, free week over  → the guest menu is UNPUBLISHED
 *   2. the operator records the payment from the console  → the menu is live
 *   3. QR Menu holds 50 dishes  → the 51st is refused
 *   4. a paid Pro plan        → ordering + marketing on, uncapped
 * Deletes everything it made.
 */
const fs = require("fs");
const env = {};
for (const line of fs.readFileSync("D:/eMenuBuilder/.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const BASE = (process.argv[2] || "https://digimenu.indubaicity.com").replace(/\/+$/, "");
const U = env.SUPABASE_URL.replace(/\/+$/, ""), K = env.SUPABASE_SECRET_KEY, ADMIN = env.ADMIN_TOKEN;
const H = { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json" };
const HADMIN = { "x-admin-token": ADMIN, "Content-Type": "application/json" };
const HANDLE = "qa-plan-" + Date.now().toString(36);
const EMAIL = HANDLE + "@example.com";
const today = new Date().toISOString().slice(0, 10);
const past = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || !detail ? "" : "\n      " + detail));
}

const api = async (p, body) => {
  const r = await fetch(BASE + p, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 200) }; }
  return { status: r.status, data: d };
};

(async () => {
  const c = await fetch(U + "/auth/v1/admin/users", { method: "POST", headers: H, body: JSON.stringify({ email: EMAIL, password: "QaPlan!2026", email_confirm: true }) });
  const user = await c.json();
  const l = await fetch(U + "/auth/v1/admin/generate_link", { method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", email: EMAIL }) });
  const lj = await l.json();
  const v = await fetch(U + "/auth/v1/verify", { method: "POST", headers: H, body: JSON.stringify({ type: "magiclink", token_hash: lj.hashed_token }) });
  const vj = await v.json();
  const AUTH = { Authorization: "Bearer " + vj.access_token, "Content-Type": "application/json" };
  const asOwner = async (p, body) => {
    const r = await fetch(BASE + p, { method: body ? "POST" : "GET", headers: AUTH, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let d; try { d = JSON.parse(t); } catch { d = { raw: t.slice(0, 200) }; }
    return { status: r.status, data: d };
  };

  const made = await asOwner("/api/restaurant", {
    name: "QA Plan", handle: HANDLE, whatsapp_e164: "+971500000555", purposes: ["Dine In"]
  });
  const rid = made.data.restaurant && made.data.restaurant.id;

  const cat = await fetch(U + "/rest/v1/menu_categories", { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify([{ restaurant_id: rid, name: "Menu", position: 0 }]) }).then((r) => r.json());
  const cid = cat[0].id;
  await fetch(U + "/rest/v1/menu_items", {
    method: "POST", headers: H,
    body: JSON.stringify([{ restaurant_id: rid, category_id: cid, name: "Dish one", price: 10, position: 0, source: "manual" }])
  });

  /* the free week is over and nothing is paid: published on paper, shut in fact */
  await fetch(U + "/rest/v1/restaurants?id=eq." + rid, {
    method: "PATCH", headers: H,
    body: JSON.stringify({ trial_ends: past, plan: "qr", paid_through: null, status: "published" })
  });
  let menu = await api("/api/menu?cb=" + Date.now() + "&handle=" + HANDLE);
  check("after the free week the menu link is unpublished", menu.status === 404 && menu.data.code === "UNPUBLISHED",
    JSON.stringify({ status: menu.status, code: menu.data.code }));
  console.log("      " + (menu.data.message || ""));

  /* the operator records the QR Menu payment from the console */
  const pay = await fetch(BASE + "/api/superadmin?payment=1", {
    method: "POST", headers: HADMIN,
    body: JSON.stringify({ handle: HANDLE, plan: "qr", billing: "yearly", method: "transfer", payRef: "QA-TEST" })
  });
  const payj = await pay.json();
  check("the console records the payment", pay.status === 200 && payj.ok !== false, JSON.stringify(payj).slice(0, 200));

  menu = await api("/api/menu?cb=" + Date.now() + "&handle=" + HANDLE);
  check("recording the payment republished the link", menu.status === 200 && menu.data.ok === true,
    JSON.stringify({ status: menu.status, code: menu.data.code }));
  check("QR Menu offers no ordering", menu.data.restaurant && menu.data.restaurant.ordering === false);

  /* the QR cap: 49 more dishes make 50, the next one is refused */
  const many = Array.from({ length: 49 }, (_, i) => ({ restaurant_id: rid, category_id: cid, name: "Dish " + (i + 2), price: 10, position: i + 1, source: "manual" }));
  await fetch(U + "/rest/v1/menu_items", { method: "POST", headers: H, body: JSON.stringify(many) });
  const count = await (await fetch(U + "/rest/v1/menu_items?restaurant_id=eq." + rid + "&select=id", { headers: H })).json();
  check("the menu now holds 50 dishes", count.length === 50, "count " + count.length);

  const over = await asOwner("/api/menu?op=edit", { action: "addItem", categoryId: cid, name: "Dish 51", price: 10 });
  check("the 51st dish is refused on QR Menu", over.status === 402 && over.data.code === "ITEM_CAP",
    JSON.stringify(over.data).slice(0, 200));
  console.log("      " + (over.data.message || ""));

  /* and the add-on: the marketing endpoint is part of Pro, not QR */
  const mkt = await asOwner("/api/marketing?settings=1");
  check("QR Menu has no marketing", mkt.status === 403 && mkt.data.code === "NOT_IN_PLAN",
    JSON.stringify({ status: mkt.status, code: mkt.data.code }));

  /* upgrade the same tenant to Pro: ordering returns, the cap lifts */
  await fetch(BASE + "/api/superadmin?payment=1", {
    method: "POST", headers: HADMIN,
    body: JSON.stringify({ handle: HANDLE, plan: "order", billing: "monthly", method: "transfer", payRef: "QA-TEST-2" })
  });
  menu = await api("/api/menu?cb=" + Date.now() + "&handle=" + HANDLE);
  check("Pro turns ordering back on", menu.status === 200 && menu.data.restaurant.ordering === true);
  const extra = await asOwner("/api/menu?op=edit", { action: "addItem", categoryId: cid, name: "Dish 51", price: 10 });
  check("Pro lifts the 50-dish cap", extra.status === 200 && extra.data.ok === true,
    JSON.stringify(extra.data).slice(0, 160));
  const mkt2 = await asOwner("/api/marketing?settings=1");
  check("Pro includes marketing", mkt2.status === 200, JSON.stringify({ status: mkt2.status, code: mkt2.data.code }));

  /* teardown */
  for (const t of ["menu_items", "menu_categories", "orders", "restaurant_members", "payments", "wa_messages"]) {
    await fetch(U + "/rest/v1/" + t + "?restaurant_id=eq." + rid, { method: "DELETE", headers: H });
  }
  await fetch(U + "/rest/v1/restaurants?id=eq." + rid, { method: "DELETE", headers: H });
  await fetch(U + "/auth/v1/admin/users/" + user.id, { method: "DELETE", headers: H });
  const gone = await (await fetch(U + "/rest/v1/restaurants?handle=eq." + HANDLE + "&select=id", { headers: H })).json();
  check("test tenant removed", gone.length === 0);

  console.log("\n" + (failed ? failed + " FAILED" : "all " + (11) + " checks passed"));
  process.exit(failed ? 1 : 0);
})();

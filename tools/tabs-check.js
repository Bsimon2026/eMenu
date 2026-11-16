/**
 * A table is a tab: open it, add to it, close it, and pay exactly once.
 *
 *   node tools/tabs-check.js [origin] [envPath]
 *
 * Needs db/0025_table_tabs.sql. Runs against a real restaurant with ordering on:
 * a waiter signs in, sends two rounds to one table, reads the running bill,
 * closes it, and asserts the arithmetic. Then it deletes every order and line it
 * made, so the tenant is left exactly as it was found.
 *
 * What it is really guarding: the bill is the number people argue about. A tab
 * that under-counts by one round, or closes twice, is money.
 */
const fs = require("fs");

const ORIGIN = (process.argv[2] || process.env.ORIGIN || "https://digimenu.indubaicity.com").replace(/\/+$/, "");
const envPath = process.argv[3] || "D:/eMenuBuilder/.env";
const OWNER = process.env.TABS_CHECK_OWNER || "wahcsp.ae@gmail.com"; /* spice-route, Pro */
const HANDLE = process.env.TABS_CHECK_HANDLE || "spice-route";
const USER = "tabs-check-" + Date.now().toString(36);
const PASS = "TabsCheck!" + Math.random().toString(36).slice(2, 10);
const TABLE = "T" + Math.floor(Math.random() * 900 + 100); /* never collide with a real table */

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail !== undefined && detail !== "" ? "   [" + detail + "]" : ""));
  if (ok) pass++; else fail++;
  return ok;
}
function skip_(name, why) { console.log("SKIP " + name + "   [" + why + "]"); skip++; }

let env = {};
try {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) { env = {}; }
const SUPA = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const SECRET = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY || "";
const ANON = env.SUPABASE_ANON_KEY || SECRET;
const admin = { apikey: SECRET, Authorization: "Bearer " + SECRET, "content-type": "application/json" };

async function mintOwner(email) {
  const made = await fetch(SUPA + "/auth/v1/admin/generate_link", {
    method: "POST", headers: admin, body: JSON.stringify({ type: "magiclink", email: email })
  }).then((r) => r.json());
  const token = made.email_otp || (made.properties && made.properties.email_otp);
  if (!token) throw new Error("no token for " + email);
  const sess = await fetch(SUPA + "/auth/v1/verify", {
    method: "POST", headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: token, email: email })
  }).then((r) => r.json());
  if (!sess.access_token) throw new Error("no session for " + email);
  return sess.access_token;
}

const as = (t) => ({ authorization: "Bearer " + t, "content-type": "application/json" });
async function call(path, opts) {
  const r = await fetch(ORIGIN + path, opts || {});
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = { _raw: text.slice(0, 140) }; }
  return { status: r.status, body: body };
}

(async () => {
  if (!SUPA || !SECRET) {
    skip_("tabs", "no SUPABASE_URL / SUPABASE_SECRET_KEY in " + envPath);
    console.log("\n0 passed · 0 failed · " + skip + " skipped");
    return;
  }

  let owner;
  try { owner = await mintOwner(OWNER); } catch (e) {
    skip_("tabs", "could not sign in as " + OWNER + ": " + e.message);
    console.log("\n0 passed · 0 failed · " + skip + " skipped");
    return;
  }

  const menu = await call("/api/menu?handle=" + HANDLE);
  if (!check("the test menu is taking orders", menu.status === 200 && menu.body.ordering !== false, "ordering " + (menu.body.restaurant || {}).ordering)) {
    console.log("\n" + pass + " passed · " + fail + " failed");
    process.exitCode = 1;
    return;
  }
  const dish = menu.body.categories[0].items[0];

  /* --- a real waiter, so the checks run with the role that uses the tablet --- */
  const made = await call("/api/team", {
    method: "POST", headers: as(owner),
    body: JSON.stringify({ action: "create", username: USER, password: PASS, role: "tablet" })
  });
  if (!made.body.ok) {
    skip_("the tab checks", "could not create a waiter: " + JSON.stringify(made.body).slice(0, 120));
    console.log("\n" + pass + " passed · " + fail + " failed · " + skip + " skipped");
    return;
  }
  const login = await call("/api/team?login=1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: HANDLE, username: USER, password: PASS })
  });
  const waiter = login.body.session && login.body.session.access_token;
  if (!check("the waiter signs in", !!waiter, "role " + login.body.role)) {
    console.log("\n" + pass + " passed · " + fail + " failed");
    process.exitCode = 1;
    return;
  }

  const round = (qty) => call("/api/order", {
    method: "POST", headers: as(waiter),
    body: JSON.stringify({
      handle: HANDLE, source: "tablet", mode: "Dine In", table: TABLE,
      submitKey: "tabs-" + TABLE + "-" + Math.random().toString(36).slice(2),
      total: Math.round(dish.price * qty * 100) / 100,
      items: [{ id: dish.id, name: dish.name, qty: qty, price: dish.price }]
    })
  });
  const tabsNow = () => call("/api/order?tabs=1&handle=" + HANDLE, { headers: as(waiter) });
  const tabOf = (list) => (list.body.tabs || []).filter((t) => t.table === TABLE)[0] || null;

  /* --- the tab does not exist until the first round ------------------------ */
  const empty = await tabsNow();
  if (!check("the waiter can read the open bills", empty.status === 200 && Array.isArray(empty.body.tabs),
    empty.status + " " + JSON.stringify(empty.body).slice(0, 100))) { /* keep going */ }
  check("a fresh table is not a bill yet", !tabOf(empty), "tab " + JSON.stringify(tabOf(empty)));
  check("the database knows about tabs", empty.body.closeReady === true,
    "closeReady " + empty.body.closeReady + (empty.body.closeReady === false ? " — run db/0025_table_tabs.sql" : ""));

  /* --- two rounds, one bill ------------------------------------------------ */
  const one = await round(2);
  const two = await round(1);
  check("the first round is accepted", one.status === 200 && one.body.orderId, one.status + " " + JSON.stringify(one.body).slice(0, 90));
  check("the second round is accepted", two.status === 200 && two.body.orderId, two.status + " " + JSON.stringify(two.body).slice(0, 90));

  const list = await tabsNow();
  const tab = tabOf(list);
  const want = Math.round(dish.price * 3 * 100) / 100;
  check("both rounds are on one tab", !!tab && tab.orders === 2, JSON.stringify(tab));
  check("the running bill is 2 + 1 of the dish", !!tab && tab.total === want, (tab && tab.total) + " want " + want);
  check("the bill says when it opened", !!tab && !!tab.opened, tab && tab.opened);

  /* --- close it, and it is paid exactly once ------------------------------- */
  const closed = await call("/api/order", {
    method: "POST", headers: as(waiter),
    body: JSON.stringify({ handle: HANDLE, source: "tablet", closeTab: TABLE })
  });
  check("the bill closes", closed.status === 200 && closed.body.closed === 2, closed.status + " " + JSON.stringify(closed.body).slice(0, 110));
  check("the closed bill totals what it owed", closed.body.total === want, closed.body.total + " want " + want);

  const after = await tabsNow();
  check("a closed table leaves the open bills", !tabOf(after), JSON.stringify(tabOf(after)));

  const twice = await call("/api/order", {
    method: "POST", headers: as(waiter),
    body: JSON.stringify({ handle: HANDLE, source: "tablet", closeTab: TABLE })
  });
  check("closing it twice is refused", twice.status === 404 && twice.body.code === "NO_TAB", twice.status + " " + JSON.stringify(twice.body).slice(0, 90));

  /* --- the paid orders are still on the record, marked as paid ------------- */
  const book = await call("/api/orders", { headers: as(owner) });
  const paid = (book.body.orders || []).filter((o) => o.table === TABLE);
  check("the owner still sees the paid orders", paid.length === 2, paid.length + " rows");
  check("they are marked as paid", paid.every((o) => !!o.tabClosedAt), JSON.stringify(paid.map((o) => o.tabClosedAt)));

  /* --- a new round at the same table opens a new bill ---------------------- */
  const again = await round(1);
  check("a later order reopens the table", again.status === 200, again.status);
  const reopened = tabOf(await tabsNow());
  check("and it is a new bill with only the new round", !!reopened && reopened.orders === 1 && reopened.total === dish.price,
    JSON.stringify(reopened));

  /* --- another restaurant's waiter cannot touch this bill ------------------ */
  const otherMenu = await call("/api/menu?handle=kings-kebab");
  if (otherMenu.status === 200) {
    const wrong = await call("/api/order", {
      method: "POST", headers: as(waiter),
      body: JSON.stringify({ handle: "kings-kebab", source: "tablet", closeTab: TABLE })
    });
    check("a waiter cannot close another restaurant's bill", wrong.status === 403, wrong.status + " " + JSON.stringify(wrong.body).slice(0, 90));
  } else {
    skip_("another restaurant's bill", "kings-kebab did not answer");
  }

  /* --- clean up: the orders, the lines, the waiter ------------------------- */
  const mine = await call("/api/restaurant", { headers: as(owner) });
  const restId = (mine.body.restaurant || {}).id || "";
  const rows = await (await fetch(SUPA + "/rest/v1/orders?restaurant_id=eq." + restId +
    "&table_no=eq." + encodeURIComponent(TABLE) + "&select=id", { headers: admin })).json();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    await fetch(SUPA + "/rest/v1/order_items?order_id=eq." + r.id, { method: "DELETE", headers: admin });
    await fetch(SUPA + "/rest/v1/orders?id=eq." + r.id, { method: "DELETE", headers: admin });
  }
  await call("/api/team", { method: "POST", headers: as(owner), body: JSON.stringify({ action: "remove", username: USER }) });
  const left = await (await fetch(SUPA + "/rest/v1/orders?table_no=eq." + encodeURIComponent(TABLE) + "&select=id", { headers: admin })).json();
  check("the test table is left empty", Array.isArray(left) && left.length === 0, JSON.stringify(left).slice(0, 80));

  console.log("\n" + pass + " passed · " + fail + " failed" + (skip ? " · " + skip + " skipped" : ""));
  if (fail) process.exitCode = 1;
})();

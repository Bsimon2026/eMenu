/**
 * Do the prices on the website match the prices the money code charges?
 *
 * They did not: the ledger charged 99 for a month of Pro and 1,990 for a year of
 * Ultra while index.html sold 129 and 1,999, and the database plan `pro` is the
 * website's *Ultra* (the website's "Pro" is the `order` row). A customer buying
 * "Pro" at the till would have been given Ultra, or charged 30 dirhams less a
 * month than the page promised.
 *
 * This reads the published price list (index.html's plan cards) and the canonical
 * table (api/_lib/plans.js) and requires them to agree, card by card.
 *
 * Run: node tools/prices-check.js        (no database, no network)
 */

const fs = require("fs");
const path = require("path");
const { PLANS, ADDONS } = require("../api/_lib/plans");

/* the card's data-plan is the marketing name; the database value is older and
   does not follow it — the website's "Pro" is the `order` row, "Ultra" is `pro` */
const CARD_TO_DB = { qr: "qr", pro: "order", ultra: "pro" };

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const terms = fs.readFileSync(path.join(root, "terms.html"), "utf8");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok || !detail ? "" : "\n      " + detail));
}

/* one card per plan: <article … data-plan="pro" data-annual="999" data-monthly="129" …> */
const cards = {};
const re = /<article[^>]*\bdata-plan="([a-z]+)"[^>]*>/g;
let m;
while ((m = re.exec(html))) {
  const tag = m[0];
  const annual = (tag.match(/data-annual="(\d*)"/) || [])[1];
  const monthly = (tag.match(/data-monthly="(\d*)"/) || [])[1];
  cards[m[1]] = { annual: annual === "" ? null : Number(annual), monthly: monthly === "" ? null : Number(monthly) };
}

check("index.html carries three plan cards", Object.keys(cards).length === 3, JSON.stringify(cards));

for (const [card, dbKey] of Object.entries(CARD_TO_DB)) {
  const c = cards[card];
  const p = PLANS[dbKey];
  if (!c || !p) { check("card " + card + " exists", false, JSON.stringify({ card: c, db: dbKey })); continue; }
  check(card + " (" + p.label + ") yearly = AED " + p.price.yearly, c.annual === p.price.yearly,
    "card says " + c.annual + ", plans.js says " + p.price.yearly);
  check(card + " (" + p.label + ") monthly = " + (p.price.monthly == null ? "not sold" : "AED " + p.price.monthly),
    c.monthly === p.price.monthly, "card says " + c.monthly + ", plans.js says " + p.price.monthly);
}

/* the two documents a customer and a lawyer read */
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
check("terms.html: QR Menu " + PLANS.qr.price.yearly + "/year",
  terms.indexOf("AED " + PLANS.qr.price.yearly + " per year") !== -1);
check("terms.html: Pro " + PLANS.order.price.yearly + "/year or " + PLANS.order.price.monthly + "/month",
  terms.indexOf("AED " + money(PLANS.order.price.yearly) + " per year") !== -1 &&
  terms.indexOf("AED " + PLANS.order.price.monthly + " per month") !== -1);
check("terms.html: Ultra " + money(PLANS.pro.price.yearly) + "/year or " + PLANS.pro.price.monthly + "/month",
  terms.indexOf("AED " + money(PLANS.pro.price.yearly) + " per year") !== -1 &&
  terms.indexOf("AED " + PLANS.pro.price.monthly + " per month") !== -1);
check("terms.html: custom domain add-on AED " + ADDONS.customDomain.yearly + "/year",
  terms.indexOf("add-on at AED " + ADDONS.customDomain.yearly + " per year") !== -1);

/* the add-on is quoted on the Ultra card too */
check("index.html: custom domain add-on AED " + ADDONS.customDomain.yearly,
  html.indexOf("AED " + ADDONS.customDomain.yearly + " per year") !== -1);

/* the dashboard quotes prices too (the trial hand-off sentence), from a PRICE
   block that has to be the same table */
const appjs = fs.readFileSync(path.join(root, "assets/app.js"), "utf8");
const block = (appjs.match(/const PRICE = \{[\s\S]*?\n  \};/) || [])[0] || "";
const num = (re) => { const m = block.match(re); return m ? Number(m[1]) : null; };
check("app.js PRICE: QR Menu yearly = " + PLANS.qr.price.yearly, num(/qr:\s*\{\s*yearly:\s*(\d+)/) === PLANS.qr.price.yearly);
check("app.js PRICE: Pro yearly = " + PLANS.order.price.yearly, num(/pro:\s*\{\s*monthly:\s*\d+,\s*yearly:\s*(\d+)/) === PLANS.order.price.yearly);
check("app.js PRICE: Pro monthly = " + PLANS.order.price.monthly, num(/pro:\s*\{\s*monthly:\s*(\d+)/) === PLANS.order.price.monthly);
check("app.js PRICE: Ultra yearly = " + PLANS.pro.price.yearly, num(/ultra:\s*\{\s*monthly:\s*\d+,\s*yearly:\s*(\d+)/) === PLANS.pro.price.yearly);
check("app.js PRICE: Ultra monthly = " + PLANS.pro.price.monthly, num(/ultra:\s*\{\s*monthly:\s*(\d+)/) === PLANS.pro.price.monthly);

/* the operator console offers the published plans, under the published names */
const console_ = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
for (const key of ["qr", "order", "pro"]) {
  const p = PLANS[key];
  check("superadmin: offers " + p.label, console_.indexOf(">" + p.label + " — ") !== -1,
    "no option labelled " + p.label);
  if (p.price.monthly != null) {
    check("superadmin: " + p.label + " covers the monthly price",
      console_.indexOf("AED " + p.price.monthly + " / month") !== -1);
  }
}
check("superadmin: no marketing add-on is sold", console_.indexOf("dwMkt") === -1 && console_.indexOf("Website add-on") === -1);

/* the QR card's dish cap is the one the handlers enforce */
check("index.html: QR Menu states its " + PLANS.qr.itemCap + "-dish cap",
  new RegExp("Up to " + PLANS.qr.itemCap + " menu items", "i").test(html));
check("plans.js: only QR Menu is capped", PLANS.qr.itemCap === 50 && PLANS.order.itemCap === null && PLANS.pro.itemCap === null);

console.log("\n" + (failed ? failed + " price(s) disagree" : "prices agree everywhere checked"));
process.exit(failed ? 1 : 0);

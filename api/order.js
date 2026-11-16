/**
 * POST /api/order
 *
 * A guest's order. Public — no account — because the guest is a stranger with a
 * phone, and the restaurant must still get a record even if WhatsApp never
 * delivers the message. That is the whole reason the phone number is asked for.
 *
 * Server-side inserts with the service key: the anon key has no write policy on
 * orders, and this endpoint decides exactly which columns a guest may set.
 */

const { rest, cors, configured, userFromToken, actorRestaurant, bearer, can } = require("./_lib/db");
const mail = require("./_lib/mail");
const listOrders = require("./_lib/order-list");
const discount = require("./_lib/discounts");
const { canTakeOrders } = require("./_lib/ordering");

const MODES = ["Dine In", "Take Away", "Delivery"];

const PUBLIC_BASE = (process.env.PUBLIC_BASE || "https://digimenu.indubaicity.com").replace(/\/+$/, "");

/**
 * The message the guest's own WhatsApp will post to the restaurant.
 *
 * One builder, two callers: the order handler (which mails it as a link) and the
 * short-link route (which rebuilds it from the stored order, so the mail can
 * carry a short URL instead of several hundred characters of encoded text).
 */
function orderMessage(o) {
  const order = o.order || {};
  const items = o.items || [];
  const restaurant = o.restaurant || {};
  const detail =
    order.mode === "Dine In" ? "Dine In · table " + (order.table_no || "—")
    : order.mode === "Take Away" ? "Take Away · collect in " + (o.pickupLabel || "as soon as ready")
    : "Delivery · " + (order.address || "address on the phone");
  const itemLines = items.map((r) =>
    "  " + r.qty + " × " + r.name + "  —  AED " + (Number(r.unit_price) * Number(r.qty)).toFixed(2)).join("\n");
  return [
    "Order — " + (restaurant.name || ""),
    detail,
    "Guest: " + (order.guest_name || ""),
    "",
    itemLines,
    "",
    "Total: AED " + Number(order.total || 0).toFixed(2),
    "Reference: " + String(order.id || "").slice(0, 8)
  ].join("\n");
}

/** The number the guest's message must reach. */
function orderNumberFor(restaurant) {
  const r = restaurant || {};
  return (r.sender_mode === "cloud" && r.wa_phone_number_id && r.wa_order_e164)
    ? r.wa_order_e164
    : r.whatsapp_e164;
}

function waUrlFor(restaurant, text) {
  const digits = String(orderNumberFor(restaurant) || "").replace(/[^\d]/g, "");
  return "https://wa.me/" + digits + "?text=" + encodeURIComponent(text);
}

/** The link that goes in the guest's mail: short, and it resolves here.
 *  The order id without its dashes — 32 characters, still exact. */
function shortOrderLink(orderId) {
  return PUBLIC_BASE + "/s/" + String(orderId || "").replace(/-/g, "");
}

/** 32 hex characters back into the uuid the database stores. */
function uuidFromCode(raw) {
  const h = String(raw || "").toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(h)) return "";
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function gonePage(res, message) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.end(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Order link — DigiMenu</title></head>" +
    '<body style="font-family:system-ui,sans-serif;background:#FBF7F0;color:#17140F;margin:0">' +
    '<div style="max-width:420px;margin:16vh auto 0;padding:0 24px;text-align:center">' +
    "<h1 style=\"font-size:20px;margin:0 0 10px\">This order link is not valid</h1>" +
    "<p style=\"color:#6C6357;line-height:1.6;margin:0\">" + String(message || "") + "</p>" +
    '<p style="color:#6C6357;line-height:1.6;margin:16px 0 0">Open the restaurant\'s menu and order again, ' +
    "or send them a message directly.</p></div></body></html>"
  );
}

/**
 * GET /s/<orderId>  (rewritten from /api/order?short=1&code=<orderId>)
 *
 * The guest mail carries this instead of a wa.me URL with the whole order
 * encoded into it. It answers 302 to the same chat, with the message rebuilt
 * from the stored order — so nothing is trusted from the URL beyond the id.
 */
async function shortLinkRoute(req, res) {
  const id = uuidFromCode((req.query && req.query.code) || "");
  if (!id) return gonePage(res, "That is not an order link.");
  const got = await rest("orders?id=eq." + encodeURIComponent(id) +
    "&select=id,restaurant_id,mode,table_no,pickup_at,address,guest_name,guest_phone,total");
  const order = got.ok && (got.data || [])[0];
  if (!order) return gonePage(res, "That order is not on this account any more.");

  const rr = await rest("restaurants?id=eq." + encodeURIComponent(order.restaurant_id) +
    "&select=name,whatsapp_e164,sender_mode,wa_phone_number_id,wa_order_e164");
  const restaurant = rr.ok && (rr.data || [])[0];
  if (!restaurant) return gonePage(res, "The restaurant behind this order is gone.");

  const ir = await rest("order_items?order_id=eq." + encodeURIComponent(order.id) + "&select=name,qty,unit_price");
  const items = ir.ok ? (ir.data || []) : [];

  res.statusCode = 302;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", waUrlFor(restaurant, orderMessage({ order, items, restaurant })));
  return res.end();
}

/* The guest picks "15 min", "30 min", "45 min" or "1 hour" — a label, not a date.
   `new Date("30 min").toISOString()` throws RangeError, and because that ran while
   the order row was being built, EVERY Take Away order died before it was saved:
   the guest pressed order and nothing reached the kitchen. Turn the label into a
   real time, and fall back to null rather than throwing. */
function pickupWhen(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  const mins = /^(\d{1,4})\s*(m|min|mins|minute|minutes)$/i.exec(text);
  if (mins) return new Date(Date.now() + Number(mins[1]) * 60e3);
  const hours = /^(\d{1,2})\s*(h|hr|hrs|hour|hours)$/i.exec(text);
  if (hours) return new Date(Date.now() + Number(hours[1]) * 3600e3);
  const when = new Date(text);
  return isNaN(when.getTime()) ? null : when;
}
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  /* The short link in the guest's mail: /s/<order id> is rewritten here with
     ?short=1&code=<id>, so one function serves the order, the owner's list and
     the redirect. */
  if (req.method === "GET" && req.query && (req.query.short === "1" || req.query.short === "true")) {
    return shortLinkRoute(req, res);
  }
  /* one function, two verbs: POST places an order, GET lists the owner's orders.
     The Hobby plan allows 12 functions and we were at the ceiling. */
  if (req.method === "GET") return listOrders(req, res);
  if (req.method === "PATCH") return listOrders.setStatus(req, res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Credentials missing on the server." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, code: "BAD_BODY", message: "Send the order as JSON." });
  }

  const handle = clean(body.handle, 40).toLowerCase();
  if (!SAFE_HANDLE.test(handle)) {
    return res.status(400).json({ ok: false, code: "BAD_HANDLE", message: "Unknown menu address." });
  }

  /* ------------------------------------------------------------------ tablet
   * A staff tablet order is a real order in the same ledger, taken by someone
   * standing at the table. Three things make it different from a guest's:
   *   · it needs a signed-in member of THIS restaurant with the orders right,
   *     because nobody outside can type an order into the kitchen;
   *   · it takes no contact details — the guest is in front of the person
   *     entering it, so name/phone/email are optional;
   *   · it sends nothing. No WhatsApp, no mail: there is no guest hand-off to
   *     lose, and the tablet is itself the record being typed.
   * `source` is the only thing the client sets, and it is checked here.
   */
  const wantsTablet = String(body.source || "guest").toLowerCase() === "tablet";
  if (wantsTablet) {
    const user = await userFromToken(bearer(req));
    if (!user) {
      return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again on the tablet — that session has expired." });
    }
    const actor = await actorRestaurant(user, "id,handle,plan,paid_through,trial_ends");
    if (!actor || !actor.restaurant) {
      return res.status(403).json({ ok: false, code: "NO_RESTAURANT", message: "This login has no restaurant yet." });
    }
    if (String(actor.restaurant.handle || "").toLowerCase() !== handle) {
      return res.status(403).json({ ok: false, code: "NOT_YOURS", message: "That order belongs to another restaurant." });
    }
    /* `orders` is the dashboard's right; `tablet` is the waiter's. Both may
       take an order at the table — a menu-only login may not. */
    if (!can(actor.role, "orders") && !can(actor.role, "tablet")) {
      return res.status(403).json({ ok: false, code: "ROLE", message: "This login can edit the menu but not take orders." });
    }
  }

  /* One code, checked before the guest commits: what it is worth against this
     basket, from the row in the database rather than the number the page shows. */
  if (body.discountCheck) {
    const dHandle = clean(body.handle, 40).toLowerCase();
    if (!SAFE_HANDLE.test(dHandle)) {
      return res.status(400).json({ ok: false, code: "BAD_HANDLE", message: "Unknown menu address." });
    }
    const dr = await rest("restaurants?handle=eq." + encodeURIComponent(dHandle) + "&select=id,currency&limit=1");
    if (!dr.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const dress = (dr.data || [])[0];
    if (!dress) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No menu at that address." });

    const subtotal = Math.max(0, Number(body.subtotal) || 0);
    const verdict = await discount.check(dress.id, body.code, subtotal, body.phone);
    if (!verdict.ok) return res.status(200).json(verdict);
    return res.status(200).json({
      ok: true,
      code: verdict.code,
      percent: verdict.percent,
      amount: verdict.amount,
      total: verdict.total,
      currency: dress.currency || "AED"
    });
  }

  const mode = MODES.includes(body.mode) ? body.mode : "Dine In";
  /* on the tablet nobody types the customer's name — the table is the identity */
  const guestName = clean(body.name, 80) ||
    (wantsTablet ? (mode === "Dine In" ? "Table " + (clean(body.table, 20) || "—") : "Counter") : "");
  const phoneDigits = clean(body.phone, 30).replace(/[^\d]/g, "");

  if (!guestName) {
    return res.status(400).json({ ok: false, code: "NAME", message: "A name is needed for the order." });
  }
  /* a guest's order without a number cannot be rescued when WhatsApp fails; a
     tablet order is already in the kitchen's hands */
  if (!wantsTablet && phoneDigits.length < 7) {
    return res.status(400).json({ ok: false, code: "PHONE", message: "A mobile number is needed in case WhatsApp fails." });
  }
  const guestEmail = clean(body.email, 120).toLowerCase();
  if (!wantsTablet && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(guestEmail)) {
    return res.status(400).json({ ok: false, code: "EMAIL", message: "An email address is needed for the order." });
  }

  const items = Array.isArray(body.items) ? body.items.filter((i) => i && i.name).slice(0, 100) : [];
  if (!items.length) {
    return res.status(400).json({ ok: false, code: "NO_ITEMS", message: "The order had no dishes." });
  }

  /* 0023 adds the fence to the row we already read. A separate, narrower read
     keeps a deployment ahead of the migration working: no radius means every
     delivery is confirmed on the phone, as before. */
  const REST_COLS = "id,name,whatsapp_e164,order_email,sender_mode,wa_phone_number_id,wa_order_e164,currency";
  /* A tablet order may be taken while the restaurant is still in its free week:
     the row is `trial` and the guest page is deliberately dark, but the kitchen
     is standing in the restaurant taking an order. A guest's order still needs a
     published menu, because that is the page they ordered from. */
  const WHERE = wantsTablet ? "status=in.(published,trial)" : "status=eq.published";
  let found = await rest("restaurants?handle=eq." + encodeURIComponent(handle) +
    "&" + WHERE + "&select=" + REST_COLS + ",delivery_radius_km,lat,lng");
  if (!found.ok) {
    found = await rest("restaurants?handle=eq." + encodeURIComponent(handle) +
      "&" + WHERE + "&select=" + REST_COLS);
  }
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (found.data || [])[0];
  if (!restaurant) {
    return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No published menu at that address." });
  }

  /* The paywall, enforced where the order is actually written — for the tablet
     as well as for the guest. Taking an order is what Pro and Ultra sell, and
     the free week is worth Pro; the menu-only plan does not take orders at the
     counter either. The rule lives in api/_lib/ordering.js and api/menu.js calls
     the same function, because two copies of this decision is how a restaurant
     in its free week was shown an order form and then refused every order. */
  {
    const gate = await rest("restaurants?handle=eq." + encodeURIComponent(handle) +
      "&select=plan,paid_through,trial_ends");
    if (gate.ok && (gate.data || [])[0]) {
      const verdict = canTakeOrders(gate.data[0]);
      if (!verdict.ok) {
        return res.status(403).json({
          ok: false,
          code: verdict.code,
          message: wantsTablet
            ? "This menu is on the plan without ordering, so the tablet cannot take orders. Upgrade to Pro to take orders at the table."
            : verdict.message
        });
      }
    }
  }

  /* The fence, re-checked where the order is written. The guest page asks for a
     location before it will offer Delivery, but a hand-made POST can claim any
     coordinates — so the same arithmetic runs here, on the restaurant's own
     radius. No location in the request means no check: the restaurant confirms
     the distance on the phone, exactly as it did before this existed. */
  if (mode === "Delivery" && Number(restaurant.delivery_radius_km) > 0 && restaurant.lat != null && restaurant.lng != null) {
    const here = geo.pair(body.lat, body.lng);
    const km = here ? geo.kmBetween({ lat: Number(restaurant.lat), lng: Number(restaurant.lng) }, here) : null;
    if (km != null && km > Number(restaurant.delivery_radius_km)) {
      return res.status(409).json({
        ok: false,
        code: "OUT_OF_AREA",
        message: "That address is " + km + " km away and " + restaurant.name + " delivers within " + Number(restaurant.delivery_radius_km) + " km.",
        km: km,
        radiusKm: Number(restaurant.delivery_radius_km)
      });
    }
  }

  /* the total is recomputed here: a client-side total is a claim, not a fact */
  let total = 0;
  const rows = items.map((it) => {
    const qty = Math.max(1, Math.min(99, Number(it.qty) || 1));
    const price = Math.max(0, Math.round((Number(it.price) || 0) * 100) / 100);
    total += price * qty;
    return {
      name: clean(it.name, 120),
      unit_price: price,
      qty,
      menu_item_id: /^[0-9a-f-]{36}$/i.test(String(it.id || "")) ? it.id : null
    };
  });
  const subtotal = Math.round(total * 100) / 100;

  /* The code is re-checked here, not trusted from the checkout page, and a used
     or stale one is refused rather than quietly dropped — a guest who saw
     "AED 20 off" must not be charged full price without being told. */
  let applied = null;
  if (body.discountCode) {
    const verdict = await discount.check(restaurant.id, body.discountCode, subtotal, body.phone);
    if (!verdict.ok) {
      const status = verdict.code === "NO_DISCOUNTS" ? 503 : 409;
      return res.status(status).json({ ok: false, code: verdict.code, message: verdict.message, subtotal: subtotal });
    }
    applied = verdict;
  }
  total = applied ? applied.total : subtotal;
  const pickupTime = mode === "Take Away" ? pickupWhen(body.pickupAt) : null;

  const submitKey = clean(body.submitKey, 64) || null;
  const order = {
    restaurant_id: restaurant.id,
    mode,
    table_no: mode === "Dine In" ? clean(body.table, 20) || null : null,
    pickup_at: mode === "Take Away" && pickupTime ? pickupTime.toISOString() : null,
    address: mode === "Delivery" ? clean(body.address, 300) || null : null,
    guest_name: guestName,
    guest_phone: clean(body.phone, 30) || null,
    email: guestEmail || null,
    total,
    subtotal: subtotal,
    delivery_fee: 0,
    discount_code: applied ? applied.code : null,
    discount_amount: applied ? applied.amount : 0,
    status: "awaiting_confirmation",
    /* 0023: which door this order came through. Dropped by the retry below if
       the migration has not run yet — an order is worth more than a label. */
    source: wantsTablet ? "tablet" : "guest"
  };
  if (submitKey) order.submit_key = submitKey;

  /* A second press of the same button, a double tap on a slow phone, or the
     same order sent twice a second apart all used to land as separate orders —
     the kitchen then cooks the same dish three times. An identical order from
     the same phone within two minutes is the same order: return the one that
     exists instead of making another.
     Two different tables ordering the same food have no phone number at all, so
     the tablet relies on submitKey alone (below) and never on this guess. */
  const since = new Date(Date.now() - 120000).toISOString();
  const twin = wantsTablet ? { ok: true, data: [] } : await rest(
    "orders?restaurant_id=eq." + restaurant.id +
    "&guest_phone=eq." + encodeURIComponent(order.guest_phone) +
    "&total=eq." + total +
    "&created_at=gte." + encodeURIComponent(since) +
    "&select=id,created_at&order=created_at.desc&limit=1"
  );
  if (twin.ok && (twin.data || []).length) {
    return res.status(200).json({
      ok: true,
      duplicate: true,
      orderId: twin.data[0].id,
      notified: false,
      message: "This order was already received."
    });
  }

  /* A plain insert, then read the outcome. `on_conflict=submit_key` looked
     tidier but Postgres cannot infer a PARTIAL unique index from it, so every
     order failed with "no unique or exclusion constraint matching the ON CONFLICT
     specification". The partial index still enforces uniqueness, so a repeated
     key comes back as 23505 and we answer with the row already created. */
  let made = await rest("orders", { method: "POST", body: order, prefer: "return=representation" });
  let duplicate = false;

  const why = JSON.stringify(made.error || made.data || "");
  if (!made.ok && submitKey && /23505|duplicate key|unique constraint/i.test(why)) {
    const ex = await rest("orders?submit_key=eq." + encodeURIComponent(submitKey) + "&select=*&limit=1");
    if (ex.ok && (ex.data || []).length) { made = { ok: true, data: ex.data }; duplicate = true; }
  }

  if (!made.ok && !duplicate && /submit_key|column|schema|PGRST204/i.test(why)) {
    /* 0021 not run yet: same order, no key */
    const noKey = Object.assign({}, order);
    delete noKey.submit_key;
    made = await rest("orders", { method: "POST", body: noKey, prefer: "return=representation" });
  }
  const why2 = JSON.stringify(made.error || made.data || "");
  if (!made.ok && /subtotal|discount_|delivery_fee|email|source|column|schema|PGRST204/i.test(why2)) {
    /* 0019 or 0020 not run yet: the money columns and the email have to go —
       and 0023's `source`, which only labels the door the order came through */
    const lean = Object.assign({}, order);
    delete lean.subtotal;
    delete lean.delivery_fee;
    delete lean.discount_code;
    delete lean.discount_amount;
    delete lean.email;
    delete lean.submit_key;
    delete lean.source;
    made = await rest("orders", { method: "POST", body: lean, prefer: "return=representation" });
  }
  if (!made.ok) {
    return res.status(500).json({
      ok: false,
      code: "SAVE_FAILED",
      message: "The restaurant did not receive the order record.",
      detail: JSON.stringify(made.error || made.data || "").slice(0, 300)
    });
  }
  const saved = (made.data || [])[0];

  if (applied && saved && saved.id) {
    const red = await discount.redeem(restaurant.id, applied.id, applied.code, body.phone, saved.id, applied.amount);
    if (!red.ok) console.error("[order] redemption", red.error);
  }

  const lines = rows.map((r) => ({ ...r, order_id: saved.id }));
  const lineRes = await rest("order_items", { method: "POST", body: lines, prefer: "return=minimal" });

  const when = new Date().toLocaleString("en-AE", { timeZone: "Asia/Dubai", hour12: true });
  const detail =
    mode === "Dine In" ? "Dine In · table " + (order.table_no || "—")
    : mode === "Take Away" ? "Take Away · collect in " + (clean(body.pickupAt, 20) || "as soon as ready")
    : "Delivery · " + (order.address || "address on the phone");
  const itemLines = rows.map((r) =>
    "  " + r.qty + " × " + r.name + "  —  AED " + (r.unit_price * r.qty).toFixed(2)).join("\n");

  /* The guest gets the email, not the restaurant: the order is already in the
     panel, and the one step that can still be lost is theirs — sending it on
     WhatsApp. The mail carries a SHORT link (/s/<order id>) rather than a wa.me
     URL with the whole order percent-encoded into it: that link was several
     hundred characters and wrapped into nonsense in every mail client. The
     short link answers a 302 to the same chat, with the message rebuilt from
     the stored order. */
  const waLink = shortOrderLink(saved.id);

  let guestNotified = false;
  if (!wantsTablet && mail.ready && guestEmail) {
    const body = [
      "Hello " + guestName + ",",
      "",
      "Your order at " + restaurant.name + " is saved.",
      "",
      detail,
      "",
      itemLines,
      "",
      "Total: AED " + total.toFixed(2),
      "Reference: " + String(saved.id).slice(0, 8),
      "",
      "One step left: send the order on WhatsApp so the restaurant can confirm it.",
      waLink,
      "",
      "If you have already sent it, there is nothing more to do — ignore this.",
      "",
      when
    ].join("\n");

    const sent = await mail.sendMail({
      to: [guestEmail],
      subject: "Your order at " + restaurant.name + " — one step left",
      fromName: restaurant.name,
      replyTo: restaurant.order_email || undefined,
      text: body
    }, 9000);
    guestNotified = Boolean(sent.ok);
    if (!sent.ok) console.error("[order] guest mail", sent.code, sent.detail);
  }

  /* The restaurant's copy goes to ITS address — never to the platform's. If no
     order address is set for the restaurant, the order still arrives in the
     panel and no mail is sent. A tablet order is not mailed: the person who
     typed it is the restaurant. */
  let notified = false;
  if (!wantsTablet && mail.ready && restaurant.order_email) {
    const body = [
      "New order — " + restaurant.name,
      "",
      detail,
      "Guest: " + guestName,
      "Mobile: " + order.guest_phone,
      "Email: " + guestEmail,
      "",
      itemLines,
      "",
      applied ? "Subtotal: AED " + subtotal.toFixed(2) : "",
      applied ? "Discount " + applied.code + " (" + applied.percent + "%): -AED " + applied.amount.toFixed(2) : "",
      "Total: AED " + total.toFixed(2),
      "",
      when,
      "Reference: " + String(saved.id).slice(0, 8)
    ].filter(function (line) { return line !== ""; }).join("\n");

    const sent = await mail.sendMail({
      to: [restaurant.order_email],
      subject: "New order — " + restaurant.name + " · AED " + total.toFixed(2) + " · " + mode,
      fromName: restaurant.name + " (DigiMenu)",
      replyTo: guestEmail,
      text: body
    }, 9000);
    notified = Boolean(sent.ok);
    if (!sent.ok) console.error("[order] restaurant mail", sent.code, sent.detail);
  }

  return res.status(200).json({
    ok: true,
    orderId: saved.id,
    total,
    subtotal,
    discount: applied ? { code: applied.code, amount: applied.amount } : null,
    items: lines.length,
    linesSaved: lineRes.ok,
    notified,
    guestNotified,
    mailReady: mail.ready,
    /* which door it came through — the tablet shows this instead of a WhatsApp
       hand-off, and the panel files it under its own section */
    source: wantsTablet ? "tablet" : "guest"
  });
};

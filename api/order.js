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

const { rest, cors, configured } = require("./_lib/db");
const mail = require("./_lib/mail");
const listOrders = require("./_lib/order-list");
const discount = require("./_lib/discounts");
const { canTakeOrders } = require("./_lib/ordering");

const MODES = ["Dine In", "Take Away", "Delivery"];

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
  const guestName = clean(body.name, 80);
  const phoneDigits = clean(body.phone, 30).replace(/[^\d]/g, "");

  if (!guestName) {
    return res.status(400).json({ ok: false, code: "NAME", message: "A name is needed for the order." });
  }
  if (phoneDigits.length < 7) {
    return res.status(400).json({ ok: false, code: "PHONE", message: "A mobile number is needed in case WhatsApp fails." });
  }
  const guestEmail = clean(body.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(guestEmail)) {
    return res.status(400).json({ ok: false, code: "EMAIL", message: "An email address is needed for the order." });
  }

  const items = Array.isArray(body.items) ? body.items.filter((i) => i && i.name).slice(0, 100) : [];
  if (!items.length) {
    return res.status(400).json({ ok: false, code: "NO_ITEMS", message: "The order had no dishes." });
  }

  const found = await rest("restaurants?handle=eq." + encodeURIComponent(handle) +
    "&status=eq.published&select=id,name,whatsapp_e164,order_email,sender_mode,wa_phone_number_id,wa_order_e164,currency");
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (found.data || [])[0];
  if (!restaurant) {
    return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No published menu at that address." });
  }

  /* The paywall, enforced where the order is actually written. The rule lives in
     api/_lib/ordering.js and api/menu.js calls the same function — two copies of
     this decision is how a restaurant in its free week was shown an order form
     and then refused every order. */
  const gate = await rest("restaurants?handle=eq." + encodeURIComponent(handle) +
    "&select=plan,paid_through,trial_ends");
  if (gate.ok && (gate.data || [])[0]) {
    const verdict = canTakeOrders(gate.data[0]);
    if (!verdict.ok) {
      return res.status(403).json({ ok: false, code: verdict.code, message: verdict.message });
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
    guest_phone: clean(body.phone, 30),
    email: guestEmail,
    total,
    subtotal: subtotal,
    delivery_fee: 0,
    discount_code: applied ? applied.code : null,
    discount_amount: applied ? applied.amount : 0,
    status: "awaiting_confirmation"
  };
  if (submitKey) order.submit_key = submitKey;

  /* A second press of the same button, a double tap on a slow phone, or the
     same order sent twice a second apart all used to land as separate orders —
     the kitchen then cooks the same dish three times. An identical order from
     the same phone within two minutes is the same order: return the one that
     exists instead of making another. */
  const since = new Date(Date.now() - 120000).toISOString();
  const twin = await rest(
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
  if (!made.ok && /subtotal|discount_|delivery_fee|email|column|schema|PGRST204/i.test(why2)) {
    /* 0019 or 0020 not run yet: the money columns and the email have to go */
    const lean = Object.assign({}, order);
    delete lean.subtotal;
    delete lean.delivery_fee;
    delete lean.discount_code;
    delete lean.discount_amount;
    delete lean.email;
    delete lean.submit_key;
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
     WhatsApp. So the mail carries the same prefilled link, in case the chat did
     not open or they closed it before pressing send. */
  const waNumber = (restaurant.sender_mode === "cloud" && restaurant.wa_phone_number_id && restaurant.wa_order_e164)
    ? restaurant.wa_order_e164
    : restaurant.whatsapp_e164;
  const waText = [
    "Order — " + restaurant.name,
    detail,
    "Guest: " + guestName,
    "",
    itemLines,
    "",
    "Total: AED " + total.toFixed(2),
    "Reference: " + String(saved.id).slice(0, 8)
  ].join("\n");
  const waLink = "https://wa.me/" + String(waNumber || "").replace(/[^\d]/g, "") +
    "?text=" + encodeURIComponent(waText);

  let guestNotified = false;
  if (mail.ready && guestEmail) {
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
     panel and no mail is sent. */
  let notified = false;
  if (mail.ready && restaurant.order_email) {
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
    mailReady: mail.ready

  });
};

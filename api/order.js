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

const MODES = ["Dine In", "Take Away", "Delivery"];
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
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

  const mode = MODES.includes(body.mode) ? body.mode : "Dine In";
  const guestName = clean(body.name, 80);
  const phoneDigits = clean(body.phone, 30).replace(/[^\d]/g, "");

  if (!guestName) {
    return res.status(400).json({ ok: false, code: "NAME", message: "A name is needed for the order." });
  }
  if (phoneDigits.length < 7) {
    return res.status(400).json({ ok: false, code: "PHONE", message: "A mobile number is needed in case WhatsApp fails." });
  }

  const items = Array.isArray(body.items) ? body.items.filter((i) => i && i.name).slice(0, 100) : [];
  if (!items.length) {
    return res.status(400).json({ ok: false, code: "NO_ITEMS", message: "The order had no dishes." });
  }

  const found = await rest("restaurants?handle=eq." + encodeURIComponent(handle) + "&status=eq.published&select=id,name,whatsapp_e164,order_email");
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (found.data || [])[0];
  if (!restaurant) {
    return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No published menu at that address." });
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
  total = Math.round(total * 100) / 100;

  const order = {
    restaurant_id: restaurant.id,
    mode,
    table_no: mode === "Dine In" ? clean(body.table, 20) || null : null,
    pickup_at: mode === "Take Away" && body.pickupAt ? new Date(body.pickupAt).toISOString() : null,
    address: mode === "Delivery" ? clean(body.address, 300) || null : null,
    guest_name: guestName,
    guest_phone: clean(body.phone, 30),
    total,
    status: "awaiting_confirmation"
  };

  const made = await rest("orders", { method: "POST", body: order, prefer: "return=representation" });
  if (!made.ok) {
    return res.status(500).json({
      ok: false,
      code: "SAVE_FAILED",
      message: "The restaurant did not receive the order record.",
      detail: String(made.data).slice(0, 200)
    });
  }
  const saved = (made.data || [])[0];

  const lines = rows.map((r) => ({ ...r, order_id: saved.id }));
  const lineRes = await rest("order_items", { method: "POST", body: lines, prefer: "return=minimal" });

  /* Tell the restaurant, by email, in the same request. The record is already
     stored, so a mail failure is reported in the response but never fails the
     guest — they did their part. */
  const when = new Date().toLocaleString("en-AE", { timeZone: "Asia/Dubai", hour12: true });
  const detail =
    mode === "Dine In" ? "Dine In · table " + (order.table_no || "—")
    : mode === "Take Away" ? "Take Away · collect at " + (body.pickup || "as soon as ready")
    : "Delivery · " + (order.address || "address on the phone");
  const itemLines = rows.map((r) => "  " + r.qty + " × " + r.name + "  —  AED " + (r.unit_price * r.qty).toFixed(2)).join("\n");
  const text = [
    "New order — " + restaurant.name,
    "",
    detail,
    "Guest: " + guestName,
    "Mobile: " + order.guest_phone,
    "",
    itemLines,
    "",
    "Total: AED " + total.toFixed(2),
    "",
    when,
    "Reference: " + String(saved.id).slice(0, 8)
  ].join("\n");

  const to = restaurant.order_email ? [restaurant.order_email] : [];
  const cc = [process.env.NOTIFY_EMAIL || "connect@indubaicity.com"].filter((e) => e && !to.includes(e));
  let notified = false;
  if ((to.length || cc.length) && mail.ready) {
    const sent = await mail.sendMail({
      to: to.length ? to : cc,
      cc: to.length ? cc : [],
      subject: "New order — " + restaurant.name + " · AED " + total.toFixed(2) + " · " + mode,
      fromName: restaurant.name + " (DigiMenu)",
      replyTo: restaurant.order_email || undefined,
      text
    }, 9000);
    notified = Boolean(sent.ok);
    if (!sent.ok) console.error("[order] mail", sent.code, sent.detail);
  }

  return res.status(200).json({
    ok: true,
    orderId: saved.id,
    total,
    items: lines.length,
    linesSaved: lineRes.ok,
    notified,
    mailReady: mail.ready
  });
};

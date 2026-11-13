/**
 * GET /api/orders (also reachable as GET /api/order — see vercel.json)
 *
 * The restaurant's own orders, newest first, with their lines. Resolved from the
 * caller's token — never from a query parameter — so one restaurant cannot read
 * another's.
 */

const { rest, userFromToken, actorRestaurant, bearer, cors, configured } = require("./db");
const discount = require("./discounts");

module.exports = async function listOrders(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Credentials missing on the server." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  const actor = await actorRestaurant(user, "id,handle,currency");
  const restaurant = actor && actor.restaurant;
  if (!restaurant) return res.status(200).json({ ok: true, orders: [], currency: "AED" });

  /* Optional server-side filters, used by the dashboard's History tab: without
     them the list stops at the newest 100 and a six-month-old order cannot be
     found by any date search. Everything is validated, never interpolated raw. */
  const q = req.query || {};
  const wantArchived = q.state === "archived";
  const state = q.state === "done" ? "eq.confirmed" : q.state === "active" ? "neq.confirmed" : "";
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
  const from = day(q.from), to = day(q.to);

  let filters = "";
  if (state) filters += "&status=" + state;
  if (from) filters += "&created_at=gte." + from + "T00:00:00";
  if (to) filters += "&created_at=lte." + to + "T23:59:59";

  /* archived rows are out of the shift unless they are what was asked for —
     including the plain list, which is what the Overview, the Open/History tabs
     and the Marketing customer list all read */
  const archFilter = wantArchived ? "&archived_at=not.is.null" : "&archived_at=is.null";

  const COLS = "id,mode,table_no,pickup_at,address,guest_name,guest_phone,total,status,created_at";
  const base = "orders?restaurant_id=eq." + restaurant.id;
  const tail = "&order=created_at.desc&limit=" + (from || to || state === "eq.confirmed" || wantArchived ? 500 : 100);

  /* 0016 adds the archive columns. A deploy can land before the migration is
     run, so ask for them and fall back to the plain read rather than taking
     the order list down. */
  const MONEY = ",subtotal,delivery_fee,discount_code,discount_amount";
  let list = await rest(base + "&select=" + COLS + ",archived_at,archive_reason" + MONEY + filters + archFilter + tail);
  let hasArchive = true, hasMoney = true;
  if (!list.ok) {
    hasMoney = false;
    list = await rest(base + "&select=" + COLS + ",archived_at,archive_reason" + filters + archFilter + tail);
  }
  if (!list.ok) {
    hasArchive = false;
    list = await rest(base + "&select=" + COLS + filters + tail);
  }
  if (!list.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

  const orders = list.data || [];
  let lines = [];
  if (orders.length) {
    const ids = orders.map((o) => o.id).join(",");
    const l = await rest("order_items?order_id=in.(" + ids + ")&select=order_id,name,qty,unit_price");
    if (l.ok) lines = l.data || [];
  }

  const byOrder = new Map();
  for (const line of lines) {
    if (!byOrder.has(line.order_id)) byOrder.set(line.order_id, []);
    byOrder.get(line.order_id).push({ name: line.name, qty: line.qty, price: Number(line.unit_price) });
  }

  /* What the guest said, and what we already sent them. The inbound time is the
     only honest evidence that the 24-hour window is open — it is what enables
     every button except Send Order. 0018 may not have been run yet, so a failed
     read means "no inbox", not "no orders". */
  const digits = (v) => String(v || "").replace(/[^\d]/g, "");
  const lastIn = new Map();        /* phone -> newest inbound */
  const sentFor = new Map();       /* order id -> { thankyou, accept, ready, review } */
  const sentForPhone = new Map();  /* phone -> newest outbound, for rows with no order id */

  if (orders.length) {
    const phones = Array.from(new Set(orders.map((o) => digits(o.guest_phone)).filter(Boolean)));
    if (phones.length) {
      const w = await rest(
        "wa_messages?restaurant_id=eq." + restaurant.id +
        "&customer_number=in.(" + phones.map(encodeURIComponent).join(",") + ")" +
        "&select=customer_number,direction,type,created_at,order_id&order=created_at.desc&limit=1000"
      );
      if (w.ok) {
        for (const m of w.data || []) {
          const phone = digits(m.customer_number);
          if (m.direction === "in") {
            if (!lastIn.has(phone)) lastIn.set(phone, m.created_at);
          } else if (m.order_id) {
            if (!sentFor.has(m.order_id)) sentFor.set(m.order_id, {});
            const bag = sentFor.get(m.order_id);
            if (!bag[m.type]) bag[m.type] = m.created_at;
          } else if (phone) {
            if (!sentForPhone.has(phone)) sentForPhone.set(phone, m.type);
          }
        }
      }
    }
  }

  return res.status(200).json({
    ok: true,
    currency: restaurant.currency || "AED",
    orders: orders.map((o) => ({
      id: o.id,
      createdAt: o.created_at,
      mode: o.mode,
      table: o.table_no,
      pickupAt: o.pickup_at,
      address: o.address,
      guest: o.guest_name,
      phone: o.guest_phone,
      total: Number(o.total),
      subtotal: o.subtotal == null ? Number(o.total) : Number(o.subtotal),
      deliveryFee: Number(o.delivery_fee) || 0,
      discountCode: o.discount_code || null,
      discountAmount: Number(o.discount_amount) || 0,
      status: o.status,
      archivedAt: o.archived_at || null,
      archiveReason: o.archive_reason || null,
      /* the panel's buttons read these three */
      inboundAt: lastIn.get(digits(o.guest_phone)) || null,
      waSent: sentFor.get(o.id) || (sentForPhone.get(digits(o.guest_phone)) ? { thankyou: true } : null),
      items: byOrder.get(o.id) || []
    }))
  });
};

/**
 * PATCH /api/orders  { id, status }
 *
 * The restaurant moves an order between the two states it cares about:
 * pending (it is in the kitchen) and confirmed (it is done, and the guest is
 * someone worth asking for a review). Scoped to the caller's own restaurant —
 * the id in the body is never trusted to imply ownership.
 */
module.exports.setStatus = async function setStatus(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "PATCH") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Credentials missing on the server." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  const actor = await actorRestaurant(user, "id,handle");
  const restaurant = actor && actor.restaurant;
  if (!restaurant) return res.status(403).json({ ok: false, code: "NOT_STAFF", message: "This account has no restaurant." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const id = body && String(body.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, code: "NO_ID", message: "Which order?" });

  /* Archiving is not a status: the order still happened, and which state it
     reached stays as it was. It just leaves the shift, with a reason on file. */
  if (body.archive !== undefined) {
    const on = body.archive === true;
    const updArch = await rest("orders?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + restaurant.id, {
      method: "PATCH",
      prefer: "return=representation",
      body: on
        ? { archived_at: new Date().toISOString(), archive_reason: String(body.reason || "").trim().slice(0, 120) || "Other" }
        : { archived_at: null, archive_reason: null }
    });
    if (!updArch.ok) {
      /* the columns arrive with 0016 */
      return res.status(503).json({ ok: false, code: "NO_ARCHIVE", message: "Archiving is not switched on yet — run db/0016_archive_orders.sql." });
    }
    if (!(updArch.data || []).length) {
      return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That order is not yours." });
    }
    return res.status(200).json({ ok: true, id, archived: on });
  }

  /* ------------------------------------------------------------ edit lines
     The kitchen changes an order after it lands: a guest adds a drink, the
     restaurant adds the delivery charge, a code is applied. Everything that
     decides money is recomputed here from the items, never taken from the page. */
  if (body.edit) {
    const ed = body.edit;
    const inItems = Array.isArray(ed.items) ? ed.items.filter((i) => i && i.name).slice(0, 100) : [];
    if (!inItems.length) {
      return res.status(400).json({ ok: false, code: "NO_ITEMS", message: "An order needs at least one dish." });
    }

    const found = await rest(
      "orders?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + restaurant.id +
      "&select=id,guest_phone,mode,status&limit=1"
    );
    if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const ord = (found.data || [])[0];
    if (!ord) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That order is not yours." });

    let subtotal = 0;
    const rows = inItems.map((it) => {
      const qty = Math.max(1, Math.min(99, Number(it.qty) || 1));
      const price = Math.max(0, discount.money(it.price));
      subtotal += price * qty;
      return {
        order_id: id,
        name: String(it.name || "").trim().slice(0, 120),
        unit_price: price,
        qty: qty,
        menu_item_id: /^[0-9a-f-]{36}$/i.test(String(it.id || "")) ? it.id : null
      };
    });
    subtotal = discount.money(subtotal);

    const fee = Math.max(0, discount.money(ed.deliveryFee));

    let applied = null;
    if (ed.discountCode) {
      const verdict = await discount.check(restaurant.id, ed.discountCode, subtotal, ord.guest_phone, id);
      if (!verdict.ok) {
        return res.status(409).json({ ok: false, code: verdict.code, message: verdict.message });
      }
      applied = verdict;
    }
    const total = discount.money(Math.max(0, subtotal + fee - (applied ? applied.amount : 0)));

    const patch = {
      total: total,
      subtotal: subtotal,
      delivery_fee: fee,
      discount_code: applied ? applied.code : null,
      discount_amount: applied ? applied.amount : 0
    };

    let upd = await rest("orders?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + restaurant.id, {
      method: "PATCH", prefer: "return=representation", body: patch
    });
    /* before 0019 lands there are no money columns; the total still moves */
    if (!upd.ok) {
      upd = await rest("orders?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + restaurant.id, {
        method: "PATCH", prefer: "return=representation", body: { total: total }
      });
    }
    if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "That did not save." });

    const wiped = await rest("order_items?order_id=eq." + encodeURIComponent(id), {
      method: "DELETE", prefer: "return=minimal"
    });
    if (!wiped.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "The lines did not save." });
    const wroteLines = await rest("order_items", { method: "POST", prefer: "return=minimal", body: rows });
    if (!wroteLines.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "The lines did not save." });

    if (applied) {
      const red = await discount.redeem(restaurant.id, applied.id, applied.code, ord.guest_phone, id, applied.amount);
      if (!red.ok) console.error("[order edit] redemption", red.error);
    }

    return res.status(200).json({
      ok: true,
      id: id,
      subtotal: subtotal,
      deliveryFee: fee,
      discount: applied ? { code: applied.code, amount: applied.amount, percent: applied.percent } : null,
      total: total
    });
  }

  /* two states, not four: everything else in the column is history */
  const want = body.status === "confirmed" ? "confirmed" : "awaiting_confirmation";

  const upd = await rest("orders?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + restaurant.id, {
    method: "PATCH",
    prefer: "return=representation",
    body: { status: want }
  });
  if (!upd.ok) {
    return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "That did not save." });
  }
  if (!(upd.data || []).length) {
    return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That order is not yours." });
  }

  return res.status(200).json({ ok: true, id, status: want });
};

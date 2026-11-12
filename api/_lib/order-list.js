/**
 * GET /api/orders (also reachable as GET /api/order — see vercel.json)
 *
 * The restaurant's own orders, newest first, with their lines. Resolved from the
 * caller's token — never from a query parameter — so one restaurant cannot read
 * another's.
 */

const { rest, userFromToken, actorRestaurant, bearer, cors, configured } = require("./db");

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

  const list = await rest(
    "orders?restaurant_id=eq." + restaurant.id +
    "&select=id,mode,table_no,pickup_at,address,guest_name,guest_phone,total,status,created_at" +
    "&order=created_at.desc&limit=100"
  );
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
      status: o.status,
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

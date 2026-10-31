/**
 * GET /api/orders
 *
 * The restaurant's own orders, newest first, with their lines. Resolved from the
 * caller's token — never from a query parameter — so one restaurant cannot read
 * another's.
 */

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Credentials missing on the server." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  const own = await rest("restaurants?owner_id=eq." + user.id + "&select=id,handle,currency");
  if (!own.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (own.data || [])[0];
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

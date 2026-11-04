/**
 * /api/admin — the operator console behind a shared secret.
 *
 * Payment is manual until Stripe lands: money arrives by transfer or cash, and
 * this endpoint records that it did. It writes the same columns a Stripe webhook
 * will write later, so swapping the source never touches the rest of the app.
 *
 * Auth is a single header, ADMIN_TOKEN, set in the host environment. Without it
 * the endpoint refuses everything — there is no "logged in as admin" user model
 * yet, and inventing one would be a bigger change than the business needs today.
 */

const { rest, cors, configured } = require("./_lib/db");

const PLANS = ["qr", "order"];
const BILLING = ["monthly", "yearly"];

function authorised(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  const given = String(req.headers["x-admin-token"] || "");
  if (!expected || !given) return false;
  /* same length first, then compare — keeps the timing honest */
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** One month or one year from a date, never from "now" when extending an active plan. */
function extend(from, billing) {
  const base = from && new Date(from) > new Date() ? new Date(from) : new Date();
  const d = new Date(base.getTime());
  if (billing === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, code: "NO_ADMIN_TOKEN", message: "Set ADMIN_TOKEN on the server first." });
  }
  if (!authorised(req)) {
    return res.status(401).json({ ok: false, code: "UNAUTHORISED", message: "That admin key is not right." });
  }

  /* ---- list every restaurant with what it is owed ---- */
  if (req.method === "GET") {
    const r = await rest("restaurants?select=id,handle,name,status,plan,billing,paid_through,paid_amount,pay_ref,pay_method,activated_at,addon_site,order_email&order=created_at");
    if (!r.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const today = new Date().toISOString().slice(0, 10);
    const rows = (r.data || []).map((x) => ({
      ...x,
      active: Boolean(x.paid_through && x.paid_through >= today),
      price: x.plan === "order" ? (x.billing === "yearly" ? 190 : 19) : (x.billing === "yearly" ? 20 : 2)
    }));
    return res.status(200).json({ ok: true, restaurants: rows, today });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.handle) return res.status(400).json({ ok: false, code: "NO_HANDLE", message: "Which restaurant?" });

  const found = await rest("restaurants?handle=eq." + encodeURIComponent(String(body.handle).toLowerCase()) + "&select=id,handle,name,plan,billing,paid_through");
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const r0 = (found.data || [])[0];
  if (!r0) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No restaurant with that handle." });

  const action = String(body.action || "record-payment");
  const patch = {};

  if (action === "set-plan") {
    if (!PLANS.includes(body.plan)) return res.status(400).json({ ok: false, code: "BAD_PLAN" });
    patch.plan = body.plan;
    if (BILLING.includes(body.billing)) patch.billing = body.billing;
  } else if (action === "record-payment") {
    if (BILLING.includes(body.billing)) patch.billing = body.billing;
    patch.paid_through = extend(body.from || r0.paid_through, patch.billing || r0.billing || "monthly");
    patch.paid_amount = Number(body.amount) || (patch.billing === "yearly"
      ? (r0.plan === "order" || body.plan === "order" ? 190 : 20)
      : (r0.plan === "order" || body.plan === "order" ? 19 : 2));
    patch.pay_ref = body.payRef ? String(body.payRef).slice(0, 120) : null;
    patch.pay_method = "manual";
    patch.activated_at = new Date().toISOString();
    if (PLANS.includes(body.plan)) patch.plan = body.plan;
    if (typeof body.addonSite === "boolean") patch.addon_site = body.addonSite;
  } else if (action === "stop") {
    patch.paid_through = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  } else {
    return res.status(400).json({ ok: false, code: "BAD_ACTION", message: "Unknown action." });
  }

  const upd = await rest("restaurants?id=eq." + r0.id, { method: "PATCH", body: patch, prefer: "return=representation" });
  if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", detail: String(upd.data).slice(0, 200) });

  const row = (upd.data || [])[0] || {};
  const today = new Date().toISOString().slice(0, 10);

  /* stopping payment must not leave a menu live that nobody has paid for */
  if (action === "stop" && row.status === "published") {
    await rest("restaurants?id=eq." + r0.id, { method: "PATCH", body: { status: "draft" } });
    row.status = "draft";
  }

  return res.status(200).json({
    ok: true,
    restaurant: {
      handle: row.handle, name: row.name, plan: row.plan, billing: row.billing,
      paid_through: row.paid_through, paid_amount: row.paid_amount, pay_ref: row.pay_ref,
      status: row.status, active: Boolean(row.paid_through && row.paid_through >= today)
    }
  });
};

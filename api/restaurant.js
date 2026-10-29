/**
 * /api/restaurant
 *
 * GET                      own restaurant (auth) or 204 when none yet
 * GET  ?check=handle       is this address free? (public, boolean only)
 * POST { ...fields }       create or update own restaurant (auth)
 *
 * One restaurant per account in phase 1: the row is found by owner_id, so a
 * second POST updates rather than creating a stray duplicate.
 */

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const PURPOSES = ["Dine In", "Take Away", "Delivery"];

function cleanHandle(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Supabase credentials missing on the server." });
  }

  /* ---------------------------------------------------- handle availability */
  if (req.method === "GET" && req.query && req.query.check !== undefined) {
    const handle = cleanHandle(req.query.check);
    if (!SAFE_HANDLE.test(handle)) {
      return res.status(200).json({ ok: true, handle, available: false, reason: "too-short" });
    }
    const hit = await rest("restaurants?handle=eq." + encodeURIComponent(handle) + "&select=handle");
    if (!hit.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    return res.status(200).json({ ok: true, handle, available: (hit.data || []).length === 0 });
  }

  /* ---------------------------------------------------------------- auth'd */
  const user = await userFromToken(bearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
  }

  const mine = await rest("restaurants?owner_id=eq." + user.id + "&select=*");
  if (!mine.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const existing = (mine.data || [])[0] || null;

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, restaurant: existing });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, code: "METHOD" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, code: "BAD_BODY", message: "Send the restaurant fields as JSON." });
  }

  const name = String(body.name || existing?.name || "").trim();
  const handle = cleanHandle(body.handle || existing?.handle || "");
  const whatsapp = String(body.whatsapp_e164 || existing?.whatsapp_e164 || "").replace(/\s+/g, "");
  const orderEmail = String(body.order_email || existing?.order_email || user.email || "").trim();

  if (name.length < 2) return res.status(400).json({ ok: false, code: "NAME", message: "The restaurant name is too short." });
  if (!SAFE_HANDLE.test(handle)) return res.status(400).json({ ok: false, code: "HANDLE", message: "Choose 3–32 characters: lowercase letters, numbers and dashes." });
  if (!E164.test(whatsapp)) return res.status(400).json({ ok: false, code: "WHATSAPP", message: "The WhatsApp number needs a country code, e.g. +971525757079." });
  if (!EMAIL.test(orderEmail)) return res.status(400).json({ ok: false, code: "EMAIL", message: "That order email does not look complete." });

  let purposes = Array.isArray(body.purposes) ? body.purposes.filter((p) => PURPOSES.includes(p)) : null;
  if (!purposes || !purposes.length) purposes = existing?.purposes?.length ? existing.purposes : ["Dine In", "Take Away"];

  const patch = {
    name,
    handle,
    owner_name: body.owner_name !== undefined ? String(body.owner_name).slice(0, 80) : (existing?.owner_name ?? null),
    whatsapp_e164: whatsapp,
    order_email: orderEmail,
    purposes,
    city: body.city !== undefined ? String(body.city).slice(0, 60) : (existing?.city ?? "Abu Dhabi"),
    accent: body.accent !== undefined ? String(body.accent).slice(0, 20) : (existing?.accent ?? "#f7941d"),
    updated_at: new Date().toISOString()
  };
  for (const k of ["logo_url", "licence_url", "maps_url"]) {
    if (body[k] !== undefined) patch[k] = body[k] ? String(body[k]).slice(0, 500) : null;
  }
  if (body.status !== undefined && ["trial", "published", "suspended"].includes(body.status)) {
    patch.status = body.status;
    if (body.status === "published") patch.published_at = new Date().toISOString();
  }

  /* The unique index on lower(handle) is the real gate — this check only turns
     a raw 409 into a sentence the owner can act on. */
  const clash = await rest(
    "restaurants?handle=eq." + encodeURIComponent(handle) +
    (existing ? "&id=neq." + existing.id : "") + "&select=id"
  );
  if (clash.ok && (clash.data || []).length) {
    return res.status(409).json({
      ok: false,
      code: "HANDLE_TAKEN",
      message: "That address is already taken. Try another — it is the name printed on your QR code."
    });
  }

  const saved = existing
    ? await rest("restaurants?id=eq." + existing.id, { method: "PATCH", body: patch, prefer: "return=representation" })
    : await rest("restaurants", { method: "POST", body: { ...patch, owner_id: user.id }, prefer: "return=representation" });

  if (!saved.ok) {
    const detail = typeof saved.data === "object" && saved.data ? JSON.stringify(saved.data).slice(0, 200) : String(saved.data).slice(0, 200);
    return res.status(400).json({ ok: false, code: "SAVE_FAILED", message: "The restaurant could not be saved.", detail });
  }

  return res.status(200).json({ ok: true, restaurant: (saved.data || [])[0] || null });
};

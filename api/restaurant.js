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

const { rest, userFromToken, actorRestaurant, bearer, cors, configured } = require("./_lib/db");
const { PLANS: PLAN_TABLE, billable, upgradeLine, capabilities, isLive, darkReason } = require("./_lib/plans");

/* Media belongs to the restaurant, so it rides in the same deployment slot:
   POST /api/restaurant?upload=1 and GET ?upload=1&action=sweep. */
const uploadMedia = require("./_lib/upload");

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const PURPOSES = ["Dine In", "Take Away", "Delivery"];

/* The guest page's look. These three lists are the contract: a value outside
   them is dropped rather than stored, so a menu never receives a ground class
   or a font stack that does not exist. */
const THEME_GROUNDS = ["dark", "light", "clay"];
const THEME_INKS = ["soft", "strong"];
const THEME_FONTS = ["serif", "grotesk", "satoshi"];

function cleanTheme(v) {
  if (!v || typeof v !== "object") return {};
  const t = {};
  if (THEME_GROUNDS.includes(v.ground)) t.ground = v.ground;
  if (THEME_INKS.includes(v.ink)) t.ink = v.ink;
  if (THEME_FONTS.includes(v.font)) t.font = v.font;
  return t;
}

function cleanHandle(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

async function restaurantHandler(req, res) {
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
    const free = (hit.data || []).length === 0;

    /* A signed-in owner re-opening the wizard (a back button, a second tab, the
       emailed signup link) is told their *own* address is taken and the finish
       button stays disabled forever — the wizard could never be completed
       again. Their own handle is available to them, and to nobody else. */
    let own = false;
    if (!free) {
      const tok = bearer(req);
      if (tok) {
        const u = await userFromToken(tok);
        if (u) {
          const actor = await actorRestaurant(u, "handle");
          const mine = actor && actor.restaurant && actor.restaurant.handle;
          own = Boolean(mine && String(mine).toLowerCase() === handle);
        }
      }
    }
    if (own) return res.status(200).json({ ok: true, handle, available: true, own: true });
    return res.status(200).json({ ok: true, handle, available: free });
  }

  /* ---------------------------------------------------------------- auth'd */
  const user = await userFromToken(bearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
  }

  /* owner, or a staff login from 0008 — either way this is *their* restaurant */
  const actor = await actorRestaurant(user, "*");
  const existing = actor && actor.restaurant;
  const role = actor ? actor.role : null;

  if (req.method === "GET") {
    /* The dashboard paints from this: the row, whether the link is actually open
       today, and the entitlements the server will enforce. Nothing here decides
       anything — a refused request still is the rule. */
    return res.status(200).json({
      ok: true,
      restaurant: existing,
      role,
      live: existing ? isLive(existing) : false,
      dark_reason: existing ? darkReason(existing) : null,
      rights: existing ? capabilities(existing) : null
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, code: "METHOD" });
  }

  /* publishing, the plan and the guest page's public identity are the owner's
     decisions. A staff login that may edit dishes does not get to take the menu
     off the internet or change who it belongs to.
     No row yet means this is the person creating their own restaurant — the
     signup path — and they own whatever they create. */
  if (existing && role !== "owner") {
    return res.status(403).json({
      ok: false, code: "NOT_OWNER",
      message: "Only the owner can change the restaurant's own details."
    });
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
    city: body.city !== undefined ? String(body.city).slice(0, 60) : (existing?.city ?? "Dubai"),
    accent: body.accent !== undefined ? String(body.accent).slice(0, 20) : (existing?.accent ?? "#f7941d"),
    theme: body.theme !== undefined ? cleanTheme(body.theme) : (existing?.theme ?? {}),
    updated_at: new Date().toISOString()
  };
  for (const k of ["logo_url", "licence_url", "maps_url", "cover_url"]) {
    if (body[k] !== undefined) patch[k] = body[k] ? String(body[k]).slice(0, 500) : null;
  }
  for (const k of ["instagram", "facebook", "tiktok"]) {
    if (body[k] !== undefined) patch[k] = body[k] ? String(body[k]).replace(/^@/, "").trim().slice(0, 60) : null;
  }
  if (body.website !== undefined) {
    const w = body.website ? String(body.website).trim() : "";
    patch.website = w ? (/^https?:\/\//i.test(w) ? w : "https://" + w).slice(0, 300) : null;
  }
  if (body.tagline !== undefined) patch.tagline = body.tagline ? String(body.tagline).slice(0, 120) : null;
  if (body.address_line !== undefined) patch.address_line = body.address_line ? String(body.address_line).slice(0, 200) : null;
  if (body.currency !== undefined) {
    const cur = String(body.currency || "").toUpperCase().trim();
    if (!/^[A-Z]{3}$/.test(cur)) {
      return res.status(400).json({ ok: false, code: "CURRENCY", message: "Currency must be a three-letter code, e.g. AED." });
    }
    patch.currency = cur;
  }
  /* Publishing is a gate, not a toggle: the licence and the logo are the
     restaurant's proof and identity, the map link is where guests go, and a
     menu with nothing on it helps nobody. Enforced here so no client can skip
     it, and so the dashboard can show the same list before the button works. */
  if (body.status !== undefined && ["trial", "published", "suspended"].includes(body.status)) {
    if (body.status === "published") {
      const finalLogo = patch.logo_url !== undefined ? patch.logo_url : (existing && existing.logo_url);
      const finalLicence = patch.licence_url !== undefined ? patch.licence_url : (existing && existing.licence_url);
      const finalMaps = patch.maps_url !== undefined ? patch.maps_url : (existing && existing.maps_url);
      const finalWhatsapp = patch.whatsapp_e164 || (existing && existing.whatsapp_e164);

      const missing = [];
      if (!finalLogo) missing.push("logo");
      if (!finalLicence) missing.push("licence");
      if (!finalMaps) missing.push("Google Maps link");

      let itemCount = 0;
      if (existing) {
        const items = await rest("menu_items?restaurant_id=eq." + existing.id + "&select=id");
        itemCount = items.ok ? (items.data || []).length : 0;
      }
      if (!itemCount) missing.push("at least one dish");

      if (missing.length) {
        return res.status(409).json({
          ok: false,
          code: "NOT_READY",
          message: "Not ready to publish yet: " + missing.join(", ") + ".",
          missing
        });
      }

      /* The paywall. A menu can be built in full for nothing, and a new
         restaurant gets seven free days with everything on. After that it does
         not stay public until a paid period exists. Checked here rather than in
         the dashboard, so no client can publish around it.
         Until migration 0007/0011 run the columns are absent — then behave as
         before. */
      const hasPlanColumns = Boolean(existing && Object.prototype.hasOwnProperty.call(existing, "paid_through"));
      const paidThrough = existing && existing.paid_through;
      const trialEnds = existing && existing.trial_ends;
      const today = new Date().toISOString().slice(0, 10);
      const paidNow = Boolean(paidThrough && paidThrough >= today);
      const onTrial = Boolean(trialEnds && trialEnds >= today);

      if (hasPlanColumns && !paidNow && !onTrial) {
        const plan = (existing && existing.plan) || "qr";
        return res.status(402).json({
          ok: false,
          code: "PAYMENT_REQUIRED",
          message: "Your free week is over. Everything you built stays saved. " + upgradeLine(plan) +
            " Pay by transfer or on WhatsApp — connect@indubaicity.com — and it goes live the same day.",
          plan,
          planLabel: PLAN_TABLE[plan] ? PLAN_TABLE[plan].label : PLAN_TABLE.qr.label,
          prices: billable(plan),
          trialEnded: Boolean(trialEnds)
        });
      }
    }
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
    : await rest("restaurants", {
        method: "POST",
        prefer: "return=representation",
        /* seven free days, everything on, from the moment the row exists.
           trial_granted_at makes it a one-time gift: no re-signup for another
           week. A deployment can land before 0011 runs, so the columns are
           optional — the retry below drops them. */
        body: {
          ...patch,
          owner_id: user.id,
          trial_ends: (function () {
            const d = new Date();
            d.setUTCDate(d.getUTCDate() + 7);
            return d.toISOString().slice(0, 10);
          })(),
          trial_granted_at: new Date().toISOString()
        }
      });

  if (!saved.ok && !existing && /trial_ends|trial_granted_at/.test(JSON.stringify(saved.data || ""))) {
    const retry = await rest("restaurants", {
      method: "POST",
      prefer: "return=representation",
      body: { ...patch, owner_id: user.id }
    });
    if (retry.ok || retry.status < 500) saved = retry;
  }

  /* PostgREST fails the whole write on one unknown column, so a deployment that
     lands before db/0021_theme.sql runs would lose the address, the number and
     everything else in the same request. Drop the theme and keep the rest. */
  if (!saved.ok && patch.theme !== undefined && /theme/.test(JSON.stringify(saved.data || "") + (saved.message || ""))) {
    const withoutTheme = { ...patch };
    delete withoutTheme.theme;
    saved = existing
      ? await rest("restaurants?id=eq." + existing.id, { method: "PATCH", body: withoutTheme, prefer: "return=representation" })
      : await rest("restaurants", { method: "POST", prefer: "return=representation", body: { ...withoutTheme, owner_id: user.id } });
  }

  if (!saved.ok) {
    const detail = typeof saved.data === "object" && saved.data ? JSON.stringify(saved.data).slice(0, 200) : String(saved.data).slice(0, 200);
    return res.status(400).json({ ok: false, code: "SAVE_FAILED", message: "The restaurant could not be saved.", detail });
  }

  return res.status(200).json({ ok: true, restaurant: (saved.data || [])[0] || null });
};

/* The row, the handle check, and this restaurant's own files. */
module.exports = async function route(req, res) {
  const q = (req.query || {});
  if (String(q.upload || "") === "1" || String(q.upload || "") === "true") return uploadMedia(req, res);
  return restaurantHandler(req, res);
};

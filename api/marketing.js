/**
 * /api/marketing — asking past customers how it went.
 *
 *   GET  ?customers=1&from=YYYY-MM-DD&to=YYYY-MM-DD   (owner)
 *   GET  ?settings=1                                  (owner)  how messages leave
 *   POST ?settings=1  { mode, template, lang, google, phoneNumberId, token }
 *   POST ?queue=1     { orderIds: [...] }             (owner)  build the worklist
 *   POST ?sent=1      { id }                          (owner)  one free send, done
 *   POST ?cloud=1     { limit }                       (owner)  send a paced batch
 *   GET  ?reviews=1                                   (owner)  what came back
 *   GET  ?feedback=1&token=…                          (public) the guest's page
 *   POST ?feedback=1  { token, rating, comment }      (public) record it
 *
 * Two senders, one queue. 'free' means the owner's own WhatsApp: the panel
 * builds a wa.me link and a human presses send, which is why it needs no
 * account, costs nothing and cannot get the restaurant's number banned.
 * 'cloud' means WhatsApp Cloud API: the server sends, paced, unattended, and
 * the restaurant pays Meta per message. Only the sending differs — the rows,
 * the tokens, the ratings and the Google gate are identical.
 *
 * The Google link is never in the first message. It is released by OUR feedback
 * page, and only when the guest scored 4 or 5. That is the whole reason the
 * link we send is ours: we never see a WhatsApp reply, so a gate that lived in
 * the chat could not exist.
 */

const crypto = require("crypto");
const { rest, userFromToken, actorRestaurant, bearer, cors, configured } = require("./_lib/db");

const GRAPH = (process.env.WHATSAPP_API_VERSION || "v21.0");
const SETTINGS_COLS =
  "sender_mode,wa_phone_number_id,wa_access_token,wa_template,wa_template_lang,google_review_url";

/* asking the same person twice on the same order is prevented by the index;
   asking twice in a month is prevented here */
const ASK_AGAIN_AFTER_DAYS = 30;

const hits = new Map();
function throttled(key, max, windowMs) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < windowMs);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 800) hits.clear();
  return seen.length > max;
}

function mask(s) {
  const v = String(s || "");
  if (!v) return "";
  return v.length <= 8 ? "••••" : "••••" + v.slice(-6);
}

/** Digits only, with the restaurant's country code. The guest typed whatever
 *  they typed; wa.me needs E.164 without the plus, or it says "invalid". */
function normalisePhone(raw, dial) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  const cc = String(dial || "").replace(/[^\d]/g, "");
  if (d.startsWith("0")) d = cc + d.replace(/^0+/, "");
  else if (cc && d.length === 9 && !d.startsWith(cc)) d = cc + d;
  if (d.length < 8 || d.length > 15) return "";
  return d;
}

function ymd(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

function dayStart(d) { return d + "T00:00:00.000Z"; }
function dayEnd(d) { return d + "T23:59:59.999Z"; }

async function settingsFor(rid) {
  const r = await rest("restaurants?id=eq." + rid + "&select=" + SETTINGS_COLS);
  return { ok: r.ok, row: (r.ok && Array.isArray(r.data) && r.data[0]) || null };
}

/* ------------------------------------------------------------------ public */

async function feedback(req, res) {
  const q = req.query || {};

  if (req.method === "GET") {
    const token = String(q.token || "").trim();
    if (!token) return res.status(400).json({ ok: false, code: "NO_TOKEN" });

    const r = await rest("review_requests?token=eq." + encodeURIComponent(token) +
      "&select=id,restaurant_id,guest_name,rating,comment,opened_at");
    if (!r.ok) return res.status(503).json({ ok: false, code: "NOT_READY" });
    const row = (r.data || [])[0];
    if (!row) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That link is not valid." });

    const rest1 = await rest("restaurants?id=eq." + row.restaurant_id + "&select=name,handle,logo_url,google_review_url");
    const rinfo = (rest1.ok && (rest1.data || [])[0]) || {};

    /* first open is worth knowing: it is the only signal that the message landed */
    if (!row.opened_at) {
      await rest("review_requests?id=eq." + row.id, {
        method: "PATCH", prefer: "return=minimal",
        body: { opened_at: new Date().toISOString() }
      });
    }

    return res.status(200).json({
      ok: true,
      restaurant: { name: rinfo.name || "", handle: rinfo.handle || "", logo: rinfo.logo_url || null },
      name: row.guest_name || "",
      rated: row.rating != null,
      rating: row.rating || null,
      /* the Google link is only ever returned with a rating that earned it */
      google: row.rating >= 4 ? (rinfo.google_review_url || null) : null
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false, code: "BAD_BODY" });

  const token = String(body.token || "").trim();
  const rating = Number(body.rating);
  const comment = String(body.comment || "").slice(0, 1200);
  if (!token) return res.status(400).json({ ok: false, code: "NO_TOKEN" });
  if (!(rating >= 1 && rating <= 5)) {
    return res.status(400).json({ ok: false, code: "BAD_RATING", message: "Pick a score from 1 to 5." });
  }

  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "local");
  if (throttled("fb:" + ip, 20, 60 * 60 * 1000)) {
    return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "Too many tries. Wait a little." });
  }

  const found = await rest("review_requests?token=eq." + encodeURIComponent(token) + "&select=id,restaurant_id,rating");
  if (!found.ok) return res.status(503).json({ ok: false, code: "NOT_READY" });
  const row = (found.data || [])[0];
  if (!row) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

  /* a second answer replaces the first: people fix a fat-fingered score */
  const upd = await rest("review_requests?id=eq." + row.id, {
    method: "PATCH", prefer: "return=minimal",
    body: { rating, comment, opened_at: new Date().toISOString() }
  });
  if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED" });

  const rest1 = await rest("restaurants?id=eq." + row.restaurant_id + "&select=google_review_url,name");
  const rinfo = (rest1.ok && (rest1.data || [])[0]) || {};

  return res.status(200).json({
    ok: true,
    rating,
    /* 4 and 5 only. Anything lower gets our attention instead of Google's. */
    google: rating >= 4 ? (rinfo.google_review_url || null) : null,
    thanks: rating >= 4
      ? "That means a lot. If you have a minute, a Google review helps other people find us."
      : "Thank you for telling us — the owner will see this."
  });
}

/* ----------------------------------------------------------------- private */

async function owner(req, res) {
  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  const actor = await actorRestaurant(user, "id,handle,name,whatsapp_e164");
  if (!actor) return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Set up your restaurant first." });
  if (actor.role !== "owner") {
    return res.status(403).json({ ok: false, code: "NOT_OWNER", message: "Only the owner can run marketing." });
  }

  const rid = actor.restaurant.id;
  const dial = actor.restaurant.whatsapp_e164 || "";
  const q = req.query || {};

  const st = await settingsFor(rid);
  if (!st.ok) {
    return res.status(503).json({
      ok: false, code: "NO_MARKETING",
      message: "Marketing is not switched on yet — run db/0009_marketing.sql in Supabase."
    });
  }
  const s = st.row || { sender_mode: "free" };

  /* ------------------------------------------------------------ settings */
  if (q.settings !== undefined) {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        sender: s.sender_mode === "cloud" ? "cloud" : "free",
        template: s.wa_template || "",
        lang: s.wa_template_lang || "en",
        google: s.google_review_url || "",
        phoneNumberId: s.wa_phone_number_id || "",
        tokenHint: mask(s.wa_access_token),
        cloudReady: Boolean(s.wa_phone_number_id && s.wa_access_token && s.wa_template),
        dial: String(dial).replace(/[^\d]/g, "")
      });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== "object") return res.status(400).json({ ok: false, code: "BAD_BODY" });

    const patch = {};
    if (body.mode !== undefined) {
      if (!["free", "cloud"].includes(body.mode)) {
        return res.status(400).json({ ok: false, code: "BAD_MODE", message: "Choose free or Cloud API." });
      }
      patch.sender_mode = body.mode;
    }
    if (body.template !== undefined) patch.wa_template = String(body.template).trim().slice(0, 120) || null;
    if (body.lang !== undefined) patch.wa_template_lang = String(body.lang).trim().slice(0, 10) || "en";
    if (body.google !== undefined) {
      const g = String(body.google).trim();
      if (g && !/^https?:\/\//i.test(g)) {
        return res.status(400).json({ ok: false, code: "BAD_URL", message: "The Google link must start with https://" });
      }
      patch.google_review_url = g.slice(0, 400) || null;
    }
    if (body.phoneNumberId !== undefined) {
      patch.wa_phone_number_id = String(body.phoneNumberId).replace(/[^\d]/g, "").slice(0, 40) || null;
    }
    /* the token is write-only: an empty field keeps the one already stored */
    if (body.token !== undefined) {
      const t = String(body.token).trim();
      patch.wa_access_token = t ? t.slice(0, 500) : null;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, code: "NOTHING" });

    const upd = await rest("restaurants?id=eq." + rid, { method: "PATCH", body: patch, prefer: "return=minimal" });
    if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "Those settings were not saved." });

    const fresh = await settingsFor(rid);
    const f = fresh.row || {};
    return res.status(200).json({
      ok: true,
      sender: f.sender_mode === "cloud" ? "cloud" : "free",
      template: f.wa_template || "",
      lang: f.wa_template_lang || "en",
      google: f.google_review_url || "",
      phoneNumberId: f.wa_phone_number_id || "",
      tokenHint: mask(f.wa_access_token),
      cloudReady: Boolean(f.wa_phone_number_id && f.wa_access_token && f.wa_template)
    });
  }

  /* ----------------------------------------------------------- customers */
  if (q.customers !== undefined) {
    const from = ymd(q.from), to = ymd(q.to);
    if (!from || !to) return res.status(400).json({ ok: false, code: "BAD_RANGE", message: "Pick a start and an end date." });
    if (from > to) return res.status(400).json({ ok: false, code: "BAD_RANGE", message: "The start date is after the end date." });

    const ords = await rest(
      "orders?restaurant_id=eq." + rid +
      "&created_at=gte." + dayStart(from) + "&created_at=lte." + dayEnd(to) +
      "&select=id,guest_name,guest_phone,total,created_at&order=created_at.desc&limit=1000"
    );
    if (!ords.ok) return res.status(502).json({ ok: false, code: "DB_ERROR", message: "Orders could not be read." });

    const asked = await rest(
      "review_requests?restaurant_id=eq." + rid +
      "&select=phone,status,rating,sent_at,created_at&order=created_at.desc&limit=1000"
    );
    const askedBy = new Map();
    for (const a of (asked.ok && asked.data) || []) {
      if (!askedBy.has(a.phone)) askedBy.set(a.phone, a);
    }

    const people = new Map();
    for (const o of ords.data || []) {
      const phone = normalisePhone(o.guest_phone, dial);
      const key = phone || "raw:" + String(o.guest_phone || "");
      const prev = people.get(key);
      if (prev) { prev.orders++; continue; }
      people.set(key, {
        phone, raw: o.guest_phone || "", orderId: o.id,
        name: o.guest_name || "", orders: 1,
        lastOrder: o.created_at, total: Number(o.total) || 0,
        usable: Boolean(phone),
        asked: askedBy.get(phone) || null
      });
    }

    const list = Array.from(people.values()).map((p) => {
      const last = p.asked ? new Date(p.asked.created_at).getTime() : 0;
      const fresh = last && (Date.now() - last) / 86400000 < ASK_AGAIN_AFTER_DAYS;
      return { ...p, skip: Boolean(p.asked && fresh) };
    });

    return res.status(200).json({
      ok: true, from, to, sender: s.sender_mode === "cloud" ? "cloud" : "free",
      customers: list, usable: list.filter((p) => p.usable).length,
      skipped: list.filter((p) => p.skip).length
    });
  }

  /* --------------------------------------------------------------- queue */
  if (q.queue !== undefined && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "GET") {
      /* what is waiting, so the tab can be closed and reopened mid-worklist */
      const r = await rest(
        "review_requests?restaurant_id=eq." + rid + "&status=in.(queued,failed,opened)" +
        "&select=id,phone,phone_raw,guest_name,token,status,error,created_at&order=created_at.asc&limit=300"
      );
      if (!r.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
      return res.status(200).json({ ok: true, sender: s.sender_mode === "cloud" ? "cloud" : "free", rows: r.data || [] });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const ids = body && Array.isArray(body.orderIds) ? body.orderIds.slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ ok: false, code: "NOBODY", message: "Select at least one customer." });

    const ords = await rest("orders?restaurant_id=eq." + rid + "&id=in.(" + ids.join(",") + ")&select=id,guest_name,guest_phone");
    if (!ords.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

    const made = [];
    let skipped = 0;
    for (const o of ords.data || []) {
      const phone = normalisePhone(o.guest_phone, dial);
      if (!phone) { skipped++; continue; }
      const row = await rest("review_requests", {
        method: "POST", prefer: "return=representation",
        body: {
          restaurant_id: rid, order_id: o.id, phone, phone_raw: o.guest_phone || "",
          guest_name: o.guest_name || "", token: crypto.randomBytes(9).toString("base64url"),
          status: "queued"
        }
      });
      if (row.ok && row.data && row.data[0]) made.push(row.data[0]);
      else skipped++;                       /* already asked for that order */
    }

    return res.status(200).json({ ok: true, queued: made.length, skipped, rows: made });
  }

  /* ------------------------------------------------- free: mark one as sent */
  if (q.sent !== undefined) {
    if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const id = body && body.id;
    if (!id) return res.status(400).json({ ok: false, code: "NO_ID" });

    const upd = await rest("review_requests?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + rid, {
      method: "PATCH", prefer: "return=minimal",
      body: { status: "sent", sent_at: new Date().toISOString() }
    });
    if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED" });
    return res.status(200).json({ ok: true });
  }

  /* --------------------------------------------- cloud: send a paced batch */
  if (q.cloud !== undefined) {
    if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
    if (!s.wa_phone_number_id || !s.wa_access_token || !s.wa_template) {
      return res.status(400).json({
        ok: false, code: "NOT_CONNECTED",
        message: "Connect the Cloud API first: phone number id, access token and an approved template name."
      });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const limit = Math.min(Math.max(Number(body && body.limit) || 5, 1), 10);

    const batch = await rest(
      "review_requests?restaurant_id=eq." + rid + "&status=eq.queued&select=id,phone,guest_name,token&order=created_at.asc&limit=" + limit
    );
    if (!batch.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

    const results = [];
    for (const row of batch.data || []) {
      const link = "https://digimenu.indubaicity.com/f/" + row.token;
      const payload = {
        messaging_product: "whatsapp",
        to: row.phone,
        type: "template",
        template: {
          name: s.wa_template,
          language: { code: s.wa_template_lang || "en" },
          /* the approved template must carry {{1}} name, {{2}} restaurant,
             {{3}} the feedback link, in that order */
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: String(row.guest_name || "there").split(" ")[0].slice(0, 40) },
              { type: "text", text: String(actor.restaurant.name || "").slice(0, 60) },
              { type: "text", text: link }
            ]
          }]
        }
      };

      let ok = false, err = "", via = "";
      /* Two doors to the same API. A number registered straight with Meta
         answers on graph.facebook.com; one connected through Kapso answers on
         Kapso's Meta-compatible proxy, which takes the project API key as the
         bearer. The token is not something we can inspect to tell them apart,
         so an auth refusal on one door is retried on the other — and a bad
         template (the other common failure) is not retried, because it is bad
         on both. */
      const routes = [
        { name: "meta", base: "https://graph.facebook.com/" + GRAPH },
        { name: "kapso", base: (process.env.WA_API_BASE || "https://api.kapso.ai/meta/whatsapp/v24.0") }
      ];
      for (const route of routes) {
        try {
          const r = await fetch(route.base + "/" + s.wa_phone_number_id + "/messages", {
            method: "POST",
            headers: { Authorization: "Bearer " + s.wa_access_token, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
          });
          const text = await r.text();
          let d = null; try { d = text ? JSON.parse(text) : null; } catch (e) { d = null; }
          ok = r.ok;
          if (ok) { via = route.name; err = ""; break; }
          err = String((d && d.error && (d.error.message || d.error.code)) || text).slice(0, 200);
          /* only a refused credential is worth asking the other door */
          if (r.status !== 401 && r.status !== 403) break;
        } catch (e) {
          err = String(e && e.message || "network").slice(0, 120);
        }
      }

      await rest("review_requests?id=eq." + row.id, {
        method: "PATCH", prefer: "return=minimal",
        body: ok
          ? { status: "sent", sent_at: new Date().toISOString(), error: null }
          : { status: "failed", error: err }
      });

      results.push({ id: row.id, phone: row.phone, ok, error: ok ? null : err, via: via || null });
      /* slow on purpose: pacing is what keeps a number healthy */
      await new Promise((r) => setTimeout(r, 700));
    }

    const left = await rest("review_requests?restaurant_id=eq." + rid + "&status=eq.queued&select=id&limit=1000");
    return res.status(200).json({
      ok: true,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
      remaining: (left.ok && left.data ? left.data.length : 0)
    });
  }

  /* -------------------------------------------------------------- reviews */
  if (q.reviews !== undefined) {
    /* the service history needs to tie a review back to the order it came
       from, so order_id travels with it */
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    const from = day(q.from), to = day(q.to);
    let filters = "";
    if (from) filters += "&created_at=gte." + from + "T00:00:00";
    if (to) filters += "&created_at=lte." + to + "T23:59:59";

    const r = await rest(
      "review_requests?restaurant_id=eq." + rid + "&rating=not.is.null" + filters +
      "&select=id,order_id,guest_name,phone,rating,comment,sent_at,created_at&order=created_at.desc&limit=500"
    );
    if (!r.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const rows = r.data || [];
    const avg = rows.length ? rows.reduce((n, x) => n + x.rating, 0) / rows.length : 0;
    const spread = [5, 4, 3, 2, 1].map((n) => rows.filter((x) => x.rating === n).length);
    return res.status(200).json({
      ok: true,
      average: Math.round(avg * 10) / 10,
      count: rows.length,
      happy: rows.filter((x) => x.rating >= 4).length,
      spread,
      reviews: rows.map((x) => ({
        id: x.id, orderId: x.order_id || null, name: x.guest_name || "", phone: x.phone,
        rating: x.rating, comment: x.comment || "", at: x.created_at
      }))
    });
  }

  return res.status(400).json({ ok: false, code: "BAD_ACTION", message: "Unknown action." });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  const q = req.query || {};
  if (q.feedback !== undefined) return feedback(req, res);
  return owner(req, res);
};

/**
 * The WhatsApp inbox.
 *
 * Kapso (or Meta directly) posts every inbound message here. The job is small
 * on purpose, because the contract is brutal: answer 200 within 10 seconds,
 * three delivery attempts, then the webhook is paused. So this module verifies,
 * stores and answers. It sends exactly one thing — the thank-you — and nothing
 * else, because it runs inside the request.
 *
 * The stored inbound row is the only honest evidence that the 24-hour window
 * is open, and its timestamp is when the clock started. Everything the panel
 * enables later is derived from it.
 */

const crypto = require("crypto");
const { rest } = require("./db");

const GRAPH = process.env.WHATSAPP_API_VERSION || "v21.0";
const KAPSO_BASE = process.env.WA_API_BASE || "https://api.kapso.ai/meta/whatsapp/v24.0";

function digits(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function rawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  /* already parsed by the platform: re-serialise. Compact JSON survives this
     round trip byte for byte in practice, which is what the HMAC needs. */
  return JSON.stringify(req.body || {});
}

function signatureOk(req, raw) {
  const secret = process.env.WA_WEBHOOK_SECRET || "";
  if (!secret) return false;
  const header =
    req.headers["x-webhook-signature"] ||
    req.headers["x-hub-signature-256"] ||
    req.headers["x-kapso-signature"] || "";
  const sig = String(header).replace(/^sha256=/i, "").trim();
  if (!sig) return false;
  const mine = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return sig.length === mine.length && crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

/* One event in, zero or more messages out. Handles the Kapso envelope, Kapso's
   batched envelope, and Meta's entry/changes/value shape, because we do not
   know which door the restaurant's number hangs off. */
function normalise(ev) {
  if (!ev || typeof ev !== "object") return [];

  if (Array.isArray(ev.entry)) {
    const out = [];
    for (const e of ev.entry) {
      for (const c of e.changes || []) {
        const v = c.value || {};
        for (const m of v.messages || []) {
          out.push({
            wamid: m.id,
            from: digits(m.from),
            type: m.type || "text",
            body: textOf(m),
            dir: "in",
            pnid: (v.metadata && v.metadata.phone_number_id) || "",
            bsuid: m.from ? "" : String((m.from_user_id) || "")
          });
        }
      }
    }
    return out;
  }

  const m = ev.message || (ev.data && ev.data.message);
  if (!m) return [];
  const k = m.kapso || {};
  return [{
    wamid: m.id || m.message_id || "",
    from: digits(k.phone_number || m.from || ""),
    type: m.type || "text",
    body: textOf(m),
    dir: String(k.direction || "").toLowerCase() === "outbound" ? "out" : "in",
    pnid: k.phone_number_id || ev.phone_number_id || (ev.data && ev.data.phone_number_id) || "",
    bsuid: k.business_scoped_user_id || ""
  }];
}

function textOf(m) {
  if (m.text && m.text.body) return String(m.text.body).slice(0, 4000);
  if (m.button && m.button.text) return String(m.button.text).slice(0, 400);
  if (m.interactive && m.interactive.button_reply) {
    return String(m.interactive.button_reply.title || m.interactive.button_reply.id || "").slice(0, 400);
  }
  return "";
}

async function restaurantFor(pnid) {
  if (!pnid) return null;
  const r = await rest(
    "restaurants?wa_phone_number_id=eq." + encodeURIComponent(pnid) +
    "&select=id,name,wa_access_token,wa_phone_number_id,wa_template,wa_template_lang,sender_mode&limit=1"
  );
  return r.ok && r.data && r.data.length ? r.data[0] : null;
}

/* Two doors again: Meta answers graph.facebook.com, Kapso answers its proxy and
   wants the project key in X-API-Key, not the bearer. */
/* every outbound message goes through here: two doors, one payload */
async function post(s, payload) {
  const doors = [
    { name: "meta", base: "https://graph.facebook.com/" + GRAPH, headers: { Authorization: "Bearer " + s.wa_access_token } },
    { name: "kapso", base: KAPSO_BASE, headers: { "X-API-Key": s.wa_access_token } }
  ];

  let err = "";
  for (const d of doors) {
    try {
      const r = await fetch(d.base + "/" + s.wa_phone_number_id + "/messages", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, d.headers),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(9000)
      });
      const t = await r.text();
      if (r.ok) return { ok: true, via: d.name, id: safeId(t) };
      let msg = t.slice(0, 200);
      try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) { /* raw */ }
      err = String(msg);
      if (r.status === 401 || r.status === 403) continue;
      return { ok: false, via: d.name, error: err };
    } catch (e) {
      err = String((e && e.message) || "network").slice(0, 120);
    }
  }
  return { ok: false, error: err };
}

async function sendText(s, to, body) {
  return post(s, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "text",
    text: { preview_url: false, body: body }
  });
}

/* A template with a quick-reply button. The tap comes back as an inbound
   message, which is the only way we can open a window from our side — a URL
   button sends us nothing, so it buys no free hours. */
async function sendTemplate(s, to, name, params, buttonPayload) {
  const components = [{
    type: "body",
    parameters: (params || []).map((t) => ({ type: "text", text: String(t == null ? "" : t).slice(0, 900) }))
  }];
  if (buttonPayload) {
    components.push({
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [{ type: "payload", payload: String(buttonPayload).slice(0, 100) }]
    });
  }
  return post(s, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "template",
    template: { name: name, language: { code: s.wa_template_lang || "en" }, components: components }
  });
}

function safeId(t) {
  try { const j = JSON.parse(t); return j.messages && j.messages[0] && j.messages[0].id; } catch (e) { return null; }
}

/* The one automatic message. Sends at most once per guest per day, because a
   guest who replies three times in a row must not collect three thank-yous. */
async function thankYou(s, row) {
  if (!s || !s.wa_phone_number_id || !s.wa_access_token || !row.from) return null;

  const recent = await rest(
    "wa_messages?restaurant_id=eq." + s.id + "&direction=eq.out&type=eq.thankyou" +
    "&customer_number=eq." + encodeURIComponent(row.from) +
    "&created_at=gte." + new Date(Date.now() - 20 * 3600e3).toISOString() +
    "&select=id&limit=1"
  );
  if (recent.ok && recent.data && recent.data.length) return null;

  /* the newest order from this number gives the greeting its name */
  let name = "";
  let orderId = null;
  /* The order stores the number the guest typed — "+971 56 891 1233" — while the
     message carries digits only. Comparing them as strings found nothing, so the
     thank-you went out without an order attached and the panel had to fall back
     to guessing by number. Compare digits instead. */
  const ord = await rest(
    "orders?restaurant_id=eq." + s.id +
    "&select=id,guest_name,guest_phone&order=created_at.desc&limit=20"
  );
  if (ord.ok && ord.data) {
    const hit = ord.data.find((o) => digits(o.guest_phone) === row.from);
    if (hit) {
      name = String(hit.guest_name || "").split(" ")[0].slice(0, 40);
      orderId = hit.id;
    }
  }

  const text = name
    ? "Thanks " + name + " — your order is in. We'll confirm it here in a moment."
    : "Thanks — your order is in. We'll confirm it here in a moment.";

  const sent = await sendText(s, row.from, text);
  if (!sent.ok) return { ok: false, error: sent.error };

  await rest("wa_messages", {
    method: "POST",
    prefer: "return=minimal",
    body: [{
      restaurant_id: s.id,
      order_id: orderId,
      wamid: sent.id || null,
      direction: "out",
      phone_number_id: s.wa_phone_number_id,
      customer_number: row.from,
      type: "thankyou",
      body: text
    }]
  });
  return { ok: true, via: sent.via };
}

async function receive(req, res) {
  if (req.method === "GET") return res.status(200).send("digimenu wa inbox");
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!process.env.WA_WEBHOOK_SECRET) {
    return res.status(503).json({ ok: false, code: "NO_SECRET", message: "WA_WEBHOOK_SECRET is not set." });
  }

  const raw = rawBody(req);
  const good = signatureOk(req, raw);
  if (!good) return res.status(401).json({ ok: false, code: "BAD_SIGNATURE" });

  let payload = null;
  try { payload = typeof req.body === "string" ? JSON.parse(raw) : req.body; } catch (e) { payload = null; }
  if (!payload) return res.status(400).json({ ok: false, code: "BAD_JSON" });

  const events = Array.isArray(payload.data) && payload.data.length ? payload.data : [payload];
  const stored = [];
  for (const ev of events) {
    for (const m of normalise(ev)) {
      if (!m.wamid) continue;
      const s = await restaurantFor(m.pnid);
      stored.push(Object.assign({}, m, { restaurant: s }));
    }
  }

  if (!stored.length) return res.status(200).json({ ok: true, stored: 0 });

  const rows = stored.map((m) => ({
    restaurant_id: m.restaurant ? m.restaurant.id : null,
    wamid: m.wamid,
    direction: m.dir,
    phone_number_id: m.pnid || null,
    customer_number: m.from || null,
    bsuid: m.bsuid || null,
    type: m.type,
    body: m.body,
    verified: true
  }));

  const ins = await rest("wa_messages?on_conflict=wamid", {
    method: "POST",
    prefer: "return=minimal,resolution=ignore-duplicates",
    body: rows
  });

  /* one automatic message only, and only for a guest's inbound */
  let thanks = 0;
  for (const m of stored) {
    if (m.dir !== "in" || !m.restaurant) continue;
    const t = await thankYou(m.restaurant, m);
    if (t && t.ok) thanks++;
  }

  return res.status(200).json({
    ok: true,
    stored: rows.length,
    insert: ins.ok ? "ok" : (ins.error || "failed").slice(0, 120),
    thankYou: thanks
  });
}

module.exports = { receive, post, sendText, sendTemplate, thankYou, normalise, digits };

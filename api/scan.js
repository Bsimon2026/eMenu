/**
 * POST /api/scan — read a menu photo into categories and dishes.
 *
 * Owner-only: the caller's access token decides who they are, so an anonymous
 * visitor cannot spend our model budget. The model never touches the database —
 * it returns JSON, this function validates it, and the dashboard shows the result
 * for the owner to check before anything is written.
 *
 * Provider is DeepSeek's multimodal flash model. Pricing and accuracy fit a menu
 * page better than a frontier model does; if accuracy disappoints, only the call
 * at the bottom of this file changes.
 */

const { userFromToken, bearer, cors, configured } = require("./_lib/db");

const DS_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.SCAN_MODEL || "deepseek-flash";
const MAX_BASE64 = 3_400_000;          /* Vercel caps the request body at ~4.5 MB */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 12;

const hits = new Map();
function overBudget(id) {
  const now = Date.now();
  const seen = (hits.get(id) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(id, seen);
  if (hits.size > 800) hits.clear();
  return seen.length > MAX_PER_HOUR;
}

const PROMPT = [
  "Read this restaurant menu image and return the dishes as JSON.",
  "",
  "Return ONLY minified JSON, no prose and no code fences, shaped exactly:",
  '{"currency":"AED","categories":[{"name":"string","items":[{"name":"string","description":"string","price":12.5}]}]}',
  "",
  "Rules:",
  "- Use the menu's own section headings as categories, in the order they appear.",
  "- price must be a number only: 27.00 not \"AED 27\" and not a string.",
  "- Keep dish names exactly as printed, including any English/Arabic mix.",
  "- description: the printed description, or an empty string when there is none.",
  "- Skip anything that is not a purchasable dish: phone numbers, addresses, timings, offers on other pages.",
  "- Never invent a dish, a price or a description. If a price is illegible, use 0.",
  "- If the image is not a menu, return {\"currency\":\"\",\"categories\":[]}."
].join("\n");

function parseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/** Keep only things that look like dishes, and cap the total. */
function tidy(raw) {
  const out = [];
  let items = 0;
  const cats = Array.isArray(raw && raw.categories) ? raw.categories : [];
  for (const c of cats) {
    const name = String((c && c.name) || "").trim().slice(0, 60);
    const list = Array.isArray(c && c.items) ? c.items : [];
    const kept = [];
    for (const it of list) {
      const n = String((it && it.name) || "").trim().slice(0, 120);
      if (!n) continue;
      const p = Number(it.price);
      kept.push({
        name: n,
        description: String((it && it.description) || "").trim().slice(0, 300),
        price: Number.isFinite(p) && p >= 0 ? Math.round(p * 100) / 100 : 0
      });
      items += 1;
      if (items >= 400) break;
    }
    if (kept.length) out.push({ name: name || "Menu", items: kept });
    if (items >= 400) break;
  }
  return out;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(503).json({ ok: false, code: "NO_MODEL_KEY", message: "Photo reading is not switched on for this server yet." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
  }
  if (overBudget(user.id)) {
    return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "That is a lot of pages in one hour. Try again a little later." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const image = body && typeof body.image === "string" ? body.image : "";
  if (!image) {
    return res.status(400).json({ ok: false, code: "NO_IMAGE", message: "Send the photo as a data URL in image." });
  }
  if (image.length > MAX_BASE64) {
    return res.status(413).json({ ok: false, code: "TOO_LARGE", message: "That photo is too large. Try a smaller one, or a tighter crop of one page." });
  }

  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(image);
  if (!m) {
    return res.status(415).json({
      ok: false,
      code: "BAD_TYPE",
      message: /^data:application\/pdf/i.test(image)
        ? "PDF reading is not built yet — photograph the page and upload that."
        : "That file is not an image we can read. Use a JPG, PNG or WebP photo."
    });
  }

  const started = Date.now();
  let data;
  try {
    const r = await fetch(DS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: image } }
        ] }]
      }),
      signal: AbortSignal.timeout(120000)
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("[scan] model", r.status, text.slice(0, 300));
      return res.status(502).json({ ok: false, code: "MODEL_ERROR", message: "The reader could not be reached. Try again in a moment." });
    }
    data = JSON.parse(text);
  } catch (e) {
    console.error("[scan] fetch", e && e.message);
    return res.status(504).json({ ok: false, code: "MODEL_TIMEOUT", message: "The photo took too long to read. Try a tighter crop of one page." });
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
  const parsed = parseJson(content);
  const categories = tidy(parsed);

  if (!categories.length) {
    return res.status(422).json({
      ok: false,
      code: "NOT_READABLE",
      message: "No dishes could be read from that photo. Shoot the page straight on, in good light, and try again."
    });
  }

  const itemCount = categories.reduce((n, c) => n + c.items.length, 0);
  return res.status(200).json({
    ok: true,
    source: "your menu photo",
    currency: (parsed && String(parsed.currency || "").toUpperCase().slice(0, 3)) || "",
    categories,
    itemCount,
    withImages: 0,
    imagesNotice: "Prices were read from a photo — check them against the printed menu.",
    model: MODEL,
    ms: Date.now() - started,
    usage: (data && data.usage) || null
  });
};

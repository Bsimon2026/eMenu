/**
 * POST /api/upload
 *
 * Accepts { kind: "logo" | "cover" | "licence", dataUrl } and puts the file in
 * the public `menu-media` bucket, under a prefix named after the restaurant's
 * handle. Returns the public URL; the caller decides which column it lands in.
 *
 * The service key never leaves the server, so no storage RLS policy is involved
 * and the design cannot be defeated by a client writing outside its own prefix:
 * the path is built here from the authenticated user's restaurant.
 */

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

const MAX_BYTES = 2_500_000;            /* base64 inflates ~33%, Vercel caps the body */
const KINDS = { logo: "logo", cover: "cover", licence: "licence" };
const TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf"
};

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Storage credentials missing on the server." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !body.dataUrl) {
    return res.status(400).json({ ok: false, code: "NO_FILE", message: "No file was sent." });
  }

  const kind = KINDS[body.kind] || "logo";

  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String(body.dataUrl));
  if (!m) {
    return res.status(400).json({ ok: false, code: "BAD_DATA", message: "That file could not be read." });
  }
  const mime = m[1].toLowerCase();
  const ext = TYPES[mime];
  if (!ext) {
    return res.status(400).json({ ok: false, code: "BAD_TYPE", message: "Use a PNG, JPG or WEBP image." });
  }
  if (kind === "licence" && ext !== "pdf" && !/^image\//.test(mime)) {
    return res.status(400).json({ ok: false, code: "BAD_TYPE", message: "The licence should be a PDF or an image." });
  }

  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({
      ok: false,
      code: "TOO_BIG",
      message: "That file is " + (buffer.length / 1048576).toFixed(1) + " MB. Keep it under 2.5 MB — resize or export it smaller."
    });
  }

  const own = await rest("restaurants?owner_id=eq." + user.id + "&select=id,handle");
  if (!own.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (own.data || [])[0];
  if (!restaurant) {
    return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Finish the restaurant details first." });
  }

  /* the "folder" is this prefix, created implicitly on the first write */
  const stamp = Date.now();
  const path = restaurant.handle + "/" + kind + "-" + stamp + "." + ext;

  const url = process.env.SUPABASE_URL.replace(/\/+$/, "") + "/storage/v1/object/menu-media/" + path;
  let up;
  try {
    up = await fetch(url, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
        "Content-Type": mime,
        "x-upsert": "true",
        "cache-control": "public, max-age=31536000"
      },
      body: buffer,
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    return res.status(502).json({ ok: false, code: "UPLOAD_FAILED", message: String(e.message || e) });
  }

  if (!up.ok) {
    const detail = (await up.text()).slice(0, 200);
    return res.status(502).json({ ok: false, code: "UPLOAD_FAILED", message: "Storage refused the file.", detail });
  }

  const publicUrl = process.env.SUPABASE_URL.replace(/\/+$/, "") +
    "/storage/v1/object/public/menu-media/" + path;

  return res.status(200).json({
    ok: true,
    url: publicUrl,
    path,
    bytes: buffer.length,
    kind
  });
};

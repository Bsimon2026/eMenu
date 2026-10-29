/**
 * Thin Supabase helpers for the serverless functions.
 *
 * The service key lives only here, in Vercel's environment. It is never sent
 * to a browser: the guest read endpoint shapes what leaves the server, and the
 * write endpoints first prove who is calling with their access token.
 */

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SECRET = process.env.SUPABASE_SECRET_KEY || "";

async function rest(path, opts = {}) {
  const { method = "GET", body, prefer, headers = {} } = opts;
  const res = await fetch(URL_BASE + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: SECRET,
      Authorization: "Bearer " + SECRET,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

/** Resolve a user's access token to their account. Returns null when invalid. */
async function userFromToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const res = await fetch(URL_BASE + "/auth/v1/user", {
      headers: { apikey: SECRET, Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : "";
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

module.exports = { rest, userFromToken, bearer, cors, configured: Boolean(URL_BASE && SECRET) };

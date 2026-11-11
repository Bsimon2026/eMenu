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

/** Ask the Auth admin API something with the service key. Server-side only. */
async function adminAuth(path) {
  try {
    const res = await fetch(URL_BASE + "/auth/v1/admin" + path, {
      headers: { apikey: SECRET, Authorization: "Bearer " + SECRET },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null };
  }
}

/** The same, for calls that write: create or change a user. */
async function adminAuthJson(path, method, body) {
  try {
    const res = await fetch(URL_BASE + "/auth/v1/admin" + path, {
      method: method || "POST",
      headers: { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null };
  }
}

/* --------------------------------------------------------------- the team ---
 * A staff login is a NAME and a PASSWORD, typed at the restaurant's own
 * address. Supabase only knows how to authenticate an email, so the server
 * builds one that can never receive post:
 *
 *     spice-route + "ali"  ->  ali@spice-route.staff.digimenu.internal
 *
 * The handle comes from the address the person signed in at, never from
 * anything they sent, so "ali" at one restaurant and "ali" at another are two
 * different identities. That is what keeps a name inside its own restaurant.
 */
const STAFF_DOMAIN = "staff.digimenu.internal";

function memberEmail(handle, username) {
  return String(username).toLowerCase() + "@" + String(handle).toLowerCase() + "." + STAFF_DOMAIN;
}

/** What a role is allowed to do. Owner is everything. */
const ROLES = {
  owner: ["menu", "orders", "publish", "team", "profile"],
  menu: ["menu", "profile"],
  orders: ["orders"]
};

function can(role, what) {
  return (ROLES[role] || []).indexOf(what) !== -1;
}

/** The restaurant a signed-in person may act on, and in what capacity.
 *
 *  Owner first: the row whose owner_id is theirs. Otherwise a staff membership
 *  from 0008 — and even then the handle on the token has to agree with the
 *  membership row, so a tampered token cannot point an account at another
 *  restaurant. Returns null when the person has no restaurant at all.
 */
async function actorRestaurant(user, cols) {
  if (!user || !user.id) return null;
  const select = cols || "id,handle,name,status";

  const own = await rest("restaurants?owner_id=eq." + user.id + "&select=" + select);
  if (own.ok && Array.isArray(own.data) && own.data[0]) {
    return { restaurant: own.data[0], role: "owner" };
  }

  const hint = String((user.app_metadata && user.app_metadata.restaurant_handle) || "");
  const mem = await rest("restaurant_members?user_id=eq." + user.id + "&select=restaurant_id,role,username");
  if (!mem.ok || !Array.isArray(mem.data) || !mem.data[0]) return null;
  const m = mem.data[0];

  const row = await rest(
    "restaurants?id=eq." + m.restaurant_id +
    (hint ? "&handle=eq." + encodeURIComponent(hint) : "") +
    "&select=" + select
  );
  if (!row.ok || !Array.isArray(row.data) || !row.data[0]) return null;

  return { restaurant: row.data[0], role: m.role === "menu" ? "menu" : "orders", username: m.username };
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

module.exports = {
  rest, userFromToken, adminAuth, adminAuthJson, actorRestaurant, can, memberEmail, ROLES,
  bearer, cors, configured: Boolean(URL_BASE && SECRET)
};

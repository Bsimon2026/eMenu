/**
 * POST /api/staff-login — { handle, username, password }
 *
 * The staff door, and the whole reason it lives on the server: the person types
 * a NAME, and the restaurant they are signing in to is the one in the address
 * they reached. Neither happens in the browser.
 *
 *   seen at  digimenu.indubaicity.com/spice-route/login
 *   typed    ali / hunter2
 *   becomes  ali@spice-route.staff.digimenu.internal  ->  Supabase password grant
 *
 * Two consequences worth stating, because they are the requirement:
 *
 *   1. "ali" created under spice-route is a different identity from "ali"
 *      anywhere else. One name cannot open another restaurant's menu, because
 *      the handle is part of the identity, not a parameter to a query.
 *   2. Nothing is emailed and nothing is verified. The owner types both fields
 *      when he creates the login, so he always knows the password. A forgotten
 *      one is replaced by him reading a new one onto the same form — there is
 *      no reset mail to wait for and no way for one person's reset to lock out
 *      another.
 */

const { rest, memberEmail, cors, configured } = require("./_lib/db");

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const SAFE_USER = /^[a-z0-9][a-z0-9._-]{1,23}$/i;

const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

function over(key, max) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 800) hits.clear();
  return seen.length > max;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, code: "BAD_BODY", message: "Send the name and password as JSON." });
  }

  const handle = String(body.handle || "").trim().toLowerCase();
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!SAFE_HANDLE.test(handle)) {
    return res.status(400).json({ ok: false, code: "BAD_HANDLE", message: "That is not a restaurant address." });
  }
  if (!SAFE_USER.test(username)) {
    return res.status(400).json({ ok: false, code: "BAD_NAME", message: "Enter the name your owner gave you." });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, code: "BAD_PASSWORD", message: "Enter your password." });
  }

  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "local");
  if (over("ip:" + ip, 30) || over("nm:" + handle + "/" + username, 12)) {
    return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "Too many tries. Wait an hour." });
  }

  /* the restaurant is decided by the address, so an unpublished menu still has
     a working staff door — the kitchen has to be able to fix it */
  const found = await rest("restaurants?handle=eq." + encodeURIComponent(handle) + "&select=id,handle,name,status");
  if (!found.ok) {
    return res.status(502).json({ ok: false, code: "DB_ERROR", message: "The database did not answer." });
  }
  const restaurant = Array.isArray(found.data) ? found.data[0] : null;
  if (!restaurant) {
    return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No restaurant at that address." });
  }

  const mem = await rest(
    "restaurant_members?restaurant_id=eq." + restaurant.id +
    "&username=eq." + encodeURIComponent(username) +
    "&select=user_id,role,username"
  );
  if (!mem.ok) {
    /* 0008 not run yet: say so plainly instead of "wrong password" */
    return res.status(503).json({
      ok: false, code: "NO_TEAM",
      message: "Team logins are not switched on for this restaurant yet."
    });
  }
  if (!Array.isArray(mem.data) || !mem.data[0]) {
    return res.status(401).json({ ok: false, code: "NO_LOGIN", message: "That name and password do not match a login here." });
  }

  const email = memberEmail(handle, username);
  const tok = await fetch(
    (process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/auth/v1/token?grant_type=password",
    {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SECRET_KEY || "",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20000)
    }
  );

  const text = await tok.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

  if (!tok.ok) {
    /* unknown name and wrong password look identical on purpose */
    return res.status(401).json({ ok: false, code: "NO_LOGIN", message: "That name and password do not match a login here." });
  }

  return res.status(200).json({
    ok: true,
    session: data,
    role: mem.data[0].role === "menu" ? "menu" : "orders",
    restaurant: { handle: restaurant.handle, name: restaurant.name }
  });
};

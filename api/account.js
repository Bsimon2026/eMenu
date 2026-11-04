/**
 * GET /api/account?email=…
 *
 * Answers one question: does an account exist for this email?
 *
 * This deliberately tells the caller the truth. Hiding it buys nothing here —
 * /auth/v1/signup already answers "User already registered" for an existing
 * address — and the cost of hiding it is a restaurant owner who types their
 * address, sees a cheerful "if that email has an account…", and then waits for
 * a message that was never sent.
 *
 * Scope is kept as tight as the intent: one email in, a boolean out. No names,
 * no ids, no list, no pagination. Throttled per address so it cannot be used to
 * sweep a list of emails quickly.
 */

const { adminAuth, cors, configured } = require("./_lib/db");

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const hits = new Map();          /* best effort: cold starts reset it */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;

function throttled(key) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 500) hits.clear();
  return seen.length > MAX_PER_WINDOW;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  const raw = String((req.query && req.query.email) || "").trim().toLowerCase();
  if (!EMAIL.test(raw)) {
    return res.status(400).json({ ok: false, code: "BAD_EMAIL", message: "That email does not look complete." });
  }

  const who = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "local");
  if (throttled(who)) {
    return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "Too many checks. Wait a minute." });
  }

  const r = await adminAuth("/users?filter=" + encodeURIComponent(raw) + "&per_page=20");
  if (!r.ok) return res.status(502).json({ ok: false, code: "LOOKUP_FAILED" });

  const users = (r.data && (r.data.users || r.data)) || [];
  /* the filter is a search, so the comparison has to be exact */
  const exists = Array.isArray(users) && users.some((u) => String(u && u.email || "").toLowerCase() === raw);

  return res.status(200).json({ ok: true, exists });
};

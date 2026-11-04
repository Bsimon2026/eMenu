/**
 * POST /api/reset-password — email a temporary password instead of a magic link.
 *
 * A reset link means two systems have to agree: the token in the URL, the browser
 * that opens it, the Site URL that must be right, and a page that knows what to do
 * with the fragment. A temporary password needs none of that — it is a password,
 * and the login form already knows what to do with a password.
 *
 * The account is flagged so the dashboard asks for a new password straight away.
 */

const crypto = require("crypto");
const { rest, adminAuth, cors, configured } = require("./_lib/db");
const mail = require("./_lib/mail");

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const WINDOW_MS = 60 * 60 * 1000;
const PER_EMAIL = 3;
const PER_IP = 12;
const hits = new Map();

function over(key, max) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 800) hits.clear();
  return seen.length > max;
}

/** Readable but not guessable: no 0/O, 1/l/I ambiguity for people typing it from a phone. */
function tempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12);
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const email = String((body && body.email) || "").trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return res.status(400).json({ ok: false, code: "BAD_EMAIL", message: "That email does not look complete." });
  }

  const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "local");
  if (over("ip:" + ip, PER_IP) || over("em:" + email, PER_EMAIL)) {
    return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "Too many attempts. Try again in an hour." });
  }

  const found = await adminAuth("/users?filter=" + encodeURIComponent(email) + "&per_page=20");
  if (!found.ok) return res.status(502).json({ ok: false, code: "LOOKUP_FAILED" });
  const users = (found.data && (found.data.users || found.data)) || [];
  const user = Array.isArray(users)
    ? users.find((u) => String((u && u.email) || "").toLowerCase() === email)
    : null;

  /* No account is said plainly: the signup form already reveals it, and a dead
     end with no explanation is worse than the information. */
  if (!user) return res.status(200).json({ ok: true, exists: false });

  const password = tempPassword();
  const set = await fetch((process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/auth/v1/admin/users/" + user.id, {
    method: "PUT",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY || "",
      Authorization: "Bearer " + (process.env.SUPABASE_SECRET_KEY || ""),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      password,
      user_metadata: { ...(user.user_metadata || {}), must_change_password: true }
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!set.ok) {
    console.error("[reset] could not set the temporary password", set.status, (await set.text()).slice(0, 200));
    return res.status(502).json({ ok: false, code: "SET_FAILED", message: "We could not reset that password. Try again in a moment." });
  }

  const sent = await mail.sendMail({
    to: [email],
    subject: "Your DigiMenu temporary password",
    fromName: "DigiMenu",
    text: [
      "Someone asked to reset the password for this DigiMenu account.",
      "",
      "Temporary password:  " + password,
      "",
      "Sign in with it here: https://digimenu.indubaicity.com/login.html",
      "You will be asked to choose your own password straight away.",
      "",
      "If this was not you, reply to this email and we will lock the account."
    ].join("\n")
  }, 9000);

  if (!sent.ok) {
    console.error("[reset] mail", sent.code, sent.detail);
    return res.status(502).json({
      ok: false,
      code: "MAIL_FAILED",
      message: "The password was reset but the email could not be sent. Contact connect@indubaicity.com."
    });
  }

  return res.status(200).json({ ok: true, exists: true });
};

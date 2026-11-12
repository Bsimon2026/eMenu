/**
 * /api/superadmin — the operator console, with names attached.
 *
 * Two ways in:
 *   a real admin user   Supabase session + a row in admin_users saying what
 *                       that person may do (view, export, pay_view, pay_entry,
 *                       admins). This is the normal path.
 *   the shared token    x-admin-token = ADMIN_TOKEN, which is every right. Kept
 *                       as a break-glass fallback for the CLI so a lost admin
 *                       account can never lock the operator out.
 *
 *   GET              ?me=1            who am I, and what may I do
 *   GET              (nothing)        the restaurant list
 *   GET              ?export=1        the same as CSV
 *   GET              ?admins=1        who else is an admin
 *   POST             ?payment=1       record a payment (or ?stop=1)
 *   POST             ?admins=1        create / remove an admin, set rights
 *   POST             ?reset=1         email that admin a temporary password
 *
 * Rights are checked here, not in the page. A hidden button is a courtesy; a
 * refused request is the rule.
 */

const crypto = require("crypto");
const {
  rest, userFromToken, bearer, cors, configured,
  adminAuth, adminAuthJson
} = require("./_lib/db");

const ALL = ["view", "export", "pay_view", "pay_entry", "admins"];

/* what a plan costs, and what the marketing add-on costs: $149 to set up,
   $8.50 a month, recorded as its own lines so it can be seen and stopped
   without touching the menu subscription */
const priceOf = (plan, billing) =>
  billing === "yearly" ? (plan === "order" ? 190 : 20) : (plan === "order" ? 19 : 2);
const MKT_SETUP = 149;
const MKT_MONTHLY = 8.5;
const PLANS = ["qr", "order"];
const BILLING = ["monthly", "yearly"];

/* ---------------------------------------------------------------- helpers */

function tokenOk(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  const given = String(req.headers["x-admin-token"] || "");
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** one month or one year on from the later of today and the current expiry */
function extend(from, billing) {
  const base = from && new Date(from) > new Date() ? new Date(from) : new Date();
  const d = new Date(base.getTime());
  if (billing === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

async function adminRow(userId) {
  const r = await rest("admin_users?user_id=eq." + userId + "&select=user_id,username,email,name,perms,last_seen");
  if (!r.ok) return { ok: false, row: null };
  return { ok: true, row: (r.data || [])[0] || null };
}

const hits = new Map();
function over(key, max) {
  const now = Date.now();
  const seen = (hits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  seen.push(now);
  hits.set(key, seen);
  if (hits.size > 500) hits.clear();
  return seen.length > max;
}

/** "  @Dmin " -> "dmin": what is typed at the door, stored without the @ */
function cleanUser(raw) {
  const u = String(raw || "").trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,23}$/.test(u) ? u : "";
}

function can(perms, what) {
  return Array.isArray(perms) && perms.indexOf(what) !== -1;
}

function csv(rows, cols) {
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  return [cols.join(",")].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
}

const BASE_COLS = "id,handle,name,status,plan,billing,paid_through,paid_amount,pay_ref,pay_method,activated_at,addon_site,addon_marketing,order_email,custom_domain,domain_status,trial_ends,created_at";

async function restaurantRows() {
  let r = await rest("restaurants?select=" + BASE_COLS + "&order=created_at");
  if (!r.ok) {
    /* a deploy can land before 0010/0011: ask for less */
    r = await rest("restaurants?select=id,handle,name,status,plan,billing,paid_through,paid_amount,pay_ref,pay_method,activated_at,addon_site,order_email&order=created_at");
  }
  if (!r.ok) return { ok: false, rows: [] };
  return { ok: true, rows: r.data || [] };
}

function shape(row, perms) {
  const today = new Date().toISOString().slice(0, 10);
  const paid = Boolean(row.paid_through && row.paid_through >= today);
  const onTrial = Boolean(row.trial_ends && row.trial_ends >= today) && !paid;
  const out = {
    handle: row.handle, name: row.name, status: row.status, plan: row.plan, billing: row.billing,
    /* the address a guest actually opens, and the state the operator chases:
       published · unpublished · expired */
    url: row.custom_domain && row.domain_status === "live" ? row.custom_domain : "digimenu.indubaicity.com/" + row.handle,
    published: row.status === "published",
    state: paid ? "paid" : (onTrial ? "trial" : "expired"),
    expires: (paid ? row.paid_through : row.trial_ends) || null,
    addon_marketing: Boolean(row.addon_marketing),
    hasPaid: Boolean(row.paid_through),
    active: paid || onTrial, onTrial,
    trialDaysLeft: onTrial ? Math.max(0, Math.round((new Date(row.trial_ends) - new Date(today)) / 86400000)) : 0,
    paid_through: row.paid_through || null,
    custom_domain: row.custom_domain || null,
    domain_status: row.domain_status || null
  };
  /* money is a separate right from seeing the shop */
  if (can(perms, "pay_view")) {
    out.paid_amount = row.paid_amount;
    out.pay_ref = row.pay_ref;
    out.pay_method = row.pay_method;
    out.activated_at = row.activated_at;
    out.order_email = row.order_email;
  }
  return out;
}

/* ------------------------------------------------------------------ routes */

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });

  const q = req.query || {};

  /* ---- the door ----
     An admin types a USER ID and a password; the email behind that id never
     appears on the page and is only ever used to send a temporary password. */
  if (q.login !== undefined) {
    if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const username = cleanUser(body && body.username);
    const password = String((body && body.password) || "");
    if (!username || password.length < 6) {
      return res.status(400).json({ ok: false, code: "BAD_LOGIN", message: "Enter your user id and password." });
    }
    const ip = String((req.headers["x-forwarded-for"] || "").split(",")[0] || "local");
    if (over("adm:" + ip + "/" + username, 12)) {
      return res.status(429).json({ ok: false, code: "SLOW_DOWN", message: "Too many tries. Wait an hour." });
    }

    const found = await rest("admin_users?username=eq." + encodeURIComponent(username) + "&select=username,email,name,perms");
    if (!found.ok) {
      return res.status(503).json({ ok: false, code: "NO_TABLE", message: "Run db/0012_admin.sql first." });
    }
    const row = (found.data || [])[0];
    if (!row) return res.status(401).json({ ok: false, code: "NO_LOGIN", message: "That user id and password do not match." });

    const tok = await fetch((process.env.SUPABASE_URL || "").replace(/\/+$/, "") + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: process.env.SUPABASE_ANON_KEY || "", "Content-Type": "application/json" },
      body: JSON.stringify({ email: row.email, password }),
      signal: AbortSignal.timeout(20000)
    });
    const text = await tok.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!tok.ok) return res.status(401).json({ ok: false, code: "NO_LOGIN", message: "That user id and password do not match." });

    return res.status(200).json({
      ok: true, session: data,
      me: { username: row.username, name: row.name || "@" + row.username, perms: row.perms || [] }
    });
  }

  /* forgot: always the same answer, so this cannot be used to find out which
     admin ids exist. The mail goes to the address stored against the id. */
  if (q.forgot !== undefined) {
    if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const username = cleanUser(body && body.username);
    if (!username) return res.status(400).json({ ok: false, code: "BAD_USER", message: "Type your user id." });

    const found = await rest("admin_users?username=eq." + encodeURIComponent(username) + "&select=email");
    /* without the table there is nothing to look up, and pretending otherwise
       sends people to an inbox to wait for a mail that was never sent */
    if (!found.ok) {
      return res.status(503).json({ ok: false, code: "NO_TABLE", message: "Admin sign-in is not switched on yet." });
    }
    const row = (found.data || [])[0] || null;
    if (row) {
      const reset = require("./_lib/reset-password");
      const shim = { setHeader() {}, status() { return shim; }, json() { return shim; }, end() { return shim; } };
      await reset({ method: "POST", headers: req.headers || {}, query: {}, body: { email: row.email } }, shim);
    }
    return res.status(200).json({ ok: true, message: "If that user id exists, a temporary password is on its way." });
  }

  /* ---- who is asking, and what may they do ---- */
  let perms = [];
  let me = null;
  let breakGlass = false;

  if (tokenOk(req)) {
    perms = ALL.slice();
    breakGlass = true;
    me = { email: "ADMIN_TOKEN", name: "operator (shared key)", breakGlass: true };
  } else {
    const user = await userFromToken(bearer(req));
    if (!user) {
      return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
    }
    const a = await adminRow(user.id);
    if (!a.ok) {
      return res.status(503).json({ ok: false, code: "DB_ERROR", message: "admin_users is not there yet — run db/0012_admin.sql." });
    }
    if (!a.row) {
      return res.status(403).json({ ok: false, code: "NOT_ADMIN", message: "This account is not an admin." });
    }
    perms = Array.isArray(a.row.perms) ? a.row.perms : [];
    me = {
      username: a.row.username,
      email: a.row.email,
      name: a.row.name || "@" + (a.row.username || ""),
      perms: perms.slice(),
      breakGlass: false
    };
    /* a quiet "last seen", best effort */
    await rest("admin_users?user_id=eq." + user.id, {
      method: "PATCH", prefer: "return=minimal", body: { last_seen: new Date().toISOString() }
    });
  }

  /* ------------------------------------------------------------- whoami */
  if (q.me !== undefined) {
    return res.status(200).json({ ok: true, me, perms });
  }

  /* ------------------------------------------------------------- admins */
  if (q.admins !== undefined) {
    if (!can(perms, "admins")) return res.status(403).json({ ok: false, code: "NO_RIGHT", message: "You cannot manage admins." });

    if (req.method === "GET") {
      const r = await rest("admin_users?select=user_id,username,email,name,perms,created_at,last_seen&order=created_at");
      if (!r.ok) return res.status(503).json({ ok: false, code: "NO_TABLE", message: "Run db/0012_admin.sql first." });
      return res.status(200).json({ ok: true, admins: r.data || [], all: ALL });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== "object") return res.status(400).json({ ok: false, code: "BAD_BODY" });

    const action = String(body.action || "create");
    const email = String(body.email || "").trim().toLowerCase();
    const username = cleanUser(body.username);
    const byUser = (u) => "admin_users?username=eq." + encodeURIComponent(u);

    /* --------------------------------------------------- create an admin */
    if (action === "create") {
      if (!username) {
        return res.status(400).json({ ok: false, code: "BAD_USER", message: "Give them a user id: 2-24 characters, letters numbers dot dash underscore." });
      }
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
        return res.status(400).json({ ok: false, code: "BAD_EMAIL", message: "An email is needed behind the id — that is where a temporary password goes." });
      }
      const name = String(body.name || "").trim().slice(0, 60) || "@" + username;
      const want = Array.isArray(body.perms) ? body.perms.filter((p) => ALL.indexOf(p) !== -1) : ["view"];

      const exists = await rest(byUser(username) + "&select=user_id");
      if (exists.ok && (exists.data || []).length) {
        return res.status(409).json({ ok: false, code: "USER_TAKEN", message: "@" + username + " is already an admin." });
      }
      const mailTaken = await rest("admin_users?email=eq." + encodeURIComponent(email) + "&select=user_id");
      if (mailTaken.ok && (mailTaken.data || []).length) {
        return res.status(409).json({ ok: false, code: "EMAIL_TAKEN", message: "That email is already behind another admin id." });
      }

      /* a random password nobody knows: the first way in is the emailed
         temporary one, which is the same door an owner uses */
      const temp = crypto.randomBytes(24).toString("base64url");
      const made = await adminAuthJson("/users", "POST", {
        email, password: temp, email_confirm: true,
        app_metadata: { is_admin: true },
        user_metadata: { name }
      });

      let userId = made.ok && made.data && made.data.id ? made.data.id : null;
      if (!userId) {
        const found = await adminAuth("/users?filter=" + encodeURIComponent(email) + "&per_page=20");
        const users = (found.ok && found.data && (found.data.users || found.data)) || [];
        const prev = (Array.isArray(users) ? users : []).find((u) => String(u.email || "").toLowerCase() === email);
        if (!prev) return res.status(502).json({ ok: false, code: "CREATE_FAILED", message: "The admin account could not be created." });
        userId = prev.id;
        await adminAuthJson("/users/" + userId, "PUT", { app_metadata: { is_admin: true } });
      }

      const row = await rest("admin_users", {
        method: "POST", prefer: "return=representation",
        body: { user_id: userId, username, email, name, perms: want.length ? want : ["view"] }
      });
      if (!row.ok) {
        await adminAuthJson("/users/" + userId, "DELETE");
        return res.status(502).json({ ok: false, code: "SAVE_FAILED", message: "Created the login but not the admin row. Try again." });
      }
      return res.status(200).json({ ok: true, admin: { username, email, name, perms: want }, next: "Send them a temporary password with Reset." });
    }

    /* --------------------------------------------------- change the rights */
    if (action === "perms") {
      const want = (Array.isArray(body.perms) ? body.perms : []).filter((p) => ALL.indexOf(p) !== -1);
      if (!want.length) return res.status(400).json({ ok: false, code: "NO_PERMS", message: "Give them at least one right." });
      const upd = await rest(byUser(username), {
        method: "PATCH", prefer: "return=minimal", body: { perms: want }
      });
      if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED" });
      return res.status(200).json({ ok: true, perms: want });
    }

    /* --------------------------------------------------------- remove */
    if (action === "remove") {
      const r = await rest(byUser(username) + "&select=user_id");
      const gone = (r.ok && (r.data || [])[0]) || null;
      if (!gone) return res.status(404).json({ ok: false, code: "NOT_FOUND" });
      const others = await rest("admin_users?select=user_id");
      if ((others.data || []).length <= 1) {
        return res.status(409).json({ ok: false, code: "LAST_ADMIN", message: "That is the only admin left. Make another first." });
      }
      await rest(byUser(username), { method: "DELETE" });
      await adminAuthJson("/users/" + gone.user_id, "DELETE");
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, code: "BAD_ACTION" });
  }

  /* ------------------------------------------------------- temp password */
  if (q.reset !== undefined) {
    if (!can(perms, "admins")) return res.status(403).json({ ok: false, code: "NO_RIGHT" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const uname = cleanUser(body && (body.username || body.email));
    if (!uname) return res.status(400).json({ ok: false, code: "NO_USER" });
    const who = await rest("admin_users?username=eq." + encodeURIComponent(uname) + "&select=email");
    const email = (who.ok && (who.data || [])[0] && who.data[0].email) || "";
    if (!email) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No admin with that user id." });

    const reset = require("./_lib/reset-password");
    const out = { code: 500, body: null };
    const shim = {
      setHeader() {}, status(c) { out.code = c; return shim; },
      json(b) { out.body = b; return shim; }, end() { return shim; }
    };
    await reset({ method: "POST", headers: req.headers || {}, query: {}, body: { email } }, shim);
    if (!out.body || !out.body.ok) {
      return res.status(502).json({ ok: false, code: "RESET_FAILED", message: (out.body && out.body.message) || "The email could not be sent." });
    }
    return res.status(200).json({ ok: true, exists: out.body.exists !== false });
  }

  /* ---------------------------------------------------------- payments */
  if (q.payment !== undefined || q.stop !== undefined) {
    if (!can(perms, "pay_entry")) {
      return res.status(403).json({ ok: false, code: "NO_RIGHT", message: "Your admin account cannot record payments." });
    }
    if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || !body.handle) return res.status(400).json({ ok: false, code: "NO_HANDLE" });

    const found = await rest("restaurants?handle=eq." + encodeURIComponent(String(body.handle).toLowerCase()) + "&select=id,handle,plan,billing,paid_through,trial_ends");
    if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const r0 = (found.data || [])[0];
    if (!r0) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No restaurant with that handle." });

    const patch = {};
    let ledger = [];
    if (q.stop !== undefined) {
      patch.paid_through = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      patch.trial_ends = null;
    } else {
      const billing = BILLING.includes(body.billing) ? body.billing : "monthly";
      const plan = PLANS.includes(body.plan) ? body.plan : (r0.plan || "qr");

      /* the marketing add-on is sold as $149 to set up plus $8.50 a month. The
         setup fee is only ever charged once per customer. */
      const wantMarketing = body.marketing === true;
      const marketingOn = body.marketing === undefined ? Boolean(r0.addon_marketing) : wantMarketing;
      const firstMarketing = wantMarketing && !r0.addon_marketing;

      const suggested =
        priceOf(plan, billing) +
        (firstMarketing ? MKT_SETUP : 0) +
        (wantMarketing ? MKT_MONTHLY : 0);
      const amount = body.amount === undefined || body.amount === null || body.amount === ""
        ? suggested
        : Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ ok: false, code: "BAD_AMOUNT", message: "That amount is not a number." });
      }

      patch.plan = plan;
      patch.billing = billing;
      patch.paid_through = extend(body.from || r0.paid_through, billing);
      patch.paid_amount = amount;
      patch.pay_ref = body.payRef ? String(body.payRef).slice(0, 120) : null;
      patch.pay_method = ["manual", "cash", "transfer", "card", "stripe"].includes(body.method) ? body.method : "manual";
      patch.activated_at = new Date().toISOString();
      if (body.marketing !== undefined) patch.addon_marketing = wantMarketing;

      /* every payment is a line in the ledger — the plan, the setup fee (once),
         and the monthly add-on separately, so any of them can be seen alone */
      ledger = [{
        plan, billing, kind: "subscription", amount,
        period_end: patch.paid_through
      }];
      if (firstMarketing) {
        ledger.push({ kind: "setup", addon: "marketing", billing: "one-off", amount: MKT_SETUP });
      }
      if (wantMarketing) {
        ledger.push({ kind: "addon", addon: "marketing", billing: "monthly", amount: MKT_MONTHLY, period_end: patch.paid_through });
      }
      for (const row of ledger) {
        row.restaurant_id = r0.id;
        row.currency = "USD";
        row.method = patch.pay_method;
        row.reference = patch.pay_ref;
        row.note = body.note ? String(body.note).slice(0, 200) : null;
        row.recorded_by = me.name;
      }
    }

    const upd = await rest("restaurants?id=eq." + r0.id, { method: "PATCH", body: patch, prefer: "return=representation" });
    if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", detail: String(upd.data).slice(0, 200) });
    const row = (upd.data || [])[0] || {};

    /* stopping an account must not leave a menu live that nobody paid for */
    if (q.stop !== undefined && row.status === "published") {
      const off = await rest("restaurants?id=eq." + r0.id, { method: "PATCH", prefer: "return=minimal", body: { status: "trial" } });
      if (!off.ok) return res.status(502).json({ ok: false, code: "UNPUBLISH_FAILED" });
    }

    /* the books are the point of recording this at all, so a failure to write
       the ledger is reported rather than swallowed — the account is still live,
       and the operator is told the line is missing */
    let ledgerOk = true;
    if (ledger.length) {
      const ins = await rest("payments", { method: "POST", prefer: "return=minimal", body: ledger });
      ledgerOk = ins.ok;
      if (!ins.ok) console.log("[superadmin] LEDGER FAILED", r0.handle, String(ins.data).slice(0, 200));
    }

    console.log("[superadmin]", me.name, q.stop !== undefined ? "stopped" : "recorded payment for", r0.handle, patch.paid_through || "", "|", ledger.map((x) => x.kind + " " + x.amount).join(" + "));
    return res.status(200).json({
      ok: true,
      restaurant: shape({ ...r0, ...row }, perms),
      ledger: ledger.map((x) => ({ kind: x.kind, addon: x.addon || null, amount: x.amount })),
      ledgerOk,
      warning: ledgerOk ? undefined : "The payment went through, but its line in the history did not save."
    });
  }

  /* ------------------------------------------------------------ export */
  if (q.export !== undefined) {
    if (!can(perms, "export")) return res.status(403).json({ ok: false, code: "NO_RIGHT", message: "Your admin account cannot export." });
    const all = await restaurantRows();
    if (!all.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const cols = ["handle", "name", "status", "plan", "billing", "active", "paid_through", "custom_domain"]
      .concat(can(perms, "pay_view") ? ["paid_amount", "pay_ref", "pay_method", "order_email"] : []);
    const rows = all.rows.map((r) => shape(r, perms));
    const body = csv(rows, cols);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="digimenu-restaurants-' + stamp + '.csv"');
    if (typeof res.send === "function") return res.status(200).send(body);
    return res.status(200).json({ ok: true, csv: body });
  }

  /* ------------------------------------------------------------ ledger */
  if (q.payments !== undefined) {
    if (!can(perms, "pay_view") && !can(perms, "pay_entry")) return res.status(403).json({ ok: false, code: "NO_RIGHT", message: "Your admin account cannot see payments." });
    const handle = String((q.handle || "")).trim().toLowerCase();
    if (!handle) return res.status(400).json({ ok: false, code: "NO_HANDLE" });

    const rr = await rest("restaurants?handle=eq." + encodeURIComponent(handle) + "&select=id,handle,name,paid_through,trial_ends,addon_marketing,plan,billing");
    const r0 = rr.ok && (rr.data || [])[0];
    if (!r0) return res.status(404).json({ ok: false, code: "NOT_FOUND" });

    const pay = await rest("payments?restaurant_id=eq." + r0.id + "&select=amount,currency,plan,billing,kind,addon,period_end,method,reference,note,recorded_by,created_at&order=created_at.desc&limit=200");
    if (!pay.ok) return res.status(503).json({ ok: false, code: "NO_LEDGER", message: "Payment history is not switched on yet." });
    const rows = pay.data || [];
    return res.status(200).json({
      ok: true,
      restaurant: { handle: r0.handle, name: r0.name, paid_through: r0.paid_through, trial_ends: r0.trial_ends, addon_marketing: Boolean(r0.addon_marketing), plan: r0.plan, billing: r0.billing },
      payments: rows,
      total: Math.round(rows.reduce((a, x) => a + Number(x.amount || 0), 0) * 100) / 100,
      prices: { qr: { monthly: 2, yearly: 20 }, order: { monthly: 19, yearly: 190 }, marketing: { setup: MKT_SETUP, monthly: MKT_MONTHLY } }
    });
  }

  /* --------------------------------------------------------------- list */
  if (req.method !== "GET") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!can(perms, "view")) return res.status(403).json({ ok: false, code: "NO_RIGHT", message: "Your admin account can only take payments, not read the list." });

  const all = await restaurantRows();
  if (!all.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  return res.status(200).json({
    ok: true,
    me, perms,
    today: new Date().toISOString().slice(0, 10),
    restaurants: all.rows.map((r) => shape(r, perms))
  });
};

/**
 * /api/admin — the operator console behind a shared secret.
 *
 * Payment is manual until Stripe lands: money arrives by transfer or cash, and
 * this endpoint records that it did. It writes the same columns a Stripe webhook
 * will write later, so swapping the source never touches the rest of the app.
 *
 * Auth is a single header, ADMIN_TOKEN, set in the host environment. Without it
 * the endpoint refuses everything — there is no "logged in as admin" user model
 * yet, and inventing one would be a bigger change than the business needs today.
 */

const { rest, cors, configured } = require("./_lib/db");

const PLANS = ["qr", "order"];
const BILLING = ["monthly", "yearly"];

function authorised(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  const given = String(req.headers["x-admin-token"] || "");
  if (!expected || !given) return false;
  /* same length first, then compare — keeps the timing honest */
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** One month or one year from a date, never from "now" when extending an active plan. */
function extend(from, billing) {
  const base = from && new Date(from) > new Date() ? new Date(from) : new Date();
  const d = new Date(base.getTime());
  if (billing === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- domains ---
 * The deployment serves every restaurant, so a customer's domain is just
 * another hostname on the same project. Vercel says whether DNS is right yet;
 * this code only relays it and keeps one column in step.
 */
const VERCEL = "https://api.vercel.com";

function vercelEnv() {
  return {
    token: process.env.VERCEL_TOKEN || "",
    project: process.env.VERCEL_PROJECT_ID || "digimenu",
    team: process.env.VERCEL_TEAM_ID || ""
  };
}

/** strip a pasted URL down to the bare domain: no scheme, no www, no path */
function cleanDomain(raw) {
  let d = String(raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  d = d.replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return "";
  if (d.split(".").length < 2) return "";
  return d;
}

async function vercel(path, method, body) {
  const { token } = vercelEnv();
  const r = await fetch(VERCEL + path, {
    method: method || "GET",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

/** the records the customer has to create, and what they mean */
function dnsFor(domain, verification) {
  const records = [
    { type: "CNAME", name: "www", value: "cname.vercel-dns.com", note: "www." + domain + " → us" },
    { type: "A", name: "@", value: "76.76.21.21", note: domain + " itself (apex)" }
  ];
  for (const v of verification || []) {
    if (v && v.type === "TXT") {
      records.push({ type: "TXT", name: v.domain || "@", value: v.value, note: v.reason || "proves the domain is yours" });
    }
  }
  return records;
}

async function domainAction(res, action, body, r0) {
  const env = vercelEnv();
  if (!env.token) {
    return res.status(503).json({
      ok: false, code: "NO_VERCEL_TOKEN",
      message: "Set VERCEL_TOKEN on the server first — a Vercel access token with access to this project."
    });
  }

  const q = env.team ? "?teamId=" + encodeURIComponent(env.team) : "";
  const current = await rest("restaurants?id=eq." + r0.id + "&select=id,handle,custom_domain,domain_status,domain_error");
  const row = (current.ok && (current.data || [])[0]) || {};

  /* ---------------------------------------------------------------- remove */
  if (action === "domain-remove") {
    const domain = cleanDomain(body.domain || row.custom_domain);
    if (domain) {
      await vercel("/v10/projects/" + env.project + "/domains/" + encodeURIComponent(domain) + q, "DELETE");
      await vercel("/v10/projects/" + env.project + "/domains/" + encodeURIComponent("www." + domain) + q, "DELETE");
    }
    await rest("restaurants?id=eq." + r0.id, {
      method: "PATCH", prefer: "return=minimal",
      body: { custom_domain: null, domain_status: null, domain_added_at: null, domain_error: null }
    });
    return res.status(200).json({ ok: true, removed: domain || null });
  }

  /* ----------------------------------------------------------------- check */
  if (action === "domain-check") {
    const domain = cleanDomain(body.domain || row.custom_domain);
    if (!domain) return res.status(400).json({ ok: false, code: "NO_DOMAIN", message: "This restaurant has no domain yet." });

    const mine = await vercel("/v9/projects/" + env.project + "/domains/" + encodeURIComponent(domain) + q, "GET");
    const cfg = await vercel("/v6/domains/" + encodeURIComponent(domain) + "/config" + q, "GET");

    const added = mine.ok;
    const verified = Boolean(mine.data && mine.data.verified);
    const misconfigured = Boolean(cfg.ok && cfg.data && cfg.data.misconfigured);
    const live = added && verified && !misconfigured;

    await rest("restaurants?id=eq." + r0.id, {
      method: "PATCH", prefer: "return=minimal",
      body: {
        domain_status: live ? "live" : (added ? "pending" : "error"),
        domain_error: live ? null : (added ? (misconfigured ? "DNS is not pointing here yet" : "waiting for the certificate") : "not on the project")
      }
    });

    return res.status(200).json({
      ok: true, domain, added, verified, misconfigured, live,
      status: live ? "live" : (added ? "pending" : "error"),
      records: dnsFor(domain, mine.data && mine.data.verification)
    });
  }

  /* ------------------------------------------------------------------- add */
  const domain = cleanDomain(body.domain);
  if (!domain) {
    return res.status(400).json({ ok: false, code: "BAD_DOMAIN", message: "That does not look like a domain. Try restaurant.com" });
  }

  const clash = await rest("restaurants?custom_domain=eq." + encodeURIComponent(domain) + "&id=neq." + r0.id + "&select=handle");
  if (clash.ok && (clash.data || []).length) {
    return res.status(409).json({
      ok: false, code: "DOMAIN_TAKEN",
      message: "That domain is already connected to /" + clash.data[0].handle + "."
    });
  }

  /* the bare domain and www: one certificate covers both, and a guest typing
     www. should not land on a dead host */
  const apex = await vercel("/v10/projects/" + env.project + "/domains" + q, "POST", { name: domain });
  if (!apex.ok) {
    const msg = (apex.data && apex.data.error && apex.data.error.message) || "Vercel refused that domain.";
    const already = /already|exists|in use|409/i.test(msg) || apex.status === 409;
    return res.status(already ? 409 : 502).json({
      ok: false, code: already ? "DOMAIN_IN_USE" : "VERCEL_ERROR",
      message: already
        ? "Vercel says that domain is already attached to another project or account."
        : msg
    });
  }
  const www = await vercel("/v10/projects/" + env.project + "/domains" + q, "POST", { name: "www." + domain });

  await rest("restaurants?id=eq." + r0.id, {
    method: "PATCH", prefer: "return=minimal",
    body: {
      custom_domain: domain,
      domain_status: "pending",
      domain_added_at: new Date().toISOString(),
      domain_error: null
    }
  });

  return res.status(200).json({
    ok: true,
    domain,
    wwwAdded: www.ok,
    verified: Boolean(apex.data && apex.data.verified),
    status: "pending",
    records: dnsFor(domain, apex.data && apex.data.verification),
    where: "This domain now serves digimenu.indubaicity.com/" + r0.handle + " — the menu loads at the domain's root once DNS resolves and Vercel issues the certificate."
  });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!configured) return res.status(500).json({ ok: false, code: "NOT_CONFIGURED" });
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, code: "NO_ADMIN_TOKEN", message: "Set ADMIN_TOKEN on the server first." });
  }
  if (!authorised(req)) {
    return res.status(401).json({ ok: false, code: "UNAUTHORISED", message: "That admin key is not right." });
  }

  /* ---- list every restaurant with what it is owed ---- */
  if (req.method === "GET") {
    const BASE = "id,handle,name,status,plan,billing,paid_through,paid_amount,pay_ref,pay_method,activated_at,addon_site,order_email";
    /* a deploy can land before 0011 runs: ask for the trial columns, and fall
       back to the ones that have always existed rather than breaking the panel */
    let r = await rest("restaurants?select=" + BASE + ",custom_domain,domain_status,domain_error,trial_ends,trial_granted_at&order=created_at");
    if (!r.ok) r = await rest("restaurants?select=" + BASE + ",custom_domain,domain_status,domain_error&order=created_at");
    if (!r.ok) r = await rest("restaurants?select=" + BASE + "&order=created_at");
    if (!r.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
    const today = new Date().toISOString().slice(0, 10);
    const rows = (r.data || []).map((x) => {
      const paid = Boolean(x.paid_through && x.paid_through >= today);
      const onTrial = Boolean(x.trial_ends && x.trial_ends >= today) && !paid;
      const daysLeft = x.trial_ends
        ? Math.max(0, Math.round((new Date(x.trial_ends) - new Date(today)) / 86400000))
        : 0;
      return {
        ...x,
        paid,
        onTrial,
        trialDaysLeft: onTrial ? daysLeft : 0,
        /* a restaurant is live on a payment or inside its free week */
        active: paid || onTrial,
        price: x.plan === "order" ? (x.billing === "yearly" ? 190 : 19) : (x.billing === "yearly" ? 20 : 2)
      };
    });
    return res.status(200).json({ ok: true, restaurants: rows, today });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !body.handle) return res.status(400).json({ ok: false, code: "NO_HANDLE", message: "Which restaurant?" });

  const found = await rest("restaurants?handle=eq." + encodeURIComponent(String(body.handle).toLowerCase()) + "&select=id,handle,name,plan,billing,paid_through");
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const r0 = (found.data || [])[0];
  if (!r0) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "No restaurant with that handle." });

  const action = String(body.action || "record-payment");

  /* ------------------------------------------------------------------------
     A customer's own domain. One Vercel project serves every restaurant, so
     adding a domain is: add it to the project through the API, tell the owner
     which DNS records to create, then check back until Vercel says the
     certificate is issued. Nothing is deployed and nothing is copied.
     ---------------------------------------------------------------------- */
  if (action === "domain-add" || action === "domain-check" || action === "domain-remove") {
    return domainAction(res, action, body, r0);
  }

  const patch = {};

  if (action === "set-plan") {
    if (!PLANS.includes(body.plan)) return res.status(400).json({ ok: false, code: "BAD_PLAN" });
    patch.plan = body.plan;
    if (BILLING.includes(body.billing)) patch.billing = body.billing;
  } else if (action === "record-payment") {
    if (BILLING.includes(body.billing)) patch.billing = body.billing;
    patch.paid_through = extend(body.from || r0.paid_through, patch.billing || r0.billing || "monthly");
    patch.paid_amount = Number(body.amount) || (patch.billing === "yearly"
      ? (r0.plan === "order" || body.plan === "order" ? 190 : 20)
      : (r0.plan === "order" || body.plan === "order" ? 19 : 2));
    patch.pay_ref = body.payRef ? String(body.payRef).slice(0, 120) : null;
    patch.pay_method = "manual";
    patch.activated_at = new Date().toISOString();
    if (PLANS.includes(body.plan)) patch.plan = body.plan;
    if (typeof body.addonSite === "boolean") patch.addon_site = body.addonSite;
  } else if (action === "stop") {
    patch.paid_through = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    /* a stopped account must not stay live on the strength of its free week */
    patch.trial_ends = null;
  } else {
    return res.status(400).json({ ok: false, code: "BAD_ACTION", message: "Unknown action." });
  }

  const upd = await rest("restaurants?id=eq." + r0.id, { method: "PATCH", body: patch, prefer: "return=representation" });
  if (!upd.ok) return res.status(502).json({ ok: false, code: "SAVE_FAILED", detail: String(upd.data).slice(0, 200) });

  const row = (upd.data || [])[0] || {};
  const today = new Date().toISOString().slice(0, 10);

  /* stopping payment must not leave a menu live that nobody has paid for.
     'trial' is the schema's word for "not published" — 'draft' is not a status
     this database accepts, and a silent check violation would leave the menu up. */
  if (action === "stop" && row.status === "published") {
    const off = await rest("restaurants?id=eq." + r0.id, { method: "PATCH", body: { status: "trial" }, prefer: "return=representation" });
    if (!off.ok) {
      return res.status(502).json({ ok: false, code: "UNPUBLISH_FAILED", detail: String(off.data).slice(0, 200) });
    }
    row.status = "trial";
  }

  return res.status(200).json({
    ok: true,
    restaurant: {
      handle: row.handle, name: row.name, plan: row.plan, billing: row.billing,
      paid_through: row.paid_through, paid_amount: row.paid_amount, pay_ref: row.pay_ref,
      status: row.status, active: Boolean(row.paid_through && row.paid_through >= today)
    }
  });
};

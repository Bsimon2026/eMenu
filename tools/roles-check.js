/**
 * Who may read the order book.
 *
 *   node tools/roles-check.js [origin] [envPath]
 *
 * A waiter is a login that takes an order at a table and nothing else. That was
 * a claim in a comment until this file existed: the list handler checked that you
 * were staff, never what you were, so any membership could pull every order — and
 * every guest's phone number — and change its status.
 *
 * It signs in as a real owner, creates a real waiter with the tablet role, and
 * asserts what each of them is allowed to do. The waiter is deleted at the end.
 * Nothing else is written: the PATCH tries a made-up id, which the role gate
 * refuses before the id is ever looked at.
 */
const fs = require("fs");

const ORIGIN = (process.argv[2] || process.env.ORIGIN || "https://digimenu.indubaicity.com").replace(/\/+$/, "");
const envPath = process.argv[3] || "D:/eMenuBuilder/.env";
const OWNER = process.env.ROLE_CHECK_OWNER || "jaivikveda@gmail.com"; /* kings-kebab */
const USER = "role-check-" + Date.now().toString(36);
const PASS = "RoleCheck!" + Math.random().toString(36).slice(2, 10);

let pass = 0, fail = 0, skip = 0;
function check(name, ok, detail) {
  const tag = ok ? "PASS " : "FAIL ";
  console.log(tag + name + (detail !== undefined && detail !== "" ? "   [" + detail + "]" : ""));
  if (ok) pass++; else fail++;
  return ok;
}
function skip_(name, why) { console.log("SKIP " + name + "   [" + why + "]"); skip++; }

/* --- the env, read without printing any of it ------------------------------ */
let env = {};
try {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) { env = {}; }
const SUPA = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const SECRET = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY || "";
const ANON = env.SUPABASE_ANON_KEY || SECRET;

/** A real session for an existing owner: generate_link, then redeem the token. */
async function mintOwner(email) {
  const made = await fetch(SUPA + "/auth/v1/admin/generate_link", {
    method: "POST",
    headers: { apikey: SECRET, Authorization: "Bearer " + SECRET, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: email })
  }).then((r) => r.json());
  const token = made.email_otp || (made.properties && made.properties.email_otp);
  if (!token) throw new Error("no token: " + JSON.stringify(made).slice(0, 160));
  const sess = await fetch(SUPA + "/auth/v1/verify", {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token: token, email: email })
  }).then((r) => r.json());
  if (!sess.access_token) throw new Error("no session: " + JSON.stringify(sess).slice(0, 160));
  return sess.access_token;
}

const as = (token) => ({ authorization: "Bearer " + token, "content-type": "application/json" });
const call = async (path, opts) => {
  const r = await fetch(ORIGIN + path, opts || {});
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = { _raw: text.slice(0, 120) }; }
  return { status: r.status, body: body };
};

(async () => {
  if (!SUPA || !SECRET) {
    skip_("who may read the order book", "no SUPABASE_URL / SUPABASE_SECRET_KEY in " + envPath);
    console.log("\n0 passed · 0 failed · " + skip + " skipped");
    return;
  }

  let owner;
  try { owner = await mintOwner(OWNER); } catch (e) {
    skip_("who may read the order book", "could not sign in as " + OWNER + ": " + e.message);
    console.log("\n0 passed · 0 failed · " + skip + " skipped");
    return;
  }

  const me = await call("/api/restaurant", { headers: as(owner) });
  check("an owner can read the order book", me.status === 200,
    (await call("/api/orders", { headers: as(owner) })).status);
  const handle = (me.body.restaurant || {}).handle;
  if (!handle) { skip_("the waiter checks", "this owner has no restaurant"); }

  /* --- a real waiter, created the way the dashboard creates one ------------- */
  let waiter = null;
  if (handle) {
    const made = await call("/api/team", {
      method: "POST", headers: as(owner),
      body: JSON.stringify({ action: "create", username: USER, password: PASS, role: "tablet" })
    });
    if (!check("the tablet role can be assigned", made.status === 200 && made.body.ok, JSON.stringify(made.body).slice(0, 110))) {
      skip_("the waiter checks", "could not create one");
    } else {
      const login = await call("/api/team?login=1", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle, username: USER, password: PASS })
      });
      waiter = login.body.session && login.body.session.access_token;
      check("the waiter signs in", !!waiter && login.body.role === "tablet", "role " + login.body.role);
    }
  }

  if (waiter) {
    const list = await call("/api/orders", { headers: as(waiter) });
    check("a waiter cannot read the order book", list.status === 403 && /ROLE/.test(JSON.stringify(list.body)),
      list.status + " " + JSON.stringify(list.body).slice(0, 90));

    const patch = await call("/api/orders", {
      method: "PATCH", headers: as(waiter),
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", status: "confirmed" })
    });
    check("a waiter cannot change an order", patch.status === 403 && /ROLE/.test(JSON.stringify(patch.body)),
      patch.status + " " + JSON.stringify(patch.body).slice(0, 90));

    const own = await call("/api/restaurant", { headers: as(waiter) });
    check("a waiter's role reads back as tablet", own.status === 200 && own.body.role === "tablet", String(own.body.role));

    const team = await call("/api/team", { headers: as(waiter) });
    check("a waiter cannot manage the team", team.status !== 200, "status " + team.status);

    /* --- and the owner still can, so the gate is a gate, not a wall -------- */
    const still = await call("/api/orders", { headers: as(owner) });
    check("the owner still reads the order book", still.status === 200, "status " + still.status);
  }

  /* --- clean up the waiter -------------------------------------------------- */
  if (waiter || handle) {
    const rm = await call("/api/team", {
      method: "POST", headers: as(owner), body: JSON.stringify({ action: "remove", username: USER })
    });
    const gone = await call("/api/team", { headers: as(owner) });
    const left = JSON.stringify(gone.body || "").indexOf(USER) !== -1;
    check("the test waiter is removed afterwards", !left, "remove " + rm.status);
  }

  console.log("\n" + pass + " passed · " + fail + " failed" + (skip ? " · " + skip + " skipped" : ""));
  if (fail) process.exitCode = 1;
})();

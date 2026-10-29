/* Create (or repair) the demo account and fill it with a real menu.
 *
 *   node tools/seed-demo.js [talabat-url]
 *
 * Auth, in order of preference:
 *   1. SUPABASE_SECRET_KEY in .env  -> Admin API creates the user already
 *      confirmed (email_confirm: true). Works whatever the auth settings say.
 *      This key stays on this machine and in the host's env vars. It must
 *      never reach the browser.
 *   2. no secret key -> plain signup. Works only if "Confirm email" is off.
 *      If it is on, the script says so and stops instead of half-seeding.
 *
 * Then: restaurant row -> Talabat import -> categories + items -> publish.
 * Re-running is safe: it reuses the account and the restaurant, and re-imports
 * items on (source, source_id) so you never get duplicates.
 */
const { importTalabat } = require("../api/_lib/talabat");

const DEMO = {
  email: "emenu@ogle.live",
  password: "DigiMenu2026!",
  name: "Demo Owner",
  restaurant: "Spice Route",
  handle: "spice-route",
  whatsapp: "+971525757079",
  orderEmail: "emenu@ogle.live",
  talabat: "https://www.talabat.com/uae/restaurant/757245/godavari-restaurant-al-markaziyah-west?aid=6484"
};

function readEnv() {
  const fs = require("fs");
  const path = require("path");
  const env = {};
  const file = path.join(process.cwd(), ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = readEnv();
const URL_BASE = (env.SUPABASE_URL || "").replace(/\/$/, "");
const ANON = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || "";
const SECRET = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";

function keyKind(k) {
  if (!k) return "none";
  if (k.startsWith("sb_secret")) return "secret";
  if (k.startsWith("sb_publishable")) return "publishable";
  try {
    const payload = JSON.parse(Buffer.from(k.split(".")[1], "base64").toString());
    return payload.role === "service_role" ? "service_role" : "anon";
  } catch (e) {
    return "unknown";
  }
}

async function api(method, path, { body, token, headers } = {}) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: {
      apikey: ANON || SECRET,
      Authorization: "Bearer " + (token || ANON || SECRET),
      "Content-Type": "application/json",
      ...(headers || {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

/* ---------------------------------------------------------------- the user */
async function ensureUser() {
  const kind = keyKind(SECRET);
  if (kind === "secret" || kind === "service_role") {
    // Admin API: create confirmed, or find the existing one and sign in.
    const created = await fetch(URL_BASE + "/auth/v1/admin/users", {
      method: "POST",
      headers: { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: DEMO.email,
        password: DEMO.password,
        email_confirm: true,
        user_metadata: { full_name: DEMO.name, demo: true }
      })
    });
    if (created.status === 200 || created.status === 201) {
      console.log("user: created and confirmed via the Admin API");
    } else {
      const body = await created.text();
      if (!/already|exists|duplicate/i.test(body)) {
        throw new Error("admin create failed: " + created.status + " " + body.slice(0, 200));
      }
      console.log("user: already exists");
      // force-confirm in case an earlier signup left it unverified
      const list = await fetch(URL_BASE + "/auth/v1/admin/users?page=1&per_page=200", {
        headers: { apikey: SECRET, Authorization: "Bearer " + SECRET }
      });
      const users = (await list.json()).users || [];
      const found = users.find((u) => (u.email || "").toLowerCase() === DEMO.email);
      if (found && !found.email_confirmed_at) {
        await fetch(URL_BASE + "/auth/v1/admin/users/" + found.id, {
          method: "PUT",
          headers: { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ email_confirm: true })
        });
        console.log("user: confirmed now");
      }
    }
  } else {
    // the account may already exist and be confirmed: sign in before signing up,
    // otherwise a confirmed user is mistaken for a blocked signup
    const existing = await api("POST", "/auth/v1/token?grant_type=password", {
      body: { email: DEMO.email, password: DEMO.password }
    });
    if (existing.status === 200) {
      console.log("user: already confirmed, signed in");
      return { token: existing.json.access_token, userId: existing.json.user.id };
    }
    if (/not confirmed/i.test(existing.text)) {
      throw new Error(
        DEMO.email + " exists but is not confirmed. Click the confirmation link sent " +
        "to that inbox and re-run, or put the secret key in .env as " +
        "SUPABASE_SECRET_KEY and I will confirm it directly."
      );
    }

    console.log("no secret key — trying a plain signup (needs 'Confirm email' OFF)");
    const r = await api("POST", "/auth/v1/signup", {
      body: { email: DEMO.email, password: DEMO.password, data: { full_name: DEMO.name, demo: true } }
    });
    if (r.status !== 200) throw new Error("signup failed: " + r.status + " " + r.text.slice(0, 200));
    if (!r.json.session) {
      throw new Error(
        "signup created the user but returned no session — 'Confirm email' is ON.\n" +
        "Either turn it off (Authentication → Sign In / Providers → Email) or put the\n" +
        "secret key in .env as SUPABASE_SECRET_KEY and re-run."
      );
    }
    console.log("user: signed up with a session");
    return { token: r.json.access_token, userId: r.json.user.id };
  }

  // sign in with the password to get a normal user token
  const login = await api("POST", "/auth/v1/token?grant_type=password", {
    body: { email: DEMO.email, password: DEMO.password }
  });
  if (login.status !== 200) throw new Error("sign-in failed: " + login.status + " " + login.text.slice(0, 220));
  return { token: login.json.access_token, userId: login.json.user.id };
}

/* --------------------------------------------------------- restaurant + menu */
async function ensureRestaurant(token, userId) {
  const existing = await api(
    "GET",
    `/rest/v1/restaurants?select=id,handle,status&handle=eq.${DEMO.handle}`,
    { token }
  );
  if (existing.status === 200 && existing.json.length) {
    console.log("restaurant: exists (" + existing.json[0].id + ")");
    return existing.json[0].id;
  }

  const created = await api("POST", "/rest/v1/restaurants", {
    token,
    headers: { Prefer: "return=representation" },
    body: {
      owner_id: userId,
      name: DEMO.restaurant,
      owner_name: DEMO.name,
      handle: DEMO.handle,
      purposes: ["Dine In", "Take Away", "Delivery"],
      whatsapp_e164: DEMO.whatsapp,
      order_email: DEMO.orderEmail,
      status: "trial",
      city: "Abu Dhabi"
    }
  });
  if (created.status >= 300) throw new Error("restaurant insert: " + created.status + " " + created.text.slice(0, 240));
  console.log("restaurant: created");
  return created.json[0].id;
}

async function importMenu(token, restaurantId, url) {
  const parsed = await importTalabat(url);
  if (!parsed.ok) throw new Error("import failed: " + parsed.code + " " + parsed.message);
  console.log(`import: ${parsed.categories.length} categories, ${parsed.itemCount} items`);

  // clear the previous demo menu so re-runs stay clean
  await api("DELETE", `/rest/v1/menu_items?restaurant_id=eq.${restaurantId}`, { token });
  await api("DELETE", `/rest/v1/menu_categories?restaurant_id=eq.${restaurantId}`, { token });

  let items = 0;
  for (let i = 0; i < parsed.categories.length; i++) {
    const c = parsed.categories[i];
    const ins = await api("POST", "/rest/v1/menu_categories", {
      token,
      headers: { Prefer: "return=representation" },
      body: { restaurant_id: restaurantId, name: c.name, position: i }
    });
    if (ins.status >= 300) throw new Error("category insert: " + ins.status + " " + ins.text.slice(0, 200));
    const catId = ins.json[0].id;

    const rows = c.items.map((it, j) => ({
      restaurant_id: restaurantId,
      category_id: catId,
      name: it.name,
      description: it.description || null,
      price: it.price == null ? 0 : it.price,
      was_price: it.wasPrice || null,
      image_url: it.image,
      sold_out: false,
      has_choices: !!it.hasChoices,
      position: j,
      source: "talabat",
      source_id: it.sourceId || null
    }));
    const itemIns = await api("POST", "/rest/v1/menu_items", { token, body: rows });
    if (itemIns.status >= 300) throw new Error("item insert: " + itemIns.status + " " + itemIns.text.slice(0, 200));
    items += rows.length;
  }
  console.log(`import: wrote ${items} items`);
  return items;
}

async function publish(token, restaurantId) {
  const r = await api("PATCH", `/rest/v1/restaurants?id=eq.${restaurantId}`, {
    token,
    headers: { Prefer: "return=representation" },
    body: { status: "published", published_at: new Date().toISOString() }
  });
  if (r.status >= 300) throw new Error("publish: " + r.status + " " + r.text.slice(0, 200));
  console.log("restaurant: published");
}

(async () => {
  if (!URL_BASE) throw new Error("SUPABASE_URL missing from .env");
  console.log("project:", URL_BASE, "| anon:", keyKind(ANON), "| secret:", keyKind(SECRET));
  console.log("");

  const { token, userId } = await ensureUser();
  const restaurantId = await ensureRestaurant(token, userId);
  await importMenu(token, restaurantId, process.argv[2] || DEMO.talabat);
  await publish(token, restaurantId);

  console.log("");
  console.log("--------------------------------------------------");
  console.log("demo login :", DEMO.email, "/", DEMO.password);
  console.log("guest menu : https://ogle.live/digimenu/" + DEMO.handle);
  console.log("--------------------------------------------------");
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});

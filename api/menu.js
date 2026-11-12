/**
 * GET /api/menu?handle=spice-route     the guest menu (public)
 * GET /api/menu?mine=1                 the signed-in owner's own menu
 *
 * Public reads only ever return a PUBLISHED restaurant — a trial menu stays
 * invisible, which is the promise made on the sign-up screen.
 *
 * Both shapes are built here rather than read from the table in the browser,
 * so no private column (order_email, licence_url, owner_id) can reach a page
 * whatever the anon-key grants happen to allow.
 */

const { rest, userFromToken, actorRestaurant, bearer, cors, configured } = require("./_lib/db");

/* The whole menu in one deployment slot. Vercel counts top-level functions, not
   files under _lib — so save-menu and menu-edit live there and this file routes
   to them: POST /api/menu?op=save, POST /api/menu?op=edit. */
const saveMenu = require("./_lib/save-menu");
const menuEdit = require("./_lib/menu-edit");

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/**
 * Read a restaurant's menu in the shape both pages render.
 *
 * A dish belongs to its primary category (menu_items.category_id) and may also
 * be listed in others through menu_item_categories. The join table is new, so
 * if it is missing the read still works from the primary category alone.
 */
async function buildMenu(restaurantId) {
  /* 0006 adds is_featured: a deployment can land before the migration is run,
     so fall back to plain menu order instead of taking the page down */
  /* Categories and items do not depend on each other, so ask for both at once —
     each saved round trip is a full hop to Sydney. */
  const catsPromise = (async () => {
    let c = await rest(
      "menu_categories?restaurant_id=eq." + restaurantId +
      "&select=id,name,position,is_featured&order=is_featured.desc,position.asc"
    );
    if (!c.ok) {
      c = await rest(
        "menu_categories?restaurant_id=eq." + restaurantId + "&select=id,name,position&order=position.asc"
      );
    }
    return c;
  })();

  const itemsPromise = rest(
    "menu_items?restaurant_id=eq." + restaurantId +
    "&select=id,category_id,name,description,price,image_url,sold_out,position&order=position.asc"
  );

  const [cats, items] = await Promise.all([catsPromise, itemsPromise]);
  if (!cats.ok || !items.ok) return null;

  const catIds = (cats.data || []).map((c) => c.id);
  let links = [];
  if (catIds.length) {
    const l = await rest(
      "menu_item_categories?select=item_id,category_id&category_id=in.(" + catIds.join(",") + ")"
    );
    if (l.ok) links = l.data || [];   /* a 404 here just means 0005 is not run yet */
  }

  const itemById = new Map((items.data || []).map((it) => [it.id, it]));

  const byCat = new Map();
  const add = (catId, it) => {
    if (!byCat.has(catId)) byCat.set(catId, []);
    const arr = byCat.get(catId);
    if (arr.some((x) => x.id === it.id)) return;
    arr.push({
      id: it.id,
      name: it.name,
      description: it.description || "",
      price: it.price === null ? null : Number(it.price),
      image: it.image_url || null,
      soldOut: Boolean(it.sold_out),
      diet: it.diet || null
    });
  };

  for (const it of items.data || []) add(it.category_id, it);
  for (const link of links) {
    const it = itemById.get(link.item_id);
    if (it) add(link.category_id, it);
  }

  const categories = (cats.data || [])
    .map((c) => ({ id: c.id, name: c.name, featured: Boolean(c.is_featured), items: byCat.get(c.id) || [] }))
    .filter((c) => c.items.length);

  return {
    categories,
    itemCount: categories.reduce((n, c) => n + c.items.length, 0)
  };
}

async function menuHandler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!configured) {
    return res.status(500).json({
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Supabase credentials missing on the server."
    });
  }

  /* ---------------------------------------- the owner's own menu (trial is ok) */
  if (req.query && (req.query.mine === "1" || req.query.mine === "true")) {
    const user = await userFromToken(bearer(req));
    if (!user) {
      return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
    }

    const actor = await actorRestaurant(user, "id,name,handle,status");
    const mineRest = actor && actor.restaurant;
    if (!mineRest) {
      return res.status(200).json({ ok: true, restaurant: null, categories: [], itemCount: 0 });
    }

    const builtOwn = await buildMenu(mineRest.id);
    if (!builtOwn) {
      return res.status(502).json({ ok: false, code: "DB_ERROR", message: "The menu database did not answer." });
    }

    return res.status(200).json({
      ok: true,
      restaurant: mineRest,
      role: actor.role,
      categories: builtOwn.categories,
      itemCount: builtOwn.itemCount
    });
  }

  /* ---------------------------------------------------------- the guest menu */
  /* Two ways to say which restaurant: the address in the path (?handle=), or
     the domain the request arrived on (?host=). A customer's own domain has no
     handle in the URL — the host IS the restaurant. */
  const host = String((req.query && req.query.host) || "")
    .trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  const handle = String((req.query && req.query.handle) || "").trim().toLowerCase();

  let lookup;
  if (!handle && host) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      return res.status(400).json({ ok: false, code: "BAD_HOST", message: "That is not a valid domain." });
    }
    lookup = "custom_domain=eq." + encodeURIComponent(host);
  } else {
    if (!SAFE_HANDLE.test(handle)) {
      return res.status(400).json({ ok: false, code: "BAD_HANDLE", message: "That is not a valid menu address." });
    }
    lookup = "handle=eq." + encodeURIComponent(handle);
  }

  const BASE_COLS = "id,name,handle,purposes,whatsapp_e164,city,accent,logo_url,maps_url";
  const FULL_COLS = BASE_COLS + ",currency,tagline,address_line,instagram,facebook,tiktok,website,cover_url,plan,paid_through,custom_domain,trial_ends,locales";
  const query = (cols) =>
    "restaurants?" + lookup + "&status=eq.published&select=" + cols;

  /* 0004 adds the identity columns; a deployment can land before the migration
     is run, so fall back to the original columns instead of failing the page */
  let found = await rest(query(FULL_COLS));
  if (!found.ok) found = await rest(query(BASE_COLS));
  if (!found.ok) {
    return res.status(502).json({ ok: false, code: "DB_ERROR", message: "The menu database did not answer." });
  }

  const restaurant = Array.isArray(found.data) && found.data[0];
  if (!restaurant) {
    return res.status(404).json({
      ok: false,
      code: "NOT_FOUND",
      message: "No published menu at that address yet."
    });
  }

  const built = await buildMenu(restaurant.id);
  if (!built) {
    return res.status(502).json({ ok: false, code: "DB_ERROR", message: "The menu database did not answer." });
  }

  /* Is this restaurant entitled to take orders? The menu plan is a menu, not a till.
     The columns arrive with 0007 — when they are present we already have them from
     the query above; when they are not, ask once and keep the old behaviour. */
  /* which plans include ordering: "order", and "pro" which has no order cap */
  const ORDERING_PLANS = ["order", "pro"];
  let ordering = true;
  let planSeen = null;
  const hasGateCols = Object.prototype.hasOwnProperty.call(restaurant, "paid_through");
  if (hasGateCols) {
    planSeen = restaurant.plan || "qr";
    const today = new Date().toISOString().slice(0, 10);
    const paid = Boolean(restaurant.paid_through && restaurant.paid_through >= today);
    const onTrial = Boolean(restaurant.trial_ends && restaurant.trial_ends >= today);
    /* the seven free days include ordering, so a new restaurant sees the whole
       product before anybody pays for it */
    ordering = onTrial || (ORDERING_PLANS.indexOf(planSeen) >= 0 && paid);
  } else {
    const gate = await rest("restaurants?handle=eq." + encodeURIComponent(handle) + "&select=plan,paid_through");
    if (gate.ok && (gate.data || [])[0]) {
      const g = gate.data[0];
      planSeen = g.plan || "qr";
      const today = new Date().toISOString().slice(0, 10);
      ordering = ORDERING_PLANS.indexOf(planSeen) >= 0 && Boolean(g.paid_through && g.paid_through >= today);
    }
  }

  /* Arabic, if this restaurant has published any. The read is best-effort:
     a deployment can land before 0015 is run, and a missing table must not
     take the menu down — the guest simply sees English. */
  let ar = { items: new Map(), cats: new Map() };
  if (Array.isArray(restaurant.locales) && restaurant.locales.indexOf("ar") >= 0) {
    const [ti, tc] = await Promise.all([
      rest("menu_item_translations?restaurant_id=eq." + restaurant.id +
        "&locale=eq.ar&status=eq.published&select=item_id,name,description"),
      rest("menu_category_translations?restaurant_id=eq." + restaurant.id +
        "&locale=eq.ar&status=eq.published&select=category_id,name")
    ]);
    if (ti.ok) (ti.data || []).forEach((x) => ar.items.set(x.item_id, x));
    if (tc.ok) (tc.data || []).forEach((x) => ar.cats.set(x.category_id, x));
  }

  /* short on purpose: a sold-out switch flipped mid-service must reach
     guests in seconds, not minutes */
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
  return res.status(200).json({
    ok: true,
    restaurant: {
      name: restaurant.name,
      handle: restaurant.handle,
      purposes: ordering ? (restaurant.purposes || []) : [],
      ordering,
      plan: planSeen,
      whatsapp: restaurant.whatsapp_e164,
      city: restaurant.city || "",
      accent: restaurant.accent || "#f7941d",
      logoUrl: restaurant.logo_url || null,
      mapsUrl: restaurant.maps_url || null,
      currency: restaurant.currency || "AED",
      tagline: restaurant.tagline || null,
      address: restaurant.address_line || null,
      social: {
        instagram: restaurant.instagram || null,
        facebook: restaurant.facebook || null,
        tiktok: restaurant.tiktok || null,
        website: restaurant.website || null
      },
      coverUrl: restaurant.cover_url || null,
      locales: Array.isArray(restaurant.locales) ? restaurant.locales : ["en"]
    },
    categories: withArabic(built.categories, ar),
    itemCount: built.itemCount
  });
};

/* Attach the published Arabic beside the English. The guest page picks a
   language; nothing here decides for it. */
function withArabic(categories, ar) {
  return (categories || []).map((c) => {
    const ct = ar.cats.get(c.id);
    const items = (c.items || []).map((it) => {
      const t = ar.items.get(it.id);
      return t ? Object.assign({}, it, { arName: t.name || "", arDesc: t.description || "" }) : it;
    });
    return ct ? Object.assign({}, c, { arName: ct.name || "", items: items }) : Object.assign({}, c, { items: items });
  });
}

/* One function, three jobs. Everything under ?op= is a write to this menu. */
module.exports = async function route(req, res) {
  const op = String((req.query && req.query.op) || "");
  if (req.method === "POST" && op === "save") return saveMenu(req, res);
  if (req.method === "POST" && op === "edit") return menuEdit(req, res);
  return menuHandler(req, res);
};

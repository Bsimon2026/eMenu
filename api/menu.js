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

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/**
 * Read a restaurant's menu in the shape both pages render.
 *
 * A dish belongs to its primary category (menu_items.category_id) and may also
 * be listed in others through menu_item_categories. The join table is new, so
 * if it is missing the read still works from the primary category alone.
 */
async function buildMenu(restaurantId) {
  const [cats, items] = await Promise.all([
    rest("menu_categories?restaurant_id=eq." + restaurantId + "&select=id,name,position&order=position.asc"),
    rest(
      "menu_items?restaurant_id=eq." + restaurantId +
      "&select=id,category_id,name,description,price,image_url,sold_out,position&order=position.asc"
    )
  ]);
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
    .map((c) => ({ id: c.id, name: c.name, items: byCat.get(c.id) || [] }))
    .filter((c) => c.items.length);

  return {
    categories,
    itemCount: categories.reduce((n, c) => n + c.items.length, 0)
  };
}

module.exports = async function handler(req, res) {
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

    const own = await rest("restaurants?owner_id=eq." + user.id + "&select=id,name,handle,status");
    if (!own.ok) {
      return res.status(502).json({ ok: false, code: "DB_ERROR", message: "The menu database did not answer." });
    }

    const mineRest = (own.data || [])[0];
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
      categories: builtOwn.categories,
      itemCount: builtOwn.itemCount
    });
  }

  /* ---------------------------------------------------------- the guest menu */
  const handle = String((req.query && req.query.handle) || "").trim().toLowerCase();
  if (!SAFE_HANDLE.test(handle)) {
    return res.status(400).json({ ok: false, code: "BAD_HANDLE", message: "That is not a valid menu address." });
  }

  const BASE_COLS = "id,name,handle,purposes,whatsapp_e164,city,accent,logo_url,maps_url";
  const FULL_COLS = BASE_COLS + ",currency,tagline,address_line,instagram,facebook,tiktok,website,cover_url";
  const query = (cols) =>
    "restaurants?handle=eq." + encodeURIComponent(handle) +
    "&status=eq.published&select=" + cols;

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

  /* short on purpose: a sold-out switch flipped mid-service must reach
     guests in seconds, not minutes */
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");
  return res.status(200).json({
    ok: true,
    restaurant: {
      name: restaurant.name,
      handle: restaurant.handle,
      purposes: restaurant.purposes || [],
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
      coverUrl: restaurant.cover_url || null
    },
    categories: built.categories,
    itemCount: built.itemCount
  });
};

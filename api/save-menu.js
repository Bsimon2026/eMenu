/**
 * POST /api/save-menu
 *
 * Replaces the signed-in owner's menu with the categories/items from the
 * import review screen.
 *
 * Auth: the caller's own access token. The restaurant is resolved from that
 * token, never from the request body, so a valid user cannot write into
 * somebody else's menu.
 *
 * Replace, not merge: the import screen shows the whole menu, and a merge
 * would leave behind dishes the owner unticked.
 *
 * Duplicates: delivery platforms repeat dishes inside promo shelves (Talabat's
 * "Offers" mirrors the whole menu). A dish can only live in one category here,
 * so the LAST occurrence wins — the specific category beats the promo shelf,
 * and a shelf left empty disappears. Rows without a source id are never merged.
 */

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

function money(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "METHOD" });
  if (!configured) {
    return res.status(500).json({ ok: false, code: "NOT_CONFIGURED", message: "Supabase credentials missing on the server." });
  }

  const user = await userFromToken(bearer(req));
  if (!user) {
    return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const incoming = (body && Array.isArray(body.categories)) ? body.categories : null;
  if (!incoming || !incoming.length) {
    return res.status(400).json({ ok: false, code: "NO_MENU", message: "There is no menu to save." });
  }

  const found = await rest("restaurants?owner_id=eq." + user.id + "&select=id,handle");
  if (!found.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (found.data || [])[0];
  if (!restaurant) {
    return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Finish the restaurant details first — the menu needs somewhere to live." });
  }

  /* ----------------------------------------------- 1. flatten and validate */
  const flat = [];
  incoming.forEach((cat, ci) => {
    const catName = String((cat && cat.name) || "").trim().slice(0, 60) || "Menu";
    (cat.items || []).forEach((it, ii) => {
      if (!it) return;
      const name = String(it.name || "").trim().slice(0, 120);
      if (!name) return;
      flat.push({
        catName,
        catIndex: ci,
        itemIndex: ii,
        source: ["manual", "photo", "talabat", "noon", "deliveroo", "spreadsheet"].includes(it.source) ? it.source : "manual",
        sourceId: it.sourceId ? String(it.sourceId).slice(0, 80) : null,
        row: {
          restaurant_id: restaurant.id,
          name,
          description: (it.desc || it.description) ? String(it.desc || it.description).slice(0, 400) : null,
          price: money(it.price),
          image_url: it.image ? String(it.image).slice(0, 500) : null,
          sold_out: Boolean(it.soldOut),
          diet: it.diet === "veg" || it.diet === "nonveg" ? it.diet : null
        }
      });
    });
  });

  if (!flat.length) {
    return res.status(400).json({ ok: false, code: "EMPTY", message: "Every dish was empty, so there was nothing to save." });
  }

  /* ------------------------- 2. one row per (source, sourceId): last wins */
  const lastSeen = new Map();
  flat.forEach((entry, i) => {
    if (!entry.sourceId) return;
    lastSeen.set(entry.source + ":" + entry.sourceId, i);
  });

  const kept = flat.filter((entry, i) => {
    if (!entry.sourceId) return true;
    return lastSeen.get(entry.source + ":" + entry.sourceId) === i;
  });

  /* -------------------------------------------- 3. clear, then write cleanly */
  await rest("menu_items?restaurant_id=eq." + restaurant.id, { method: "DELETE" });
  const cleared = await rest("menu_categories?restaurant_id=eq." + restaurant.id, { method: "DELETE" });
  if (!cleared.ok) {
    return res.status(502).json({ ok: false, code: "CLEAR_FAILED", message: "Could not clear the old menu." });
  }

  /* group the surviving rows back into their categories, in original order */
  const groups = new Map();
  for (const entry of kept) {
    if (!groups.has(entry.catName)) groups.set(entry.catName, { order: entry.catIndex, rows: [] });
    groups.get(entry.catName).rows.push(entry.row);
  }
  const ordered = Array.from(groups.entries()).sort((a, b) => a[1].order - b[1].order);

  let itemCount = 0;
  let catCount = 0;

  for (const [catName, group] of ordered) {
    const madeCat = await rest("menu_categories", {
      method: "POST",
      body: { restaurant_id: restaurant.id, name: catName, position: catCount },
      prefer: "return=representation"
    });
    if (!madeCat.ok) {
      return res.status(500).json({
        ok: false,
        code: "CATEGORY_FAILED",
        message: "Failed while saving “" + catName + "”.",
        detail: String(madeCat.data).slice(0, 300)
      });
    }
    const categoryId = (madeCat.data || [])[0].id;
    catCount++;

    const rows = group.rows.map((row, i) => ({ ...row, category_id: categoryId, position: i }));

    const madeItems = await rest("menu_items", { method: "POST", body: rows, prefer: "return=minimal" });
    if (!madeItems.ok) {
      return res.status(500).json({
        ok: false,
        code: "ITEMS_FAILED",
        message: "Failed while saving the dishes in “" + catName + "”.",
        detail: String(madeItems.data).slice(0, 300)
      });
    }
    itemCount += rows.length;
  }

  return res.status(200).json({
    ok: true,
    restaurantId: restaurant.id,
    handle: restaurant.handle,
    categories: catCount,
    items: itemCount,
    duplicatesMerged: flat.length - kept.length
  });
};

/**
 * POST /api/menu-edit
 *
 * Single-item editing after the menu is live: the dashboard changes one dish
 * without resending the whole menu.
 *
 *   { action: "addItem",       categoryId, name, price, description, diet }
 *   { action: "updateItem",    id, name?, price?, description?, soldOut?, diet? }
 *   { action: "deleteItem",    id }
 *   { action: "addCategory",   name }
 *   { action: "renameCategory", id, name }
 *   { action: "deleteCategory", id }
 *
 * Every action resolves the caller's restaurant from their token, then proves
 * the row being touched belongs to that restaurant. A valid session must never
 * be able to edit another restaurant's menu.
 */

const { rest, userFromToken, bearer, cors, configured } = require("./_lib/db");

function money(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
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
  if (!user) return res.status(401).json({ ok: false, code: "NO_SESSION", message: "Sign in again — that session has expired." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !body.action) {
    return res.status(400).json({ ok: false, code: "BAD_BODY", message: "Send { action, … }." });
  }

  const own = await rest("restaurants?owner_id=eq." + user.id + "&select=id");
  if (!own.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
  const restaurant = (own.data || [])[0];
  if (!restaurant) {
    return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Finish the restaurant details first." });
  }
  const rid = restaurant.id;

  const ownsItem = async (id) => {
    if (!id) return null;
    const r = await rest("menu_items?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + rid + "&select=id");
    return r.ok && (r.data || []).length ? r.data[0] : null;
  };
  const ownsCategory = async (id) => {
    if (!id) return null;
    const r = await rest("menu_categories?id=eq." + encodeURIComponent(id) + "&restaurant_id=eq." + rid + "&select=id");
    return r.ok && (r.data || []).length ? r.data[0] : null;
  };

  try {
    switch (body.action) {
      /* ------------------------------------------------------------- dishes */
      case "addItem": {
        const cat = await ownsCategory(body.categoryId);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        const name = String(body.name || "").trim();
        const price = money(body.price);
        if (name.length < 1) return res.status(400).json({ ok: false, code: "NAME", message: "Give the dish a name." });
        if (price === null) return res.status(400).json({ ok: false, code: "PRICE", message: "Give the dish a price." });

        const made = await rest("menu_items", {
          method: "POST",
          prefer: "return=representation",
          body: [{
            restaurant_id: rid,
            category_id: cat.id,
            name: name.slice(0, 120),
            description: body.description ? String(body.description).slice(0, 400) : null,
            price,
            image_url: body.image ? String(body.image).slice(0, 500) : null,
            diet: body.diet === "veg" || body.diet === "nonveg" ? body.diet : null,
            sold_out: Boolean(body.soldOut),
            position: 999,
            source: "manual"
          }]
        });
        if (!made.ok) return res.status(500).json({ ok: false, code: "INSERT_FAILED", detail: String(made.data).slice(0, 200) });
        return res.status(200).json({ ok: true, item: (made.data || [])[0] });
      }

      case "updateItem": {
        const item = await ownsItem(body.id);
        if (!item) return res.status(404).json({ ok: false, code: "NO_ITEM", message: "That dish is not on your menu." });

        const patch = {};
        if (body.name !== undefined) {
          const name = String(body.name).trim();
          if (!name) return res.status(400).json({ ok: false, code: "NAME", message: "A dish needs a name." });
          patch.name = name.slice(0, 120);
        }
        if (body.price !== undefined) {
          const price = money(body.price);
          if (price === null) return res.status(400).json({ ok: false, code: "PRICE", message: "That price is not a number." });
          patch.price = price;
        }
        if (body.description !== undefined) patch.description = body.description ? String(body.description).slice(0, 400) : null;
        if (body.soldOut !== undefined) patch.sold_out = Boolean(body.soldOut);
        if (body.diet !== undefined) patch.diet = (body.diet === "veg" || body.diet === "nonveg") ? body.diet : null;
        if (body.image !== undefined) patch.image_url = body.image ? String(body.image).slice(0, 500) : null;

        if (!Object.keys(patch).length) return res.status(400).json({ ok: false, code: "NO_CHANGES", message: "Nothing to change." });
        patch.updated_at = new Date().toISOString();

        const saved = await rest("menu_items?id=eq." + item.id, { method: "PATCH", body: patch, prefer: "return=representation" });
        if (!saved.ok) return res.status(500).json({ ok: false, code: "PATCH_FAILED", detail: String(saved.data).slice(0, 200) });
        return res.status(200).json({ ok: true, item: (saved.data || [])[0] });
      }

      case "deleteItem": {
        const item = await ownsItem(body.id);
        if (!item) return res.status(404).json({ ok: false, code: "NO_ITEM", message: "That dish is not on your menu." });
        const gone = await rest("menu_items?id=eq." + item.id, { method: "DELETE" });
        if (!gone.ok) return res.status(500).json({ ok: false, code: "DELETE_FAILED" });
        return res.status(200).json({ ok: true, deleted: item.id });
      }

      /* --------------------------------------------------------- categories */
      case "addCategory": {
        const name = String(body.name || "").trim();
        if (name.length < 1) return res.status(400).json({ ok: false, code: "NAME", message: "Give the category a name." });

        const count = await rest("menu_categories?restaurant_id=eq." + rid + "&select=id");
        const position = count.ok ? (count.data || []).length : 0;

        const made = await rest("menu_categories", {
          method: "POST",
          prefer: "return=representation",
          body: [{ restaurant_id: rid, name: name.slice(0, 60), position }]
        });
        if (!made.ok) return res.status(500).json({ ok: false, code: "INSERT_FAILED", detail: String(made.data).slice(0, 200) });
        return res.status(200).json({ ok: true, category: (made.data || [])[0] });
      }

      case "renameCategory": {
        const cat = await ownsCategory(body.id);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });
        const name = String(body.name || "").trim();
        if (!name) return res.status(400).json({ ok: false, code: "NAME", message: "A category needs a name." });
        const saved = await rest("menu_categories?id=eq." + cat.id, {
          method: "PATCH", body: { name: name.slice(0, 60) }, prefer: "return=representation"
        });
        if (!saved.ok) return res.status(500).json({ ok: false, code: "PATCH_FAILED" });
        return res.status(200).json({ ok: true, category: (saved.data || [])[0] });
      }

      case "deleteCategory": {
        const cat = await ownsCategory(body.id);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        const inside = await rest("menu_items?category_id=eq." + cat.id + "&select=id");
        const count = inside.ok ? (inside.data || []).length : 0;
        if (count > 0 && !body.confirm) {
          return res.status(409).json({
            ok: false,
            code: "CATEGORY_NOT_EMPTY",
            message: "That category still has " + count + " dish" + (count === 1 ? "" : "es") + ". Move or delete them first.",
            items: count
          });
        }

        await rest("menu_items?category_id=eq." + cat.id, { method: "DELETE" });
        const gone = await rest("menu_categories?id=eq." + cat.id, { method: "DELETE" });
        if (!gone.ok) return res.status(500).json({ ok: false, code: "DELETE_FAILED" });
        return res.status(200).json({ ok: true, deleted: cat.id, removedItems: count });
      }

      default:
        return res.status(400).json({ ok: false, code: "UNKNOWN_ACTION", message: "Unknown action: " + body.action });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, code: "FAILED", message: String(e.message || e) });
  }
};

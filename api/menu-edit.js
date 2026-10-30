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

      /* ------------------------------------------- one dish, many categories */
      case "linkItem":
      case "addExistingItems": {
        const cat = await ownsCategory(body.categoryId);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        const ids = body.action === "linkItem" ? [body.itemId] : (Array.isArray(body.itemIds) ? body.itemIds : []);
        if (!ids.length) return res.status(400).json({ ok: false, code: "NO_ITEMS", message: "Choose the dishes to add." });

        const rows = [];
        for (const id of ids) {
          const item = await ownsItem(id);
          if (!item) continue;                     /* skip anything not theirs */
          rows.push({ item_id: item.id, category_id: cat.id, position: 0 });
        }
        if (!rows.length) return res.status(404).json({ ok: false, code: "NO_ITEMS", message: "None of those dishes are on your menu." });

        const linked = await rest("menu_item_categories", {
          method: "POST",
          body: rows,
          prefer: "resolution=merge-duplicates,return=minimal"
        });
        if (!linked.ok) {
          return res.status(500).json({
            ok: false,
            code: "LINK_FAILED",
            message: "Could not add those dishes. Has migration 0005 been run?",
            detail: String(linked.data).slice(0, 200)
          });
        }
        return res.status(200).json({ ok: true, linked: rows.length, categoryId: cat.id });
      }

      case "unlinkItem": {
        const cat = await ownsCategory(body.categoryId);
        const item = await ownsItem(body.itemId);
        if (!cat || !item) return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That dish or category is not yours." });

        if (item.category_id === cat.id && !body.confirm) {
          return res.status(409).json({
            ok: false,
            code: "PRIMARY_CATEGORY",
            message: "This is the main category for that dish. Move it to another category instead."
          });
        }

        const gone = await rest(
          "menu_item_categories?item_id=eq." + item.id + "&category_id=eq." + cat.id,
          { method: "DELETE" }
        );
        if (!gone.ok) return res.status(500).json({ ok: false, code: "UNLINK_FAILED" });
        return res.status(200).json({ ok: true, removed: item.id + "/" + cat.id });
      }

      case "setItemCategories": {
        const item = await ownsItem(body.id);
        if (!item) return res.status(404).json({ ok: false, code: "NO_ITEM", message: "That dish is not on your menu." });

        const wanted = Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [];
        const verified = [];
        for (const id of wanted) {
          if (await ownsCategory(id)) verified.push(id);
        }
        if (!verified.length) {
          return res.status(400).json({ ok: false, code: "NO_CATEGORY", message: "Keep at least one category." });
        }

        /* the primary category always stays: it is the dish's home */
        if (verified.indexOf(item.category_id) === -1) verified.unshift(item.category_id);

        const cleared = await rest("menu_item_categories?item_id=eq." + item.id, { method: "DELETE" });
        if (!cleared.ok) return res.status(500).json({ ok: false, code: "CLEAR_FAILED", message: "Has migration 0005 been run?" });

        const rows = verified.map((categoryId, i) => ({ item_id: item.id, category_id: categoryId, position: i }));
        const made = await rest("menu_item_categories", { method: "POST", body: rows, prefer: "return=minimal" });
        if (!made.ok) {
          return res.status(500).json({ ok: false, code: "LINK_FAILED", detail: String(made.data).slice(0, 200) });
        }
        return res.status(200).json({ ok: true, itemId: item.id, categories: verified });
      }

      /* ------------------------------------------------- bulk rows from Excel */
      case "importRows": {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return res.status(400).json({ ok: false, code: "NO_ROWS", message: "The file had no rows." });
        if (rows.length > 800) return res.status(400).json({ ok: false, code: "TOO_MANY", message: "Send 800 rows at a time at most." });

        const existing = await rest("menu_categories?restaurant_id=eq." + rid + "&select=id,name,position");
        if (!existing.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
        const catBy = new Map((existing.data || []).map((c) => [String(c.name).trim().toLowerCase(), c.id]));
        let catPos = (existing.data || []).length;

        const itemsNow = await rest("menu_items?restaurant_id=eq." + rid + "&select=id,category_id,name,price");
        if (!itemsNow.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
        const byNameInCat = new Map();
        for (const it of itemsNow.data || []) {
          byNameInCat.set(it.category_id + "|" + String(it.name).trim().toLowerCase(), it);
        }

        let createdItems = 0;
        let updatedItems = 0;
        let createdCats = 0;

        for (const row of rows) {
          const catName = String((row && row.category) || "").trim().slice(0, 60);
          const name = String((row && row.name) || "").trim().slice(0, 120);
          if (!catName || !name) continue;

          const key = catName.toLowerCase();
          let categoryId = catBy.get(key);
          if (!categoryId) {
            const madeCat = await rest("menu_categories", {
              method: "POST",
              prefer: "return=representation",
              body: [{ restaurant_id: rid, name: catName, position: catPos++ }]
            });
            if (!madeCat.ok) continue;
            categoryId = (madeCat.data || [])[0].id;
            catBy.set(key, categoryId);
            createdCats++;
          }

          const price = money(row.price);
          const existingItem = byNameInCat.get(categoryId + "|" + name.toLowerCase());

          if (existingItem) {
            const patch = {};
            if (price !== null && Number(existingItem.price) !== price) patch.price = price;
            if (row.description) patch.description = String(row.description).slice(0, 400);
            if (Object.keys(patch).length) {
              await rest("menu_items?id=eq." + existingItem.id, { method: "PATCH", body: patch });
              updatedItems++;
            }
            continue;
          }

          const made = await rest("menu_items", {
            method: "POST",
            prefer: "return=representation",
            body: [{
              restaurant_id: rid,
              category_id: categoryId,
              name: name,
              description: row.description ? String(row.description).slice(0, 400) : null,
              price: price === null ? 0 : price,
              diet: row.diet === "veg" || row.diet === "nonveg" ? row.diet : null,
              sold_out: false,
              position: 999,
              source: "spreadsheet"
            }]
          });
          if (made.ok && (made.data || [])[0]) {
            const newItem = (made.data || [])[0];
            createdItems++;
            byNameInCat.set(categoryId + "|" + name.toLowerCase(), newItem);
            await rest("menu_item_categories", {
              method: "POST",
              prefer: "resolution=merge-duplicates,return=minimal",
              body: [{ item_id: newItem.id, category_id: categoryId, position: 0 }]
            });
          }
        }

        return res.status(200).json({
          ok: true,
          createdCategories: createdCats,
          createdItems: createdItems,
          updatedItems: updatedItems
        });
      }

      default:
        return res.status(400).json({ ok: false, code: "UNKNOWN_ACTION", message: "Unknown action: " + body.action });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, code: "FAILED", message: String(e.message || e) });
  }
};

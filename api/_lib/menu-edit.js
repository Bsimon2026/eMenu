/**
 * POST /api/menu?op=edit
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

const { rest, userFromToken, actorRestaurant, can, bearer, cors, configured } = require("./db");
const i18n = require("./i18n");
const { capabilities, PLANS } = require("./plans");

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

  const actor = await actorRestaurant(user, "id,plan,paid_through,trial_ends");
  const restaurant = actor && actor.restaurant;
  if (!restaurant) {
    return res.status(409).json({ ok: false, code: "NO_RESTAURANT", message: "Finish the restaurant details first." });
  }
  const rid = restaurant.id;

  /* QR Menu holds 50 dishes; Pro and Ultra hold no cap, and the free week is
     worth Pro. Checked here because the price list says so and nothing else
     knew it.
     `itemCap` null means no limit. */
  const itemCap = capabilities(restaurant).itemCap;
  const capMessage = () => PLANS.qr.label + " holds " + itemCap + " dishes. " +
    PLANS.order.label + " (AED " + PLANS.order.price.monthly + " a month, or AED " +
    PLANS.order.price.yearly + " a year) has no limit.";
  const countItems = async () => {
    const r = await rest("menu_items?restaurant_id=eq." + rid + "&select=id");
    return r.ok ? (r.data || []).length : 0;
  };
  const refuseCap = () => res.status(402).json({ ok: false, code: "ITEM_CAP", message: capMessage(), cap: itemCap });

  /* The kitchen needs one thing from this endpoint mid-service: the sold-out
     switch. A login with orders-only access may do exactly that and nothing
     else — no renames, no price changes, no deletions. */
  const ordersOnly = !can(actor.role, "menu");
  if (ordersOnly) {
    const keys = Object.keys(body).filter((k) => k !== "action" && k !== "id" && k !== "soldOut");
    const isSoldOut = body.action === "updateItem" && body.soldOut !== undefined && keys.length === 0;
    if (!isSoldOut) {
      return res.status(403).json({
        ok: false, code: "NOT_ALLOWED",
        message: "Your login can change what is sold out, not the menu itself."
      });
    }
  }

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
        if (itemCap != null && (await countItems()) >= itemCap) return refuseCap();

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

      case "setCategoryFeatured": {
        const cat = await ownsCategory(body.id);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        const saved = await rest("menu_categories?id=eq." + cat.id, {
          method: "PATCH",
          body: { is_featured: Boolean(body.featured) },
          prefer: "return=representation"
        });
        if (!saved.ok) {
          return res.status(500).json({
            ok: false,
            code: "PATCH_FAILED",
            message: "Could not change that. Has migration 0006 been run?",
            detail: String(saved.data).slice(0, 200)
          });
        }
        return res.status(200).json({ ok: true, category: (saved.data || [])[0] });
      }

      case "moveCategory": {
        const cat = await ownsCategory(body.id);
        if (!cat) return res.status(404).json({ ok: false, code: "NO_CATEGORY", message: "That category is not on your menu." });

        let all = await rest(
          "menu_categories?restaurant_id=eq." + rid + "&select=id,name,position,is_featured&order=is_featured.desc,position.asc"
        );
        if (!all.ok) {
          /* 0006 not run yet: order without the featured band */
          all = await rest("menu_categories?restaurant_id=eq." + rid + "&select=id,name,position&order=position.asc");
        }
        if (!all.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

        const list = all.data || [];
        const at = list.findIndex((c) => c.id === cat.id);
        const to = body.direction === "up" ? at - 1 : at + 1;
        if (at === -1 || to < 0 || to >= list.length) {
          return res.status(200).json({ ok: true, moved: false });   /* already at the edge */
        }

        /* only swap with a neighbour in the same band: a featured shelf never
           trades places with an ordinary section */
        const a = list[at];
        const b = list[to];
        if (Boolean(a.is_featured) !== Boolean(b.is_featured)) {
          return res.status(200).json({ ok: true, moved: false });
        }

        await rest("menu_categories?id=eq." + a.id, { method: "PATCH", body: { position: b.position } });
        await rest("menu_categories?id=eq." + b.id, { method: "PATCH", body: { position: a.position } });

        return res.status(200).json({ ok: true, moved: true, order: [b.id, a.id] });
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

        /* the plan's dish cap, enforced where dishes are created rather than on
           the file size: re-importing an existing menu creates nothing and must
           keep working on a capped plan */
        let roomLeft = itemCap == null ? Infinity : Math.max(0, itemCap - (await countItems()));
        let overCap = 0;
        const existing = await rest("menu_categories?restaurant_id=eq." + rid + "&select=id,name,position");
        if (!existing.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
        const catBy = new Map((existing.data || []).map((c) => [String(c.name).trim().toLowerCase(), c.id]));
        let catPos = (existing.data || []).length;

        const itemsNow = await rest("menu_items?restaurant_id=eq." + rid + "&select=id,category_id,name,price,image_url");
        if (!itemsNow.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
        const byNameInCat = new Map();
        for (const it of itemsNow.data || []) {
          byNameInCat.set(it.category_id + "|" + String(it.name).trim().toLowerCase(), it);
        }

        /* A dish can sit in more than one category through menu_item_categories,
           and the guest page shows it in each. Without indexing those links, a
           re-import looks for the dish under the second category, misses its
           primary row, and invents a duplicate — which is exactly what a second
           import of the same menu used to do. */
        const catIds = (existing.data || []).map((c) => c.id);
        if (catIds.length) {
          const byId = new Map((itemsNow.data || []).map((it) => [it.id, it]));
          const linksRes = await rest(
            "menu_item_categories?category_id=in.(" + catIds.join(",") + ")&select=item_id,category_id&limit=5000"
          );
          for (const link of (linksRes.ok && linksRes.data) || []) {
            const it = byId.get(link.item_id);
            if (!it) continue;
            const key = link.category_id + "|" + String(it.name).trim().toLowerCase();
            if (!byNameInCat.has(key)) byNameInCat.set(key, it);
          }
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
            /* a re-import may carry a photo for a dish that has none; it must
               never overwrite one the owner chose by hand */
            if (row.image && !existingItem.image_url) patch.image_url = String(row.image).slice(0, 500);
            if (Object.keys(patch).length) {
              await rest("menu_items?id=eq." + existingItem.id, { method: "PATCH", body: patch });
              updatedItems++;
            }
            continue;
          }

          if (roomLeft <= 0) { overCap++; continue; }
          const made = await rest("menu_items", {
            method: "POST",
            prefer: "return=representation",
            body: [{
              restaurant_id: rid,
              category_id: categoryId,
              name: name,
              description: row.description ? String(row.description).slice(0, 400) : null,
              image_url: row.image ? String(row.image).slice(0, 500) : null,
              price: price === null ? 0 : price,
              diet: row.diet === "veg" || row.diet === "nonveg" ? row.diet : null,
              sold_out: false,
              position: 999,
              source: "spreadsheet"
            }]
          });
          if (made.ok && (made.data || [])[0]) {
            roomLeft -= 1;
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
          updatedItems: updatedItems,
          /* rows the plan would not take: the import is not silent about them */
          overCap: overCap,
          cap: itemCap,
          capMessage: overCap ? capMessage() : null
        });
      }

      /* ------------------------------------------------ Arabic drafts
         translateMenu  → machine drafts for every dish and category
         setTranslation → the owner's own text, draft or published
         publishTranslations → every draft becomes visible to guests */

      case "translateMenu": {
        const locale = "ar";
        const it = await rest("menu_items?restaurant_id=eq." + rid + "&select=id,name,description&limit=400");
        const ct = await rest("menu_categories?restaurant_id=eq." + rid + "&select=id,name&limit=100");
        if (!it.ok || !ct.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });

        /* Anything that already has a row is left alone. Pressing Translate a
           second time used to upsert over every row — which silently reset
           published Arabic back to draft and threw away the owner's edits. The
           button now fills gaps and nothing else. */
        const haveItems = await rest("menu_item_translations?restaurant_id=eq." + rid + "&locale=eq." + locale + "&select=item_id");
        const haveCats = await rest("menu_category_translations?restaurant_id=eq." + rid + "&locale=eq." + locale + "&select=category_id");
        if (!haveItems.ok || !haveCats.ok) {
          return res.status(503).json({ ok: false, code: "NO_I18N", message: "Arabic is not switched on yet." });
        }
        const known = new Set((haveItems.data || []).map((x) => x.item_id));
        const knownCats = new Set((haveCats.data || []).map((x) => x.category_id));

        const items = (it.data || []).filter((x) => x.name && !known.has(x.id));
        const cats = (ct.data || []).filter((x) => x.name && !knownCats.has(x.id));

        let drafted = 0;
        for (const chunk of i18n.batches(items, 20)) {
          const t = await i18n.translateChunk(chunk.map((x) => ({ id: x.id, name: x.name, description: x.description || "" })));
          if (!t.ok) {
            return res.status(t.code === "NO_KEY" ? 503 : 502).json({
              ok: false, code: t.code, message: t.message || "The translation did not come back."
            });
          }
          if (!t.items.length) continue;
          const rows = t.items.map((x) => ({
            restaurant_id: rid, item_id: x.id, locale: locale,
            name: x.name, description: x.description || null,
            status: "draft", source: "machine"
          }));
          const w = await rest("menu_item_translations?on_conflict=item_id,locale", {
            method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows
          });
          if (!w.ok) return res.status(503).json({ ok: false, code: "NO_I18N", message: "Arabic is not switched on yet." });
          drafted += rows.length;
        }

        let catDrafted = 0;
        for (const chunk of i18n.batches(cats, 20)) {
          const t = await i18n.translateChunk(chunk.map((x) => ({ id: x.id, name: x.name, description: "" })));
          if (!t.ok) break;   /* dishes already landed; a category retry is the same button */
          if (!t.items.length) continue;
          const rows = t.items.map((x) => ({
            restaurant_id: rid, category_id: x.id, locale: locale,
            name: x.name, status: "draft", source: "machine"
          }));
          const w = await rest("menu_category_translations?on_conflict=category_id,locale", {
            method: "POST", prefer: "resolution=merge-duplicates,return=minimal", body: rows
          });
          if (!w.ok) return res.status(503).json({ ok: false, code: "NO_I18N", message: "Arabic is not switched on yet." });
          catDrafted += rows.length;
        }

        return res.status(200).json({ ok: true, items: drafted, categories: catDrafted, already: known.size + knownCats.size });
      }

      case "setTranslation": {
        const locale = "ar";
        const kind = body.kind === "category" ? "category" : "item";
        const id = String(body.id || "").trim();
        const name = String(body.name || "").trim().slice(0, 200);
        if (!id) return res.status(400).json({ ok: false, code: "NO_ID", message: "Which one?" });
        if (!name) return res.status(400).json({ ok: false, code: "NO_NAME", message: "The Arabic name is empty." });

        /* the row has to be this restaurant's before anything is written */
        const owner = kind === "category" ? "menu_categories" : "menu_items";
        const own = await rest(owner + "?id=eq." + id + "&restaurant_id=eq." + rid + "&select=id");
        if (!own.ok) return res.status(502).json({ ok: false, code: "DB_ERROR" });
        if (!(own.data || []).length) {
          return res.status(404).json({ ok: false, code: "NOT_FOUND", message: "That row is not yours." });
        }

        const row = {
          restaurant_id: rid, locale: locale, name: name,
          status: body.status === "published" ? "published" : "draft",
          source: "owner"
        };
        const table = kind === "category" ? "menu_category_translations" : "menu_item_translations";
        const conflict = kind === "category" ? "category_id,locale" : "item_id,locale";
        row[kind === "category" ? "category_id" : "item_id"] = id;
        if (kind === "item") row.description = String(body.description || "").trim().slice(0, 600) || null;

        const w = await rest(table + "?on_conflict=" + conflict, {
          method: "POST", prefer: "resolution=merge-duplicates,return=representation", body: row
        });
        if (!w.ok) return res.status(503).json({ ok: false, code: "NO_I18N", message: "Arabic is not switched on yet." });
        return res.status(200).json({ ok: true, translation: (w.data || [])[0] || row });
      }

      case "publishTranslations": {
        const locale = "ar";
        const out = [];
        for (const table of ["menu_item_translations", "menu_category_translations"]) {
          const w = await rest(table + "?restaurant_id=eq." + rid + "&locale=eq." + locale + "&status=eq.draft", {
            method: "PATCH", prefer: "return=representation", body: { status: "published", updated_at: new Date().toISOString() }
          });
          if (!w.ok) return res.status(503).json({ ok: false, code: "NO_I18N", message: "Arabic is not switched on yet." });
          out.push((w.data || []).length);
        }

        /* the guest page only asks for Arabic when the restaurant advertises
           it, so publishing is also the moment it is switched on — otherwise
           the owner publishes a menu and nothing changes for the guest */
        const cur = await rest("restaurants?id=eq." + rid + "&select=locales");
        const have = (cur.ok && (cur.data || [])[0] && (cur.data || [])[0].locales) || ["en"];
        if (have.indexOf(locale) < 0 && (out[0] + out[1]) > 0) {
          await rest("restaurants?id=eq." + rid, {
            method: "PATCH", prefer: "return=minimal",
            body: { locales: have.concat([locale]) }
          });
        }

        return res.status(200).json({ ok: true, published: out[0] + out[1] });
      }

      default:
        return res.status(400).json({ ok: false, code: "UNKNOWN_ACTION", message: "Unknown action: " + body.action });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, code: "FAILED", message: String(e.message || e) });
  }
};

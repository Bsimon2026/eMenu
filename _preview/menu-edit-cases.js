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


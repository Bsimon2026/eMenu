  /* ---------------- picker: existing dishes into a category ---------------- */

  function allItemsFlat() {
    const seen = new Map();
    for (const c of menuSource().categories) {
      for (const it of c.items) {
        if (!seen.has(it.id)) seen.set(it.id, { item: it, firstCat: c.name });
      }
    }
    return Array.from(seen.values());
  }

  function categoriesOfItem(itemId) {
    return menuSource().categories.filter((c) => c.items.some((i) => i.id === itemId));
  }

  async function reloadOwnMenu() {
    try {
      const m = await window.Auth.api("/api/menu?mine=1");
      if (!m.ok || !m.data.categories) return false;
      state.menu = {
        categories: m.data.categories.map((c) => ({
          id: c.id,
          name: c.name,
          items: c.items.map((it) => ({
            id: it.id,
            name: it.name,
            desc: it.description || "",
            price: it.price == null ? 0 : it.price,
            diet: it.diet || null,
            image: it.image || null,
            soldOut: !!it.soldOut
          }))
        }))
      };
      save();
      return true;
    } catch (e) {
      return false;
    }
  }

  let pickerCat = null;

  function openPicker(categoryId) {
    pickerCat = categoryId;
    const cat = menuSource().categories.find((c) => c.id === categoryId);
    if (!cat) return;

    const already = new Set(cat.items.map((i) => i.id));
    const pool = allItemsFlat().filter((x) => !already.has(x.item.id));

    $("#pickerTitle").textContent = "Add existing dishes to “" + cat.name + "”";

    if (!pool.length) {
      $("#pickerBody").innerHTML = '<p class="picker-empty">Every dish on your menu is already in this category. Create a new dish instead.</p>';
      $("#pickerAdd").disabled = true;
      $("#pickerCount").textContent = "0 selected";
    } else {
      $("#pickerBody").innerHTML = pool.map((x) => `
        <label class="picker-row">
          <input type="checkbox" data-pick="${x.item.id}">
          <span class="pn">${esc(x.item.name)}</span>
          <span class="pp">${priceLabel(x.item.price)}</span>
          <span class="pc">${esc(x.firstCat)}</span>
        </label>`).join("");
      $("#pickerCount").textContent = "0 selected";
      $("#pickerAdd").disabled = true;
      $$("[data-pick]").forEach((cb) =>
        cb.addEventListener("change", () => {
          const n = $$("[data-pick]").filter((x) => x.checked).length;
          $("#pickerCount").textContent = n + " selected";
          $("#pickerAdd").disabled = n === 0;
        })
      );
    }
    $("#picker").hidden = false;
  }

  $("#pickerClose").addEventListener("click", () => { $("#picker").hidden = true; });
  $("#picker").addEventListener("click", (e) => { if (e.target.id === "picker") $("#picker").hidden = true; });

  $("#pickerAdd").addEventListener("click", async () => {
    const ids = $$("[data-pick]").filter((x) => x.checked).map((x) => x.dataset.pick);
    if (!ids.length || !pickerCat) return;
    const btn = $("#pickerAdd");
    btn.disabled = true;
    btn.textContent = "Adding…";
    const saved = await menuEdit({ action: "addExistingItems", categoryId: pickerCat, itemIds: ids }, ids.length + " dishes added to the category");
    btn.textContent = "Add to category";
    if (saved) {
      $("#picker").hidden = true;
      await reloadOwnMenu();
      renderMenuEditor();
    } else {
      btn.disabled = false;
    }
  });

  /* ---------------- spreadsheet import ---------------- */

  let sheetRows = [];

  function headerKey(h) {
    return String(h || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }

  function rowsFromTable(matrix) {
    if (!matrix || !matrix.length) return [];
    const head = matrix[0].map(headerKey);
    const find = (...names) => {
      for (const n of names) {
        const at = head.indexOf(n);
        if (at !== -1) return at;
      }
      return -1;
    };
    const cCat = find("category", "categoryname", "section");
    const cName = find("itemname", "item", "name", "dish", "dishname");
    const cDesc = find("description", "desc", "details");
    const cPrice = find("price", "amount", "aed", "rate");
    const cDiet = find("diet", "type", "veg");

    if (cCat === -1 || cName === -1) {
      toast("The file needs a Category column and an Item Name column.");
      return [];
    }

    const out = [];
    for (let i = 1; i < matrix.length; i++) {
      const r = matrix[i] || [];
      const category = String(r[cCat] == null ? "" : r[cCat]).trim();
      const name = String(r[cName] == null ? "" : r[cName]).trim();
      if (!category || !name) continue;
      out.push({
        category,
        name,
        description: cDesc === -1 ? "" : String(r[cDesc] == null ? "" : r[cDesc]).trim(),
        price: cPrice === -1 ? 0 : Number(String(r[cPrice]).replace(/[^0-9.]/g, "")) || 0,
        diet: cDiet === -1 ? "" : String(r[cDiet] || "").trim().toLowerCase()
      });
    }
    return out;
  }

  function showSheetPreview(rows) {
    sheetRows = rows;
    const host = $("#sheetPreview");
    if (!rows.length) {
      host.hidden = true;
      $("#sheetAdd").disabled = true;
      return;
    }
    const cats = new Set(rows.map((r) => r.category));
    host.innerHTML =
      '<div class="sheet-summary"><b>' + rows.length + ' rows</b> · ' + cats.size +
      ' categories · first: ' + esc(rows[0].category) + ' → ' + esc(rows[0].name) + '</div>' +
      '<div class="sheet-list">' + rows.slice(0, 8).map((r) =>
        '<div class="sheet-row"><span>' + esc(r.category) + '</span><span>' + esc(r.name) +
        '</span><span>' + priceLabel(r.price) + '</span></div>').join("") +
      (rows.length > 8 ? '<div class="sheet-more">…and ' + (rows.length - 8) + ' more</div>' : "") +
      '</div>';
    host.hidden = false;
    $("#sheetAdd").disabled = false;
  }

  $("#sheetFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const done = (matrix) => showSheetPreview(rowsFromTable(matrix));

    if (/\.csv$/i.test(file.name)) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        done(text.split(/\r?\n/).map((line) => line.split(",").map((c) => c.replace(/^"|"$/g, ""))));
      };
      reader.readAsText(file);
      return;
    }

    if (!window.XLSX) { toast("The spreadsheet reader did not load. Save the file as CSV instead."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        done(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true }));
      } catch (err) {
        toast("That file could not be read. Try .xlsx or CSV.");
      }
    };
    reader.readAsArrayBuffer(file);
  });

  $("#sheetAdd").addEventListener("click", async () => {
    if (!sheetRows.length) return;
    const btn = $("#sheetAdd");
    btn.disabled = true;
    btn.textContent = "Adding…";
    const saved = await menuEdit({ action: "importRows", rows: sheetRows }, null);
    btn.textContent = "Add these dishes";
    if (!saved) { btn.disabled = false; return; }

    toast(saved.createdItems + " dishes added, " + saved.updatedItems + " updated" +
          (saved.createdCategories ? ", " + saved.createdCategories + " new categories" : ""));
    sheetRows = [];
    $("#sheetPreview").hidden = true;
    $("#sheetFile").value = "";
    await reloadOwnMenu();
    renderMenuEditor();
    showView("menu");
  });

  $("#sheetSample").addEventListener("click", () => {
    const rows = [
      ["Category", "Item Name", "Description", "Price", "Diet"],
      ["Starters", "Chicken 65", "Curry leaf chicken, fried green chillies", 34, "nonveg"],
      ["Starters", "Paneer Tikka", "Charred cottage cheese, mint chutney", 32, "veg"],
      ["Main Course", "Butter Chicken", "Slow cooked, makhani sauce", 62, "nonveg"],
      ["Main Course", "Dal Makhni", "Black lentils, 24 hours on charcoal", 38, "veg"],
      ["Breads", "Butter Naan", "", 6, ""],
      ["Desserts", "Gulab Jamun", "With rabdi", 18, ""]
    ];

    if (window.XLSX) {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 16 }, { wch: 24 }, { wch: 42 }, { wch: 8 }, { wch: 8 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Menu");
      XLSX.writeFile(wb, "digimenu-sample-menu.xlsx");
      return;
    }

    const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "digimenu-sample-menu.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

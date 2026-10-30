"""Wire the sheet import, the existing-dish picker and multi-category editing into app.js."""
import pathlib

app = pathlib.Path("assets/app.js")
s = app.read_text(encoding="utf-8")
block = pathlib.Path("_preview/sheet-block.js").read_text(encoding="utf-8")

# 1. the new block goes in before boot
marker = "  /* ---------------- boot ---------------- */"
assert marker in s
s = s.replace(marker, block + "\n" + marker, 1)

# 2. the import tabs need the third panel
old_tabs = '''      $("#tabFile").hidden = b.dataset.tab !== "file";
      $("#tabLink").hidden = b.dataset.tab !== "link";'''
assert old_tabs in s
s = s.replace(old_tabs, '''      $("#tabFile").hidden = b.dataset.tab !== "file";
      $("#tabLink").hidden = b.dataset.tab !== "link";
      const sheet = $("#tabSheet");
      if (sheet) sheet.hidden = b.dataset.tab !== "sheet";''', 1)

# 3. every category gets a way to pull in dishes that already exist
old_bar = '''          <span class="cat-tools">
            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>'''
assert old_bar in s
s = s.replace(old_bar, '''          <span class="cat-tools">
            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>
            ${c.items.length || allItemsFlat().length ? `<button class="btn-quiet" type="button" data-existing="${c.id}" title="Add dishes that already exist">+ Existing</button>` : ""}''', 1)

old_wire = '''    /* ---- add dish ---- */
    $$("[data-add]").forEach((btn) =>
      btn.addEventListener("click", () => addDishRow(btn.dataset.add))
    );'''
assert old_wire in s
s = s.replace(old_wire, old_wire + '''

    /* ---- pull in existing dishes ---- */
    $$("[data-existing]").forEach((btn) =>
      btn.addEventListener("click", () => openPicker(btn.dataset.existing))
    );''', 1)

# 4. the edit form gains category membership
old_fields = '''      <div class="edit-actions">
        <button class="btn btn-brand btn-sm" type="button" data-save>${isNew ? "Add dish" : "Save"}</button>'''
assert old_fields in s
s = s.replace(old_fields, '''      ${isNew ? "" : `<div class="edit-cats">
        <span class="ec-label">Also listed in</span>
        ${menuSource().categories.map((c) => {
          const checked = categoriesOfItem(id).some((x) => x.id === c.id);
          const home = categoriesOfItem(id)[0]; const isHome = home && home.id === c.id;
          return `<label class="ec"><input type="checkbox" data-cat-pick="${c.id}" ${checked ? "checked" : ""} ${isHome ? "disabled checked" : ""}> ${esc(c.name)}${isHome ? " (main)" : ""}</label>`;
        }).join("")}
      </div>`}
      <div class="edit-actions">
        <button class="btn btn-brand btn-sm" type="button" data-save>${isNew ? "Add dish" : "Save"}</button>''', 1)

# 5. saving also records the memberships, then reload the truth from the database
old_commit = '''      save();
      renderMenuEditor();
      renderOverview();
    });
  }'''
assert old_commit in s
s = s.replace(old_commit, '''      if (!isNew) {
        const picked = $$("[data-cat-pick]").filter((x) => x.checked).map((x) => x.dataset.catPick);
        if (picked.length) {
          await menuEdit({ action: "setItemCategories", id, categoryIds: picked });
        }
      }

      await reloadOwnMenu();
      renderMenuEditor();
      renderOverview();
    });
  }''', 1)

app.write_text(s, encoding="utf-8")
print("spliced | picker:", "openPicker" in s, "| sheet:", "sheetSample" in s, "| cats:", "data-cat-pick" in s)

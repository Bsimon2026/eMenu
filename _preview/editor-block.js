  /* ---------------- menu editor ---------------- */

  const CUR_SYMBOL = { USD: "$", EUR: "€", GBP: "£", INR: "₹", PKR: "₨", EGP: "E£" };

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function priceLabel(n) {
    const code = state.currency || "AED";
    const sym = CUR_SYMBOL[code] || code;
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return /^[A-Z]{3}$/.test(sym) ? sym + " " + v : sym + v;
  }

  /* every edit goes to Postgres and only then to the screen */
  async function menuEdit(payload, okMessage) {
    const r = await window.Auth.api("/api/menu-edit", { method: "POST", body: JSON.stringify(payload) });
    if (!r.ok) {
      toast(r.data.message || "That change was not saved.");
      return null;
    }
    if (okMessage) toast(okMessage);
    return r.data;
  }

  function renderMenuEditor() {
    const cats = menuSource().categories;

    const empty = `
      <div class="cat-block">
        <div class="cat-bar">
          <span class="cn">Your menu is empty</span>
          <span class="cc">Add a category, then the dishes</span>
        </div>
      </div>`;

    $("#menuEditor").innerHTML = (cats.length ? cats.map((c) => `
      <div class="cat-block" data-cat="${c.id}">
        <div class="cat-bar">
          <span class="cn">${esc(c.name)}</span>
          <span class="cc">${c.items.length} items · ${c.items.filter((i) => !i.soldOut).length} available</span>
          <span class="cat-tools">
            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>
            <button class="btn-quiet" type="button" data-catdel="${c.id}" title="Delete category">Delete</button>
          </span>
        </div>
        ${c.items.map((it) => `
          <div class="mrow ${it.soldOut ? "is-sold" : ""}" data-row="${it.id}">
            <div>
              <div class="nm">
                ${it.diet ? `<span class="diet ${it.diet === "veg" ? "" : "non"}"></span>` : ""}
                ${esc(it.name)}
              </div>
              <div class="ds">${esc(it.desc || "")}</div>
            </div>
            <div class="pr">${priceLabel(it.price)}</div>
            <span class="row-tools">
              <button class="btn-quiet" type="button" data-edit="${it.id}" title="Edit">Edit</button>
              <button class="btn-quiet danger" type="button" data-del="${it.id}" title="Delete">Delete</button>
              <button class="switch" type="button" role="switch" aria-checked="${!it.soldOut}"
                      aria-label="Available: ${esc(it.name)}" data-toggle="${it.id}"></button>
            </span>
          </div>`).join("")}
      </div>`).join("") : empty) + `
      <div class="cat-add">
        <input class="input" id="newCatName" placeholder="New category, e.g. Desserts" maxlength="60">
        <button class="btn btn-brand btn-sm" type="button" id="addCat">Add category</button>
      </div>`;

    /* ---- sold out switch ---- */
    $$("[data-toggle]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.toggle;
        const item = findItemEverywhere(id);
        if (!item) return;
        const next = !item.soldOut;
        btn.setAttribute("aria-checked", String(!next));
        btn.closest(".mrow").classList.toggle("is-sold", next);
        item.soldOut = next;
        save();
        const saved = await menuEdit({ action: "updateItem", id, soldOut: next });
        if (!saved) { item.soldOut = !next; renderMenuEditor(); return; }
        toast(next ? item.name + " marked sold out" : item.name + " is back on the menu");
        renderOverview();
      })
    );

    /* ---- delete dish ---- */
    $$("[data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.del;
        const item = findItemEverywhere(id);
        if (!item) return;
        if (!confirm("Delete “" + item.name + "” from your menu?")) return;
        const saved = await menuEdit({ action: "deleteItem", id }, "Dish deleted");
        if (saved) removeItemLocally(id);
      })
    );

    /* ---- edit dish ---- */
    $$("[data-edit]").forEach((btn) =>
      btn.addEventListener("click", () => startEdit(btn.closest(".mrow"), btn.dataset.edit))
    );

    /* ---- add dish ---- */
    $$("[data-add]").forEach((btn) =>
      btn.addEventListener("click", () => addDishRow(btn.dataset.add))
    );

    /* ---- delete category ---- */
    $$("[data-catdel]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.catdel;
        const cat = menuSource().categories.find((c) => c.id === id);
        if (!cat) return;
        if (!confirm("Delete the category “" + cat.name + "” and everything in it?")) return;
        const saved = await menuEdit({ action: "deleteCategory", id, confirm: true }, "Category deleted");
        if (saved) {
          state.menu.categories = state.menu.categories.filter((c) => c.id !== id);
          save();
          renderMenuEditor();
        }
      })
    );

    /* ---- add category ---- */
    const addCat = $("#addCat");
    if (addCat) {
      addCat.addEventListener("click", async () => {
        const name = $("#newCatName").value.trim();
        if (!name) { toast("Give the category a name"); return; }
        const saved = await menuEdit({ action: "addCategory", name }, "Category added");
        if (!saved || !saved.category) return;
        state.menu.categories.push({ id: saved.category.id, name: saved.category.name, items: [] });
        save();
        renderMenuEditor();
      });
    }
  }

  function findItemEverywhere(id) {
    for (const c of menuSource().categories) {
      const hit = c.items.find((i) => i.id === id);
      if (hit) return hit;
    }
    return null;
  }

  function removeItemLocally(id) {
    const cats = menuSource().categories;
    for (const c of cats) {
      const at = c.items.findIndex((i) => i.id === id);
      if (at !== -1) { c.items.splice(at, 1); break; }
    }
    state.menu.categories = cats;
    save();
    renderMenuEditor();
    renderOverview();
  }

  /* a row that turns into a form; used for both edit and add */
  function startEdit(row, id, isNew) {
    const item = isNew ? { name: "", desc: "", price: "" } : findItemEverywhere(id);
    if (!item) return;

    row.classList.add("editing");
    row.innerHTML = `
      <div class="edit-fields">
        <input class="input" data-e="name" placeholder="Dish name" value="${esc(item.name)}" maxlength="120">
        <input class="input" data-e="price" placeholder="Price" inputmode="decimal" value="${item.price === "" ? "" : item.price}">
        <input class="input" data-e="desc" placeholder="Description (optional)" value="${esc(item.desc || "")}" maxlength="400">
      </div>
      <div class="edit-actions">
        <button class="btn btn-brand btn-sm" type="button" data-save>${isNew ? "Add dish" : "Save"}</button>
        <button class="btn btn-outline btn-sm" type="button" data-cancel>Cancel</button>
      </div>`;

    const nameIn = row.querySelector('[data-e="name"]');
    if (nameIn) nameIn.focus();

    row.querySelector("[data-cancel]").addEventListener("click", () => {
      if (isNew) row.remove(); else renderMenuEditor();
    });

    row.querySelector("[data-save]").addEventListener("click", async () => {
      const name = row.querySelector('[data-e="name"]').value.trim();
      const price = row.querySelector('[data-e="price"]').value.trim();
      const desc = row.querySelector('[data-e="desc"]').value.trim();
      if (!name) { toast("Give the dish a name"); return; }
      if (price === "" || isNaN(Number(price))) { toast("Give the dish a price"); return; }

      const payload = isNew
        ? { action: "addItem", categoryId: id, name, price: Number(price), description: desc }
        : { action: "updateItem", id, name, price: Number(price), description: desc };

      const saved = await menuEdit(payload, isNew ? "Dish added" : "Dish updated");
      if (!saved) return;

      if (isNew) {
        const cat = menuSource().categories.find((c) => c.id === id);
        if (cat) {
          cat.items.push({
            id: saved.item.id, name: saved.item.name, desc: saved.item.description || "",
            price: Number(saved.item.price), image: saved.item.image_url || null,
            soldOut: !!saved.item.sold_out, diet: saved.item.diet || null
          });
        }
      } else {
        const item2 = findItemEverywhere(id);
        if (item2) {
          item2.name = name;
          item2.price = Number(price);
          item2.desc = desc;
        }
      }
      save();
      renderMenuEditor();
      renderOverview();
    });
  }

  function addDishRow(catId) {
    const block = document.querySelector('[data-cat="' + catId + '"]');
    if (!block) return;
    const row = document.createElement("div");
    row.className = "mrow editing new-row";
    block.appendChild(row);
    startEdit(row, catId, true);
  }

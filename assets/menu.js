/* Guest menu behaviour: render, cart, order type, WhatsApp handoff. */

(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const stored = loadState();
  const restaurant = (stored && stored.restaurant) || {};
  const docs = (stored && stored.docs) || {};

  const name = restaurant.name || DEMO_MENU.restaurant;
  const accent = (stored && stored.accent) || DEMO_MENU.accent;
  const handle = (stored && stored.handle) || DEMO_MENU.handle;
  const whatsapp = (restaurant.whatsapp || DEMO_MENU.whatsapp).replace(/\D/g, "");
  const purposes = (restaurant.purposes && restaurant.purposes.length)
    ? restaurant.purposes
    : ["Dine In", "Take Away"];

  const cats = DEMO_MENU.categories;
  const cart = new Map(); // id -> {item, cat, qty}
  let mode = purposes[0] || "Dine In";
  let table = "";
  let pickup = "";
  let address = "";

  /* ---------- head ---------- */

  document.documentElement.style.setProperty("--brand", accent);
  document.title = name + " — menu";
  $("#restName").textContent = name;
  $("#restMeta").textContent =
    (restaurant.city || DEMO_MENU.city) + " · " + purposes.map((p) => (p === "Dine In" ? "Dine in" : p.toLowerCase())).join(" · ");
  $("#footHandle").textContent = "ogle.live/digimenu/" + handle;

  const logo = $("#restLogo");
  if (docs.logo) {
    logo.innerHTML = '<img src="' + docs.logo + '" alt="">';
  } else {
    const parts = name.trim().split(/\s+/);
    logo.textContent = parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  }

  const waLink = $("#waLink");
  waLink.href = "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent("Hello " + name + ", I'd like to ask about the menu.");

  /* ---------- render menu ---------- */

  const rail = $("#rail");
  rail.innerHTML = cats.map((c) => '<a href="#c-' + c.id + '" data-cat="' + c.id + '">' + c.name + "</a>").join("");

  $("#sections").innerHTML = cats
    .map(
      (c) => `
      <section class="sec" id="c-${c.id}">
        <div class="sec-head">
          <h2>${c.name}</h2>
          <span>${c.items.length} items</span>
        </div>
        ${c.items
          .map(
            (it) => `
          <div class="item">
            <div>
              <div class="nm">
                <span class="diet ${it.diet === "veg" ? "" : "non"}" title="${it.diet === "veg" ? "Vegetarian" : "Non-vegetarian"}"></span>
                ${it.name}
              </div>
              <div class="ds">${it.desc}</div>
            </div>
            <div class="right">
              <div class="pr">AED ${it.price}</div>
              <button class="add" type="button" data-id="${it.id}" data-cat="${c.id}">Add</button>
            </div>
          </div>`
          )
          .join("")}
      </section>`
    )
    .join("");

  $$(".add").forEach((b) =>
    b.addEventListener("click", () => {
      addToCart(b.dataset.id, b.dataset.cat);
      b.classList.add("on");
      b.textContent = "Added";
      setTimeout(() => {
        if (cart.has(b.dataset.id)) { b.textContent = "Add another"; }
        else { b.classList.remove("on"); b.textContent = "Add"; }
      }, 900);
    })
  );

  /* ---------- cart ---------- */

  function findItem(id) {
    for (const c of cats) {
      const it = c.items.find((i) => i.id === id);
      if (it) return { item: it, cat: c };
    }
    return null;
  }

  function addToCart(id, catId) {
    const found = findItem(id);
    if (!found) return;
    const existing = cart.get(id);
    if (existing) existing.qty++;
    else cart.set(id, { item: found.item, cat: found.cat.name, qty: 1 });
    renderCart();
  }

  function changeQty(id, delta) {
    const row = cart.get(id);
    if (!row) return;
    row.qty += delta;
    if (row.qty <= 0) cart.delete(id);
    const btn = $('.add[data-id="' + id + '"]');
    if (btn && !cart.has(id)) { btn.classList.remove("on"); btn.textContent = "Add"; }
    renderCart();
  }

  function totals() {
    let count = 0, sum = 0;
    cart.forEach((r) => { count += r.qty; sum += r.qty * r.item.price; });
    return { count, sum };
  }

  function renderCart() {
    const { count, sum } = totals();
    const body = $("#cartBody");
    const foot = $("#cartFoot");

    if (!count) {
      body.innerHTML = '<p class="cart-empty">Nothing yet. Add a dish and it appears here — no account, no app.</p>';
      foot.innerHTML = '<button class="checkout-btn" type="button" disabled>Review order</button>';
    } else {
      body.innerHTML = Array.from(cart.entries())
        .map(
          ([id, r]) => `
          <div class="crow">
            <span>${r.item.name}</span>
            <span class="qty">
              <button type="button" data-dec="${id}" aria-label="Remove one ${r.item.name}">−</button>
              <span>${r.qty}</span>
              <button type="button" data-inc="${id}" aria-label="Add one ${r.item.name}">+</button>
            </span>
            <span style="font-variant-numeric:tabular-nums">${r.qty * r.item.price}</span>
          </div>`
        )
        .join("");
      foot.innerHTML =
        '<div class="total"><span>Total</span><b>AED ' + sum + "</b></div>" +
        '<button class="checkout-btn" type="button" id="goCheckout">Review order</button>';
      $$("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
      $$("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
      const go = $("#goCheckout");
      if (go) go.addEventListener("click", openSheet);
    }

    $("#cartCount").textContent = count + (count === 1 ? " item" : " items");
    $("#barCount").textContent = count + (count === 1 ? " item" : " items");
    $("#barTotal").textContent = "AED " + sum;
    $("#mobileBar").classList.toggle("on", count > 0);
  }

  $("#barCheckout").addEventListener("click", openSheet);

  /* ---------- sheet ---------- */

  const sheet = $("#sheet");
  const sheetBack = $("#sheetBack");

  function openSheet() {
    if (!totals().count) return;
    renderModeFields();
    renderSheetTotals();
    sheet.classList.add("on");
    sheetBack.classList.add("on");
    setTimeout(() => $("#guestName").focus({ preventScroll: true }), 300);
  }

  function closeSheet() {
    sheet.classList.remove("on");
    sheetBack.classList.remove("on");
  }

  $("#closeSheet").addEventListener("click", closeSheet);
  sheetBack.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  $$("#modeBtns button").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      $$("#modeBtns button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderModeFields();
    })
  );

  function renderModeFields() {
    const host = $("#modeFields");
    if (mode === "Dine In") {
      host.innerHTML = `
        <div class="field">
          <label for="tableNo">Table number <span style="color:var(--brand)">*</span></label>
          <input class="input" id="tableNo" inputmode="numeric" placeholder="e.g. 12" value="${table}">
          <div class="err" id="tableErr">Add the table number printed on your card.</div>
        </div>`;
      $("#tableNo").addEventListener("input", (e) => { table = e.target.value; });
    } else if (mode === "Take Away") {
      const times = ["15 min", "30 min", "45 min", "1 hour"];
      host.innerHTML = `
        <div class="field">
          <label>Ready for pickup <span style="color:var(--brand)">*</span></label>
          <div class="chips" id="pickChips">
            ${times.map((t) => `<button type="button" data-t="${t}" aria-pressed="${pickup === t}">${t}</button>`).join("")}
          </div>
          <div class="err" id="pickErr">Choose when you'll collect the order.</div>
        </div>`;
      $$("#pickChips button").forEach((b) =>
        b.addEventListener("click", () => {
          pickup = b.dataset.t;
          $$("#pickChips button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        })
      );
    } else {
      host.innerHTML = `
        <div class="field">
          <label for="addr">Delivery address <span style="color:var(--brand)">*</span></label>
          <textarea class="input" id="addr" rows="2" placeholder="Building, street, area, landmark">${address}</textarea>
          <div class="err" id="addrErr">We need an address to deliver to.</div>
        </div>`;
      $("#addr").addEventListener("input", (e) => { address = e.target.value; });
    }
  }

  function renderSheetTotals() {
    const { sum } = totals();
    $("#sheetTotals").innerHTML =
      Array.from(cart.values())
        .map((r) => `<div class="rl"><span>${r.qty} × ${r.item.name}</span><span>AED ${r.qty * r.item.price}</span></div>`)
        .join("") + `<div class="rt"><span>Total</span><b>AED ${sum}</b></div>`;
  }

  function err(id, bad) {
    const el = $(id);
    if (el) el.classList.toggle("on", !!bad);
    return !bad;
  }

  function buildMessage(guest) {
    const { sum } = totals();
    const lines = ["*New order — " + name + "*", "Type: " + mode, ""];
    if (mode === "Dine In") lines.push("Table: " + table);
    if (mode === "Take Away") lines.push("Pickup in: " + pickup);
    if (mode === "Delivery") lines.push("Address: " + address.replace(/\s+/g, " ").trim());
    lines.push("Guest: " + guest, "");
    cart.forEach((r) => lines.push(r.qty + " × " + r.item.name + " — AED " + r.qty * r.item.price));
    lines.push("", "Total: AED " + sum, "", "Sent from ogle.live/digimenu/" + handle);
    return lines.join("\n");
  }

  $("#confirmOrder").addEventListener("click", () => {
    let ok = true;
    ok = err("#nameErr", !$("#guestName").value.trim()) && ok;
    if (mode === "Dine In") ok = err("#tableErr", !String(table).trim()) && ok;
    if (mode === "Take Away") ok = err("#pickErr", !pickup) && ok;
    if (mode === "Delivery") ok = err("#addrErr", !address.trim()) && ok;
    if (!ok) return;

    const guest = $("#guestName").value.trim();
    const msg = buildMessage(guest);
    const url = "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent(msg);

    $("#doneWa").href = url;
    $("#doneReceipt").innerHTML =
      `<div class="rl"><span>${mode}${mode === "Dine In" ? " · table " + table : mode === "Take Away" ? " · " + pickup : ""}</span><span>AED ${totals().sum}</span></div>
       <div class="rl muted"><span>${totals().count} item${totals().count === 1 ? "" : "s"} for ${guest}</span><span>${name}</span></div>`;
    $("#doneNext").textContent =
      mode === "Dine In"
        ? "The restaurant replies on WhatsApp to confirm your table order. Payment stays at the table."
        : mode === "Take Away"
        ? "The restaurant confirms the pickup time on WhatsApp. Nothing is charged online."
        : "The restaurant confirms the address and delivery fee on WhatsApp before sending.";

    $("#sheetForm").hidden = true;
    $("#sheetDone").hidden = false;
    window.open(url, "_blank", "noopener");
  });

  $("#doneClose").addEventListener("click", () => {
    $("#sheetDone").hidden = true;
    $("#sheetForm").hidden = false;
    closeSheet();
  });

  /* ---------- rail active state ---------- */

  const links = $$("#rail a");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          const id = en.target.id.replace("c-", "");
          links.forEach((a) => a.classList.toggle("on", a.dataset.cat === id));
        }
      });
    },
    { rootMargin: "-56px 0px -70% 0px" }
  );
  $$(".sec").forEach((s) => observer.observe(s));

  renderCart();
})();

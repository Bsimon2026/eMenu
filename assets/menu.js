/* Guest menu: render, sold-out handling, cart, order type, WhatsApp handoff. */

(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const params = new URLSearchParams(location.search);
  const embed = params.get("embed") === "1";
  if (embed) {
    document.body.classList.add("embed");
    document.documentElement.classList.add("embed-root");
  }

  const stored = loadState();

  /* the handle can arrive as ?r=<handle> or as /digimenu/<handle> (vercel.json rewrite) */
  const pathHandle = (location.pathname.match(/\/digimenu\/([a-z0-9][a-z0-9-]*)\/?$/i) || [])[1] || null;
  const urlHandle = String(params.get("r") || pathHandle || "").toLowerCase() || null;

  /* a link for restaurant A must not borrow the saved data of restaurant B */
  const mine = stored && (!urlHandle || stored.handle === urlHandle);
  const restaurant = (mine && stored.restaurant) || {};
  const docs = (mine && stored.docs) || {};

  const PUBLIC_BASE = /^(www\.)?ogle\.live$/i.test(location.hostname)
    ? "https://ogle.live/digimenu/"
    : location.origin + "/digimenu/";

  const name = restaurant.name || DEMO_MENU.restaurant;
  const accent = (mine && stored.accent) || "#f7941d";
  const handle = urlHandle || (stored && stored.handle) || DEMO_MENU.handle;
  const publicLink = PUBLIC_BASE.replace(/^https?:\/\//i, "") + handle;
  const whatsapp = (restaurant.whatsapp || DEMO_MENU.whatsapp).replace(/\D/g, "");
  const purposes = (restaurant.purposes && restaurant.purposes.length)
    ? restaurant.purposes
    : ["Dine In", "Take Away"];

  const cats = (mine && stored.menu && stored.menu.categories) || DEMO_MENU.categories;
  const cart = new Map();
  let mode = purposes[0] || "Dine In";
  let table = "";
  let pickup = "";
  let address = "";

  /* ---------- head ---------- */

  document.title = name + " — menu";
  $("#restName").textContent = name;
  $("#restMeta").textContent =
    (restaurant.city || DEMO_MENU.city) + " · " +
    purposes.map((p) => (p === "Dine In" ? "Dine in" : p === "Take Away" ? "Takeaway" : "Delivery")).join(" · ");
  $("#footHandle").textContent = publicLink;

  const logo = $("#restLogo");
  if (docs.logo) {
    logo.innerHTML = '<img src="' + docs.logo + '" alt="">';
  } else {
    const parts = name.trim().split(/\s+/);
    logo.textContent = parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
  }

  $("#waLink").href = "https://wa.me/" + whatsapp + "?text=" +
    encodeURIComponent("Hello " + name + ", I have a question about the menu.");

  /* ---------- render ---------- */

  const rail = $("#rail");
  rail.innerHTML = cats.map((c) =>
    '<a href="#c-' + c.id + '" data-cat="' + c.id + '">' + c.name + "</a>").join("");

  $("#sections").innerHTML = cats.map((c) => {
    const available = c.items.filter((i) => !i.soldOut).length;
    return `
      <section class="sec" id="c-${c.id}">
        <div class="sec-head">
          <h2>${c.name}</h2>
          <span>${available} of ${c.items.length} available</span>
        </div>
        <div class="items">
          ${c.items.map((it) => `
            <div class="item ${it.soldOut ? "sold" : ""}" data-id="${it.id}">
              <div>
                <div class="nm">
                  <span class="diet ${it.diet === "veg" ? "" : "non"}" title="${it.diet === "veg" ? "Vegetarian" : "Non-vegetarian"}"></span>
                  ${it.name}
                </div>
                <div class="ds">${it.desc}</div>
              </div>
              <div class="right">
                <div class="pr">AED ${it.price}</div>
                ${it.soldOut
                  ? '<span class="sold-tag">Sold out</span>'
                  : `<button class="add" type="button" data-id="${it.id}" data-cat="${c.id}">Add</button>`}
              </div>
            </div>`).join("")}
        </div>
      </section>`;
  }).join("");

  $$(".add").forEach((b) =>
    b.addEventListener("click", () => {
      addToCart(b.dataset.id);
      b.classList.add("on");
      b.textContent = "Added";
      setTimeout(() => {
        b.textContent = cart.has(b.dataset.id) ? "Add another" : "Add";
        if (!cart.has(b.dataset.id)) b.classList.remove("on");
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

  function addToCart(id) {
    const found = findItem(id);
    if (!found || found.item.soldOut) return;
    const existing = cart.get(id);
    if (existing) existing.qty++;
    else cart.set(id, { item: found.item, cat: found.cat.name, qty: 1 });
    renderCart();
  }

  function changeQty(id, delta) {
    const row = cart.get(id);
    if (!row) return;
    row.qty += delta;
    if (row.qty <= 0) {
      cart.delete(id);
      const btn = $('.add[data-id="' + id + '"]');
      if (btn) { btn.classList.remove("on"); btn.textContent = "Add"; }
    }
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
      body.innerHTML = '<p class="cart-empty">Nothing added yet. Tap Add on a dish and it appears here.</p>';
      foot.innerHTML = '<button class="checkout-btn" type="button" disabled>Review order</button>';
    } else {
      body.innerHTML = Array.from(cart.entries()).map(([id, r]) => `
        <div class="crow">
          <span class="cn">${r.item.name}</span>
          <span class="qty">
            <button type="button" data-dec="${id}" aria-label="Remove one ${r.item.name}">−</button>
            <span>${r.qty}</span>
            <button type="button" data-inc="${id}" aria-label="Add one ${r.item.name}">+</button>
          </span>
          <span style="font-variant-numeric:tabular-nums">${r.qty * r.item.price}</span>
        </div>`).join("");
      foot.innerHTML =
        '<div class="cart-total"><span>Total</span><b>AED ' + sum + "</b></div>" +
        '<button class="checkout-btn" type="button" id="goCheckout">Review order</button>';
      $$("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
      $$("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
      $("#goCheckout").addEventListener("click", openSheet);
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
    setTimeout(() => $("#guestName").focus({ preventScroll: true }), 260);
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
          <label for="tableNo">Table number <span style="color:var(--danger)">*</span></label>
          <input class="input" id="tableNo" inputmode="numeric" placeholder="Printed on your table card" value="${table}">
          <div class="err" id="tableErr">Add the table number printed on your card.</div>
        </div>`;
      $("#tableNo").addEventListener("input", (e) => { table = e.target.value; });
    } else if (mode === "Take Away") {
      const times = ["15 min", "30 min", "45 min", "1 hour"];
      host.innerHTML = `
        <div class="field">
          <label>Ready for pickup <span style="color:var(--danger)">*</span></label>
          <div class="chips" id="pickChips">
            ${times.map((t) => `<button type="button" data-t="${t}" aria-pressed="${pickup === t}">${t}</button>`).join("")}
          </div>
          <div class="err" id="pickErr">Choose when you will collect the order.</div>
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
          <label for="addr">Delivery address <span style="color:var(--danger)">*</span></label>
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
        .map((r) => `<div class="ol-row"><span>${r.qty} × ${r.item.name}</span><span>AED ${r.qty * r.item.price}</span></div>`)
        .join("") + `<div class="ol-row total"><span>Total</span><span>AED ${sum}</span></div>`;
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
    lines.push("", "Total: AED " + sum, "", "Sent from " + publicLink);
    return lines.join("\n");
  }

  function recordOrder(guest, msg) {
    try {
      const key = "digimenu.orders.v1";
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      list.unshift({
        ts: Date.now(),
        mode: mode,
        guest: guest,
        table: table,
        pickup: pickup,
        address: address,
        total: totals().sum,
        count: totals().count,
        items: Array.from(cart.values()).map((r) => ({ name: r.item.name, qty: r.qty, price: r.item.price })),
        message: msg
      });
      localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
    } catch (e) { /* storage full or blocked */ }
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
    recordOrder(guest, msg);

    const place = mode === "Dine In" ? "table " + table : mode === "Take Away" ? pickup : "Delivery";
    $("#doneWa").href = url;
    $("#doneReceipt").innerHTML =
      `<div class="ol-row"><span>${mode} · ${place}</span><span>AED ${totals().sum}</span></div>` +
      `<div class="ol-row"><span>${totals().count} item${totals().count === 1 ? "" : "s"} for ${guest}</span><span>${name}</span></div>`;
    $("#doneNext").textContent =
      mode === "Dine In"
        ? "The restaurant confirms your table order on WhatsApp. Payment stays at the table."
        : mode === "Take Away"
        ? "The restaurant confirms the pickup time on WhatsApp. Nothing is charged online."
        : "The restaurant confirms the address and delivery charge on WhatsApp before sending.";

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
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const id = en.target.id.replace("c-", "");
            links.forEach((a) => a.classList.toggle("on", a.dataset.cat === id));
          }
        });
      },
      { rootMargin: "-60px 0px -70% 0px" }
    );
    $$(".sec").forEach((s) => observer.observe(s));
  }

  renderCart();
})();

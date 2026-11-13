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

  /* the handle arrives as ?r=<handle>, as /digimenu/<handle> on the old host,
     or as /<handle> at the root of the Vercel deployment */
  const RESERVED = { login: 1, app: 1, menu: 1, assets: 1, api: 1 };
  const seg = (location.pathname.match(/^\/([a-z0-9][a-z0-9-]*)\/?$/i) || [])[1];
  const sub = (location.pathname.match(/^\/digimenu\/([a-z0-9][a-z0-9-]*)\/?$/i) || [])[1];
  const pathHandle = (seg && !RESERVED[seg.toLowerCase()]) ? seg : (sub || null);
  const urlHandle = String(params.get("r") || pathHandle || "").toLowerCase() || null;

  /* On a restaurant's own domain there is no handle in the URL — the host is
     the restaurant. Anything that is not one of ours is looked up by domain. */
  const OUR_HOST = /^(www\.)?(digimenu\.indubaicity\.com|digimenu[-a-z0-9]*\.vercel\.app)$/i;
  const hostName = location.hostname.replace(/^www\./i, "").toLowerCase();
  const hostLookup = (!urlHandle && !OUR_HOST.test(location.hostname)) ? hostName : "";

  const PUBLIC_BASE = (function () {
    const cfg = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.publicBase) || "";
    if (cfg) return cfg.replace(/\/?$/, "/");
    /* no pinned domain: print the address the page is actually served from,
       keeping the /digimenu prefix if this copy lives in that subfolder */
    return location.origin + (/^\/digimenu/.test(location.pathname) ? "/digimenu/" : "/");
  })();

  /* Filled from /api/menu before the first paint: the database decides what
     this page shows, so the same link looks the same on every phone. */
  let restaurant = {};
  let docs = { logo: null };
  let name = "";
  let accent = "#f0485f";
  let handle = urlHandle || "";
  let publicLink = "";
  let whatsapp = "";
  let purposes = ["Dine In", "Take Away"];
  /* which language the guest reads the menu in, and what is on offer */
  let LANG = (function () {
    try { return localStorage.getItem("dm.lang") === "ar" ? "ar" : "en"; } catch (e) { return "en"; }
  })();
  let LOCALES = ["en"];
  let cats = [];

  /* the restaurant picks its currency once; every price uses it */
  const SYMBOL = { USD: "$", EUR: "€", GBP: "£", INR: "₹", PKR: "₨", EGP: "E£" };
  let currency = "AED";
  function money(n) {
    const sym = SYMBOL[currency] || currency;
    const raw = Math.round((Number(n) || 0) * 100) / 100;
    /* a price is money, not a number: 41.6 prints as "41.60", 60 stays "60" */
    const v = Number.isInteger(raw) ? String(raw) : raw.toFixed(2);
    return /^[A-Z]{3}$/.test(sym) ? sym + " " + v : sym + v;
  }
  /* Thumbs load when their card comes near the viewport. `loading="lazy"` was
     not enough: inside a horizontal shelf the browser counted every card as
     close, asked for all 114 at once, and the first shelf waited behind them. */
  let thumbIO = null;
  function wireThumbs() {
    const imgs = Array.prototype.slice.call(document.querySelectorAll(".item .thumb[data-src]"));
    if (!imgs.length) return;
    if (!("IntersectionObserver" in window)) {
      imgs.forEach(function (i) { i.src = i.dataset.src; i.removeAttribute("data-src"); });
      return;
    }
    if (!thumbIO) {
      thumbIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          const img = e.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute("data-src");
          }
          thumbIO.unobserve(img);
        });
      }, { rootMargin: "320px 320px" });
    }
    imgs.forEach(function (i) { thumbIO.observe(i); });
  }

  /* the CDN serves the original unless asked for a width: a menu page with 40
     dishes would pull tens of megabytes on mobile data without this */
  function sized(url, w) {
    if (!url) return url;
    if (!/talabat\.dhmedia\.io/i.test(url)) return url;
    return url + (url.indexOf("?") === -1 ? "?" : "&") + "width=" + w;
  }

  /* Arabic where it exists, English where it does not — never a blank row */
  /* two-word UI strings; the menu data itself comes from the API */
  function T(en, ar) { return LANG === "ar" ? ar : en; }

  /* The static shell — headings, the picker's label, the two hero buttons that
     are words rather than brands — swapped once per paint. */
  function chrome() {
    const pick = document.querySelector(".cat-pick > span");
    if (pick) pick.textContent = T("Jump to", "انتقل إلى");

    const cartH = document.querySelector(".cart h3");
    if (cartH) {
      const em = cartH.querySelector("em");
      cartH.textContent = T("Your order ", "طلبك ");
      if (em) cartH.appendChild(em);
    }
    const call = document.querySelector("#heroCall span");
    if (call) call.textContent = T("Call", "اتصال");
    const web = document.querySelector("#heroWeb span");
    if (web) web.textContent = T("Website", "الموقع");
    const catLabel = document.querySelector('label.cat-pick');
    if (catLabel) catLabel.setAttribute("aria-label", T("Menu categories", "أقسام القائمة"));
  }

  function nm(x) {
    return (LANG === "ar" && x && x.arName) ? x.arName : ((x && x.name) || "");
  }
  function ds(x) {
    return (LANG === "ar" && x && x.arDesc) ? x.arDesc : ((x && x.desc) || "");
  }

  function setLang(l) {
    LANG = l === "ar" ? "ar" : "en";
    try { localStorage.setItem("dm.lang", LANG); } catch (e) { /* private mode */ }
    document.documentElement.lang = LANG;
    document.documentElement.dir = LANG === "ar" ? "rtl" : "ltr";
    const sw = $("#langSwitch");
    if (sw) Array.from(sw.querySelectorAll("[data-lang]")).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === LANG));
    });
    paint();
    /* paint() rebuilds every card, so each switch hands over a fresh set of
       thumbs that nobody is watching — the photos would simply not come back */
    wireThumbs();
    chrome();
  }

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  const cart = new Map();
  let mode = purposes[0] || "Dine In";
  let table = "";
  let pickup = "";
  let address = "";

  function paint() {
  /* ---------- head ---------- */

  /* The ground the shelves sit on. Charcoal by default: the menu is mostly
     photographs and a dark page stops the paper competing with them. The
     marketing page embeds this menu in a phone frame, and there it stays light
     so the landing hero does not turn black. */
  if (!document.body.classList.contains("embed")) document.documentElement.classList.add("t-dark");

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
    '<a href="#c-' + c.id + '" data-cat="' + c.id + '"' + (c.featured ? ' class="feat"' : "") + ">" +
    (c.featured ? '<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17.3-6.2 3.7 1.7-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.5 4.8 1.7 7z"/></svg> ' : "") + esc(nm(c)) + "</a>").join("");

  /* On a phone the chips are replaced by this picker: fifteen categories in a
     single scrolling row means dragging sideways past most of the menu. */
  const catSel = $("#catSelect");
  if (catSel) {
    catSel.innerHTML = cats.map((c) =>
      '<option value="' + esc(c.id) + '">' + esc(nm(c)) + "</option>").join("");
  }

  $("#sections").innerHTML = cats.map((c) => {
    const available = c.items.filter((i) => !i.soldOut).length;
    return `
      <section class="sec${c.featured ? " featured" : ""}" id="c-${c.id}">
        <div class="sec-head">
          <h2>${c.featured ? '<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 17.3-6.2 3.7 1.7-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.5 4.8 1.7 7z"/></svg> ' : ""}${esc(nm(c))}</h2>
          <span>${available === c.items.length
            ? (LANG === "ar" ? c.items.length + (c.items.length === 1 ? " \u0637\u0628\u0642" : " \u0623\u0637\u0628\u0627\u0642") : c.items.length + (c.items.length === 1 ? " dish" : " dishes"))
            : (LANG === "ar" ? available + " \u0645\u0646 " + c.items.length + " \u0645\u062a\u0648\u0641\u0631" : available + " of " + c.items.length + " available")}</span>
        </div>
        <div class="items">
          ${(() => {
            const sectionHasImg = c.items.some((x) => x.image);
            return c.items.map((it) => {
              const col = it.image ? "has-img" : sectionHasImg ? "has-img" : "";
              return `
            <div class="item ${it.soldOut ? "sold" : ""} ${col}" data-id="${it.id}">
              ${it.image
                ? `<img class="thumb loading" data-src="${sized(it.image, 320)}" alt="" referrerpolicy="no-referrer" onload="this.classList.remove('loading')" onerror="this.classList.add('ph'); this.removeAttribute('src')">`
                : sectionHasImg ? `<div class="thumb ph" aria-hidden="true"></div>` : ""}
              <div>
                <div class="nm">
                  ${it.diet ? `<span class="diet ${it.diet === "veg" ? "" : "non"}" title="${it.diet === "veg" ? "Vegetarian" : "Non-vegetarian"}"></span>` : ""}
                  ${esc(nm(it))}
                </div>
                <div class="ds">${esc(ds(it))}</div>
              </div>
              <div class="right">${rightCell(it, c.id)}</div>
            </div>`;
            }).join("");
          })()}
        </div>
      </section>`;
  }).join("");

  document.getElementById("sections").addEventListener("click", (e) => {
    const add = e.target.closest("[data-id].add");
    if (add) { addToCart(add.dataset.id); syncItemRow(add.dataset.id); return; }
    const plus = e.target.closest("[data-step-plus]");
    if (plus) { changeQty(plus.getAttribute("data-step-plus"), 1); syncItemRow(plus.getAttribute("data-step-plus")); return; }
    const minus = e.target.closest("[data-step-minus]");
    if (minus) { changeQty(minus.getAttribute("data-step-minus"), -1); syncItemRow(minus.getAttribute("data-step-minus")); }
  });

  /* ---------- cart ---------- */

  function findItem(id) {
    for (const c of cats) {
      const it = c.items.find((i) => i.id === id);
      if (it) return { item: it, cat: c };
    }
    return null;
  }

  /* The right of a dish row answers one question: how many of this did I add?
     It used to say "Add" forever, so a mis-tap twice could only be undone from
     the cart — on a phone, behind another tap. It becomes a stepper the moment
     the count is above zero, and the count is on the row. */
  function rightCell(it, catId) {
    const q = (cart.get(it.id) || {}).qty || 0;
    const price = '<div class="pr">' + money(it.price) + '</div>';
    if (it.soldOut) return price + '<span class="sold-tag">' + T("Sold out", "\u0646\u0641\u062f") + '</span>';
    if (!q) {
      return price + '<button class="add" type="button" data-id="' + it.id +
        '" data-cat="' + catId + '">' + T("Add", "\u0623\u0636\u0641") + '</button>';
    }
    return price +
      '<div class="steps" role="group" aria-label="' + esc(it.name) + '">' +
        '<button class="step" type="button" data-step-minus="' + it.id + '" aria-label="' + T("One less", "\u0648\u0627\u062d\u062f \u0623\u0642\u0644") + '">\u2212</button>' +
        '<b class="qn" aria-live="polite">' + q + '</b>' +
        '<button class="step on" type="button" data-step-plus="' + it.id + '" aria-label="' + T("One more", "\u0648\u0627\u062d\u062f \u0623\u0643\u062b\u0631") + '">+</button>' +
      '</div>';
  }

  /* repaint one row's cell without touching the rest of the list */
  function syncItemRow(id) {
    const row = document.querySelector('.item[data-id="' + id + '"]');
    const found = findItem(id);
    if (!row || !found) return;
    const cell = row.querySelector(".right");
    if (cell) cell.innerHTML = rightCell(found.item, found.cat.id);
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
    if (row.qty <= 0) cart.delete(id);
    renderCart();
    syncItemRow(id);
  }

  function totals() {
    let count = 0, sum = 0;
    cart.forEach((r) => { count += r.qty; sum += r.qty * r.item.price; });
    return { count, sum };
  }

  /* The code the guest applied. The percentage and the cap come from the
     server; the amount is recomputed here whenever the cart changes, so adding
     a dish after applying a code never discounts more than the code allows. */
  let applied = null;

  function discountNow() {
    if (!applied) return { amount: 0, total: totals().sum };
    const { sum } = totals();
    let amount = sum * (applied.percent / 100);
    if (applied.maxAmount) amount = Math.min(amount, applied.maxAmount);
    amount = Math.min(Math.round(amount * 100) / 100, sum);
    return { amount, total: Math.round((sum - amount) * 100) / 100 };
  }

  function renderCart() {
    const { count, sum } = totals();
    const body = $("#cartBody");
    const foot = $("#cartFoot");

    if (!count) {
      body.innerHTML = '<p class="cart-empty">' +
        T("Nothing added yet. Tap Add on a dish and it appears here.", "لم تُضف شيئاً بعد. اضغط أضف على أي طبق.") + '</p>';
      foot.innerHTML = '<button class="checkout-btn" type="button" disabled>' + T("Review order", "مراجعة الطلب") + '</button>';
    } else {
      body.innerHTML = Array.from(cart.entries()).map(([id, r]) => `
        <div class="crow">
          <span class="cn">${r.item.name}</span>
          <span class="qty">
            <button type="button" data-dec="${id}" aria-label="Remove one ${r.item.name}">−</button>
            <span>${r.qty}</span>
            <button type="button" data-inc="${id}" aria-label="Add one ${r.item.name}">+</button>
          </span>
          <span style="font-variant-numeric:tabular-nums">${money(r.qty * r.item.price)}</span>
        </div>`).join("");
      foot.innerHTML =
        '<div class="cart-total"><span>Total</span><b>' + money(sum) + "</b></div>" +
        '<button class="checkout-btn" type="button" id="goCheckout">' + T("Review order", "مراجعة الطلب") + '</button>';
      $$("[data-inc]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.inc, 1)));
      $$("[data-dec]").forEach((b) => b.addEventListener("click", () => changeQty(b.dataset.dec, -1)));
      $("#goCheckout").addEventListener("click", openSheet);
    }

    const countWords = LANG === "ar"
      ? (count + " \u0639\u0646\u0635\u0631")
      : (count + (count === 1 ? " item" : " items"));
    $("#cartCount").textContent = countWords;
    $("#barCount").textContent = countWords;
    $("#barTotal").textContent = money(sum);
    $("#mobileBar").classList.toggle("on", count > 0);
  }

  $("#barCheckout").addEventListener("click", openSheet);

  /* ---------- sheet ---------- */

  const sheet = $("#sheet");
  const sheetBack = $("#sheetBack");

  function openSheet() {
    /* the confirm button is disabled after a successful send; opening the
       sheet again is a new order and it must be pressable */
    const cb = $("#confirmOrder");
    if (cb) cb.disabled = false;
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
          <label>When will you Pick Up <span style="color:var(--danger)">*</span></label>
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
    const d = discountNow();
    /* Every line carries its own quantity and a way out of the order: a guest
       who tapped Add twice should not have to go back and find the dish. */
    const lines = Array.from(cart.entries())
      .map(([id, r]) => `
        <div class="ol-row line">
          <span class="ol-nm">${esc(r.item.name)}</span>
          <span class="ol-qty">
            <button class="sstep" type="button" data-sheet-minus="${id}" aria-label="${T("One less", "\u0648\u0627\u062d\u062f \u0623\u0642\u0644")}">−</button>
            <b>${r.qty}</b>
            <button class="sstep" type="button" data-sheet-plus="${id}" aria-label="${T("One more", "\u0648\u0627\u062d\u062f \u0623\u0643\u062b\u0631")}">+</button>
          </span>
          <span class="ol-pr">${money(r.qty * r.item.price)}</span>
          <button class="ol-del" type="button" data-sheet-del="${id}" aria-label="${T("Remove this dish", "\u0625\u0632\u0627\u0644\u0629 \u0647\u0630\u0627 \u0627\u0644\u0637\u0628\u0642")}">×</button>
        </div>`)
      .join("");
    const off = applied && d.amount > 0
      ? `<div class="ol-row disc"><span>${applied.code} · ${applied.percent}% off</span><span>− ${money(d.amount)}</span></div>`
      : "";
    $("#sheetTotals").innerHTML = lines + off +
      `<div class="ol-row total"><span>Total</span><span>${money(d.total)}</span></div>`;
  }

  /* the sheet's lines are redrawn on every change, so the clicks are handled
     once on the container rather than bound to each button */
  $("#sheetTotals").addEventListener("click", (e) => {
    const plus = e.target.closest("[data-sheet-plus]");
    const minus = e.target.closest("[data-sheet-minus]");
    const drop = e.target.closest("[data-sheet-del]");
    if (plus) changeQty(plus.getAttribute("data-sheet-plus"), 1);
    else if (minus) changeQty(minus.getAttribute("data-sheet-minus"), -1);
    else if (drop) { cart.delete(drop.getAttribute("data-sheet-del")); renderCart(); }
    else return;
    /* an empty order has nothing to confirm: put the sheet away */
    if (!totals().count) { renderSheetTotals(); closeSheet(); return; }
    renderSheetTotals();
  });

  /* Applying a code is a question for the server: it knows the percentage, the
     cap, whether the code is still running and whether this number used it. */
  async function applyCode() {
    const input = $("#discCode");
    const btn = $("#applyCode");
    const msg = $("#codeMsg");
    const code = (input.value || "").trim().toUpperCase();
    if (!code) { if (msg) { msg.className = "hint bad"; msg.textContent = "Type the code first."; } return; }

    const before = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const res = await fetch(API_BASE + "/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discountCheck: true,
          handle: handle,
          code: code,
          subtotal: totals().sum,
          phone: ($("#guestPhone") || {}).value || ""
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        applied = null;
        if (msg) {
          msg.className = "hint bad";
          msg.textContent = data.message || (data.code === "NO_DISCOUNTS"
            ? "Discounts are not switched on for this restaurant."
            : "That code did not work.");
        }
      } else {
        applied = {
          code: data.code, percent: data.percent,
          amount: data.amount, maxAmount: data.maxAmount || null
        };
        if (msg) {
          msg.className = "hint good";
          const d = discountNow();
          msg.textContent = applied.code + " applied — you save " + money(d.amount) + ".";
        }
        input.value = applied.code;
      }
      renderSheetTotals();
    } catch (e) {
      if (msg) { msg.className = "hint bad"; msg.textContent = "Could not check that code. Try again."; }
    } finally {
      btn.disabled = false;
      btn.textContent = before;
    }
  }

  function err(id, bad) {
    const el = $(id);
    if (el) el.classList.toggle("on", !!bad);
    return !bad;
  }

  function buildMessage(guest, phone) {
    const { sum } = totals();
    const lines = ["*New order — " + name + "*", "Type: " + mode, ""];
    if (mode === "Dine In") lines.push("Table: " + table);
    if (mode === "Take Away") lines.push("Pickup in: " + pickup);
    if (mode === "Delivery") lines.push("Address: " + address.replace(/\s+/g, " ").trim());
    lines.push("Guest: " + guest);
    if (phone) lines.push("Mobile: " + phone);
    lines.push("");
    cart.forEach((r) => lines.push(r.qty + " × " + r.item.name + " — " + money(r.qty * r.item.price)));
    const d = discountNow();
    if (applied && d.amount > 0) {
      lines.push("", "Discount " + applied.code + " (" + applied.percent + "%): − " + money(d.amount));
    }
    lines.push("", "Total: " + money(d.total), "", "Sent from " + publicLink);
    return lines.join("\n");
  }

  function recordOrder(guest, msg, phone) {
    try {
      const key = "digimenu.orders.v1";
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      list.unshift({
        ts: Date.now(),
        mode: mode,
        guest: guest,
        phone: phone || "",
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

  /* The guest is handed to WhatsApp either way, but the restaurant needs a
     record even when that message never arrives — which is exactly why the
     mobile number is now required. */
  const API_BASE = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.apiBase) || "";
  let sending = false;

  async function submitOrder(guest, phone) {
    if (sending) return null;
    sending = true;
    try {
      const res = await fetch(API_BASE + "/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: handle,
          mode: mode,
          table: table,
          pickupAt: pickup || null,
          address: address,
          name: guest,
          phone: phone,
          total: totals().sum,
          discountCode: applied ? applied.code : null,
          items: Array.from(cart.values()).map((r) => ({
            id: r.item.id, name: r.item.name, qty: r.qty, price: r.item.price
          }))
        })
      });
      const data = await res.json().catch(() => ({}));
      return res.ok ? data : { ok: false, message: data.message || "not saved" };
    } catch (e) {
      return { ok: false, message: "network" };
    } finally {
      sending = false;
    }
  }

  const applyBtn = $("#applyCode");
  if (applyBtn) applyBtn.addEventListener("click", applyCode);
  const codeInput = $("#discCode");
  if (codeInput) codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); applyCode(); }
  });

  /* ---------- reading progress: one throttled handler, one property ----
     The hairline at the top of the page is scaleX(--py); nothing else on the
     page listens to scroll. */
  let scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const y = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
      document.documentElement.style.setProperty("--py", y.toFixed(4));
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  $("#confirmOrder").addEventListener("click", async () => {
    let ok = true;
    ok = err("#nameErr", !$("#guestName").value.trim()) && ok;
    const phoneRaw = ($("#guestPhone").value || "").trim();
    ok = err("#phoneErr", phoneRaw.replace(/[^\d]/g, "").length < 7) && ok;
    if (mode === "Dine In") ok = err("#tableErr", !String(table).trim()) && ok;
    if (mode === "Take Away") ok = err("#pickErr", !pickup) && ok;
    if (mode === "Delivery") ok = err("#addrErr", !address.trim()) && ok;
    if (!ok) return;

    const guest = $("#guestName").value.trim();
    const msg = buildMessage(guest, phoneRaw);
    const confirmBtn = $("#confirmOrder");
    if (confirmBtn) confirmBtn.disabled = true;
    const saved = await submitOrder(guest, phoneRaw);
    const url = "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent(msg);
    recordOrder(guest, msg, phoneRaw);

    const place = mode === "Dine In" ? "table " + table : mode === "Take Away" ? pickup : "Delivery";
    $("#doneWa").href = url;
    $("#doneReceipt").innerHTML =
      `<div class="ol-row"><span>${mode} · ${place}</span><span>${money(totals().sum)}</span></div>` +
      `<div class="ol-row"><span>${totals().count} item${totals().count === 1 ? "" : "s"} for ${guest}</span><span>${name}</span></div>`;
    if (saved && saved.ok === false) {
      $("#doneNext").textContent = "WhatsApp is ready — but we could not save a copy for the restaurant. Send the message so they get it.";
    } else {
    $("#doneNext").textContent =
      mode === "Dine In"
        ? "The restaurant confirms your table order on WhatsApp. Payment stays at the table."
        : mode === "Take Away"
        ? "The restaurant confirms the pickup time on WhatsApp. Nothing is charged online."
        : "The restaurant confirms the address and delivery charge on WhatsApp before sending.";
    }

    $("#sheetForm").hidden = true;
    $("#sheetDone").hidden = false;
    window.open(url, "_blank", "noopener");
  });

  $("#doneClose").addEventListener("click", () => {
    $("#sheetDone").hidden = true;
    $("#sheetForm").hidden = false;
    closeSheet();
  });

  /* ---------- category picker (phones) ---------- */
  const catPick = $("#catSelect");
  if (catPick) {
    catPick.addEventListener("change", function () {
      const sec = document.getElementById("c-" + catPick.value);
      if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ---------- rail active state ---------- */

  const links = $$("#rail a");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const id = en.target.id.replace("c-", "");
            links.forEach((a) => a.classList.toggle("on", a.dataset.cat === id));
            const sel = $("#catSelect");
            if (sel && sel.value !== id) sel.value = id;
          }
        });
      },
      { rootMargin: "-60px 0px -70% 0px" }
    );
    $$(".sec").forEach((s) => observer.observe(s));
  }

  renderCart();
  }

  /* ---------- the restaurant, before the food ---------- */

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name || "?").slice(0, 2)).toUpperCase();
  }

  function renderHero(r, data) {
    if (embed) return;
    const hero = $("#hero");
    if (!hero) return;

    const rn = r.name || "Menu";
    $("#heroName").textContent = rn;
    /* a logo URL can outlive its file — replaced uploads delete the old object.
       Falling back to initials beats showing a broken-image box to a diner. */
    const logoHost = $("#heroLogo");
    if (r.logoUrl) {
      logoHost.innerHTML = '<img src="' + esc(r.logoUrl) + '" alt="">';
      const img = logoHost.querySelector("img");
      img.addEventListener("error", () => { logoHost.textContent = initials(rn); });
    } else {
      logoHost.textContent = initials(rn);
    }

    if (r.tagline) {
      $("#heroTagline").textContent = r.tagline;
      $("#heroTagline").hidden = false;
    }

    /* The $2 plan is a menu, not a till. When ordering is not included there is no
     cart to show — the page becomes a clean read-only menu. */
  if (r.ordering === false) {
    document.body.classList.add("view-only");
    const note = document.getElementById("viewOnlyNote");
    if (note) note.hidden = false;
  }

  /* The place and the service modes are two different facts: the address gets
     its own line so it never wraps into "· Delivery" on a phone. */
  const place = r.address || r.city || "";
    const modeWord = (p) =>
      LANG === "ar"
        ? ({ "Dine In": "داخل المطعم", "Take Away": "استلام", Delivery: "توصيل" }[p] || p)
        : (p === "Dine In" ? "Dine in" : p === "Take Away" ? "Takeaway" : p);
    const modes = (r.purposes || []).map(modeWord);
    const metaHtml =
      (place ? esc(place) + '<span class="break" aria-hidden="true"></span>' : "") +
      modes.map(esc).join('<span class="sep" aria-hidden="true">·</span>');
    $("#heroMeta").innerHTML = metaHtml;

    $("#heroWa").href = "https://wa.me/" + whatsapp + "?text=" +
      encodeURIComponent("Hello " + rn + ", I have a question about the menu.");

    /* Call uses the same line — most restaurants publish one number for both. */
    if (whatsapp) {
      const call = $("#heroCall");
      if (call) { call.href = "tel:+" + whatsapp; call.hidden = false; }
    }

    /* a real link if they gave one, otherwise a Maps search built from the address */
    const mapHref = r.mapsUrl || (r.address
      ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(r.address)
      : "");
    if (mapHref) {
      $("#heroMap").href = mapHref;
      $("#heroAddress").textContent = r.address ? T("Directions", "الاتجاهات") : T("Open in Maps", "افتح الخريطة");
      $("#heroMap").hidden = false;
    }

    const social = r.social || {};
    /* hand-entered values arrive as handles, as URLs, and sometimes as URLs with
       the slashes mangled. Normalise them, or leave the pill off entirely. */
    const socialHref = (raw, build) => {
      const v = String(raw || "").trim();
      if (!v) return "";
      if (/^https?:\/\//i.test(v)) return v;
      if (/^https?:\//i.test(v)) return v.replace(/^https?:\//i, "https://");   /* https:/host */
      if (v.charAt(0) === "/") return "";                                          /* a bare path */
      if (v.indexOf("/") !== -1) return "https://" + v.replace(/^\/+/, "");       /* instagram.com/x */
      return build(v.replace(/^@/, "").replace(/\/+$/, ""));                       /* a handle, dots allowed */
    };
    const igUrl = socialHref(social.instagram, (h) => "https://instagram.com/" + encodeURIComponent(h));
    const fbUrl = socialHref(social.facebook, (h) => "https://facebook.com/" + encodeURIComponent(h));
    const ttUrl = socialHref(social.tiktok, (h) => "https://tiktok.com/@" + encodeURIComponent(h));
    const webUrl = /^https?:\/\//i.test(String(social.website || "")) ? social.website : "";

    if (igUrl) {
      $("#heroIg").href = igUrl;
      $("#heroIg").hidden = false;
    }
    if (fbUrl) {
      $("#heroFb").href = fbUrl;
      $("#heroFb").hidden = false;
    }
    if (ttUrl) {
      $("#heroTt").href = ttUrl;
      $("#heroTt").hidden = false;
    }
    if (webUrl) {
      $("#heroWeb").href = webUrl;
      $("#heroWeb").hidden = false;
    }

    /* their own cover if they have one, otherwise three of their dish photos */
    const media = $("#heroMedia");
    /* one photograph, edge to edge. Three dish shots side by side meet at hard
       seams and read like a collage from a takeaway flyer. */
    const photos = [];
    if (r.coverUrl) photos.push(r.coverUrl);
    else {
      for (const c of data.categories || []) {
        for (const it of c.items || []) {
          if (it.image) { photos.push(it.image); break; }
        }
        if (photos.length) break;
      }
    }

    if (photos.length) {
      /* the hero must never be a grey box: it is the first thing a guest sees,
         and the photo comes off a third-party CDN that can be slow */
      media.innerHTML = photos
        .map((src, i) => '<img src="' + esc(sized(src, 1200)) + '" alt="" '
          + (i === 0 ? 'loading="eager" fetchpriority="high" decoding="async"' : 'loading="lazy"') + '>')
        .join("");
      if (photos.length === 1) media.classList.add("one");
      hero.classList.add("has-media");
    }

    chrome();
    wireThumbs();
    hero.hidden = false;
    document.body.classList.add("has-hero");

    /* The bar takes over from the hero: it holds the language switch and the
       category picker for the rest of the page. A scroll listener rather than an
       observer — the observer fired once at load and then never again, so the
       bar stayed hidden however far the page was scrolled. */
    if (!window.__headWatch) {
      window.__headWatch = true;
      var syncHead = function () {
        var r = hero.getBoundingClientRect();
        document.body.classList.toggle("scrolled", r.bottom < 72);
      };
      /* straight in the handler: a single bounding-box read, and rAF is not
         guaranteed to run (it never did in the headless browser, which made the
         bar look broken while the code was right) */
      window.addEventListener("scroll", syncHead, { passive: true });
      window.addEventListener("resize", syncHead, { passive: true });
      syncHead();
    }
  }

  /* ---------- when there is no menu to show ---------- */

  function unavailable(message) {
    document.title = "Menu not available — DigiMenu";
    const rail = $("#rail");
    if (rail) rail.innerHTML = "";
    $("#sections").innerHTML =
      '<div style="padding:64px 24px;text-align:center;max-width:420px;margin:0 auto">' +
        '<h2 style="margin:0 0 10px;font-size:20px">This menu is not available</h2>' +
        '<p style="margin:0;color:var(--ink-3);line-height:1.6">' + message + '</p>' +
      '</div>';
  }

  /* ---------- load, then paint ---------- */

  (async function start() {
    const cfg = window.DIGIMENU_CONFIG || {};
    const base = cfg.apiBase || "";
    /* only the address decides which menu this is: an unknown URL must show
       "not available", never whatever restaurant this browser saw last */
    const wanted = urlHandle || hostLookup || "";

    if (!wanted) {
      unavailable("This link has no menu address in it. Scan the restaurant's QR code again.");
      return;
    }

    let res;
    let data;
    try {
      res = await fetch(base + "/api/menu?" +
        (urlHandle ? "handle=" : "host=") + encodeURIComponent(wanted));
      data = await res.json();
    } catch (e) {
      unavailable("We could not reach the menu. Check your connection and try again.");
      return;
    }

    if (!res.ok || !data.ok) {
      unavailable((data && data.message) || "This menu is not published yet.");
      return;
    }

    const r = data.restaurant || {};
    restaurant = { name: r.name, city: r.city, whatsapp: r.whatsapp, purposes: r.purposes };
    LOCALES = Array.isArray(r.locales) ? r.locales : ["en"];
    docs = { logo: r.logoUrl || null };
    name = r.name || "Menu";
    accent = r.accent || "#f0485f";
    /* the restaurant's own colour becomes the accent: buttons, the active chip,
       the star, the progress hairline. Until now it was fetched and never used. */
    document.documentElement.style.setProperty("--brand", accent);

    /* Whatever sits ON the accent has to be readable on it. White on this
       orange measured 2.3:1; the ink is chosen by contrast, not by taste,
       because the accent is different for every restaurant. */
    (function readableInk(value) {
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || "").trim());
      if (!m) return;
      let h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      const onWhite = 1.05 / (L + 0.05);
      const onInk = (L + 0.05) / (0.013 + 0.05);
      document.documentElement.style.setProperty("--accent-ink", onInk >= onWhite ? "#14120E" : "#FFFFFF");
      /* a wash of the same colour for the header's category strip */
      const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      document.documentElement.style.setProperty("--accent-soft", "rgba(" + channels.join(",") + ",0.16)");
    })(accent);
    handle = r.handle || wanted;
    publicLink = PUBLIC_BASE.replace(/^https?:\/\//i, "") + handle;

    /* on a customer's own domain the address bar should read their domain, not
     * /menu.html — the hop through the marketing page is ours, not theirs */
    if (hostLookup && location.pathname === "/menu.html") {
      try { history.replaceState(null, "", "/"); } catch (e) { /* not fatal */ }
    }
    /* the API number takes the order when there is one: the guest messaging it
       is what unlocks the free replies that follow */
    whatsapp = String(r.orderWhatsapp || r.whatsapp || "").replace(/\D/g, "");
    purposes = (r.purposes && r.purposes.length) ? r.purposes : ["Dine In", "Take Away"];
    mode = purposes[0] || "Dine In";

    cats = (data.categories || []).map((c, i) => ({
      id: "c" + i,
      name: c.name,
      arName: c.arName || "",
      featured: !!c.featured,
      items: (c.items || []).map((it, j) => ({
        id: "i" + i + "x" + j,
        name: it.name,
        arName: it.arName || "",
        desc: it.description || "",
        arDesc: it.arDesc || "",
        price: it.price == null ? 0 : it.price,
        image: it.image || null,
        soldOut: !!it.soldOut,
        diet: null
      }))
    }));

    currency = r.currency || "AED";
    renderHero(r, data);

    /* the switch only exists when the restaurant has published Arabic —
       showing an EN|AR toggle that flips to nothing is worse than no toggle */
    const sw = $("#langSwitch");
    if (sw) {
      const hasAr = LOCALES.indexOf("ar") >= 0;
      sw.hidden = !hasAr;
      if (hasAr) {
        Array.from(sw.querySelectorAll("[data-lang]")).forEach(function (b) {
          b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
        });
      }
      if (hasAr && LANG === "ar") setLang("ar");
      else document.documentElement.dir = "ltr";
    }

    /* most guests are local: start the number with the restaurant's own dial code */
    const phoneInput = $("#guestPhone");
    if (phoneInput && !phoneInput.value) {
      const dial = (String(r.whatsapp || "").match(/^\+\d{1,3}/) || [])[0];
      if (dial) phoneInput.value = dial + " ";
    }

    paint();
    /* paint() is what renders the shelves, so the thumbs can only be observed
       once it has finished — wiring them from the hero ran too early. */
    wireThumbs();
  })();
})();

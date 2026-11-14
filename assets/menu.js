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

  /* The look the owner picked in Settings → Appearance. Empty means the
     charcoal ground, which is what every existing tenant already sees. */
  let THEME = {};

  const FONT_STACKS = {
    serif: '"Fraunces", "Noto Kufi Arabic", ui-serif, Georgia, serif',
    grotesk: '"Outfit", "Noto Kufi Arabic", system-ui, "Segoe UI", sans-serif',
    satoshi: '"Satoshi", "Outfit", system-ui, sans-serif'
  };

  /* Three grounds, two ink tones, three display faces — the same set the
     dashboard offers, applied by swapping the classes and custom properties the
     sheet already defines. Nothing here invents a colour: an unknown value falls
     back rather than painting something untested. */
  function applyTheme(theme) {
    const t = theme && typeof theme === "object" ? theme : {};
    const html = document.documentElement;
    /* the marketing page embeds this menu in a phone frame, and there it stays
       light so the landing hero does not turn black */
    const embed = document.body.classList.contains("embed");
    const ground = ["dark", "light", "clay"].includes(t.ground) ? t.ground : "dark";

    html.classList.toggle("t-dark", !embed && ground === "dark");
    html.classList.toggle("t-clay", !embed && ground === "clay");

    /* "strong" is the same ground with the ink pushed to pure black or white;
       both ends pass contrast on all three grounds, so the choice cannot make
       the page unreadable */
    if (!embed && t.ink === "strong") {
      html.style.setProperty("--ink", ground === "dark" ? "#FFFFFF" : "#000000");
    } else {
      html.style.removeProperty("--ink");
    }

    if (!embed && FONT_STACKS[t.font]) {
      html.style.setProperty("--font-display", FONT_STACKS[t.font]);
    } else {
      html.style.removeProperty("--font-display");
    }
  }

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
    /* the bar's button is written once in the markup and never followed the
       language: an Arabic menu still said "Review order" at the bottom */
    const barGo = document.querySelector("#barCheckout");
    if (barGo) barGo.textContent = T("Review order", "مراجعة الطلب");

    /* the two big buttons are three lines each and were written only in English */
    const cta = function (sel, main) {
      const btn = document.querySelector(sel);
      if (!btn) return;
      const lead = btn.querySelector(".cta-lead");
      const name = btn.querySelector("span");
      const sub = btn.querySelector(".cta-sub");
      if (lead) lead.textContent = T("Click Here to", "اضغط هنا لـ");
      if (name) name.textContent = main;
      if (sub) sub.textContent = T("Get Instant Confirmation", "تأكيد فوري");
    };
    cta("#confirmOrder", T("Review & Confirm", "مراجعة وتأكيد"));
    cta("#doneWa", T("Send on WhatsApp", "أرسل على واتساب"));

    /* The checkout was written once in English and never wired to the language
       layer, so an Arabic guest read an Arabic menu and then met an English
       form. Every string the guest sees in the sheet lives here. */
    const S = function (sel, en, ar) {
      const el = document.querySelector(sel);
      if (el) el.textContent = T(en, ar);
    };
    const H = function (sel, en, ar) {
      const el = document.querySelector(sel);
      if (el) el.placeholder = T(en, ar);
    };
    S("#sheetTitle", "How would you like it?", "كيف تحب طلبك؟");
    S("#sheetSub",
      "Your order is sent to the restaurant on WhatsApp from your own phone. They reply to confirm.",
      "يرسل طلبك إلى المطعم عبر واتساب من هاتفك، ويردون عليك للتأكيد.");
    const modes = [
      ['[data-mode="Dine In"]', "Dine In", "تناول في المطعم"],
      ['[data-mode="Take Away"]', "Take Away", "استلام"],
      ['[data-mode="Delivery"]', "Delivery", "توصيل"]
    ];
    modes.forEach(function (m) { S(m[0], m[1], m[2]); });

    const labels = document.querySelectorAll("#sheetForm > .field > label");
    const labelText = [
      ["Your name", "اسمك"],
      ["Mobile number", "رقم الجوال"],
      ["Email", "البريد الإلكتروني"],
      ["Discount code", "كود الخصم"]
    ];
    labels.forEach(function (el) {
      labelText.forEach(function (pair) {
        if (el.textContent.indexOf(pair[0]) === 0) {
          el.childNodes[0].nodeValue = T(pair[0] + " ", pair[1] + " ");
        }
      });
    });

    H("#guestName", "So the kitchen knows whose order it is", "ليعرف المطبخ صاحب الطلب");
    S("#nameErr", "We need a name for the order.", "نحتاج اسماً للطلب.");
    const phoneHints = document.querySelectorAll("#sheetForm .field .hint");
    phoneHints.forEach(function (el) {
      if (el.textContent.indexOf("Pick your country code") === 0) {
        el.textContent = T("Pick your country code, then the number without it.",
          "اختر رمز الدولة ثم أدخل الرقم بدونه.");
      } else if (el.textContent.indexOf("We email you the order") === 0) {
        el.textContent = T("We email you the order and a WhatsApp link, in case the chat does not open.",
          "نرسل لك الطلب ورابط واتساب على بريدك في حال لم يفتح التطبيق.");
      }
    });
    S("#phoneErr", "Enter the mobile number without the country code.",
      "أدخل رقم الجوال بدون رمز الدولة.");
    S("#emailErr", "We need an email so we can send your order.",
      "نحتاج بريداً إلكترونياً لإرسال طلبك.");
    H("#discCode", "Have a code?", "لديك كود؟");
    S("#applyCode", "Apply", "تطبيق");
    S("#closeSheet", "Back to menu", "رجوع للقائمة");
    S("#sheetDone h2", "Order received", "تم استلام طلبك");
    S("#doneSub",
      "Your order is with the restaurant. Send it on WhatsApp so they can confirm it — one tap, and it is on its way.",
      "طلبك لدى المطعم. أرسله على واتساب ليؤكدوه — ضغطة واحدة وينطلق.");
    S("#doneClose", "Done", "تم");

    /* The mode field and the totals are built from strings by functions that live
       inside paint(), out of reach from here, so their labels are set directly on
       the DOM instead. Without this the table/pickup/address field and the word
       "Total" stayed in the language the sheet was first opened in. */
    const firstLabel = function () {
      const l = document.querySelector("#modeFields label");
      return l && l.childNodes.length ? l : null;
    };
    const setLabel = function (text) {
      const l = firstLabel();
      if (l) l.childNodes[0].nodeValue = text + " ";
    };
    if (mode === "Dine In") {
      setLabel(T("Table number", "رقم الطاولة"));
      const t = $("#tableNo");
      if (t) t.placeholder = T("Printed on your table card", "مكتوب على بطاقة طاولتك");
      S("#tableErr", "Add the table number printed on your card.",
        "أضف رقم الطاولة المطبوع على بطاقتك.");
    } else if (mode === "Take Away") {
      setLabel(T("When will you Pick Up", "متى ستستلم؟"));
      const names = {
        "15 min": ["15 min", "١٥ دقيقة"],
        "30 min": ["30 min", "٣٠ دقيقة"],
        "45 min": ["45 min", "٤٥ دقيقة"],
        "1 hour": ["1 hour", "ساعة"]
      };
      $$("#pickChips button").forEach(function (b) {
        const pair = names[b.getAttribute("data-t")];
        if (pair) b.textContent = T(pair[0], pair[1]);
      });
      S("#pickErr", "Choose when you will collect the order.", "اختر وقت الاستلام.");
    } else {
      setLabel(T("Delivery address", "عنوان التوصيل"));
      const a = $("#addr");
      if (a) a.placeholder = T("Building, street, area, landmark",
        "المبنى، الشارع، المنطقة، علامة مميزة");
      S("#addrErr", "We need an address to deliver to.", "نحتاج عنواناً للتوصيل.");
    }
    S("#sheetTotals .ol-row.total span", "Total", "الإجمالي");
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
    $$("#langSwitch [data-lang], #langSwitchHero [data-lang]").forEach(function (b) {
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

  /* The ground the shelves sit on, as the owner chose it in the dashboard:
     charcoal by default, bone or clay on request, and always light inside the
     marketing page's phone frame. */
  applyTheme(THEME);

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



  /* paint() runs on every language switch, and a large part of this file lives
     inside it (brace depth 2 from the section render onwards). Every listener
     registered on a static element was therefore added again on each repaint:
     one Add tap became seven after six switches, and one confirm press could
     POST the order twice. These elements exist once, so bind them once. */
  /* The flag lives ON the element, not in a variable up here: this whole block is
     re-executed by paint(), so any map declared here is born and dies with it. */
  const bind = function (el, type, fn) {
    if (!el) return;
    const flag = "__dmBound_" + type;
    if (el[flag]) return;
    el[flag] = true;
    el.addEventListener(type, fn);
  };

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
          <span class="cn">${esc(nm(r.item))}</span>
          <span class="qty">
            <button type="button" data-dec="${id}" aria-label="Remove one ${esc(nm(r.item))}">−</button>
            <span>${r.qty}</span>
            <button type="button" data-inc="${id}" aria-label="Add one ${esc(nm(r.item))}">+</button>
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

  bind($("#barCheckout"), "click", openSheet);

  /* One listener for the whole dish list. This used to sit inside paint(), so a
     language switch attached a second copy and every tap counted twice. */
  bind(document.getElementById("sections"), "click", (e) => {
    const add = e.target.closest("[data-id].add");
    if (add) { addToCart(add.dataset.id); syncItemRow(add.dataset.id); return; }
    const plus = e.target.closest("[data-step-plus]");
    if (plus) { changeQty(plus.getAttribute("data-step-plus"), 1); syncItemRow(plus.getAttribute("data-step-plus")); return; }
    const minus = e.target.closest("[data-step-minus]");
    if (minus) { changeQty(minus.getAttribute("data-step-minus"), -1); syncItemRow(minus.getAttribute("data-step-minus")); }
  });

  /* ---------- sheet ---------- */

  const sheet = $("#sheet");
  const sheetBack = $("#sheetBack");

  function openSheet() {
    /* the confirm button is disabled after a successful send; opening the
       sheet again is a new order and it must be pressable */
    const cb = $("#confirmOrder");
    if (cb) cb.disabled = false;
    if (!totals().count) return;
    submitKey = newSubmitKey();
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

  bind($("#closeSheet"), "click", closeSheet);
  bind(sheetBack, "click", closeSheet);
  bind(document, "keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  $$("#modeBtns button").forEach((b) =>
    bind(b, "click", () => {
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
          <label for="tableNo">${T("Table number", "\u0631\u0642\u0645 \u0627\u0644\u0637\u0627\u0648\u0644\u0629")} <span style="color:var(--danger)">*</span></label>
          <input class="input" id="tableNo" inputmode="numeric" placeholder="${T("Printed on your table card", "\u0645\u0643\u062a\u0648\u0628 \u0639\u0644\u0649 \u0628\u0637\u0627\u0642\u0629 \u0637\u0627\u0648\u0644\u062a\u0643")}" value="${table}">
          <div class="err" id="tableErr">${T("Add the table number printed on your card.", "\u0623\u0636\u0641 \u0631\u0642\u0645 \u0627\u0644\u0637\u0627\u0648\u0644\u0629 \u0627\u0644\u0645\u0637\u0628\u0648\u0639 \u0639\u0644\u0649 \u0628\u0637\u0627\u0642\u062a\u0643.")}</div>
        </div>`;
      $("#tableNo").addEventListener("input", (e) => { table = e.target.value; });
    } else if (mode === "Take Away") {
      /* the value stays English because the server parses it; only the label
         the guest reads is translated */
      const times = [
        { v: "15 min", en: "15 min", ar: "\u0661\u0665 \u062f\u0642\u064a\u0642\u0629" },
        { v: "30 min", en: "30 min", ar: "\u0663\u0660 \u062f\u0642\u064a\u0642\u0629" },
        { v: "45 min", en: "45 min", ar: "\u0664\u0665 \u062f\u0642\u064a\u0642\u0629" },
        { v: "1 hour", en: "1 hour", ar: "\u0633\u0627\u0639\u0629" }
      ];
      host.innerHTML = `
        <div class="field">
          <label>${T("When will you Pick Up", "\u0645\u062a\u0649 \u0633\u062a\u0633\u062a\u0644\u0645\u061f")} <span style="color:var(--danger)">*</span></label>
          <div class="chips" id="pickChips">
            ${times.map((t) => `<button type="button" data-t="${t.v}" aria-pressed="${pickup === t.v}">${T(t.en, t.ar)}</button>`).join("")}
          </div>
          <div class="err" id="pickErr">${T("Choose when you will collect the order.", "\u0627\u062e\u062a\u0631 \u0648\u0642\u062a \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645.")}</div>
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
          <label for="addr">${T("Delivery address", "\u0639\u0646\u0648\u0627\u0646 \u0627\u0644\u062a\u0648\u0635\u064a\u0644")} <span style="color:var(--danger)">*</span></label>
          <textarea class="input" id="addr" rows="2" placeholder="${T("Building, street, area, landmark", "\u0627\u0644\u0645\u0628\u0646\u0649\u060c \u0627\u0644\u0634\u0627\u0631\u0639\u060c \u0627\u0644\u0645\u0646\u0637\u0642\u0629\u060c \u0639\u0644\u0627\u0645\u0629 \u0645\u0645\u064a\u0632\u0629")}">${address}</textarea>
          <div class="err" id="addrErr">${T("We need an address to deliver to.", "\u0646\u062d\u062a\u0627\u062c \u0639\u0646\u0648\u0627\u0646\u0627\u064b \u0644\u0644\u062a\u0648\u0635\u064a\u0644.")}</div>
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
          <span class="ol-nm">${esc(nm(r.item))}</span>
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
      ? `<div class="ol-row disc"><span>${applied.code} · ${applied.percent}% ${T("off", "\u062e\u0635\u0645")}</span><span>− ${money(d.amount)}</span></div>`
      : "";
    $("#sheetTotals").innerHTML = lines + off +
      `<div class="ol-row total"><span>${T("Total", "\u0627\u0644\u0625\u062c\u0645\u0627\u0644")}</span><span>${money(d.total)}</span></div>`;
  }

  /* the sheet's lines are redrawn on every change, so the clicks are handled
     once on the container rather than bound to each button */
  bind($("#sheetTotals"), "click", (e) => {
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
  /* the done panel exactly as shipped, so a retry after a failed save can put
     its own words back */
  const DONE_TITLE = ($("#doneTitle") || {}).textContent || "Order received";
  const DONE_SUB = ($("#doneSub") || {}).textContent || "";
  /* One key per order attempt: a double tap, a flaky connection or a retried
     request can only ever create one order, because the server keys on this. */
  let submitKey = "";
  const newSubmitKey = function () {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + "-" + Math.random().toString(16).slice(2); }
  };

  async function submitOrder(guest, phone, email) {
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
          email: email || "",
          submitKey: submitKey || null,
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
  bind(applyBtn, "click", applyCode);
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

  bind($("#confirmOrder"), "click", async () => {
    let ok = true;
    ok = err("#nameErr", !$("#guestName").value.trim()) && ok;
    /* nine digits is the UAE mobile; anywhere else, at least seven and never
       more than fifteen, which is every number WhatsApp accepts */
    const chosenCode = ($("#dialCode") || {}).value || "+971";
    const localDigits = (window.__dmLocalNumber || function (v) { return String(v || "").replace(/\D/g, "").slice(0, 9); })($("#guestPhone").value);
    const phoneRaw = chosenCode + localDigits;
    const totalDigits = (chosenCode + localDigits).replace(/\D/g, "").length;
    const needDigits = chosenCode === "+971" ? 9 : 6;
    ok = err("#phoneErr", localDigits.length < needDigits || totalDigits > 15) && ok;
    const emailRaw = ($("#guestEmail").value || "").trim();
    ok = err("#emailErr", !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw)) && ok;
    if (mode === "Dine In") ok = err("#tableErr", !String(table).trim()) && ok;
    if (mode === "Take Away") ok = err("#pickErr", !pickup) && ok;
    if (mode === "Delivery") ok = err("#addrErr", !address.trim()) && ok;
    if (!ok) return;

    const guest = $("#guestName").value.trim();
    const confirmBtn = $("#confirmOrder");
    if (confirmBtn) confirmBtn.disabled = true;
    const saved = await submitOrder(guest, phoneRaw, emailRaw);
    if (saved && saved.ok) submitKey = newSubmitKey();

    /* The reference travels in the guest's own message. The WhatsApp account they
       send from can be a different number from the one they typed, and without
       this the reply has no way back to the order — that is how a real order sat
       with no answer. */
    let msg = buildMessage(guest, phoneRaw);
    if (saved && saved.orderId) msg += "\nRef: " + String(saved.orderId).slice(0, 8);
    const url = "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent(msg);
    recordOrder(guest, msg, phoneRaw);

    const place = mode === "Dine In" ? "table " + table
      : mode === "Take Away" ? pickup
      : (address.replace(/\s+/g, " ").trim() || "your address");
    $("#doneWa").href = url;
    const modeAr = { "Dine In": "تناول في المطعم", "Take Away": "استلام", "Delivery": "توصيل" };
    const countLine = LANG === "ar"
      ? totals().count + " عناصر — " + guest
      : totals().count + (totals().count === 1 ? " item" : " items") + " for " + guest;
    $("#doneReceipt").innerHTML =
      `<div class="ol-row"><span>${T(mode, modeAr[mode])} · ${place}</span><span>${money(totals().sum)}</span></div>` +
      `<div class="ol-row"><span>${countLine}</span><span>${name}</span></div>`;
    if (saved && saved.ok === false) {
      /* Say it plainly, and say it at the top: the panel will not show this
         order, so the WhatsApp message is the only copy the restaurant gets. A
         "Order received" headline over a small warning is how a guest walks
         away believing the kitchen has it. */
      console.error("[order] not saved", saved);
      const title = $("#doneTitle");
      if (title) title.textContent = "Not saved — send it on WhatsApp";
      const sub = $("#doneSub");
      if (sub) sub.textContent = "The restaurant's dashboard did not take this order. Send the message below and they will still receive it.";
      $("#doneNext").textContent = "This order could not be saved for the restaurant — send the message below so they still receive it.";
      $("#doneNext").classList.add("warn");
    } else {
    const title = $("#doneTitle");
    if (title) title.textContent = DONE_TITLE;
    const sub = $("#doneSub");
    if (sub) sub.textContent = DONE_SUB;
    $("#doneNext").classList.remove("warn");
    $("#doneNext").textContent =
      mode === "Dine In"
        ? T("Your table order is saved. The restaurant confirms it on WhatsApp; payment stays at the table.",
            "تم حفظ طلبك. يؤكده المطعم على واتساب، والدفع على الطاولة.")
        : mode === "Take Away"
        ? T("Your order is saved. The restaurant confirms the pickup time on WhatsApp; nothing is charged online.",
            "تم حفظ طلبك. يؤكد المطعم وقت الاستلام على واتساب، ولا يُخصم أي مبلغ إلكترونياً.")
        : T("Your order is saved. The restaurant confirms the address and delivery charge on WhatsApp before sending.",
            "تم حفظ طلبك. يؤكد المطعم العنوان ورسوم التوصيل على واتساب قبل الإرسال.");
    }

    /* No window.open here: it fires after an await, so the popup blocker eats it
       on some phones, and the guest was then asked to send twice. The order is
       already saved above — the send is one deliberate tap on the next screen,
       which no blocker can refuse because it comes from a real gesture. */
    $("#sheetForm").hidden = true;
    $("#sheetDone").hidden = false;
  });

  bind($("#doneClose"), "click", () => {
    $("#sheetDone").hidden = true;
    $("#sheetForm").hidden = false;
    closeSheet();
  });

  /* ---------- category picker (phones) ---------- */
  const catPick = $("#catSelect");
  if (catPick) {
    bind(catPick, "change", function () {
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

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* The page a guest opens when there is no menu to show. It stays the
     restaurant's own page — its name, its initial — because that is the link
     the owner checks, and it says why in a sentence rather than the empty shell
     it used to leave behind. The owner, signed in on this origin, also gets the
     list of what is missing and a way into the dashboard. */
  function unavailable(message, kind) {
    const boot = window.DM_PAGE || {};
    /* the server names the page; with no name (an old cached shell, or a host
       that cannot inject) the address itself still identifies it */
    const fromHandle = handle ? handle.replace(/-/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : "";
    const rn = boot.name || name || fromHandle || "";
    document.title = kind === "draft"
      ? (rn || "Menu") + " — not live yet"
      : "Menu not available — DigiMenu";
    const rail = $("#rail");
    if (rail) rail.innerHTML = "";
    ["#hero", "#cart", "#sheet", "#picker", "#mbar"].forEach(function (sel) {
      const el = $(sel);
      if (el) el.hidden = true;
    });
    const initial = (String(rn).trim().charAt(0) || "M").toUpperCase();
    $("#sections").innerHTML =
      '<div class="nl">' +
        '<div class="mlogo nl-logo">' + esc(initial) + "</div>" +
        (rn ? '<h1 class="nl-name">' + esc(rn) + "</h1>" : "") +
        '<p class="nl-why">' + esc(message) + "</p>" +
        '<div class="nl-fix" id="nlFix" hidden></div>' +
        '<p class="nl-help">Need a hand? <a href="https://wa.me/971568911233" target="_blank" rel="noopener">WhatsApp us</a>' +
        " · <a href=\"tel:+971568911233\">call +971 56 891 1233</a></p>" +
      "</div>";
    if (kind === "draft") ownerProblems();
  }

  /* Signed in as this restaurant? Say exactly what is missing, and the way in.
     A guest sees only the sentence above — nothing of the owner's business. */
  async function ownerProblems() {
    let tok = "";
    try {
      tok = (JSON.parse(localStorage.getItem("digimenu.session.v1") || "null") || {}).access_token || "";
    } catch (e) { tok = ""; }
    if (!tok || !handle) return;
    let row = null;
    try {
      const api = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.apiBase) || "";
      const r = await fetch(api + "/api/restaurant", { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) return;
      row = (await r.json()).restaurant || null;
    } catch (e) { return; }
    if (!row || String(row.handle || "").toLowerCase() !== String(handle).toLowerCase()) return;

    const missing = [];
    if (!row.logo_url) missing.push("restaurant logo");
    if (!row.licence_url) missing.push("trade licence copy");
    if (!row.maps_url) missing.push("Google Maps link");
    const box = $("#nlFix");
    if (!box) return;
    const live = String(row.status) === "published";
    box.innerHTML =
      "<b>" + (live
        ? "You are the owner of this menu. It is published — reload in a moment."
        : missing.length
          ? "You are the owner of this menu. It cannot go live until these are added:"
          : "You are the owner of this menu. Everything needed is here — it just is not published.") + "</b>" +
      (missing.length ? "<ul>" + missing.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" : "") +
      '<a class="nl-go" href="/app.html#publish">Open dashboard → Publishing</a>';
    box.hidden = false;
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
      /* A draft and a wrong address are different sentences: the server says
         which when it injected the page, and a 404 from /api/menu on a handle
         that exists is a menu that has not been published yet. */
      const boot = window.DM_PAGE || {};
      const draft = boot.status
        ? boot.status !== "published"
        : (res.status === 404 && /publish/i.test(String((data && data.message) || "")));
      unavailable(
        draft
          ? "This menu is not published yet. The restaurant has not opened it to guests."
          : ((data && data.message) || "This menu is not available."),
        draft ? "draft" : "gone"
      );
      return;
    }

    const r = data.restaurant || {};
    restaurant = { name: r.name, city: r.city, whatsapp: r.whatsapp, purposes: r.purposes };
    THEME = r.theme && typeof r.theme === "object" ? r.theme : {};
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
    /* Two switches, one language: the header's, and one in the hero so a guest
       can change language without first scrolling the landing away. */
    const hasAr = LOCALES.indexOf("ar") >= 0;
    $$("#langSwitch, #langSwitchHero").forEach(function (sw) {
      sw.hidden = !hasAr;
      if (!hasAr) return;
      Array.from(sw.querySelectorAll("[data-lang]")).forEach(function (b) {
        b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
      });
    });
    if (hasAr && LANG === "ar") setLang("ar");
    else document.documentElement.dir = "ltr";

    /* most guests are local: start the number with the restaurant's own dial code */
    /* The country code is not the guest's to type: it is the restaurant's, shown
       as a fixed prefix. A hand-typed code is how a number stops matching the
       WhatsApp the guest actually sends from. */
    const dialEl = $("#dialCode");
    const dialCode = (String(r.whatsapp || "").match(/^\+\d{1,3}/) || ["+971"])[0];
    if (dialEl && !dialEl.dataset.touched) {
      /* tourists outnumber locals in Dubai, so the code is a picker, not a label.
         It opens on the restaurant's own country and keeps whatever the guest
         chose across repaints. */
      if (!Array.prototype.some.call(dialEl.options, function (o) { return o.value === dialCode; })) {
        const extra = document.createElement("option");
        extra.value = dialCode;
        extra.textContent = dialCode;
        dialEl.appendChild(extra);
      }
      dialEl.value = dialCode;
    }
    if (dialEl && !dialEl.dataset.bound) {
      dialEl.dataset.bound = "1";
      dialEl.addEventListener("change", function () {
        dialEl.dataset.touched = "1";
        const inp = $("#guestPhone");
        if (inp) inp.dispatchEvent(new Event("input"));
      });
    }
    const phoneInput = $("#guestPhone");
    /* A guest who pastes "+971 50 111 2222" or types "050 111 2222" must end up
       with the same nine digits, or the number they gave the kitchen is not the
       number WhatsApp knows them by. */
    const localNumber = function (raw) {
      let d = String(raw || "").replace(/\D/g, "");
      const chosen = String(($("#dialCode") || {}).value || dialCode);
      const code = chosen.replace(/\D/g, "");
      if (code && d.indexOf(code) === 0) d = d.slice(code.length);
      while (d.charAt(0) === "0") d = d.slice(1);
      /* UAE mobiles are nine digits; everywhere else WhatsApp accepts up to
         fifteen digits in total, so the local part may be longer */
      return d.slice(0, chosen === "+971" ? 9 : 12);
    };
    window.__dmLocalNumber = localNumber;
    if (phoneInput) {
      phoneInput.value = localNumber(phoneInput.value);
      phoneInput.addEventListener("input", function () {
        const digits = localNumber(phoneInput.value);
        if (phoneInput.value !== digits) phoneInput.value = digits;
      });
    }

    paint();
    /* paint() is what renders the shelves, so the thumbs can only be observed
       once it has finished — wiring them from the hero ran too early. */
    wireThumbs();
  })();
})();

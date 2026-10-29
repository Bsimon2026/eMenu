/* ==========================================================================
   DigiMenu app: onboarding wizard, dashboard, menu editor, import, QR.
   No backend — everything persists in localStorage so the guest page and the
   dashboard read the same record.
   ========================================================================== */

(function () {
  "use strict";

  /* The dashboard is the signed-in surface: with no session there is nothing
     here to show. Every write is re-checked server-side against the same token. */
  if (!window.Auth || !window.Auth.session()) {
    location.replace("login.html");
    return;
  }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const KEY = "digimenu.state.v1";
  const ORDERS_KEY = "digimenu.orders.v1";
  const STEPS = ["Your restaurant", "Documents", "Menu link"];
  const TAKEN = ["karak-house", "al-noor", "tandoori-nights", "biryani-point", "the-grill", "shishawi", "table9", "salt-pepper", "khan-mandi"];

  /* Where this build is actually served. On ogle.live the printed link is the
     real one; anywhere else (a preview deployment) the QR encodes the URL that
     resolves right now, so the code still scans to a live menu. */
  const PUBLIC_BASE = /^(www\.)?ogle\.live$/i.test(location.hostname)
    ? "https://ogle.live/digimenu/"
    : location.origin + "/digimenu/";

  const publicLink = (h) => PUBLIC_BASE.replace(/^https?:\/\//i, "") + (h || "—");

  /* ---------------- state ---------------- */

  function seed() {
    return {
      account: { name: "Biju Simon", email: "biju@ogle.live", mobile: "503975612", password: "" },
      restaurant: {
        name: "Spice Route",
        ownerName: "Biju Simon",
        purposes: ["Dine In", "Take Away"],
        whatsapp: "971525757079",
        orderEmail: "biju@ogle.live",
        mapsUrl: ""
      },
      docs: { logo: null, license: null },
      handle: "spice-route",
      accent: "#f7941d",
      menuImported: true,
      menu: null,
      onboarded: true
    };
  }

  let state = loadState();
  if (!state) { state = seed(); saveState(state); }
  if (!state.docs) state.docs = { logo: null, license: null };
  if (!state.restaurant) state.restaurant = seed().restaurant;
  if (!state.restaurant.purposes) state.restaurant.purposes = ["Dine In", "Take Away"];

  function menuSource() {
    if (state.menu && state.menu.categories && state.menu.categories.length) return state.menu;
    /* a real restaurant with no menu yet must not be shown the sample dishes */
    if (state.restaurantId) return { categories: [] };
    return DEMO_MENU;
  }

  function save() { saveState(state); }

  /* ---------------- toast ---------------- */

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 2200);
  }

  /* ---------------- QR ---------------- */

  function qrDataUrl(text, px) {
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 3;
      const size = (n + quiet * 2) * (px || 8);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#12161a";
      for (let r = 0; r < n; r++) {
        for (let col = 0; col < n; col++) {
          if (qr.isDark(r, col)) ctx.fillRect((col + quiet) * px, (r + quiet) * px, px, px);
        }
      }
      return c.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  function paintQR(host, handle) {
    if (!host) return;
    host.innerHTML = "";
    if (!handle) return;
    const src = qrDataUrl(PUBLIC_BASE + handle, 8);
    if (!src) { host.textContent = "QR unavailable"; return; }
    const img = document.createElement("img");
    img.src = src;
    img.alt = "QR code for " + publicLink(handle);
    img.dataset.qr = src;
    host.appendChild(img);
  }

  function downloadQR(host, handle) {
    const img = host && host.querySelector("img");
    if (!img) { toast("Claim your link first"); return; }
    const a = document.createElement("a");
    a.href = img.dataset.qr || img.src;
    a.download = "digimenu-qr-" + handle + ".png";
    a.click();
  }

  /* ---------------- routing ---------------- */

  const VIEW_TITLES = {
    overview: "Overview",
    menu: "Menu",
    import: "Import menu",
    qr: "QR & link",
    orders: "Orders",
    docs: "Documents"
  };

  function showView(name) {
    $$("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    $$(".side-nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === name));
    $("#pageTitle").textContent = VIEW_TITLES[name] || "Overview";
    const topImport = $('.topbar [data-view="import"]');
    if (topImport) topImport.style.display = name === "import" ? "none" : "";
    location.hash = name === "overview" ? "" : name;
    if (name === "menu") renderMenuEditor();
    if (name === "orders") renderOrders();
    if (name === "docs") { renderDocs(); renderProfile(); }
    if (name === "qr") renderQrPane();
    if (name === "overview") renderOverview();
  }

  $$("[data-view]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showView(el.dataset.view);
    })
  );

  $("#signOut").addEventListener("click", () => {
    window.Auth.signOut();
    location.href = "login.html";
  });

  /* ---------------- onboarding ---------------- */

  let obStep = 2;

  function showOb(step) {
    obStep = step;
    $("#onboard").hidden = false;
    $("#shell").style.display = "none";
    [2, 3, 4].forEach((s) => { $("#ob" + s).hidden = s !== step; });
    $("#obSteps").innerHTML = STEPS.map((label, i) => {
      const n = i + 1; // displayed as 1..3 of the restaurant setup
      const real = i + 2;
      const cls = real < step ? "done" : real === step ? "current" : "";
      return `<div class="ob-step ${cls}">
        <div class="n">${real < step ? "✓" : n}</div>
        <div class="l">${label}<small>${i === 0 ? "Channels and WhatsApp" : i === 1 ? "Logo and licence" : "Address and QR"}</small></div>
      </div>`;
    }).join("");

    if (step === 3) renderObDocs();
    if (step === 4) {
      const h = $("#handle");
      if (!h.value) h.value = slugify(state.restaurant.name || state.account.name || "");
      checkHandle(h.value);
    }
  }

  $$("[data-ob]").forEach((b) =>
    b.addEventListener("click", () => {
      const n = Number(b.dataset.ob);
      if (n === 1) { location.href = "login.html?mode=up"; return; }
      showOb(n);
    })
  );

  // step 2 ------------------------------------------------------------------

  const choices = $$("#purposeChoices .choice");

  function syncChoices() {
    choices.forEach((lab) => { lab.dataset.checked = String($("input", lab).checked); });
    state.restaurant.purposes = choices.filter((l) => $("input", l).checked).map((l) => $("input", l).value);
  }
  choices.forEach((lab) => $("input", lab).addEventListener("change", syncChoices));

  function markErr(input, errEl, bad) {
    input.classList.toggle("err", !!bad);
    errEl.classList.toggle("show", !!bad);
    return !bad;
  }

  $("#formRestaurant").addEventListener("submit", (e) => {
    e.preventDefault();
    const rn = $("#restName"), wa = $("#waNum");
    const waDial = $("#waCC").value;
    const waProblem = DigiPhone.problem(waDial, wa.value);
    $("#waErr").textContent = waProblem || "Without a WhatsApp number, orders have nowhere to go.";
    let ok = true;
    ok = markErr(rn, $("#restNameErr"), !rn.value.trim()) && ok;
    ok = markErr(wa, $("#waErr"), !!waProblem) && ok;
    const noPurpose = state.restaurant.purposes.length === 0;
    $("#purposeErr").classList.toggle("show", noPurpose);
    if (!ok || noPurpose) return;

    state.restaurant.name = rn.value.trim();
    state.restaurant.ownerName = $("#ownerName").value.trim();
    state.restaurant.whatsapp = DigiPhone.toE164(waDial, wa.value);
    const oe = $("#orderEmail").value.trim();
    state.restaurant.orderEmail = oe || state.account.email;
    save();
    showOb(3);
  });

  // step 3 ------------------------------------------------------------------

  function readAsDataURL(file, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.readAsDataURL(file);
  }

  function wireUpload(inputSel, rowSel, handler) {
    const input = $(inputSel), row = $(rowSel);
    if (!input) return;
    input.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handler(f);
    });
    if (row) {
      ["dragenter", "dragover"].forEach((ev) => row.addEventListener(ev, (e) => { e.preventDefault(); row.classList.add("dragover"); }));
      ["dragleave", "drop"].forEach((ev) => row.addEventListener(ev, (e) => { e.preventDefault(); row.classList.remove("dragover"); }));
      row.addEventListener("drop", (e) => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handler(f);
      });
    }
  }

  function acceptLogo(file, done) {
    if (!/^image\//.test(file.type)) { toast("Use a PNG or JPG for the logo"); return; }
    readAsDataURL(file, (url) => {
      state.docs.logo = url;
      const img = new Image();
      img.onload = () => {
        extractPalette(img, (pal) => {
          if (pal) { state.accent = pal.hex; state.swatches = pal.swatches; }
          save();
          if (obStep === 3 && !$("#onboard").hidden) renderObDocs(); else renderDocs();
          renderOverview();
          if (done) done();
        });
      };
      img.src = url;
    });
  }

  wireUpload("#obFileLogo", "#obRowLogo", (f) => acceptLogo(f, () => toast("Logo added — colours read from it")));
  wireUpload("#fileLogo", "#rowLogo", (f) => acceptLogo(f, () => toast("Logo updated")));

  function acceptLicence(file, ob) {
    state.docs.license = file.name;
    save();
    if (ob) renderObDocs(); else renderDocs();
    renderOverview();
    toast("Licence received");
  }

  wireUpload("#obFileLic", "#obRowLic", (f) => acceptLicence(f, true));
  wireUpload("#fileLic", "#rowLic", (f) => acceptLicence(f, false));

  function renderObDocs() {
    const { logo, license } = state.docs;
    if (logo) {
      $("#obThumbLogo").innerHTML = `<img src="${logo}" alt="">`;
      $("#obDescLogo").textContent = "Received" + (state.accent ? " · colour " + state.accent : "");
      $("#obPillLogo").className = "pill pill-ok";
      $("#obPillLogo").textContent = "Added";
      $("#obRowLogo").classList.add("has");
    }
    if (license) {
      $("#obThumbLic").innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.2"/></svg>`;
      $("#obDescLic").textContent = "Received";
      $("#obPillLic").className = "pill pill-ok";
      $("#obPillLic").textContent = "Added";
      $("#obRowLic").classList.add("has");
    }
    $("#obMaps").value = state.restaurant.mapsUrl || "";
  }

  $("#obMaps").addEventListener("input", (e) => {
    state.restaurant.mapsUrl = e.target.value.trim();
    save();
  });

  $("#toOb4").addEventListener("click", () => showOb(4));

  // step 4 ------------------------------------------------------------------

  const handleInput = $("#handle");
  let handleTimer = null;
  let handleFree = false;

  function checkHandle(raw) {
    const v = slugify(raw);
    handleInput.value = v;
    $("#suggestions").innerHTML = "";
    if (!v || v.length < 3) {
      handleFree = false;
      $("#handleStatus").className = "handle-status";
      $("#handleStatus").textContent = v ? "At least 3 characters." : "";
      $("#handleStatus").style.color = v ? "var(--danger)" : "";
      $("#finishOb").disabled = true;
      return;
    }
    $("#handleStatus").className = "handle-status busy";
    $("#handleStatus").textContent = "Checking availability…";
    $("#handleStatus").style.color = "";

    clearTimeout(handleTimer);
    handleTimer = setTimeout(async () => {
      let free = false;
      let reason = "";
      try {
        const res = await fetch(window.Auth.apiBase + "/api/restaurant?check=" + encodeURIComponent(v));
        const data = await res.json();
        free = Boolean(data.available);
        reason = data.reason || "";
      } catch (e) {
        $("#handleStatus").className = "handle-status";
        $("#handleStatus").textContent = "Could not check that address. Try again.";
        $("#finishOb").disabled = true;
        return;
      }

      if (!free) {
        handleFree = false;
        $("#handleStatus").className = "handle-status taken";
        $("#handleStatus").textContent = reason === "too-short"
          ? "Use at least 3 characters."
          : publicLink(v) + " is already taken.";
        $("#suggestions").innerHTML = [v + "-abudhabi", v + "-uae", v + "-menu", v + "1"]
          .map((s) => `<button type="button" data-sug="${s}">${s}</button>`).join("");
        $$("#suggestions button").forEach((b) => b.addEventListener("click", () => checkHandle(b.dataset.sug)));
      } else {
        handleFree = true;
        $("#handleStatus").className = "handle-status free";
        $("#handleStatus").textContent = "Available. It becomes yours when you finish.";
        state.handle = v;
        save();
        $("#linkOb").textContent = publicLink(v);
        paintQR($("#qrOb"), v);
      }
      $("#finishOb").disabled = !handleFree;
    }, 380);
  }

  handleInput.addEventListener("input", () => {
    handleInput.value = handleInput.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    checkHandle(handleInput.value);
  });

  $("#finishOb").addEventListener("click", async () => {
    if (!handleFree) return;
    const btn = $("#finishOb");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";

    const payload = {
      name: state.restaurant.name,
      handle: state.handle,
      owner_name: state.restaurant.ownerName || (state.account && state.account.name) || "",
      whatsapp_e164: state.restaurant.whatsapp,
      order_email: state.restaurant.orderEmail || (state.account && state.account.email) || "",
      purposes: state.restaurant.purposes,
      accent: state.accent,
      maps_url: state.restaurant.mapsUrl || null
    };

    const r = await window.Auth.api("/api/restaurant", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) {
      toast(r.data.message || "Could not save your restaurant.");
      return;
    }

    applyRestaurant(r.data.restaurant);
    location.href = "app.html#overview";
  });

  /* ---------------- overview ---------------- */

  function renderOverview() {
    const { logo, license } = state.docs;
    const hasMenu = !!(state.menu || state.menuImported);
    const items = [
      { key: "logo", label: "Restaurant logo", note: logo ? "Added" : "Used on the menu header", ok: !!logo, go: "docs" },
      { key: "lic", label: "Trade licence copy", note: license ? "Added" : "Needed before publishing", ok: !!license, go: "docs" },
      { key: "menu", label: "Menu content", note: hasMenu ? "Imported · review any time" : "Import a photo or a link", ok: hasMenu, go: "import" },
      { key: "maps", label: "Google Maps link", note: state.restaurant.mapsUrl ? "Added" : "Optional", ok: !!state.restaurant.mapsUrl, optional: true, go: "docs" }
    ];

    $("#checkList").innerHTML = items.map((it) => `
      <div class="check-row ${it.ok ? "ok" : "todo"}">
        <span class="ic">${it.ok ? "✓" : "!"}</span>
        <span class="lbl"><b>${it.label}</b><span>${it.note}</span></span>
        ${it.ok ? '<span class="pill pill-ok">Done</span>'
                : it.optional ? '<span class="pill">Optional</span>'
                : `<button class="btn btn-outline btn-sm" type="button" data-go="${it.go}">Add</button>`}
      </div>`).join("");

    $$("[data-go]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));

    const ready = !!(logo && license);
    $("#publishPill").className = "pill " + (ready ? "pill-ok" : "pill-warn");
    $("#publishPill").textContent = ready ? "Ready to publish" : "Draft";
    $("#publishHint").textContent = ready
      ? "Everything needed is here. Publish when you are happy with the menu."
      : "Two things are needed before guests can see this menu.";
    $("#topStatus").className = "pill " + (ready ? "pill-ok" : "pill-warn");
    $("#topStatus").textContent = ready ? "Ready to publish" : "Trial";
    $("#sideStatus").textContent = ready ? "Ready to publish" : "Trial · not published";
    $("#sideDot").className = "dot" + (ready ? " live" : "");
    $("#sideRest").textContent = state.restaurant.name || "Your restaurant";

    $("#linkOverview").textContent = publicLink(state.handle);
    paintQR($("#qrOverview"), state.handle);

    const cats = menuSource().categories;
    const total = cats.reduce((n, c) => n + c.items.length, 0);
    const sold = cats.reduce((n, c) => n + c.items.filter((i) => i.soldOut).length, 0);
    $("#menuGlance").innerHTML = `
      <div class="check-row"><span class="lbl"><b>${cats.length} categories</b><span>${total} dishes</span></span></div>
      <div class="check-row"><span class="lbl"><b>${sold} sold out</b><span>${sold ? "Hidden from ordering, still visible" : "Everything is available"}</span></span></div>
      <div class="check-row" style="border-bottom:none"><span class="lbl"><b>${state.restaurant.purposes.join(" · ")}</b><span>Order types enabled</span></span></div>`;

    renderRecentOrders();
  }

  function orders() {
    try { return JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]"); } catch (e) { return []; }
  }

  function renderRecentOrders() {
    const list = orders().slice(0, 3);
    const host = $("#recentOrders");
    if (!list.length) {
      host.innerHTML = `<div class="empty"><b>No orders yet</b>When a guest sends an order it arrives in your WhatsApp, and a copy appears here.</div>`;
      return;
    }
    host.innerHTML = list.map(orderRowHtml).join("");
  }

  function orderRowHtml(o) {
    const d = new Date(o.ts);
    const when = d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    const place = o.mode === "Dine In" ? "Table " + o.table : o.mode === "Take Away" ? o.pickup : "Delivery";
    return `<div class="order-row">
      <span class="ot">${when}</span>
      <span>${o.guest} · ${o.count} item${o.count === 1 ? "" : "s"}</span>
      <span class="omode"><span class="pill">${o.mode}</span> <span class="ot">${place}</span></span>
      <span class="otot">AED ${o.total}</span>
    </div>`;
  }

  function renderOrders() {
    const list = orders();
    const host = $("#ordersList");
    if (!list.length) {
      host.innerHTML = `<div class="empty"><b>No orders recorded yet</b>Orders are sent from the guest's own WhatsApp to your number. A copy is kept here so you have a record of what came through.</div>`;
      return;
    }
    host.innerHTML = list.map(orderRowHtml).join("");
  }

  $("#dlOverview").addEventListener("click", () => downloadQR($("#qrOverview"), state.handle));

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

  /* ---------------- import ---------------- */

  const drop = $("#dropZone");
  const fileMenu = $("#fileMenu");

  $$(".import-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".import-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("#tabFile").hidden = b.dataset.tab !== "file";
      $("#tabLink").hidden = b.dataset.tab !== "link";
    })
  );

  drop.addEventListener("click", () => fileMenu.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileMenu.click(); } });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startScan("your menu photo");
  });
  fileMenu.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) startScan(f.name);
  });

  /* The link reader is real: it calls the deployed API, which reads Talabat's
     menu payload. Photo reading is still simulated, and says so on screen. */
  const API_BASE = /(^|\.)vercel\.app$/i.test(location.hostname)
    ? ""
    : "https://digimenu-blush.vercel.app";

  let pendingImport = null;
  let scanning = false;

  $("#importLink").addEventListener("click", () => {
    const url = $("#partnerUrl").value.trim();
    if (!/^https?:\/\/.+/i.test(url)) { toast("Paste the full link, starting with https://"); return; }
    readLink(url);
  });

  function scanOn() {
    $("#scan").hidden = false;
    $("#review").hidden = true;
    $("#protoNote").hidden = true;
    const err = $("#importError");
    if (err) err.hidden = true;
    const note = $("#linkNote");
    if (note) note.hidden = false;
    $$("#scanSteps div").forEach((s) => s.classList.remove("on"));
    $("#scanBar").style.width = "8%";
  }

  function scanProgress(stepMs) {
    const nodes = $$("#scanSteps div");
    let i = 0;
    return new Promise((resolve) => {
      const tick = () => {
        if (i > 0) nodes[i - 1].classList.add("on");
        $("#scanBar").style.width = Math.min(92, 8 + (i + 1) * 22) + "%";
        i++;
        if (i <= nodes.length) setTimeout(tick, stepMs);
        else {
          nodes.forEach((n) => n.classList.add("on"));
          $("#scanBar").style.width = "100%";
          setTimeout(resolve, 240);
        }
      };
      setTimeout(tick, 180);
    });
  }

  async function readLink(url) {
    if (scanning) return;
    scanning = true;
    scanOn();
    toast("Reading the page…");

    const progress = scanProgress(360);
    let data = null;

    try {
      const res = await fetch(API_BASE + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      data = await res.json();
    } catch (e) {
      data = { ok: false, message: "We could not reach the reader. Check your connection and try again.", fallback: "photo" };
    }

    await progress;
    scanning = false;

    if (data && data.ok) showImportResult(data);
    else showImportFailure(data);
  }

  function showImportResult(data) {
    pendingImport = data;
    const rows = [];
    data.categories.forEach((c) =>
      c.items.forEach((it) => rows.push({ cat: c.name, name: it.name, price: it.price, image: it.image }))
    );

    $("#reviewRows").innerHTML = rows.map((r, i) => `
      <label class="review-row">
        <input type="checkbox" checked data-review="${i}">
        <span><span class="rc">${r.cat}</span><br>${r.name}</span>
        <span class="rp">${r.price == null ? "—" : "AED " + r.price}</span>
        <span class="rconf ${r.image ? "" : "low"}">${r.image ? "photo" : "no photo"}</span>
      </label>`).join("");

    $("#reviewSummary").textContent =
      data.itemCount + " dishes in " + data.categories.length + " categories · " +
      data.withImages + " with photos" +
      (data.restaurant && data.restaurant.name ? " · read from " + data.restaurant.name : "");

    $("#review").hidden = false;
    $("#protoNote").hidden = false;
    $("#protoNote").innerHTML =
      "<b>Read from " + data.source + ".</b> " +
      (data.imagesNotice || "Check every line before publishing.") +
      " Nothing reaches the guest menu until you press <b>Add to my menu</b>.";
    $("#review").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function showImportFailure(data) {
    const box = $("#importError");
    const msg = (data && (data.fallbackMessage || data.message)) || "That link could not be read.";
    const why = data && data.message && data.fallbackMessage ? data.message : "";
    box.innerHTML =
      '<div><b>We could not read that page.</b></div>' +
      '<div style="margin-top:6px">' + msg + "</div>" +
      (why ? '<div style="margin-top:6px;font-size:12.5px;color:var(--ink-3)">' + why + "</div>" : "") +
      '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-brand btn-sm" type="button" id="fallbackPhoto">Upload a photo instead</button>' +
      '<button class="btn btn-outline btn-sm" type="button" id="fallbackDismiss">Close</button>' +
      "</div>";
    box.hidden = false;
    $("#scan").hidden = true;
    const staticNote = $("#linkNote");
    if (staticNote) staticNote.hidden = true;   /* the box now says it once */

    const go = $("#fallbackPhoto");
    if (go) go.addEventListener("click", () => {
      $$(".import-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x.dataset.tab === "file")));
      $("#tabFile").hidden = false;
      $("#tabLink").hidden = true;
      box.hidden = true;
    });
    const close = $("#fallbackDismiss");
    if (close) close.addEventListener("click", () => { box.hidden = true; });
  }

  /* the photo tab is still a simulation and says so */
  function startScan(label) {
    if (scanning) return;
    scanning = true;
    scanOn();
    toast("Reading " + label);
    scanProgress(520).then(() => {
      pendingImport = null;
      $("#protoNote").hidden = false;
      $("#protoNote").innerHTML =
        "<b>Prototype.</b> Photo reading is not connected in this build. The rows below are sample data, not what a model returned.";
      showSampleReview();
      scanning = false;
    });
  }

  function showSampleReview() {
    const rows = [];
    DEMO_MENU.categories.slice(0, 5).forEach((c) => {
      c.items.slice(0, 2).forEach((it) => rows.push({ cat: c.name, name: it.name, price: it.price, image: true }));
    });
    $("#reviewRows").innerHTML = rows.map((r, i) => `
      <label class="review-row">
        <input type="checkbox" checked data-review="${i}">
        <span><span class="rc">${r.cat}</span><br>${r.name}</span>
        <span class="rp">AED ${r.price}</span>
        <span class="rconf">sample</span>
      </label>`).join("");
    $("#reviewSummary").textContent = rows.length + " sample dishes";
    $("#review").hidden = false;
    $("#review").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("#discard").addEventListener("click", () => {
    $("#review").hidden = true;
    $("#scan").hidden = true;
    $("#protoNote").hidden = true;
    pendingImport = null;
  });

  $("#applyImport").addEventListener("click", async () => {
    const ticked = $$("[data-review]").filter((c) => c.checked).map((c) => Number(c.dataset.review));
    if (!ticked.length) { toast("Select at least one dish"); return; }

    if (!pendingImport) {
      state.menu = JSON.parse(JSON.stringify(DEMO_MENU));
      state.menuImported = true;
      save();
      toast(ticked.length + " sample dishes applied");
      showView("menu");
      return;
    }

    // real import: keep only the ticked dishes, preserving category order
    let cursor = 0;
    let kept = 0;
    const categories = [];

    pendingImport.categories.forEach((c, ci) => {
      const items = [];
      c.items.forEach((it, j) => {
        const flatIndex = cursor + j;
        if (ticked.indexOf(flatIndex) !== -1) {
          kept++;
          items.push({
            id: "i" + ci + "x" + j,
            name: it.name,
            desc: it.description || "",
            price: it.price == null ? 0 : it.price,
            diet: null,
            image: it.image || null,
            soldOut: false,
            source: pendingImport.source || "manual",
            sourceId: it.sourceId || null
          });
        }
      });
      cursor += c.items.length;
      if (items.length) categories.push({ id: "c" + ci, name: c.name, items: items });
    });

    state.menu = { categories: categories };
    state.menuImported = true;
    save();

    const btn = $("#applyImport");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";

    const r = await window.Auth.api("/api/save-menu", {
      method: "POST",
      body: JSON.stringify({ categories: categories })
    });

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) {
      toast(r.data.message || "Kept on this device only — the database refused it.");
      showView("menu");
      return;
    }

    toast(kept + " dishes saved to your menu");
    showView("menu");
  });

  /* ---------------- qr pane ---------------- */

  function renderQrPane() {
    $("#linkBig").textContent = publicLink(state.handle);
    paintQR($("#qrBig"), state.handle);
  }

  $("#dlBig").addEventListener("click", () => downloadQR($("#qrBig"), state.handle));

  /* ---------------- documents ---------------- */

  function renderDocs() {
    const { logo, license } = state.docs;
    if (logo) {
      $("#thumbLogo").innerHTML = `<img src="${logo}" alt="">`;
      $("#descLogo").textContent = "Added" + (state.accent ? " · colour " + state.accent : "");
      $("#pillLogo").className = "pill pill-ok";
      $("#pillLogo").textContent = "Added";
      $("#rowLogo").classList.add("has");
    }
    if (license) {
      $("#thumbLic").innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.2"/></svg>`;
      $("#descLic").textContent = "Received";
      $("#pillLic").className = "pill pill-ok";
      $("#pillLic").textContent = "Added";
      $("#rowLic").classList.add("has");
    }
    $("#mapsUrl").value = state.restaurant.mapsUrl || "";
  }

  $("#mapsUrl").addEventListener("input", (e) => {
    state.restaurant.mapsUrl = e.target.value.trim();
    save();
    renderOverview();
  });


  /* ---------------- guest page identity ---------------- */

  function renderProfile() {
    const set = (sel, val) => { const el = $(sel); if (el) el.value = val || ""; };
    set("#setTagline", state.restaurant.tagline);
    set("#setAddress", state.restaurant.address);
    set("#setCurrency", state.currency || "AED");
    const soc = state.social || {};
    set("#setIg", soc.instagram);
    set("#setFb", soc.facebook);
    set("#setTt", soc.tiktok);
    set("#setWeb", soc.website);
  }

  $("#saveProfile").addEventListener("click", async () => {
    const btn = $("#saveProfile");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";

    const payload = {
      tagline: $("#setTagline").value.trim(),
      address_line: $("#setAddress").value.trim(),
      currency: $("#setCurrency").value,
      instagram: $("#setIg").value.trim(),
      facebook: $("#setFb").value.trim(),
      tiktok: $("#setTt").value.trim(),
      website: $("#setWeb").value.trim()
    };

    const r = await window.Auth.api("/api/restaurant", { method: "POST", body: JSON.stringify(payload) });

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) { toast(r.data.message || "Could not save the guest page."); return; }

    applyRestaurant(r.data.restaurant);
    renderProfile();
    toast("Guest page updated");
  });

  /* ---------------- boot ---------------- */

  /* The restaurant row in Supabase is the source of truth; localStorage is a
     cache for the wizard's half-filled fields. */

  function applyRestaurant(r) {
    if (!r) return;
    state.restaurantId = r.id;
    state.restaurant.name = r.name || "";
    state.restaurant.ownerName = r.owner_name || "";
    if (Array.isArray(r.purposes) && r.purposes.length) state.restaurant.purposes = r.purposes;
    state.restaurant.whatsapp = r.whatsapp_e164 || "";
    state.restaurant.orderEmail = r.order_email || "";
    state.restaurant.mapsUrl = r.maps_url || "";
    state.handle = r.handle || state.handle;
    state.accent = r.accent || state.accent;
    state.status = r.status || "trial";
    state.currency = r.currency || "AED";
    state.restaurant.tagline = r.tagline || "";
    state.restaurant.address = r.address_line || "";
    state.restaurant.coverUrl = r.cover_url || "";
    state.social = {
      instagram: r.instagram || "",
      facebook: r.facebook || "",
      tiktok: r.tiktok || "",
      website: r.website || ""
    };
    state.onboarded = true;
    save();
  }

  function blankState(account) {
    return {
      account: account || null,
      restaurant: { name: "", ownerName: "", purposes: ["Dine In", "Take Away"], whatsapp: "", orderEmail: "", mapsUrl: "" },
      docs: { logo: null, license: null },
      handle: "",
      accent: "#f7941d",
      menuImported: false,
      menu: null,
      onboarded: false
    };
  }

  const obParam = new URLSearchParams(location.search).get("onboard");

  (async function boot() {
    /* sample data must never leak into a real account */
    if (!state.restaurantId) {
      const u = window.Auth.user() || {};
      const meta = u.user_metadata || {};
      const acct = state.account || (u.email ? { name: meta.name || "", email: u.email, mobile_e164: meta.mobile_e164 || "" } : null);
      state = blankState(acct);
      if (acct && acct.name) state.restaurant.ownerName = acct.name;
      saveState(state);
    }

    let saved = null;
    try {
      const r = await window.Auth.api("/api/restaurant");
      if (r.ok) saved = r.data.restaurant;
    } catch (e) {
      /* api() already sent us to the sign-in page on 401 */
    }

    if (saved) {
      applyRestaurant(saved);

      /* the menu lives in Postgres; pull it back so the editor shows what the
         guest page shows, trial or not */
      try {
        const m = await window.Auth.api("/api/menu?mine=1");
        if (m.ok && m.data.categories && m.data.categories.length) {
          state.menu = {
            categories: m.data.categories.map((c, i) => ({
              id: c.id,
              name: c.name,
              items: c.items.map((it, j) => ({
                id: it.id,
                name: it.name,
                desc: it.description || "",
                price: it.price == null ? 0 : it.price,
                diet: null,
                image: it.image || null,
                soldOut: !!it.soldOut
              }))
            }))
          };
          state.menuImported = true;
          save();
        }
      } catch (e) {
        /* an empty editor is better than a blocked dashboard */
      }
    }

    /* no restaurant yet, or the wizard was explicitly opened */
    if (!saved || obParam) {
      showOb(Number(obParam) || 2);
      $("#restName").value = state.restaurant.name || "";
      $("#ownerName").value = state.restaurant.ownerName || (state.account && state.account.name) || "";
      if (state.restaurant.orderEmail) $("#orderEmail").value = state.restaurant.orderEmail;
      syncChoices();
      const waSplit = DigiPhone.split(state.restaurant.whatsapp);
      if (waSplit.national) {
        $("#waCC").value = waSplit.dial;
        $("#waNum").value = waSplit.national;
      }
      return;
    }

    $("#shell").style.display = "";
    const hash = (location.hash || "").replace("#", "");
    renderOverview();
    showView(VIEW_TITLES[hash] ? hash : "overview");
  })();
})();

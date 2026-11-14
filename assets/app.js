/* ==========================================================================
   DigiMenu app: onboarding wizard, dashboard, menu editor, import, QR.
   No backend — everything persists in localStorage so the guest page and the
   dashboard read the same record.
   ========================================================================== */

(function () {
  "use strict";

  /* The dashboard is the signed-in surface: with no session there is nothing
     here to show. Every write is re-checked server-side against the same token.
     ?demo=1 is the one exception: the landing page embeds this page as its
     product screenshot, and without it the frame renders the sign-in card — a
     marketing picture that is really a second login page. Demo renders sample
     data, holds no session and writes nothing. */
  const DEMO = /(^|[?&])demo=1(&|$)/.test(location.search);

  if (!DEMO && (!window.Auth || !window.Auth.session())) {
    location.replace("/login.html");
    return;
  }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const KEY = "digimenu.state.v1";
  const STEPS = ["Your restaurant", "Documents", "Menu link"];
  const TAKEN = ["karak-house", "al-noor", "tandoori-nights", "biryani-point", "the-grill", "shishawi", "table9", "salt-pepper", "khan-mandi"];

  /* Where this build is actually served. On ogle.live the printed link is the
     real one; anywhere else (a preview deployment) the QR encodes the URL that
     resolves right now, so the code still scans to a live menu. */
  const PUBLIC_BASE = (function () {
    const cfg = (window.DIGIMENU_CONFIG && window.DIGIMENU_CONFIG.publicBase) || "";
    if (cfg) return cfg.replace(/\/?$/, "/");
    /* the landing page's screenshot prints the domain the marketing claims,
       not whatever host the preview happens to be served from */
    if (DEMO) return "https://digimenu.indubaicity.com/";
    /* no pinned domain: print the address the page is actually served from,
       keeping the /digimenu prefix if this copy lives in that subfolder */
    return location.origin + (/^\/digimenu/.test(location.pathname) ? "/digimenu/" : "/");
  })();

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
      accent: "#f0485f",
      menuImported: true,
      menu: null,
      onboarded: true
    };
  }

  let state = DEMO ? demoState() : loadState();
  /* a first visit must not open a sample restaurant — seed() is the demo
     tenant, and it is only ever right inside the landscape preview */
  if (!state) {
    state = DEMO ? seed() : { account: null, restaurant: null, docs: { logo: null, license: null },
      handle: "", accent: "#f0485f", menuImported: false, menu: null, onboarded: false };
  }
  if (!state.docs) state.docs = { logo: null, license: null };
  if (!state.restaurant) {
    state.restaurant = { name: "", ownerName: "", purposes: ["Dine In", "Take Away"], whatsapp: "", orderEmail: "", mapsUrl: "" };
  }
  if (!state.restaurant.purposes) state.restaurant.purposes = ["Dine In", "Take Away"];

  /* a demo frame must look finished, and must never touch the visitor's storage */
  function demoState() {
    const s = seed();
    s.docs = { logo: "demo", license: "demo" };
    s.restaurant.mapsUrl = "https://maps.google.com/?q=Spice+Route";
    s.restaurant.orderEmail = s.account.email;
    s.status = "published";
    return s;
  }

  function menuSource() {
    if (state.menu && state.menu.categories && state.menu.categories.length) return state.menu;
    /* the sample dishes are the landing page's picture; a real account with no
       menu gets an empty editor and the import button, not someone's demo food */
    return DEMO ? DEMO_MENU : { categories: [] };
  }

  function save() { if (!DEMO) saveState(state); }

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
    overview: "Today",
    menu: "Menu",
    import: "Import menu",
    qr: "QR & link",
    orders: "Orders",
    feedback: "Feedback",
    marketing: "Marketing",
    docs: "Settings",
    more: "More"
  };

  function showView(name) {
    $$("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    $$(".side-nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === name));
    $("#pageTitle").textContent = VIEW_TITLES[name] || "Overview";
    const topImport = $('.topbar [data-view="import"]');
    if (topImport) topImport.style.display = name === "import" ? "none" : "";
    location.hash = name === "overview" ? "" : name;
    if (name === "menu") {
      renderMenuEditor();
      /* the menu in memory can predate Arabic (or a price changed on another
         device); refresh from the server and repaint rather than trusting it */
      Promise.resolve(reloadOwnMenu()).then(() => renderMenuEditor()).catch(() => {});
    }
    if (name === "orders") renderOrders();
    if (name === "feedback") renderFeedback();
    if (name === "marketing") renderMarketing();
    if (name === "docs") { renderDocs(); renderProfile(); renderTeam(); }
    if (name === "qr") renderQrPane();
    renderGuestLinks();
    if (name === "overview") renderOverview();
  }

  $$("[data-view]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showView(el.dataset.view);
    })
  );

  /* ---------------- sub-menus ----------------
     Settings and Marketing each hold four screens; everything on one page was
     long enough to read as clutter. A sub-pane is a div inside the pane, so the
     ids the rest of this file renders into stay put whether it is open or not. */
  $$("[data-subnav]").forEach((nav) => {
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sub]");
      if (!btn || !nav.contains(btn)) return;
      const group = nav.dataset.subnav;
      $$('[data-subnav="' + group + '"] [data-sub]').forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn)));
      $$('[data-subpane-group="' + group + '"] > .subpane').forEach((p) => {
        p.hidden = p.dataset.sub !== btn.dataset.sub;
      });
    });
  });

  // one sign-out action, reachable from the rail on a desktop and from the
  // More screen on a phone
  ["#signOut", "#signOutMore"].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("click", () => {
      const staff = state.role && state.role !== "owner";
      const handle = state.handle;
      window.Auth.signOut();
      location.href = staff && handle ? "/" + handle + "/login" : "/login.html";
    });
  });

  /* ---------------- team logins (owner only) ----------------
     A name and a password per person, created here and handed over by the owner.
     The staff door is this restaurant's own address, so a name is scoped to one
     menu: the server builds the identity from (handle + name). */

  async function renderTeam() {
    const host = $("#tmList");
    if (!host) return;

    const r = await window.Auth.api("/api/team");
    if (!r.ok) {
      host.innerHTML = '<p class="hint">' + esc(r.data.message || "The team list could not be loaded.") + "</p>";
      return;
    }

    const handle = (r.data && r.data.handle) || state.handle || "";
    const list = (r.data && r.data.members) || [];
    const where = (location.host || "digimenu.indubaicity.com") + "/" + handle + "/login";

    host.innerHTML =
      '<p class="hint" style="margin-top:14px">Staff sign in at <b>' + esc(where) + "</b> with the name and password you set. Nothing is emailed — you hand it over, and a new password is set the same way.</p>" +
      (list.length
        ? list.map((m) =>
            '<div class="team-row"><span><span class="who">' + esc(m.username) + "</span> " +
            '<span class="meta">' + (m.role === "menu" ? "Menu and orders" : "Orders only") +
            (m.last_sign_in_at ? " · last signed in " + esc(new Date(m.last_sign_in_at).toLocaleDateString()) : " · never signed in") +
            "</span></span>" +
            '<button class="btn btn-outline btn-sm" type="button" data-np="' + esc(m.username) + '">New password</button>' +
            '<button class="btn btn-outline btn-sm" type="button" data-rm="' + esc(m.username) + '">Remove</button></div>'
          ).join("")
        : '<p class="hint">No staff logins yet.</p>');

    /* a forgotten password is not a reset link — the owner makes a new one here
       and reads it out, which is the same act as the first time */
    $$("[data-np]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const username = btn.dataset.np;
        const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        const b = crypto.getRandomValues(new Uint8Array(10));
        let password = "";
        for (let i = 0; i < 10; i++) password += A[b[i] % A.length];

        btn.disabled = true;
        const d = await window.Auth.api("/api/team", {
          method: "POST",
          body: JSON.stringify({ action: "password", username, password })
        });
        btn.disabled = false;
        if (!d.ok) { toast(d.data.message || "Could not set a new password."); return; }

        const row = btn.closest(".team-row");
        let line = row && row.querySelector(".newpw");
        if (line) {
          line.innerHTML = "New password: <b>" + esc(password) + "</b> — write it down now.";
        } else if (row) {
          line = document.createElement("span");
          line.className = "meta newpw";
          line.innerHTML = "New password: <b>" + esc(password) + "</b> — write it down now.";
          row.appendChild(line);
        }
        toast("New password set. The old one stops working immediately.");
      })
    );

    $$("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        /* removing a login kills a password that is in somebody's pocket. Two
           presses, then it is a decision. */
        if (btn.dataset.armed !== "1") {
          btn.dataset.armed = "1";
          btn.textContent = "Sure?";
          setTimeout(() => {
            if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = "Remove"; }
          }, 4000);
          return;
        }
        btn.disabled = true;
        const d = await window.Auth.api("/api/team", {
          method: "POST",
          body: JSON.stringify({ action: "remove", username: btn.dataset.rm })
        });
        if (!d.ok) { btn.disabled = false; toast(d.data.message || "That login was not removed."); return; }
        toast("Login removed — that password stops working now.");
        renderTeam();
      })
    );
  }

  const tmAdd = $("#tmAdd");
  if (tmAdd) {
    tmAdd.addEventListener("click", async () => {
      const n = $("#tmName"), p = $("#tmPass"), role = $("#tmRole");
      let ok = true;
      n.value = n.value.trim().toLowerCase();
      ok = markErr(n, $("#tmNameErr"), !/^[a-z0-9][a-z0-9._-]{1,23}$/.test(n.value)) && ok;
      ok = markErr(p, $("#tmPassErr"), p.value.length < 6) && ok;
      if (!ok) return;

      const label = tmAdd.textContent;
      tmAdd.disabled = true;
      tmAdd.textContent = "Creating…";

      const r = await window.Auth.api("/api/team", {
        method: "POST",
        body: JSON.stringify({ action: "create", username: n.value, password: p.value, role: role.value })
      });

      tmAdd.disabled = false;
      tmAdd.textContent = label;

      if (!r.ok) {
        n.classList.add("err");
        $("#tmNameErr").textContent = r.data.message || "That login could not be created.";
        $("#tmNameErr").classList.add("show");
        return;
      }

      n.value = ""; p.value = "";
      $("#tmNameErr").classList.remove("show");
      $("#tmPassErr").classList.remove("show");
      toast("Created. Hand over the name and password you just set.");
      renderTeam();
    });
  }



  /* ---------------- marketing ----------------
     Asking past customers how it went. Two senders, one queue: 'free' opens
     WhatsApp with the message typed and a human presses send; 'cloud' lets the
     server do it, paced, for restaurants that have a WhatsApp Business account.
     Either way the message carries a private link, and only that page decides
     whether a happy guest is offered the Google review link. */

  const mk = { mode: "free", customers: null, queue: [] };

  const mkLink = (token) => location.origin + "/f/" + token;

  function mkText(name, link) {
    const first = String(name || "").trim().split(/\s+/)[0];
    return (first ? "Hello " + first + ", " : "Hello, ") +
      "thank you for ordering from " + (state.restaurant.name || "us") + "." +
      "\n\nHow was it? Two taps, honestly — it helps us more than you would think:\n" + link;
  }

  function mkWa(phone, text) {
    return "https://wa.me/" + String(phone).replace(/[^\d]/g, "") + "?text=" + encodeURIComponent(text);
  }

  async function mkLoadSettings() {
    const r = await window.Auth.api("/api/marketing?settings=1");
    if (!r.ok) {
      $("#mkModePill").textContent = "Not ready";
      $("#mkGoogle").parentNode.querySelector(".hint").textContent = r.data.message || "Marketing settings could not be loaded.";
      return;
    }
    const d = r.data;
    mk.mode = d.sender;
    $("#mkFreeIn").checked = d.sender === "free";
    $("#mkCloudIn").checked = d.sender === "cloud";
    $("#mkModePill").textContent = d.sender === "cloud" ? "Cloud API" : "Free";
    $("#mkCloudFields").hidden = d.sender !== "cloud";
    $("#mkPhoneId").value = d.phoneNumberId || "";
    $("#mkTemplate").value = d.template || "";
    $("#mkLang").value = d.lang || "en";
    $("#mkGoogle").value = d.google || "";
    const wo = $("#mkWaOrder");
    if (wo) wo.value = d.waOrderNumber || "";
    $("#mkTokenHint").textContent = d.tokenHint ? "Saved token " + d.tokenHint : "No token saved yet";
  }

  async function mkSaveSettings(patch) {
    const r = await window.Auth.api("/api/marketing?settings=1", { method: "POST", body: JSON.stringify(patch) });
    if (!r.ok) { toast(r.data.message || "Those settings were not saved."); return null; }
    await mkLoadSettings();
    return r.data;
  }

  /* an order marked Done is a guest who ate, paid and left happy enough to be
     asked. This is where those people surface. */
  /* An order marked Done is a guest who ate, paid and left. This is where
     those people surface, and the button here queues them for the ask — the
     same queue the sending card below already drains. */
  async function mkLoadDone() {
    const card = $("#mkDoneCard"), body = $("#mkDoneBody");
    if (!card || !body) return;

    const all = await loadOrders();
    const done = (all || []).filter((o) => o.status === "confirmed");
    if (!done.length) { card.hidden = true; body.innerHTML = ""; return; }

    card.hidden = false;
    $("#mkDoneCount").textContent = done.length;

    body.innerHTML =
      '<div class="mk-done-bar">' +
        '<label class="chk"><input type="checkbox" id="mkDoneAll"> Select all</label>' +
        '<button class="btn btn-brand btn-sm" type="button" id="mkDoneAsk">Ask these people</button>' +
      '</div>' +
      done.slice(0, 60).map((o) => {
        const when = new Date(o.ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        return '<label class="mk-done-row">' +
          '<input type="checkbox" class="mk-done-chk" value="' + esc(o.id) + '">' +
          '<span><span class="who">' + esc(o.guest || "Guest") + '</span> ' +
            '<span class="meta">' + esc(o.phone || "no number") + ' · ' + esc(when) + ' · ' + esc(o.mode || "") + '</span></span>' +
          '<span class="amt">' + esc(money(o.total)) + '</span>' +
        '</label>';
      }).join("");
  }

  /* the rows are rebuilt on every load, so these two are delegated rather than
     bound to elements that keep being replaced */
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === "mkDoneAll") {
      const on = e.target.checked;
      Array.from(document.querySelectorAll(".mk-done-chk")).forEach((c) => { c.checked = on; });
    }
  });

  document.addEventListener("click", async (e) => {
    if (!e.target || e.target.id !== "mkDoneAsk") return;
    const btn = e.target;
    const ids = Array.from(document.querySelectorAll(".mk-done-chk:checked")).map((c) => c.value);
    if (!ids.length) { toast("Tick who you want to ask."); return; }
    btn.disabled = true;
    const r = await window.Auth.api("/api/marketing?queue=1", { method: "POST", body: JSON.stringify({ orderIds: ids }) });
    btn.disabled = false;
    if (!r.ok) { toast((r.data && r.data.message) || "That did not work."); return; }
    toast("Queued " + r.data.queued + (r.data.skipped ? " · " + r.data.skipped + " already asked or no number" : ""));
    await mkLoadQueue();
  });

  async function mkLoadQueue() {
    const r = await window.Auth.api("/api/marketing?queue=1");
    if (!r.ok) return;
    mk.queue = r.data.rows || [];
    mkPaintQueue();
  }

  function mkPaintQueue() {
    const card = $("#mkQueueCard");
    const body = $("#mkQueueBody");
    if (!card || !body) return;

    if (!mk.queue.length) { card.hidden = true; body.innerHTML = ""; return; }
    card.hidden = false;

    const free = mk.mode !== "cloud";
    $("#mkQueueTitle").textContent = free ? "Tap to send — " + mk.queue.length + " waiting" : "Sending — " + mk.queue.length + " waiting";
    $("#mkQueueLede").textContent = free
      ? "Each button opens WhatsApp with the message typed. Press send there, then come back — the row ticks itself off."
      : "The server sends these, paced, five at a time. You can close this tab.";

    body.innerHTML =
      (free
        ? '<div class="hint" style="margin-bottom:8px">Sending from your own number keeps it safe. Never send more than 20–30 in an hour.</div>'
        : '<button class="btn btn-brand btn-sm" type="button" id="mkCloudSend" style="margin-bottom:10px">Send the next 5</button><div class="hint" id="mkCloudProgress"></div>') +
      mk.queue.map((row, i) =>
        '<div class="mk-row" data-row="' + esc(row.id) + '">' +
          '<span class="grow"><span class="who">' + esc(row.guest_name || "Guest") + "</span> " +
          '<span class="meta">' + esc(row.phone || row.phone_raw || "") +
          (row.status === "failed" ? " · failed: " + esc(row.error || "") : "") + "</span></span>" +
          (free
            ? '<a class="btn btn-brand btn-sm" target="_blank" rel="noopener" href="' +
              esc(mkWa(row.phone, mkText(row.guest_name, mkLink(row.token)))) +
              '" data-wa="' + esc(row.id) + '">Open WhatsApp</a>'
            : "") +
        "</div>"
      ).join("");

    if (free) {
      $$("[data-wa]").forEach((a) =>
        a.addEventListener("click", async () => {
          const id = a.dataset.wa;
          a.closest(".mk-row").classList.add("done");
          a.textContent = "Opened";
          /* clicking the link is the only evidence we have; WhatsApp never
             tells us whether the send arrow was pressed */
          await window.Auth.api("/api/marketing?sent=1", { method: "POST", body: JSON.stringify({ id }) });
          const next = a.closest(".mk-row").nextElementSibling;
          if (next) { next.scrollIntoView({ block: "center" }); const b = next.querySelector("[data-wa]"); if (b) b.focus(); }
        })
      );
    } else {
      const send = $("#mkCloudSend");
      if (send) {
        send.addEventListener("click", async () => {
          send.disabled = true;
          const out = $("#mkCloudProgress");
          let sent = 0, failed = 0, guard = 0;
          while (guard++ < 40) {
            const r = await window.Auth.api("/api/marketing?cloud=1", { method: "POST", body: JSON.stringify({ limit: 5 }) });
            if (!r.ok) { out.textContent = r.data.message || "That batch failed."; break; }
            sent += r.data.sent; failed += r.data.failed;
            out.textContent = sent + " sent, " + failed + " failed, " + r.data.remaining + " left";
            if (!r.data.remaining) break;
          }
          send.disabled = false;
          toast(sent + " sent" + (failed ? ", " + failed + " failed" : ""));
          await mkLoadQueue();
        });
      }
    }
  }

  async function mkLoadReviews() {
    const r = await window.Auth.api("/api/marketing?reviews=1");
    const host = $("#mkReviews");
    if (!host) return;
    if (!r.ok) { host.innerHTML = '<p class="hint">' + esc(r.data.message || "No reviews yet.") + "</p>"; return; }
    const d = r.data;
    $("#mkReviewSummary").textContent = d.count
      ? d.average + " out of 5 from " + d.count + (d.count === 1 ? " answer" : " answers") + " · " + d.happy + " happy"
      : "Nothing yet. Ask the people who ordered.";
    host.innerHTML = d.count
      ? d.reviews.slice(0, 20).map((x) =>
          '<div class="mk-row"><span class="grow"><span class="mk-stars">' + "★".repeat(x.rating) + "☆".repeat(5 - x.rating) + "</span> " +
          '<span class="who">' + esc(x.name || "Guest") + "</span>" +
          (x.comment ? '<div class="meta">' + esc(x.comment) + "</div>" : "") +
          '<div class="meta">' + esc(new Date(x.at).toLocaleDateString()) + "</div></span></div>"
        ).join("")
      : "";
  }

  async function renderMarketing() {
    const f = $("#mkFrom"), t = $("#mkTo");
    if (f && !f.value) {
      const now = new Date();
      t.value = now.toISOString().slice(0, 10);
      f.value = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
    }
    await mkLoadSettings();
    dcWireOnce();
    await dcLoad();
    await mkLoadDone();
    await mkLoadQueue();
    await mkLoadReviews();
  }

  /* ------------------------------------------------------- discount codes
     A code is a percentage with a cap and a once-per-number rule; the server
     owns all three. This only draws what it returns. */
  async function dcLoad() {
    const list = $("#dcList");
    if (!list) return;
    list.innerHTML = '<div class="dc-empty">Loading…</div>';
    const r = await window.Auth.api("/api/marketing?discounts=1");
    if (!r.ok) {
      const d = r.data || {};
      list.innerHTML = '<div class="dc-empty">' +
        esc(d.code === "NO_DISCOUNTS"
          ? "Discount codes are not switched on yet."
          : (d.message || "Could not load the codes.")) + '</div>';
      return;
    }
    const d = r.data || {};
    const given = $("#dcGiven");
    if (given) given.textContent = "AED " + (d.givenAway || 0) + " given away";

    const codes = d.codes || [];
    if (!codes.length) {
      list.innerHTML = '<div class="dc-empty">No codes yet. The first one you make is live immediately.</div>';
      return;
    }
    list.innerHTML = codes.map(function (c) {
      const cap = c.maxAmount ? "max AED " + c.maxAmount : "no cap";
      const min = c.minOrder ? "min AED " + c.minOrder : "no minimum";
      return '<div class="dc-row ' + (c.active ? "" : "off") + '" data-id="' + esc(c.id) + '">' +
        '<div class="dc-code">' + esc(c.code) +
          '<small>' + esc(min) + ' · used ' + c.uses + ' time' + (c.uses === 1 ? "" : "s") + '</small></div>' +
        '<div class="dc-num">' + c.percent + '%</div>' +
        '<div class="dc-num">' + esc(cap) + '</div>' +
        '<div class="dc-num">' + (c.active ? "Live" : "Paused") + '</div>' +
        '<div class="dc-act">' +
          '<button class="btn btn-sm btn-quiet" type="button" data-dc-toggle="' + esc(c.id) + '" data-on="' + (c.active ? "0" : "1") + '">' +
            (c.active ? "Pause" : "Resume") + '</button>' +
          '<button class="btn btn-sm btn-quiet" type="button" data-dc-del="' + esc(c.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  function dcMsg(text, bad) {
    const el = $("#dcMsg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "hint" + (bad ? " bad" : "");
  }

  async function dcCreate() {
    const code = ($("#dcCode") || {}).value || "";
    const percent = ($("#dcPercent") || {}).value || "";
    const maxAmount = ($("#dcMax") || {}).value || "";
    const minOrder = ($("#dcMin") || {}).value || "";

    if (!code.trim() || !percent) { dcMsg("A code needs a name and a percentage.", true); return; }
    const btn = $("#dcCreate");
    if (btn) btn.disabled = true;
    const r = await window.Auth.api("/api/marketing?discounts=1", {
      method: "POST",
      body: JSON.stringify({ action: "create", code: code, percent: percent, maxAmount: maxAmount, minOrder: minOrder })
    });
    if (btn) btn.disabled = false;

    if (!r.ok) {
      const d = r.data || {};
      dcMsg(d.code === "NO_DISCOUNTS"
        ? "Discount codes are not switched on yet — run db/0019_discounts.sql."
        : (d.message || "That code did not save."), true);
      return;
    }
    $("#dcCode").value = ""; $("#dcPercent").value = ""; $("#dcMax").value = ""; $("#dcMin").value = "";
    dcMsg("Created — guests can use it now.", false);
    await dcLoad();
  }

  function dcWireOnce() {
    const create = $("#dcCreate");
    if (!create || create.dataset.wired) return;
    create.dataset.wired = "1";
    create.addEventListener("click", dcCreate);
  }

  function mkWireOnce() {
    const save = $("#mkSave");
    if (!save || save.dataset.wired) return;
    save.dataset.wired = "1";

    const paintMode = () => {
      const cloud = $("#mkCloudIn").checked;
      $("#mkCloudFields").hidden = !cloud;
      $("#mkModePill").textContent = cloud ? "Cloud API" : "Free";
      mk.mode = cloud ? "cloud" : "free";
      mkPaintQueue();
    };
    $$('input[name="mkSender"]').forEach((r) => r.addEventListener("change", async () => {
      paintMode();
      await mkSaveSettings({ mode: $("#mkCloudIn").checked ? "cloud" : "free" });
      toast($("#mkCloudIn").checked ? "Cloud API selected — connect it below." : "Free sending selected.");
    }));

    save.addEventListener("click", async () => {
      const patch = {
        google: $("#mkGoogle").value.trim(),
        waOrderNumber: (($("#mkWaOrder") || {}).value || "").trim(),
        template: $("#mkTemplate").value.trim(),
        lang: $("#mkLang").value.trim() || "en",
        phoneNumberId: $("#mkPhoneId").value.trim()
      };
      const tok = $("#mkToken").value.trim();
      if (tok) patch.token = tok;
      save.disabled = true;
      const d = await mkSaveSettings(patch);
      save.disabled = false;
      if (d) { $("#mkToken").value = ""; toast("Saved."); }
    });

    $("#mkLoad").addEventListener("click", async () => {
      const btn = $("#mkLoad");
      btn.disabled = true;
      btn.textContent = "Loading…";
      const r = await window.Auth.api("/api/marketing?customers=1&from=" + $("#mkFrom").value + "&to=" + $("#mkTo").value);
      btn.disabled = false;
      btn.textContent = "Load customers";
      const host = $("#mkList");
      if (!r.ok) { host.innerHTML = '<p class="hint">' + esc(r.data.message || "Could not load.") + "</p>"; $("#mkActions").hidden = true; return; }

      mk.customers = r.data.customers || [];
      if (!mk.customers.length) {
        host.innerHTML = '<p class="hint" style="margin-top:12px">No orders in that period.</p>';
        $("#mkActions").hidden = true;
        return;
      }

      host.innerHTML =
        '<div class="mk-row" style="margin-top:12px"><label style="display:flex;gap:8px;align-items:center;font-weight:600">' +
        '<input type="checkbox" id="mkAll" checked> Select all ' + mk.customers.length + " customers</label></div>" +
        mk.customers.map((c, i) =>
          '<div class="mk-row' + (c.usable ? "" : " dead") + '">' +
            '<input type="checkbox" data-pick="' + i + '"' + (c.usable && !c.skip ? " checked" : "") + (c.usable ? "" : " disabled") + ">" +
            '<span class="grow"><span class="who">' + esc(c.name || "Guest") + "</span> " +
            '<span class="meta">' + esc(c.usable ? "…" + c.phone.slice(-8) : "unusable: " + (c.raw || "blank")) +
            " · " + c.orders + (c.orders === 1 ? " order" : " orders") +
            " · " + esc(new Date(c.lastOrder).toLocaleDateString()) +
            (c.skip ? " · already asked" : "") + "</span></span>" +
          "</div>"
        ).join("");

      $("#mkActions").hidden = false;
      const count = () => {
        const n = $$("[data-pick]").filter((b) => b.checked).length;
        $("#mkCount").textContent = n + " selected";
        $("#mkQueue").disabled = !n;
      };
      $$("[data-pick]").forEach((b) => b.addEventListener("change", count));
      const all = $("#mkAll");
      all.checked = $$("[data-pick]").every((b) => b.checked || b.disabled);
      all.addEventListener("change", () => {
        $$("[data-pick]").forEach((b) => { if (!b.disabled) b.checked = all.checked; });
        count();
      });
      count();
    });

    $("#mkQueue").addEventListener("click", async () => {
      const picks = $$("[data-pick]").filter((b) => b.checked && !b.disabled).map((b) => mk.customers[Number(b.dataset.pick)].orderId);
      if (!picks.length) return;
      const btn = $("#mkQueue");
      btn.disabled = true;
      btn.textContent = "Building…";
      const r = await window.Auth.api("/api/marketing?queue=1", { method: "POST", body: JSON.stringify({ orderIds: picks }) });
      btn.disabled = false;
      btn.textContent = "Build the queue";
      if (!r.ok) { toast(r.data.message || "The queue could not be built."); return; }
      toast(r.data.queued + " added to the queue" + (r.data.skipped ? ", " + r.data.skipped + " skipped" : ""));
      await mkLoadQueue();
      $("#mkQueueCard").scrollIntoView({ block: "start" });
    });
  }

  mkWireOnce();

  /* ---------------- onboarding ---------------- */

  let obStep = 2;

  /* The wizard keeps the two documents the guest page and the publish gate
     need as *files* until the restaurant row exists — storage writes under the
     restaurant's handle, so nothing can be uploaded before the row is created.
     Holding them in memory is what lets "Open my dashboard" put them in the
     row on the way out; storing a data URL in localStorage (what this used to
     do) never reached the server, so the checklist said "Added" and publishing
     still answered "Still needed: logo, licence". */
  const pendingDocs = { logo: null, license: null };

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
      /* the printed address, from the same base the QR and every other link use:
         a hard-coded "ogle.live/digimenu/" told owners their address was one
         thing while the availability check named another */
      if ($("#handlePrefix")) $("#handlePrefix").textContent = PUBLIC_BASE.replace(/^https?:\/\//i, "");
      const h = $("#handle");
      if (!h.value) h.value = slugify(state.restaurant.name || state.account.name || "");
      checkHandle(h.value);
    }
  }

  $$("[data-ob]").forEach((b) =>
    b.addEventListener("click", () => {
      const n = Number(b.dataset.ob);
      if (n === 1) { location.href = "/login.html?mode=up"; return; }
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
      pendingDocs.logo = file;
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

  /* ---------------- file uploads ---------------- */

  async function uploadTo(kind, file) {
    if (!file) return null;
    if (file.size > 2_500_000) {
      toast("That file is " + (file.size / 1048576).toFixed(1) + " MB. Keep it under 2.5 MB.");
      return null;
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });

    const up = await window.Auth.api("/api/restaurant?upload=1", {
      method: "POST",
      body: JSON.stringify({ kind, dataUrl })
    });
    if (!up.ok) { toast(up.data.message || "That file could not be uploaded."); return null; }

    const column = kind === "logo" ? "logo_url" : kind === "cover" ? "cover_url" : "licence_url";
    const payload = {};
    payload[column] = up.data.url;
    const saved = await window.Auth.api("/api/restaurant", { method: "POST", body: JSON.stringify(payload) });
    if (!saved.ok) { toast(saved.data.message || "Uploaded, but the restaurant did not save."); return null; }

    applyRestaurant(saved.data.restaurant);
    return up.data.url;
  }

  wireUpload("#obFileLogo", "#obRowLogo", (f) => acceptLogo(f, () => toast("Logo added — colours read from it")));
  wireUpload("#fileLogo", "#rowLogo", async (f) => {
    const url = await uploadTo("logo", f);
    if (url) { state.docs.logo = url; save(); renderDocs(); toast("Logo uploaded"); }
  });

  function acceptLicence(file, ob) {
    state.docs.license = file.name;
    pendingDocs.license = file;
    save();
    if (ob) renderObDocs(); else renderDocs();
    renderOverview();
    toast("Licence received");
  }

  wireUpload("#obFileLic", "#obRowLic", (f) => acceptLicence(f, true));
  wireUpload("#fileLic", "#rowLic", async (f) => {
    const url = await uploadTo("licence", f);
    if (url) { state.docs.license = url; save(); renderDocs(); toast("Licence uploaded"); }
  });

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
    /* Typing a dash used to lose it: slugify drops a trailing separator, so the
       box was rewritten mid-word and "kings-kebab" arrived as "kingskebab".
       The box keeps what was typed (cleaned, trailing dash allowed); `v` stays
       the canonical handle that is checked, printed and saved. */
    const typed = String(raw || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");
    if (handleInput.value !== typed) handleInput.value = typed;
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
      let own = false;
      let reason = "";
      try {
        /* Signed in, the check can recognise the owner's own address: without
           the token every returning owner was told their own handle was taken
           and this button never came back to life. */
        const headers = {};
        if (window.Auth && window.Auth.session && window.Auth.session()) {
          headers.Authorization = "Bearer " + window.Auth.token();
        }
        const res = await fetch(window.Auth.apiBase + "/api/restaurant?check=" + encodeURIComponent(v), { headers });
        const data = await res.json();
        free = Boolean(data.available);
        own = Boolean(data.own);
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
        $("#handleStatus").textContent = own
          ? "This address is already yours — it stays as it is."
          : "Available. It becomes yours when you finish.";
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

    /* The row exists, so the two documents chosen in step 2 can finally be
       stored. Publishing is gated on them server-side; until this ran, a logo
       and a licence picked in the wizard existed only in this browser. */
    if (pendingDocs.logo) {
      btn.disabled = true;
      btn.textContent = "Uploading the logo…";
      await uploadTo("logo", pendingDocs.logo);
      pendingDocs.logo = null;
    }
    if (pendingDocs.license) {
      btn.disabled = true;
      btn.textContent = "Uploading the licence…";
      await uploadTo("licence", pendingDocs.license);
      pendingDocs.license = null;
    }

    location.href = "/app.html#overview";
  });

  /* ---------------- overview ---------------- */

  async function setStatus(status) {
    const btn = $("#publishBtn");
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = status === "published" ? "Publishing…" : "Working…"; }

    const r = await window.Auth.api("/api/restaurant", { method: "POST", body: JSON.stringify({ status }) });

    if (btn) { btn.disabled = false; btn.textContent = label; }

    if (!r.ok) {
      const list = (r.data && r.data.missing) || [];
      toast(list.length ? "Still needed: " + list.join(", ") : (r.data.message || "That did not work."));
      renderOverview();
      return;
    }

    applyRestaurant(r.data.restaurant);
    state.status = r.data.restaurant.status;
    save();
    renderOverview();
    toast(status === "published"
      ? "Published — guests can open " + publicLink(state.handle)
      : "Back to trial: the menu is hidden from guests");
  }

  function renderOverview() {
    const { logo, license } = state.docs;
    const hasMenu = !!(state.menu || state.menuImported);
    const items = [
      { key: "logo", label: "Restaurant logo", note: logo ? "Added" : "Used on the menu header", ok: !!logo, go: "docs" },
      { key: "lic", label: "Trade licence copy", note: license ? "Added" : "Needed before publishing", ok: !!license, go: "docs" },
      { key: "menu", label: "Menu content", note: hasMenu ? "Imported · review any time" : "Import a photo or a link", ok: hasMenu, go: "import" },
      { key: "maps", label: "Google Maps link", note: state.restaurant.mapsUrl ? "Added" : "Needed before publishing", ok: !!state.restaurant.mapsUrl, go: "docs" }
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

    const ready = items.every((it) => it.ok);
    const live = state.status === "published";
    const missing = items.filter((it) => !it.ok).map((it) => it.label.toLowerCase());

    $("#publishPill").className = "pill " + (live ? "pill-ok" : ready ? "pill-ok" : "pill-warn");
    $("#publishPill").textContent = live ? "Published" : ready ? "Ready to publish" : "Draft";
    $("#publishHint").textContent = live
      ? "Your menu is live. Guests can open it from the link below."
      : ready
        ? "Everything needed is here. Publish when you are happy with the menu."
        : "Still needed: " + missing.join(", ") + ".";

    /* The trial sentence used to overwrite the "still needed" line unconditionally,
       so every new restaurant — always on trial — was told how many days were
       left and never what was actually blocking the publish. The missing list
       wins while something is missing; the free-week note keeps the line when
       nothing is. */
    const todayStr = new Date().toISOString().slice(0, 10);
    const paidNow = Boolean(state.paidThrough && state.paidThrough >= todayStr);
    if ((live || ready) && state.trialEnds && !paidNow) {
      const left = Math.round((new Date(state.trialEnds) - new Date(todayStr)) / 86400000);
      if (left >= 0) {
        $("#publishHint").textContent = "Free until " +
          new Date(state.trialEnds).toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
          " — " + left + " day" + (left === 1 ? "" : "s") + " left with everything on. After that the menu stays " +
          "private until you pay, and everything you built is kept.";
      }
    }

    const pubBtn = $("#publishBtn");
    if (pubBtn) {
      pubBtn.disabled = !ready || live;
      pubBtn.textContent = live ? "Published" : "Publish my menu";
      const un = $("#unpublishBtn");
      if (un) un.hidden = !live;
      const note = $("#publishNote");
      if (note) note.textContent = live ? publicLink(state.handle) : "";
    }

    $("#topStatus").className = "pill " + (live ? "pill-ok" : ready ? "pill-warn" : "pill-warn");
    $("#topStatus").textContent = live ? "Live" : ready ? "Ready to publish" : "Trial";
    $("#sideStatus").textContent = live ? "Live · published" : ready ? "Ready to publish" : "Trial · not published";
    $("#sideDot").className = "dot" + (live ? " live" : "");
    $("#sideRest").textContent = state.restaurant.name || "Your restaurant";

    const publishBtn = $("#publishBtn");
    if (publishBtn && !publishBtn.dataset.wired) {
      publishBtn.dataset.wired = "1";
      publishBtn.addEventListener("click", () => setStatus("published"));
      const un = $("#unpublishBtn");
      if (un && !un.dataset.wired) {
        un.dataset.wired = "1";
        un.addEventListener("click", () => {
          /* One press takes the guest QR offline for everyone who has the code
             printed on the table. Two presses, five seconds apart, and it is a
             decision instead of a mis-click. */
          if (un.dataset.armed === "1") {
            un.dataset.armed = "";
            un.textContent = "Unpublish";
            setStatus("trial");
            return;
          }
          un.dataset.armed = "1";
          un.textContent = "Take it offline?";
          toast("Press again to take " + publicLink(state.handle) + " offline.");
          setTimeout(() => {
            if (un.dataset.armed === "1") { un.dataset.armed = ""; un.textContent = "Unpublish"; }
          }, 5000);
        });
      }
    }

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

  /* Orders live in the database: a guest orders from their own phone, so a
     copy in this browser's storage would never be seen by the restaurant. One
     fetch now feeds both the overview card and the Orders tab — two sources is
     how the tab showed orders the overview swore did not exist. */
  let ordersCache = null, ordersFetchedAt = 0, ordersError = "";

  /* One normaliser for every path that reads orders — the cached list, the
     filtered history search, and the overview — so a row means the same thing
     wherever it is drawn. */
  function normaliseOrders(rows) {
    return (rows || []).map((o) => ({
      id: o.id,
      ts: o.createdAt,
      mode: o.mode,
      guest: o.guest,
      phone: o.phone,
      table: o.table || "",
      pickup: o.pickupAt ? new Date(o.pickupAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "",
      address: o.address || "",
      total: o.total,
      count: (o.items || []).reduce((n, i) => n + i.qty, 0),
      items: o.items || [],
      status: o.status,
      archivedAt: o.archivedAt || null,
      archiveReason: o.archiveReason || null,
      /* the WhatsApp strip's whole state: dropping these here is why a guest who
         had messaged still read "not messaged" and every free button stayed off */
      inboundAt: o.inboundAt || null,
      waSent: o.waSent || null,
      /* and the money breakdown the edit sheet shows */
      subtotal: o.subtotal == null ? o.total : o.subtotal,
      deliveryFee: o.deliveryFee || 0,
      discountCode: o.discountCode || null,
      discountAmount: o.discountAmount || 0
    }));
  }

  async function loadOrders(force) {
    if (!force && ordersCache && Date.now() - ordersFetchedAt < 20000) return ordersCache;
    let r;
    /* no-store: a list of live orders must never come back from the browser's
       cache — marking one done and watching it stay Pending is exactly what a
       cached GET does */
    try { r = await window.Auth.api("/api/orders", { cache: "no-store" }); } catch (e) { ordersError = "Could not reach the server."; return null; }
    if (!r.ok) { ordersError = (r.data && r.data.message) || "Try again in a moment."; return null; }
    ordersError = "";
    if (r.data.currency) state.currency = r.data.currency;
    ordersCache = normaliseOrders(r.data.orders);
    ordersFetchedAt = Date.now();
    return ordersCache;
  }

  /* The history search goes to the server: the cached list stops at the newest
     rows, so a range that reaches back months has nothing to filter. This same
     loader is used by nothing else, and it never writes the cache. */
  async function fetchOrders(params) {
    const qs = Object.keys(params)
      .filter((k) => params[k])
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
      .join("&");
    let r;
    try { r = await window.Auth.api("/api/orders?" + qs, { cache: "no-store" }); }
    catch (e) { return { ok: false, message: "Could not reach the server." }; }
    if (!r.ok) return { ok: false, message: (r.data && r.data.message) || "Try again in a moment." };
    return { ok: true, orders: normaliseOrders(r.data.orders) };
  }

  function ovAgo(ts) {
    const d = new Date(ts);
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    const h = Math.floor(mins / 60);
    if (h < 24) return h + "h ago";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }

  function ovPlace(o) {
    if (o.mode === "Dine In") return o.table ? "Table " + o.table : "Dine in";
    if (o.mode === "Take Away") return o.pickup ? "Pickup " + o.pickup : "Take away";
    return "Delivery";
  }

  /* One line per order, not a five-cell table: the overview is a glance at what
     the kitchen still owes, not the ledger. The ledger is the Orders pane. */
  function ovRowHtml(o) {
    return '<div class="ov-row">' +
      '<span class="ov-who"><b>' + esc(o.guest || "Guest") + '</b>' +
        '<span class="ov-meta">' + esc(ovPlace(o)) + ' · ' + esc(o.count + " item" + (o.count === 1 ? "" : "s")) + '</span>' +
      '</span>' +
      '<span class="ov-when">' + esc(ovAgo(o.ts)) + '</span>' +
      '<span class="ov-total">' + money(o.total) + '</span>' +
      '<button class="btn btn-outline btn-sm" type="button" data-id="' + esc(o.id) + '" data-status="confirmed">Done</button>' +
    '</div>';
  }

  function ovStat(label, value, note) {
    return '<div class="ov-stat"><span class="ov-k">' + esc(label) + '</span>' +
      '<b class="ov-v">' + value + '</b>' +
      '<span class="ov-n">' + esc(note) + '</span></div>';
  }

  async function renderRecentOrders() {
    const host = $("#recentOrders"), stats = $("#ovOrderStats"), sub = $("#ovOrdersSub");
    const all = await loadOrders();
    if (!all) {
      if (stats) stats.innerHTML = "";
      host.innerHTML = `<div class="empty"><b>Could not load orders</b>${esc(ordersError)}</div>`;
      return;
    }

    const open = all.filter((o) => o.status !== "confirmed");
    const todayKey = new Date().toDateString();
    const today = all.filter((o) => new Date(o.ts).toDateString() === todayKey);
    const takings = today.reduce((n, o) => n + (Number(o.total) || 0), 0);
    const oldest = open.length ? open[open.length - 1].ts : null;

    if (stats) {
      stats.innerHTML =
        ovStat("Open now", String(open.length), open.length ? "oldest " + ovAgo(oldest) : "all clear") +
        ovStat("Today", String(today.length), "orders") +
        ovStat("Taken", money(takings), "today");
    }
    if (sub) {
      sub.textContent = open.length
        ? open.length + " still in the kitchen."
        : "Nothing waiting. Finished orders are under Orders \u2192 History.";
    }

    if (!open.length) {
      host.innerHTML = '<div class="empty"><b>Nothing in the kitchen</b>New orders land here the moment a guest sends one, with their name, number and dishes.</div>';
      return;
    }
    host.innerHTML = open.slice(0, 4).map(ovRowHtml).join("");
  }

  /* Orders live in the database: a guest orders from their own phone, so a
     copy in this browser's storage would never be seen by the restaurant. */
  let ORDER_TAB = "all", ORDERS = [];
  /* Open vs History is the split the shift actually uses; a counter, not a
     filter over a hundred rows. */
  let ORDER_STATE = "active", OR_RANGE = { from: "", to: "" }, FB_FILTER = "all";
  let ARCH_FOR = null;   /* the order whose reason bar is open */
  let REVIEWS = { byOrder: new Map(), list: [] };

  /* the tabs are the order types this restaurant actually offers — read from
     the menu first, then from the orders it has taken, so a restaurant that
     only does dine-in never sees a Delivery tab for nothing */
  function orderModes(rows) {
    const seen = [];
    const add = (m) => { if (m && seen.indexOf(m) < 0) seen.push(m); };
    ((state.restaurant && state.restaurant.purposes) || []).forEach(add);
    (rows || ORDERS).forEach((o) => add(o.mode));
    return seen;
  }

  /* reviews come from review_requests, keyed by the order they belong to, so a
     history row can show its own verdict without a second request per row */
  let reviewsFetchedAt = 0;
  async function loadReviews(force) {
    if (!force && reviewsFetchedAt && Date.now() - reviewsFetchedAt < 30000) return REVIEWS;
    let r;
    try { r = await window.Auth.api("/api/marketing?reviews=1", { cache: "no-store" }); }
    catch (e) { return { ok: false, message: "Could not reach the server.", byOrder: new Map(), list: [] }; }
    if (!r.ok) return { ok: false, message: (r.data && r.data.message) || "Try again in a moment.", byOrder: new Map(), list: [] };
    const list = (r.data.reviews || []);
    const byOrder = new Map();
    list.forEach((x) => { if (x.orderId) byOrder.set(x.orderId, x); });
    REVIEWS = {
      ok: true, byOrder: byOrder, list: list,
      average: r.data.average, count: r.data.count, happy: r.data.happy, spread: r.data.spread
    };
    reviewsFetchedAt = Date.now();
    return REVIEWS;
  }

  function money(n) {
    const cur = state.currency || "AED";
    return cur + " " + (Math.round((Number(n) || 0) * 100) / 100)
      .toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function starHtml(n) {
    const k = Math.max(0, Math.min(5, Number(n) || 0));
    return "\u2605".repeat(k) + "\u2606".repeat(5 - k);
  }

  /* ---------------------------------------------------------- WhatsApp strip
     The 24-hour window is the whole point: inside it a plain message is free
     and allowed, outside it only an approved template reaches the guest. The
     inbound time comes from the server, so the button a guest's own message
     enables cannot be faked by a clock on the browser. */
  const WA_FREE_MS = 23 * 3600e3;   /* 23h, not 24: a minute of margin */

  function waState(o) {
    const now = Date.now();
    const inAt = o.inboundAt ? new Date(o.inboundAt).getTime() : 0;
    const created = new Date(o.ts || o.createdAt).getTime() || 0;
    const open = Boolean(inAt) && now - inAt < WA_FREE_MS;
    return {
      open: open,
      inAt: inAt,
      freeMs: inAt ? Math.max(0, WA_FREE_MS - (now - inAt)) : 0,
      ageMs: created ? now - created : 0,
      sent: o.waSent || {}
    };
  }

  function waLeft(ms) {
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function waStatusKind(o) {
    return o.mode === "Delivery" ? "delivery" : o.mode === "Dine In" ? "meal" : "ready";
  }

  /* Quiet hours: nothing wakes a guest between 22:00 and 09:00 in Dubai.
     With no scheduler, this lives on the button instead. */
  function quietNow() {
    const h = (new Date().getUTCHours() + 4) % 24;   /* Asia/Dubai, no DST */
    return h >= 22 || h < 9;
  }

  function waStripHtml(o) {
    const w = waState(o);
    const kind = waStatusKind(o);
    const label = { delivery: "Sent for Delivery", meal: "Enjoy your Meal", ready: "Ready for Pickup" }[kind];

    const canOrder = !w.open && !w.sent.order && w.ageMs >= 2 * 60e3;
    const quiet = quietNow();
    const btn = (k, text, on, sentAt, cls) =>
      '<button type="button" class="wa-btn ' + (cls || "") + (sentAt ? " done" : "") + '" data-wa="' + k +
      '" data-id="' + esc(o.id) + '"' + (on && !sentAt ? "" : " disabled") + '>' +
      (sentAt ? "\u2713 " : "") + esc(text) + '</button>';

    return '<div class="owa" data-created="' + (new Date(o.ts || o.createdAt).getTime() || 0) + '"' +
      ' data-inbound="' + (w.inAt || "") + '" data-sent="' + esc(JSON.stringify(w.sent)) + '">' +
      '<span class="owa-win ' + (w.open ? "on" : "off") + '">' +
        (w.open ? "Free window \u00b7 " + waLeft(w.freeMs) + " left" : "Guest has not messaged") +
      '</span>' +
      btn("order", w.sent.order ? "Order sent" : "Send Order", canOrder, w.sent.order, "paid") +
      btn("accept", "Accept Order", w.open, w.sent.accept) +
      btn(kind, label, w.open, w.sent[kind]) +
      btn("review", quiet ? "Review Message (from 9am)" : "Review Message", w.open && !quiet, w.sent.review) +
    '</div>';
  }

  /* the strip must change on its own: Send Order unlocks two minutes after the
     order, and the window countdown has to be honest a minute later too */
  /* A message that arrives while the pane is open must light its buttons by
     itself: the ticker can count down from what it was painted with, but it
     cannot invent an inbound time. So every third tick (a minute) the list is
     re-read, and the pane repaints only if the window state actually moved. */
  let waStateSig = "";
  let waTicks = 0;

  function waSignature(rows) {
    return (rows || []).map(function (o) {
      return o.id + ":" + (o.inboundAt || "") + ":" + Object.keys(o.waSent || {}).sort().join("+");
    }).join("|");
  }

  async function waRefreshIfChanged() {
    if (document.hidden) return;
    if (!document.querySelector(".owa")) return;      /* not on the orders pane */
    ordersFetchedAt = 0;
    const cache = await loadOrders(true);
    if (!cache) return;
    if (waSignature(cache) === waStateSig) return;
    await renderOrders();
  }

  let waTicker = 0;
  function startWaTicker() {
    if (waTicker) return;
    waTicker = setInterval(function () {
      waTicks += 1;
      if (waTicks % 3 === 0) waRefreshIfChanged();
      document.querySelectorAll(".owa").forEach(function (bar) {
        const inAt = Number(bar.getAttribute("data-inbound") || 0);
        const created = Number(bar.getAttribute("data-created") || 0);
        let sent = {};
        try { sent = JSON.parse(bar.getAttribute("data-sent") || "{}") || {}; } catch (e) { sent = {}; }
        const now = Date.now();
        const open = Boolean(inAt) && now - inAt < WA_FREE_MS;
        const age = created ? now - created : 0;

        const win = bar.querySelector(".owa-win");
        if (win) {
          win.className = "owa-win " + (open ? "on" : "off");
          win.textContent = open ? "Free window \u00b7 " + waLeft(Math.max(0, WA_FREE_MS - (now - inAt))) + " left"
                                 : "Guest has not messaged";
        }
        bar.querySelectorAll("[data-wa]").forEach(function (b) {
          const k = b.getAttribute("data-wa");
          const already = Boolean(sent[k]);
          let on;
          const quiet = quietNow();
          if (k === "order") on = !open && !already && age >= 2 * 60e3;
          else if (k === "review") {
            on = open && !quiet;
            b.textContent = quiet ? "Review Message (from 9am)" : "Review Message";
          } else on = open;
          b.disabled = !on || already;
          if (k === "order" && already) b.textContent = "\u2713 Order sent";
        });
      });
    }, 20000);
  }

  function orderLedgerRowHtml(o, rev) {
    const archived = Boolean(o.archivedAt);
    const d = new Date(o.ts);
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const done = o.status === "confirmed";

    const where = o.mode === "Dine In"
      ? (o.table ? "Table " + o.table : "")
      : o.mode === "Take Away"
        ? (o.pickup ? "Pickup " + o.pickup : "")
        : (o.address || "");

    const items = (o.items || []).map((i) =>
      '<span class="oline"><span class="q">' + (i.qty || 1) + '\u00d7</span>' +
      '<span class="nm">' + esc(i.name) + '</span></span>'
    ).join("");

    /* the review gets its own full-width line under the row: squeezed into the
       items column it wrapped into five lines and made the list unreadable */
    const review = rev
      ? '<div class="orev r' + rev.rating + '">' + starHtml(rev.rating) +
        (rev.comment ? '<span class="orev-text">' + esc(rev.comment) + '</span>' : '') + '</div>'
      : (done ? '<div class="orev none">no review left</div>' : '');

    return '<article class="orow ' + (done ? "is-done" : "is-pending") + '" data-order="' + esc(o.id) + '">' +
      '<div class="otime"><b>' + esc(time) + '</b><span>' + esc(day) + '</span></div>' +
      '<div class="oguest"><b>' + esc(o.guest || "Guest") + '</b>' +
        (o.phone ? '<a href="tel:' + esc(o.phone.replace(/[^\d+]/g, "")) + '">' + esc(o.phone) + '</a>'
                 : '<span class="none">no number</span>') +
      '</div>' +
      '<div class="oitems">' + (items || '<span class="oline"><span class="nm">no dishes recorded</span></span>') + '</div>' +
      '<div class="owhere"><span>' + esc(o.mode || "Order") + '</span>' +
        (where ? '<span class="meta">' + esc(where) + '</span>' : '') +
      '</div>' +
      '<div class="ototal">' + money(o.total) + '</div>' +
      '<div class="ostate"><span class="st"><span class="dot"></span>' +
        (archived ? "Archived" : done ? "Done" : "Pending") + '</span></div>' +
      '<div class="oact">' +
        (archived
          ? '<button class="btn btn-sm btn-outline" type="button" data-arch="' + esc(o.id) + '" data-on="0">Restore</button>'
          : '<button class="btn btn-sm ' + (done ? "btn-quiet" : "btn-outline") + '" type="button" ' +
              'data-id="' + esc(o.id) + '" data-status="' + (done ? "awaiting_confirmation" : "confirmed") + '">' +
              (done ? "Reopen" : "Mark done") + '</button>' +
            (done ? "" : '<button class="btn btn-sm btn-quiet" type="button" data-edit="' + esc(o.id) + '">Edit</button>') +
            '<button class="btn btn-sm btn-quiet" type="button" data-arch="' + esc(o.id) + '" data-on="1">Archive</button>') +
      '</div>' + (archived ? "" : waStripHtml(o)) + review +
    '</article>' + (ARCH_FOR === o.id
      ? '<div class="arch-bar">' +
          '<span class="arch-why">Archive this order — why?</span>' +
          ["Duplicate", "Test order", "Guest cancelled", "Wrong entry"].map(function (why) {
            return '<button type="button" class="arch-btn" data-arch-do="' + esc(why) + '">' + esc(why) + '</button>';
          }).join("") +
          '<button type="button" class="btn-quiet" data-arch-cancel>Cancel</button>' +
        '</div>'
      : '');
  }

  /* ------------------------------------------------------ editing an order
     The kitchen changes what was ordered: a drink added at the table, the
     delivery charge the restaurant quotes, a code applied at the counter. The
     page only collects it — the server recomputes every figure. */
  const EDIT = { id: null, items: [], fee: 0, code: "", disc: null, phone: "", place: "" };

  function esMoney(n) { return (state.currency || "AED") + " " + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

  function esSubtotal() {
    return Math.round(EDIT.items.reduce((a, i) => a + i.price * i.qty, 0) * 100) / 100;
  }

  function esDiscount() {
    if (!EDIT.disc) return 0;
    const sub = esSubtotal();
    /* an order that already carries a code knows only what it was worth, not the
       percentage: show that figure until the staff press Apply again */
    if (EDIT.disc.percent == null) return Math.min(EDIT.disc.amount || 0, sub);
    let amount = sub * (EDIT.disc.percent / 100);
    if (EDIT.disc.maxAmount) amount = Math.min(amount, EDIT.disc.maxAmount);
    return Math.min(Math.round(amount * 100) / 100, sub);
  }

  function esPaint() {
    const host = $("#esItems");
    if (!host) return;
    host.innerHTML = EDIT.items.length
      ? EDIT.items.map(function (it, i) {
          return '<div class="es-row" data-i="' + i + '">' +
            '<span class="es-nm">' + esc(it.name) + '</span>' +
            '<span class="es-qty">' +
              '<button type="button" data-es-minus="' + i + '" aria-label="One less">\u2212</button>' +
              '<b>' + it.qty + '</b>' +
              '<button type="button" data-es-plus="' + i + '" aria-label="One more">+</button>' +
            '</span>' +
            '<span class="es-amt">' + esMoney(it.price * it.qty) + '</span>' +
            '<button class="es-x" type="button" data-es-drop="' + i + '" aria-label="Remove">\u00d7</button>' +
          '</div>';
        }).join("")
      : '<div class="es-row"><span class="es-nm none">No dishes. Add one below.</span></div>';

    const fee = Math.max(0, Number(($("#esFee") || {}).value || 0));
    EDIT.fee = fee;
    const sub = esSubtotal();
    const off = esDiscount();
    const total = Math.round(Math.max(0, sub + fee - off) * 100) / 100;

    $("#esTotals").innerHTML =
      '<div><span>Food</span><span>' + esMoney(sub) + '</span></div>' +
      (fee > 0 ? '<div><span>Delivery</span><span>' + esMoney(fee) + '</span></div>' : '') +
      (off > 0 ? '<div class="disc"><span>' + esc(EDIT.disc.code) + (EDIT.disc.percent == null ? '' : ' \u00b7 ' + EDIT.disc.percent + '% off') + '</span><span>\u2212 ' + esMoney(off) + '</span></div>' : '') +
      '<div class="grand"><span>Total</span><span>' + esMoney(total) + '</span></div>';
  }

  function esPicker() {
    const sel = $("#esPicker");
    if (!sel) return;
    const cats = (state.menu && state.menu.categories) || [];
    const opts = [];
    cats.forEach(function (c) {
      (c.items || []).forEach(function (i) {
        if (i.soldOut) return;
        opts.push('<option value="' + esc(i.id || "") + '" data-name="' + esc(i.name) + '" data-price="' + (Number(i.price) || 0) + '">' +
          esc(i.name) + ' \u00b7 ' + (state.currency || "AED") + ' ' + (Number(i.price) || 0).toFixed(2) + '</option>');
      });
    });
    sel.innerHTML = opts.length ? opts.join("") : '<option value="">The menu is not loaded</option>';
  }

  function openEditOrder(id) {
    const o = (ORDERS || []).filter((x) => x.id === id)[0];
    if (!o) return;
    EDIT.id = id;
    EDIT.items = (o.items || []).map((i) => ({ name: i.name, price: i.price, qty: i.qty }));
    EDIT.fee = o.deliveryFee || 0;
    EDIT.code = o.discountCode || "";
    EDIT.disc = o.discountAmount > 0
      ? { code: o.discountCode || "code", percent: null, amount: o.discountAmount, maxAmount: null }
      : null;
    EDIT.phone = o.phone || "";
    EDIT.place = (o.mode || "") + (o.table ? " \u00b7 table " + o.table : "");

    $("#esTitle").textContent = "Edit order";
    $("#esSub").textContent = [o.guest || "Guest", EDIT.place, o.phone || ""].filter(Boolean).join(" \u00b7 ");
    $("#esFee").value = EDIT.fee ? String(EDIT.fee) : "";
    $("#esCode").value = EDIT.code || "";
    const msg = $("#esCodeMsg");
    if (msg) {
      msg.className = "hint";
      msg.textContent = o.discountAmount > 0
        ? "Applied: \u2212 " + esMoney(o.discountAmount) + ". Apply again after changing the lines."
        : "";
    }
    esPicker();
    esPaint();
    $("#editSheet").hidden = false;
    $("#editBack").hidden = false;
  }

  function closeEdit() {
    $("#editSheet").hidden = true;
    $("#editBack").hidden = true;
    EDIT.id = null;
  }

  async function esApplyCode() {
    const btn = $("#esApply"), msg = $("#esCodeMsg");
    const code = (($("#esCode") || {}).value || "").trim().toUpperCase();
    if (!code) {
      EDIT.disc = null; EDIT.code = "";
      if (msg) { msg.className = "hint bad"; msg.textContent = "Type the code first."; }
      esPaint();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Checking\u2026"; }
    const r = await window.Auth.api("/api/order", {
      method: "POST",
      body: JSON.stringify({ discountCheck: true, handle: state.handle, code: code, subtotal: esSubtotal(), phone: EDIT.phone })
    });
    if (btn) { btn.disabled = false; btn.textContent = "Apply"; }
    if (!r.ok || !(r.data && r.data.ok)) {
      EDIT.disc = null;
      if (msg) { msg.className = "hint bad"; msg.textContent = (r.data && r.data.message) || "That code did not work."; }
      esPaint();
      return;
    }
    EDIT.code = r.data.code;
    EDIT.disc = { code: r.data.code, percent: r.data.percent, maxAmount: r.data.maxAmount || null };
    if (msg) { msg.className = "hint good"; msg.textContent = r.data.code + " applied."; }
    esPaint();
  }

  async function esSave() {
    if (!EDIT.items.length) { toast("An order needs at least one dish."); return; }
    const btn = $("#esSave");
    if (btn) { btn.disabled = true; btn.textContent = "Saving\u2026"; }
    const r = await window.Auth.api("/api/orders", {
      method: "PATCH",
      body: JSON.stringify({
        id: EDIT.id,
        edit: {
          items: EDIT.items.map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
          deliveryFee: Number(($("#esFee") || {}).value || 0),
          discountCode: EDIT.code || null
        }
      })
    });
    if (btn) { btn.disabled = false; btn.textContent = "Save changes"; }
    if (!r.ok) {
      const d = r.data || {};
      toast(d.code === "NO_DISCOUNTS" ? "Discounts are not switched on yet \u2014 run db/0019_discounts.sql."
        : (d.message || "That did not save."));
      return;
    }
    closeEdit();
    ordersFetchedAt = 0;
    await renderOrders();
    if (typeof renderRecentOrders === "function") renderRecentOrders();
    toast("Order updated \u2014 " + esMoney(r.data.total) + ".");
  }

  function esWireOnce() {
    const save = $("#esSave");
    if (!save || save.dataset.wired) return;
    save.dataset.wired = "1";

    save.addEventListener("click", esSave);
    $("#esCancel").addEventListener("click", closeEdit);
    $("#esClose").addEventListener("click", closeEdit);
    $("#editBack").addEventListener("click", closeEdit);
    $("#esFee").addEventListener("input", esPaint);
    $("#esApply").addEventListener("click", esApplyCode);
    $("#esCode").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); esApplyCode(); }
    });
    $("#esAdd").addEventListener("click", function () {
      const sel = $("#esPicker");
      const opt = sel && sel.options[sel.selectedIndex];
      if (!opt || !opt.dataset.name) return;
      const name = opt.dataset.name, price = Number(opt.dataset.price) || 0;
      const hit = EDIT.items.filter((i) => i.name === name)[0];
      if (hit) hit.qty += 1;
      else EDIT.items.push({ name: name, price: price, qty: 1 });
      /* a code is a percentage of the food: re-price it, never leave yesterday's */
      if (EDIT.disc) EDIT.disc = Object.assign({}, EDIT.disc);
      esPaint();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("#editSheet").hidden) closeEdit();
    });
  }

  function skeletonRows(n) {
    let out = "";
    for (let i = 0; i < n; i++) out += '<div class="skrow"><span></span><span></span><span></span><span></span><span></span><span></span></div>';
    return out;
  }

  /* what the shift needs at a glance: how much work is open, and what it took */
  function orderSummary(rows) {
    if (ORDER_STATE === "history") {
      const takings = rows.reduce((n, o) => n + (Number(o.total) || 0), 0);
      const rated = rows.filter((o) => REVIEWS.byOrder.has(o.id));
      const avg = rated.length
        ? rated.reduce((n, o) => n + REVIEWS.byOrder.get(o.id).rating, 0) / rated.length
        : 0;
      return '<b>' + rows.length + '</b> order' + (rows.length === 1 ? "" : "s") +
        (OR_RANGE.from || OR_RANGE.to ? " in this range" : "") +
        ', <b>' + money(takings) + '</b> taken' +
        (rated.length ? ', <b>' + (Math.round(avg * 10) / 10) + '</b> avg from ' + rated.length + ' review' + (rated.length === 1 ? "" : "s") : "");
    }
    const key = new Date().toDateString();
    const today = rows.filter((o) => new Date(o.ts).toDateString() === key);
    const takings = today.reduce((n, o) => n + (Number(o.total) || 0), 0);
    return '<b>' + rows.length + '</b> open, ' + today.length + ' order' + (today.length === 1 ? "" : "s") +
      ' today, <b>' + money(takings) + '</b> taken';
  }

  async function renderOrders() {
    const host = $("#ordersList"), tabs = $("#orderTabs"), sum = $("#orderSum"),
          stateTabs = $("#orderStateTabs"), range = $("#ordersRange");
    host.innerHTML = skeletonRows(3);

    const cache = await loadOrders(true);
    if (!cache) {
      tabs.innerHTML = "";
      sum.textContent = "";
      if (stateTabs) stateTabs.innerHTML = "";
      host.innerHTML = '<div class="empty"><b>Could not load orders</b>' + esc(ordersError) + '</div>';
      return;
    }
    ORDERS = cache;

    const openRows = ORDERS.filter((o) => o.status !== "confirmed");
    const doneRows = ORDERS.filter((o) => o.status === "confirmed");

    if (range) range.hidden = ORDER_STATE !== "history";

    let rows, err = "";
    if (ORDER_STATE === "archived") {
      const r = await fetchOrders({ state: "archived" });
      if (!r.ok) { err = r.message; rows = []; } else rows = r.orders;
    } else if (ORDER_STATE === "history" && (OR_RANGE.from || OR_RANGE.to)) {
      const r = await fetchOrders({ state: "done", from: OR_RANGE.from, to: OR_RANGE.to });
      if (!r.ok) { err = r.message; rows = []; } else rows = r.orders;
    } else {
      rows = ORDER_STATE === "history" ? doneRows : openRows;
    }

    /* Counted after the rows resolve, not from the cache: the cached list stops
       at the newest hundred, so a badge built from it under-reports a history
       search that reached further back than that. */
    if (stateTabs) {
      const historyCount = ORDER_STATE === "history" ? rows.length : doneRows.length;
      void historyCount;
      stateTabs.innerHTML = [["active", "Open", openRows.length], ["history", "History", historyCount], ["archived", "Archived", ORDER_STATE === "archived" ? rows.length : null]]
        .map(function (t) {
          return '<button type="button" role="tab" data-ostate="' + t[0] + '" aria-selected="' +
            (ORDER_STATE === t[0] ? "true" : "false") + '">' + t[1] +
            (t[2] === null || t[2] === undefined ? '' : ' <span class="n">' + t[2] + '</span>') + '</button>';
        }).join("");
    }

    if (ORDER_STATE === "history") {
      await loadReviews();
    } else if (!REVIEWS.byOrder) {
      REVIEWS = { byOrder: new Map(), list: [] };
    }

    const modes = orderModes(rows);
    if (ORDER_TAB !== "all" && modes.indexOf(ORDER_TAB) < 0) ORDER_TAB = "all";

    const count = (m) => (m === "all" ? rows.length : rows.filter((o) => o.mode === m).length);
    tabs.innerHTML = [["all", "All"]].concat(modes.map((m) => [m, m]))
      .map(function (t) {
        return '<button type="button" role="tab" data-otab="' + esc(t[0]) + '" aria-selected="' +
          (ORDER_TAB === t[0] ? "true" : "false") + '">' + esc(t[1]) +
          ' <span class="n">' + count(t[0]) + '</span></button>';
      }).join("");

    sum.innerHTML = orderSummary(rows);

    if (err) {
      host.innerHTML = '<div class="empty"><b>That search did not run</b>' + esc(err) + '</div>';
      return;
    }

    const shown = ORDER_TAB === "all" ? rows : rows.filter((o) => o.mode === ORDER_TAB);
    if (!shown.length) {
      host.innerHTML = ORDER_STATE === "history"
        ? '<div class="empty"><b>No finished orders' + (OR_RANGE.from || OR_RANGE.to ? " in that range" : " yet") +
          '</b>Mark an order done and it moves here, with the review the guest left.'
        : (ORDER_TAB === "all"
          ? '<div class="empty"><b>No open orders</b>A guest orders from their own phone and a copy lands here within seconds, with their name and number \u2014 even if the WhatsApp message never arrives.</div>'
          : '<div class="empty"><b>No open ' + esc(ORDER_TAB) + ' orders</b>They will appear here. The other tabs keep theirs.</div>');
      return;
    }
    host.innerHTML = shown.map((o) => orderLedgerRowHtml(o, REVIEWS.byOrder.get(o.id))).join("");
    waStateSig = waSignature(shown);
    startWaTicker();
  }

  /* ---------------- feedback ----------------
     The reviews live in review_requests, which the marketing pane already
     reads. This pane is the service view of them: the low scores first,
     because those are the ones a phone call can still save. */

  function fbRowHtml(x) {
    const when = new Date(x.at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return '<article class="fb-row r' + x.rating + '">' +
      '<div class="fb-score-cell"><b class="fb-num">' + x.rating + '</b>' +
        '<span class="mk-stars">' + starHtml(x.rating) + '</span>' +
        '<span class="fb-when">' + esc(when) + '</span></div>' +
      '<div class="fb-body"><b>' + esc(x.name || "Guest") + '</b>' +
        (x.phone ? ' <a class="fb-phone" href="tel:' + esc(String(x.phone).replace(/[^\d+]/g, "")) + '">' + esc(x.phone) + '</a>' : '') +
        (x.comment ? '<p class="fb-text">' + esc(x.comment) + '</p>' : '<p class="fb-text none">No comment left.</p>') +
      '</div>' +
      '<div class="fb-act">' +
        (x.orderId ? '<button class="btn-quiet" type="button" data-jump="' + esc(x.orderId) + '">See order</button>' : '') +
      '</div>' +
    '</article>';
  }

  async function renderFeedback() {
    const pill = $("#fbPill"), avg = $("#fbAvg"), bars = $("#fbBars"),
          tabs = $("#fbTabs"), host = $("#fbList");
    if (!host) return;
    host.innerHTML = '<div class="empty"><b>Loading</b>Reading what guests said.</div>';

    const d = await loadReviews(true);
    if (!d.ok) {
      host.innerHTML = '<div class="empty"><b>Feedback could not load</b>' + esc(d.message || "Try again in a moment.") + '</div>';
      return;
    }

    if (pill) pill.textContent = d.count
      ? d.count + " review" + (d.count === 1 ? "" : "s") + " \u00b7 " + Math.round((d.happy / d.count) * 100) + "% happy"
      : "Nothing yet";
    if (avg) avg.textContent = d.count ? (Math.round((d.average || 0) * 10) / 10).toFixed(1) : "\u2014";

    /* with nothing to chart, five dead bars and five dead filters are noise —
       hide them inline, because [hidden] loses to display:flex here */
    const scoreBlock = document.querySelector(".fb-score");
    if (scoreBlock) scoreBlock.style.display = d.count ? "" : "none";

    if (bars && d.count) {
      const max = Math.max(1, ...(d.spread || [0]));
      bars.innerHTML = [5, 4, 3, 2, 1].map(function (n, i) {
        const c = (d.spread || [])[i] || 0;
        return '<div class="fb-bar"><span class="fb-bn">' + n + ' \u2605</span>' +
          '<span class="fb-track"><span class="fb-fill r' + n + '" style="width:' + Math.round((c / max) * 100) + '%"></span></span>' +
          '<span class="fb-bc">' + c + '</span></div>';
      }).join("");
    }

    if (tabs) {
      const counts = [5, 4, 3, 2, 1].map((n) => d.list.filter((x) => x.rating === n).length);
      tabs.innerHTML = !d.list.length ? "" : [["all", "All", d.list.length]]
        .concat([5, 4, 3, 2, 1].map((n, i) => [String(n), n + " \u2605", counts[i]]))
        .map(function (t) {
          return '<button type="button" role="tab" data-frate="' + t[0] + '" aria-selected="' +
            (FB_FILTER === t[0] ? "true" : "false") + '">' + t[1] +
            ' <span class="n">' + t[2] + '</span></button>';
        }).join("");
    }

    const shown = FB_FILTER === "all" ? d.list : d.list.filter((x) => x.rating === Number(FB_FILTER));
    if (!shown.length) {
      host.innerHTML = d.count
        ? '<div class="empty"><b>No ' + esc(FB_FILTER) + '-star reviews</b>The other filters keep theirs.</div>'
        : '<div class="empty"><b>No reviews yet</b>When a guest answers the message you sent after they ate, it lands here \u2014 the score, the comment, and the order it came from.</div>';
      return;
    }
    host.innerHTML = shown.map(fbRowHtml).join("");
  }

  /* one listener for the tab strips, the state switch and the state buttons —
     the list is redrawn on every change, so per-button handlers would be
     re-bound constantly */
  document.addEventListener("click", async (e) => {
    const st = e.target.closest && e.target.closest("[data-ostate]");
    if (st) { ORDER_STATE = st.getAttribute("data-ostate"); renderOrders(); return; }

    const tab = e.target.closest && e.target.closest("[data-otab]");
    if (tab) { ORDER_TAB = tab.getAttribute("data-otab"); renderOrders(); return; }

    const fr = e.target.closest && e.target.closest("[data-frate]");
    if (fr) { FB_FILTER = fr.getAttribute("data-frate"); renderFeedback(); return; }

    const jump = e.target.closest && e.target.closest("[data-jump]");
    if (jump) {
      const id = jump.getAttribute("data-jump");
      ORDER_STATE = "history";
      OR_RANGE = { from: "", to: "" };
      const f = $("#orFrom"), t = $("#orTo");
      if (f) f.value = "";
      if (t) t.value = "";
      showView("orders");
      setTimeout(function () {
        const row = document.querySelector('[data-order="' + id + '"]');
        if (row) { row.classList.add("is-hit"); row.scrollIntoView({ block: "center", behavior: "smooth" }); }
      }, 350);
      return;
    }

    const archBtn = e.target.closest && e.target.closest("[data-arch]");
    if (archBtn) {
      const id = archBtn.getAttribute("data-arch");
      if (archBtn.getAttribute("data-on") === "0") {
        await archiveOrder(id, null);
      } else {
        ARCH_FOR = ARCH_FOR === id ? null : id;
        renderOrders();
      }
      return;
    }

    const archDo = e.target.closest && e.target.closest("[data-arch-do]");
    if (archDo && ARCH_FOR) {
      await archiveOrder(ARCH_FOR, archDo.getAttribute("data-arch-do"));
      return;
    }

    const archNo = e.target.closest && e.target.closest("[data-arch-cancel]");
    if (archNo) { ARCH_FOR = null; renderOrders(); return; }

    /* ---- the WhatsApp buttons -------------------------------------------
       Send Order is the paid one: it re-checks with the server at the moment of
       the click, because the state that enabled it can change between the paint
       and the press. Everything else sends a free message inside the window. */
    /* the edit sheet's own controls first: they live inside a delegated click */
    const esOpen = e.target.closest && e.target.closest("[data-edit]");
    if (esOpen) {
      e.preventDefault();
      esWireOnce();
      openEditOrder(esOpen.getAttribute("data-edit"));
      return;
    }

    if (EDIT.id) {
      const plus = e.target.closest && e.target.closest("[data-es-plus]");
      const minus = e.target.closest && e.target.closest("[data-es-minus]");
      const drop = e.target.closest && e.target.closest("[data-es-drop]");
      if (plus || minus || drop) {
        e.preventDefault();
        const i = Number((plus || minus || drop).getAttribute(plus ? "data-es-plus" : minus ? "data-es-minus" : "data-es-drop"));
        if (plus) EDIT.items[i].qty += 1;
        if (minus) { EDIT.items[i].qty -= 1; if (EDIT.items[i].qty <= 0) EDIT.items.splice(i, 1); }
        if (drop) EDIT.items.splice(i, 1);
        esPaint();
        return;
      }
    }

    const waBtn = e.target.closest && e.target.closest("[data-wa]");
    if (waBtn) {
      e.preventDefault();
      if (waBtn.disabled) return;
      const kind = waBtn.getAttribute("data-wa");
      const orderId = waBtn.getAttribute("data-id");
      const was = waBtn.textContent;
      waBtn.disabled = true;
      waBtn.textContent = "Sending\u2026";
      const r = await window.Auth.api("/api/marketing?send=1", {
        method: "POST",
        body: JSON.stringify({ orderId: orderId, kind: kind })
      });
      if (!r.ok) {
        const d = r.data || {};
        waBtn.textContent = was;
        waBtn.disabled = false;
        toast(d.code === "NO_INBOX" ? "The message inbox is not switched on yet \u2014 run db/0018_wa_messages.sql."
          : d.code === "WINDOW_CLOSED" ? "That window has closed. Only Send Order can reach them now."
          : d.code === "NOT_YET" ? "Give it two minutes \u2014 Send Order unlocks after that."
          : (d.message || "That did not send."));
        return;
      }
      ordersFetchedAt = 0;
      await renderOrders();
      toast((r.data && r.data.via ? "Sent via " + r.data.via + "." : "Sent."));
      return;
    }

    const dcToggle = e.target.closest && e.target.closest("[data-dc-toggle]");
    if (dcToggle) {
      e.preventDefault();
      dcToggle.disabled = true;
      const r = await window.Auth.api("/api/marketing?discounts=1", {
        method: "POST",
        body: JSON.stringify({ action: "toggle", id: dcToggle.getAttribute("data-dc-toggle"), active: dcToggle.getAttribute("data-on") === "1" })
      });
      if (!r.ok) { dcToggle.disabled = false; toast((r.data && r.data.message) || "That did not save."); return; }
      await dcLoad();
      return;
    }

    /* deleting is its own decision, with its own words — arming the button you
       just pressed reads as a button that does nothing */
    const dcDel = e.target.closest && e.target.closest("[data-dc-del]");
    if (dcDel) {
      e.preventDefault();
      const row = dcDel.closest(".dc-row");
      const act = row && row.querySelector(".dc-act");
      if (act) {
        act.innerHTML =
          '<button class="btn btn-sm btn-outline" type="button" data-dc-yes="' + esc(dcDel.getAttribute("data-dc-del")) + '">Delete it</button>' +
          '<button class="btn btn-sm btn-quiet" type="button" data-dc-no="1">Keep it</button>';
      }
      return;
    }

    const dcNo = e.target.closest && e.target.closest("[data-dc-no]");
    if (dcNo) { e.preventDefault(); await dcLoad(); return; }

    const dcYes = e.target.closest && e.target.closest("[data-dc-yes]");
    if (dcYes) {
      e.preventDefault();
      dcYes.disabled = true;
      const r = await window.Auth.api("/api/marketing?discounts=1", {
        method: "POST",
        body: JSON.stringify({ action: "delete", id: dcYes.getAttribute("data-dc-yes") })
      });
      if (!r.ok) { dcYes.disabled = false; toast((r.data && r.data.message) || "That did not save."); return; }
      await dcLoad();
      toast("Code deleted.");
      return;
    }

    const btn = e.target.closest && e.target.closest("[data-status]");
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute("data-id");
    const status = btn.getAttribute("data-status");
    btn.disabled = true;
    const r = await window.Auth.api("/api/orders", { method: "PATCH", body: JSON.stringify({ id, status }) });
    btn.disabled = false;
    if (!r.ok) { toast((r.data && r.data.message) || "That did not save."); return; }
    ordersFetchedAt = 0;
    await renderOrders();
    if (typeof renderRecentOrders === "function") renderRecentOrders();
    toast(status === "confirmed" ? "Done \u2014 it moved to History." : "Back to open.");
  });

  async function archiveOrder(id, reason) {
    const r = await window.Auth.api("/api/orders", {
      method: "PATCH",
      body: JSON.stringify(reason ? { id: id, archive: true, reason: reason } : { id: id, archive: false })
    });
    if (!r.ok) {
      const d = r.data || {};
      toast(d.code === "NO_ARCHIVE" ? "Archiving is not switched on yet — run db/0016_archive_orders.sql." : (d.message || "That did not save."));
      return;
    }
    ARCH_FOR = null;
    ordersFetchedAt = 0;
    await renderOrders();
    toast(reason ? "Archived — " + reason : "Back in the list.");
  }

  /* the date range is a search, so it fires on change rather than per keystroke */
  ["#orFrom", "#orTo"].forEach(function (sel) {
    const el = $(sel);
    if (el) el.addEventListener("change", function () {
      OR_RANGE = { from: ($("#orFrom") || {}).value || "", to: ($("#orTo") || {}).value || "" };
      if (OR_RANGE.from && OR_RANGE.to && OR_RANGE.from > OR_RANGE.to) {
        const swap = OR_RANGE.from; OR_RANGE.from = OR_RANGE.to; OR_RANGE.to = swap;
        $("#orFrom").value = OR_RANGE.from; $("#orTo").value = OR_RANGE.to;
      }
      if (ORDER_STATE === "history") renderOrders();
    });
  });

  const orToday = $("#orToday");
  if (orToday) orToday.addEventListener("click", function () {
    const now = new Date().toISOString().slice(0, 10);
    $("#orFrom").value = now;
    $("#orTo").value = now;
    OR_RANGE = { from: now, to: now };
    ORDER_STATE = "history";
    renderOrders();
  });

  const orClear = $("#orClear");
  if (orClear) orClear.addEventListener("click", function () {
    $("#orFrom").value = "";
    $("#orTo").value = "";
    OR_RANGE = { from: "", to: "" };
    renderOrders();
  });

  const fbReload = $("#fbReload");
  if (fbReload) fbReload.addEventListener("click", function () { renderFeedback(); });

  $("#dlOverview").addEventListener("click", () => downloadQR($("#qrOverview"), state.handle));

  /* ---------------- menu editor ---------------- */

  const CUR_SYMBOL = { USD: "$", EUR: "€", GBP: "£", INR: "₹", PKR: "₨", EGP: "E£" };

  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function priceLabel(n) {
    const code = state.currency || "AED";
    const sym = CUR_SYMBOL[code] || code;
    /* two decimals at the point of display: a price that reads 41.6 next to one
       that reads 59.20 looks like a data bug to the person paying */
    const v = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
    return /^[A-Z]{3}$/.test(sym) ? sym + " " + v : sym + v;
  }

  /* every edit goes to Postgres and only then to the screen */
  async function menuEdit(payload, okMessage) {
    const r = await window.Auth.api("/api/menu?op=edit", { method: "POST", body: JSON.stringify(payload) });
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
            <button class="feat ${c.featured ? "on" : ""}" type="button" data-feat="${c.id}"
                    title="${c.featured ? "Shown first on the guest page" : "Show this category first"}"
                    aria-pressed="${c.featured ? "true" : "false"}">${c.featured ? "★ Highlighted" : "☆ Highlight"}</button>
            <button class="btn btn-outline btn-sm" type="button" data-add="${c.id}">+ Dish</button>
            <span class="ord">
              <button class="ord-btn" type="button" data-move="up" data-cat-move="${c.id}" title="Move up">▲</button>
              <button class="ord-btn" type="button" data-move="down" data-cat-move="${c.id}" title="Move down">▼</button>
            </span>
            ${c.items.length || allItemsFlat().length ? `<button class="btn-quiet" type="button" data-existing="${c.id}" title="Add dishes that already exist">+ Existing</button>` : ""}
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
            <div class="pr"><input class="price-in" type="text" inputmode="decimal"
              data-price="${it.id}" value="${(Number(it.price) || 0).toFixed(2)}"
              aria-label="Price for ${esc(it.name)}"></div>
            <span class="row-tools">
              <button class="btn-quiet" type="button" data-edit="${it.id}" title="Edit">Edit</button>
              <button class="btn-quiet danger" type="button" data-del="${it.id}" title="Delete">Delete</button>
              <button class="avail ${it.soldOut ? "is-off" : ""}" type="button" data-toggle="${it.id}"
                      aria-pressed="${it.soldOut}"
                      aria-label="${it.soldOut ? "Sold out" : "Available"}: ${esc(it.name)}"
                      title="${it.soldOut ? "Put it back on the menu" : "Hide it from ordering"}"
                      ><span class="d"></span>${it.soldOut ? "Sold out" : "Available"}</button>
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
        btn.setAttribute("aria-pressed", String(next));
        btn.classList.toggle("is-off", next);
        btn.innerHTML = '<span class="d"></span>' + (next ? "Sold out" : "Available");
        const row = btn.closest(".mrow");
        if (row) row.classList.toggle("is-sold", next);
        item.soldOut = next;
        save();
        const saved = await menuEdit({ action: "updateItem", id, soldOut: next });
        if (!saved) { item.soldOut = !next; renderMenuEditor(); return; }
        toast(next ? item.name + " marked sold out" : item.name + " is back on the menu");
        renderOverview();
      })
    );

    /* ---- one price, changed in place ---- */
    $$("[data-price]").forEach((inp) => {
      let was = inp.value;
      const reset = () => {
        const it = findItemEverywhere(inp.dataset.price);
        if (it) inp.value = (Number(it.price) || 0).toFixed(2);
      };

      inp.addEventListener("focus", () => { was = inp.value; inp.select(); });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
        if (e.key === "Escape") { inp.value = was; inp.blur(); }
      });

      inp.addEventListener("change", async () => {
        const id = inp.dataset.price;
        const item = findItemEverywhere(id);
        if (!item) { reset(); return; }

        const before = Number(item.price) || 0;
        const typed = Number(String(inp.value).replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(typed) || typed < 0) {
          inp.value = before.toFixed(2);
          toast("That price is not a number.");
          return;
        }
        if (Math.abs(typed - before) < 0.004) { inp.value = before.toFixed(2); return; }

        inp.disabled = true;
        const saved = await menuEdit({ action: "updateItem", id, price: typed });
        inp.disabled = false;
        if (!saved) { inp.value = before.toFixed(2); return; }

        item.price = Number(saved.item && saved.item.price != null ? saved.item.price : typed);
        save();
        inp.value = item.price.toFixed(2);
        toast(item.name + " is now " + priceLabel(item.price));
        renderOverview();
      });
    });

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

    /* ---- highlight this category first ---- */
    $$("[data-feat]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.feat;
        const cat = menuSource().categories.find((c) => c.id === id);
        if (!cat) return;
        const next = !cat.featured;
        const saved = await menuEdit({ action: "setCategoryFeatured", id, featured: next },
          next ? "“" + cat.name + "” will show first" : "“" + cat.name + "” back in menu order");
        if (!saved) return;
        cat.featured = next;
        save();
        await reloadOwnMenu();
        renderMenuEditor();
      })
    );

    /* ---- reorder categories ---- */
    $$("[data-cat-move]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.dataset.catMove;
        const saved = await menuEdit({ action: "moveCategory", id, direction: btn.dataset.move });
        if (saved) {
          await reloadOwnMenu();
          renderMenuEditor();
        }
      })
    );

    /* ---- pull in existing dishes ---- */
    $$("[data-existing]").forEach((btn) =>
      btn.addEventListener("click", () => openPicker(btn.dataset.existing))
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
      ${isNew ? "" : `<div class="edit-fields ar-fields">
        <input class="input" data-e="arName" dir="rtl" lang="ar" placeholder="الاسم بالعربية" value="${esc(item.arName || "")}" maxlength="120">
        <input class="input" data-e="arDesc" dir="rtl" lang="ar" placeholder="الوصف بالعربية (اختياري)" value="${esc(item.arDesc || "")}" maxlength="400">
        <label class="ar-pub"><input type="checkbox" data-e="arPub"> Publish this one now</label>
      </div>`}
      ${isNew ? "" : `<div class="edit-cats">
        <span class="ec-label">Also listed in</span>
        ${menuSource().categories.map((c) => {
          const checked = categoriesOfItem(id).some((x) => x.id === c.id);
          const home = categoriesOfItem(id)[0]; const isHome = home && home.id === c.id;
          return `<label class="ec"><input type="checkbox" data-cat-pick="${c.id}" ${checked ? "checked" : ""} ${isHome ? "disabled checked" : ""}> ${esc(c.name)}${isHome ? " (main)" : ""}</label>`;
        }).join("")}
      </div>`}
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
      if (!isNew) {
        const picked = $$("[data-cat-pick]").filter((x) => x.checked).map((x) => x.dataset.catPick);
        if (picked.length) {
          await menuEdit({ action: "setItemCategories", id, categoryIds: picked });
        }

        /* the Arabic beside the English: saved in the same press, so a dish
           never ends up corrected in one language and stale in the other */
        const arNameIn = row.querySelector('[data-e="arName"]');
        const arDescIn = row.querySelector('[data-e="arDesc"]');
        const arPubIn = row.querySelector('[data-e="arPub"]');
        if (arNameIn && arNameIn.value.trim()) {
          await menuEdit({
            action: "setTranslation", kind: "item", id: id,
            name: arNameIn.value.trim(),
            description: arDescIn ? arDescIn.value.trim() : "",
            status: arPubIn && arPubIn.checked ? "published" : "draft"
          });
        }
      }

      await reloadOwnMenu();
      renderMenuEditor();
      renderOverview();
    });
  }

  /* ---------------- Arabic, drafted once and reviewed ----------------
     The model writes the first version and marks it a draft. Publishing is a
     separate act, per dish or for the whole menu, because "Chicken 65" comes
     back as something no Arabic menu would print. */

  async function arCall(action, okMessage) {
    const r = await window.Auth.api("/api/menu?op=edit", {
      method: "POST", body: JSON.stringify({ action: action })
    });
    const d = r.data || {};
    if (!r.ok || d.ok === false) {
      const code = d.code || "";
      if (code === "NO_I18N") return { ok: false, message: "Arabic is not switched on yet — run db/0015_menu_i18n.sql in Supabase." };
      if (code === "NO_KEY") return { ok: false, message: "No translation key on the server." };
      return { ok: false, message: d.message || "That did not work." };
    }
    if (okMessage) toast(okMessage(d));
    return { ok: true, data: d };
  }

  const arTrans = $("#arTranslateBtn");
  if (arTrans) arTrans.addEventListener("click", async () => {
    arTrans.disabled = true;
    const out = await arCall("translateMenu", (d) => (d.items + d.categories)
      ? "Drafted " + d.items + " dish" + (d.items === 1 ? "" : "es") + " and " + d.categories +
        " categor" + (d.categories === 1 ? "y" : "ies") + " in Arabic — open a dish to check it."
      : "Every dish already has Arabic. Nothing was replaced.");
    arTrans.disabled = false;
    if (!out.ok) { toast(out.message); return; }
    await reloadOwnMenu();
    renderMenuEditor();
  });

  const arPub = $("#arPublishBtn");
  if (arPub) arPub.addEventListener("click", async () => {
    arPub.disabled = true;
    const out = await arCall("publishTranslations", (d) =>
      d.published ? "Published " + d.published + " Arabic line" + (d.published === 1 ? "" : "s") + "." : "Nothing was waiting to publish.");
    arPub.disabled = false;
    if (!out.ok) { toast(out.message); return; }
    await reloadOwnMenu();
    renderMenuEditor();
  });

  function addDishRow(catId) {
    const block = document.querySelector('[data-cat="' + catId + '"]');
    if (!block) return;
    const row = document.createElement("div");
    row.className = "mrow editing new-row";
    block.appendChild(row);
    startEdit(row, catId, true);
  }

  /* ---------------- bulk price change ----------------
     This used to change every dish, which is the one thing an operator rarely
     wants. Now the selection is explicit: all of it by default, one category,
     or single dishes. Underneath it is still the same merge — category + name
     match, the price is updated, nothing is created and nothing is deleted. */

  const bulkItems = () => {
    const out = [];
    ((state.menu && state.menu.categories) || []).forEach((c) => {
      (c.items || []).forEach((it) => out.push({ catId: c.id, cat: c.name, item: it }));
    });
    return out;
  };

  let bulkSel = null;   /* item ids that will change; null until the panel opens */

  function bulkPct() {
    const dir = Number($("#bulkDir").value) || 1;
    const raw = Number($("#bulkPct").value);
    return dir * (Number.isFinite(raw) ? Math.max(0, Math.min(90, raw)) : 0);
  }

  function bulkNew(was) {
    const pct = bulkPct();
    const mode = $("#bulkRound").value;
    return Math.max(0, roundPrice((Number(was) || 0) * (1 + pct / 100), mode));
  }

  function bulkPlan() {
    return bulkItems()
      .filter((x) => bulkSel && bulkSel.has(x.item.id))
      .map((x) => {
        const was = Number(x.item.price) || 0;
        return { cat: x.cat, name: x.item.name, was, now: bulkNew(was) };
      });
  }

  function bulkPaintList() {
    const host = $("#bulkList");
    if (!host) return;
    const cats = (state.menu && state.menu.categories) || [];
    if (!cats.length) { host.innerHTML = '<div class="hint" style="padding:12px">There is no menu to change yet.</div>'; return; }

    host.innerHTML = cats.map((c) => {
      const items = c.items || [];
      const on = items.filter((i) => bulkSel.has(i.id)).length;
      return '<div class="bulk-catblock">' +
        '<label class="bulk-cat">' +
          '<input type="checkbox" data-bcat="' + esc(c.id) + '"' + (items.length && on === items.length ? " checked" : "") + '>' +
          '<span>' + esc(c.name) + '</span>' +
          '<span class="n">' + on + '/' + items.length + '</span>' +
        '</label>' +
        items.map((it) => {
          const sel = bulkSel.has(it.id);
          const was = Number(it.price) || 0;
          const now = bulkNew(was);
          const dirCls = now > was + 0.004 ? "up" : now < was - 0.004 ? "down" : "";
          return '<label class="bulk-item' + (sel ? "" : " off") + '">' +
            '<input type="checkbox" data-bitem="' + esc(it.id) + '"' + (sel ? " checked" : "") + '>' +
            '<span class="nm">' + esc(it.name) + (it.soldOut ? ' <span class="was">sold out</span>' : "") + '</span>' +
            '<span class="was">' + priceLabel(was) + '</span>' +
            '<span class="now ' + dirCls + '">' + priceLabel(now) + '</span>' +
          '</label>';
        }).join("") +
      '</div>';
    }).join("");

    /* a category with some of its dishes picked shows a dash, not a tick */
    Array.from(host.querySelectorAll("[data-bcat]")).forEach((box) => {
      const cat = cats.filter((c) => c.id === box.dataset.bcat)[0];
      if (!cat) return;
      const items = cat.items || [];
      const on = items.filter((i) => bulkSel.has(i.id)).length;
      box.indeterminate = on > 0 && on < items.length;
    });
  }

  function bulkPaint() {
    bulkPaintList();
    const plan = bulkPlan();
    const changed = plan.filter((p) => Math.abs(p.was - p.now) > 0.004);
    const out = $("#bulkPreview");
    if (!out) return;

    if (!plan.length) {
      out.innerHTML = "Nothing is selected — tick the dishes this should apply to.";
    } else {
      const sample = changed.slice(0, 3).map((p) => p.name + " " + p.was.toFixed(2) + " → " + p.now.toFixed(2));
      out.innerHTML = "<b>" + changed.length + " of " + plan.length + " selected dishes change.</b> " +
        (sample.length ? esc(sample.join(" · ")) + (changed.length > 3 ? " …" : "") : "");
    }

    const selCount = $("#bulkSelCount");
    if (selCount) selCount.textContent = plan.length;
    const go = $("#bulkGo");
    if (go && !go.dataset.armed) {
      go.textContent = changed.length ? "Apply to " + changed.length + (changed.length === 1 ? " dish" : " dishes") : "Apply";
    }
  }

  (function wireBulkPrice() {
    const btn = $("#bulkPriceBtn");
    const panel = $("#bulkPricePanel");
    /* a missing control must cost the control, never the page: this is wired
       during load, so a throw here leaves the whole dashboard unrendered */
    if (!btn || !panel || btn.dataset.wired) return;
    btn.dataset.wired = "1";

    const open = (on) => {
      $("#bulkPricePanel").hidden = !on;
      if (!on) return;
      /* every dish is ticked the first time, and again each time it is opened:
         the default is the whole menu, the choice is to narrow it */
      bulkSel = new Set(bulkItems().map((x) => x.item.id));
      const go = $("#bulkGo");
      go.dataset.armed = "";
      bulkPaint();
    };

    btn.addEventListener("click", () => open($("#bulkPricePanel").hidden));
    $("#bulkCancel").addEventListener("click", () => open(false));

    ["bulkPct", "bulkDir", "bulkRound"].forEach((id) => {
      $("#" + id).addEventListener("input", bulkPaint);
      $("#" + id).addEventListener("change", bulkPaint);
    });

    const allBtn = $("#bulkAll"), noneBtn = $("#bulkNone"), listHost = $("#bulkList");
    if (!allBtn || !noneBtn || !listHost) return;

    $("#bulkAll").addEventListener("click", () => {
      bulkSel = new Set(bulkItems().map((x) => x.item.id));
      bulkPaint();
    });
    $("#bulkNone").addEventListener("click", () => {
      bulkSel = new Set();
      bulkPaint();
    });

    /* one listener for the whole tree: category ticks cascade, item ticks
       update their category, and both repaint the prices */
    $("#bulkList").addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.bcat !== undefined) {
        const cat = ((state.menu && state.menu.categories) || []).filter((c) => c.id === t.dataset.bcat)[0];
        if (!cat) return;
        (cat.items || []).forEach((i) => { if (t.checked) bulkSel.add(i.id); else bulkSel.delete(i.id); });
        bulkPaint();
      } else if (t.dataset && t.dataset.bitem !== undefined) {
        if (t.checked) bulkSel.add(t.dataset.bitem); else bulkSel.delete(t.dataset.bitem);
        bulkPaint();
      }
    });

    const goEl = $("#bulkGo");
    const boxEl = $("#bulkConfirm");
    if (!goEl) return;

    /* The Apply button used to arm itself on the first press — the label
       changed and nothing else did, which is indistinguishable from a dead
       button. The confirmation is now its own bar with its own verbs. */
    goEl.addEventListener("click", () => {
      const plan = bulkPlan().filter((p) => Math.abs(p.was - p.now) > 0.004);
      if (!plan.length) { toast(bulkSel.size ? "Those prices are already there." : "Nothing is selected."); return; }
      if (!boxEl) return;

      $("#bulkConfirmText").textContent = "This rewrites " + plan.length +
        (plan.length === 1 ? " price" : " prices") + ". The old ones are not kept.";
      boxEl.hidden = false;
      goEl.disabled = true;
    });

    const confirmNo = $("#bulkConfirmNo");
    if (confirmNo) confirmNo.addEventListener("click", () => {
      if (boxEl) boxEl.hidden = true;
      goEl.disabled = false;
    });

    const confirmGo = $("#bulkConfirmGo");
    if (!confirmGo) return;

    confirmGo.addEventListener("click", async () => {
      const plan = bulkPlan().filter((p) => Math.abs(p.was - p.now) > 0.004);
      if (!plan.length) return;

      confirmGo.disabled = true;
      $("#bulkConfirmText").textContent = "Changing " + plan.length + "…";

      const rows = plan.map((p) => ({ category: p.cat, name: p.name, price: p.now }));
      const r = await window.Auth.api("/api/menu?op=edit", {
        method: "POST", body: JSON.stringify({ action: "importRows", rows })
      });

      confirmGo.disabled = false;
      if (boxEl) boxEl.hidden = true;
      goEl.disabled = false;

      if (!r.ok) { toast((r.data && r.data.message) || "The prices were not changed."); return; }

      /* report what the server says it wrote, not what was planned: a silent
         zero out of forty-four is exactly the case worth shouting about */
      const done = Number(r.data.updatedItems || 0);
      toast(done
        ? done + (done === 1 ? " price changed" : " prices changed")
        : "Nothing changed — those prices were already there.");

      $("#bulkPricePanel").hidden = true;
      await reloadOwnMenu();
      renderMenuEditor();
    });
  })();

  /* ---------------- import ---------------- */

  wireReviewTools();

  const drop = $("#dropZone");
  const fileMenu = $("#fileMenu");

  $$(".import-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".import-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("#tabFile").hidden = b.dataset.tab !== "file";
      $("#tabLink").hidden = b.dataset.tab !== "link";
      const sheet = $("#tabSheet");
      if (sheet) sheet.hidden = b.dataset.tab !== "sheet";
    })
  );

  drop.addEventListener("click", () => fileMenu.click());
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileMenu.click(); } });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startScan(f);
  });
  fileMenu.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) startScan(f);
  });

  /* The API lives on the same host as the page — no cross-host hop, no CORS. */
  const API_BASE = "";

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

  /* ---------------- what an import will actually change ----------------
     The reader returns rows; what matters is what those rows do to a menu that
     already exists. POST ?op=save deleted every dish and category first and
     re-inserted — which is how an import made the old menu vanish. The default
     is now the merge the spreadsheet upload has always used: match on
     category + name (the same key the server uses, so the preview cannot lie),
     update the price, create only what is new, delete nothing.
     A loose key exists too, but only to *suggest* that two rows are one dish —
     never to merge them. Merging "Paneer Tikka (8 pcs)" into "Paneer Tikka"
     automatically is how a menu quietly loses a size. */

  const REV_STEP = { exact: 0, "0.25": 0.25, "0.5": 0.5, "1": 1 };
  const rev = { rows: [], pct: 0, round: "exact", replace: false, sample: false };

  function roundPrice(p, mode) {
    const step = REV_STEP[mode] || 0;
    const v = Number(p) || 0;
    if (!step) return Math.round(v * 100) / 100;
    return Math.round(v / step) * step;
  }

  const revKey = (cat, name) =>
    String(cat).trim().toLowerCase() + "|" + String(name).trim().toLowerCase();

  function looseKey(name) {
    return String(name)
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function menuIndex() {
    const exact = new Map();
    const loose = new Map();
    ((state.menu && state.menu.categories) || []).forEach((c) => {
      (c.items || []).forEach((it) => {
        exact.set(revKey(c.name, it.name), { name: it.name, price: Number(it.price) || 0, cat: c.name });
        const k = looseKey(it.name);
        if (k && !loose.has(k)) loose.set(k, { name: it.name, price: Number(it.price) || 0, cat: c.name });
      });
    });
    return { exact, loose };
  }

  function revBuild(source, sample) {
    const idx = menuIndex();
    const rows = [];
    (source.categories || []).forEach((c) => {
      (c.items || []).forEach((it) => {
        const base = it.price == null || it.price === "" ? null : Number(it.price);
        const existing = idx.exact.get(revKey(c.name, it.name)) || null;
        const near = existing ? null : (idx.loose.get(looseKey(it.name)) || null);
        rows.push({
          cat: c.name, name: it.name, desc: it.description || "", image: it.image || null,
          base, price: base, existing, near,
          /* a near match is left unticked: if it really is a second listing of a
             dish you already have, the safe default is to not create it. The
             owner ticks it if it is genuinely something new. */
          ticked: !near
        });
      });
    });
    rev.rows = rows;
    rev.pct = 0;
    rev.round = "exact";
    rev.replace = false;
    rev.sample = !!sample;
    return rows;
  }

  function revRecalc() {
    rev.rows.forEach((r) => {
      if (r.base == null) { r.price = null; return; }
      const p = r.base * (1 + rev.pct / 100);
      r.price = p < 0 ? 0 : roundPrice(p, rev.round);
    });
  }

  function revState(r) {
    if (r.existing) {
      const was = Number(r.existing.price) || 0;
      if (r.price != null && Math.abs(was - r.price) > 0.004) {
        return { key: "change", label: was.toFixed(2) + " → " + r.price.toFixed(2), cls: "chg" };
      }
      return { key: "same", label: "unchanged", cls: "same" };
    }
    if (r.near) return { key: "near", label: "looks like “" + r.near.name + "”", cls: "near" };
    return { key: "new", label: "new", cls: "new" };
  }

  function renderReview() {
    const host = $("#reviewRows");
    if (!host) return;

    host.innerHTML = rev.rows.map((r, i) => {
      const st = revState(r);
      return '<label class="review-row">' +
        '<input type="checkbox" data-review="' + i + '"' + (r.ticked ? " checked" : "") + ">" +
        '<span><span class="rc">' + esc(r.cat) + "</span><br>" + esc(r.name) + "</span>" +
        '<span class="rp">' + (r.price == null ? "—" : "AED " + r.price.toFixed(2)) +
          (r.existing && st.key === "change" ? '<br><s>' + esc(String(Number(r.existing.price).toFixed(2))) + "</s>" : "") + "</span>" +
        '<span class="rev-badge ' + st.cls + '">' + esc(st.label) + "</span>" +
        "</label>";
    }).join("");

    const counts = { new: 0, change: 0, same: 0, near: 0 };
    rev.rows.forEach((r) => { counts[revState(r).key]++; });
    const picked = rev.rows.filter((r) => r.ticked).length;

    $("#reviewSummary").textContent =
      counts.new + " new · " + counts.change + " price change" + (counts.change === 1 ? "" : "s") +
      " · " + counts.same + " unchanged" +
      (counts.near ? " · " + counts.near + " need a look" : "") +
      " · " + picked + " selected" + (rev.pct ? " · prices " + (rev.pct > 0 ? "+" : "") + rev.pct + "%" : "");

    $$("[data-review]").forEach((b) => b.addEventListener("change", () => {
      rev.rows[Number(b.dataset.review)].ticked = b.checked;
      renderReview();
    }));

    const rep = $("#revReplace");
    if (rep) rep.checked = rev.replace;
    const apply = $("#applyImport");
    if (apply) apply.textContent = rev.replace ? "Replace my menu" : "Merge into my menu";
  }

  function wireReviewTools() {
    const pct = $("#revPct");
    if (!pct || pct.dataset.wired) return;
    pct.dataset.wired = "1";

    const recalc = () => {
      const n = Number(pct.value);
      rev.pct = Number.isFinite(n) ? Math.max(-90, Math.min(300, n)) : 0;
      rev.round = $("#revRound").value;
      revRecalc();
      renderReview();
    };
    pct.addEventListener("input", recalc);
    $("#revRound").addEventListener("change", recalc);

    $$("[data-sel]").forEach((b) => b.addEventListener("click", () => {
      const how = b.dataset.sel;
      rev.rows.forEach((r) => {
        const st = revState(r).key;
        r.ticked = how === "all" ? true
          : how === "changed" ? (st === "new" || st === "change")
          : st === "new";
      });
      renderReview();
    }));

    const rep = $("#revReplace");
    if (rep) rep.addEventListener("change", async () => {
      if (!rep.checked) { rev.replace = false; renderReview(); return; }
      /* replacing deletes dishes; make it a second, deliberate press */
      rep.checked = false;
      if (rep.dataset.armed !== "1") {
        rep.dataset.armed = "1";
        toast("Press it again to replace the whole menu — everything not in this file goes.");
        setTimeout(() => { rep.dataset.armed = ""; }, 5000);
        return;
      }
      rep.dataset.armed = "";
      rep.checked = true;
      rev.replace = true;
      renderReview();
    });
  }

  function showImportResult(data) {
    pendingImport = data;
    revBuild(data, false);
    renderReview();

    $("#scan").hidden = true;          /* the progress panel has done its job */
    $("#review").hidden = false;
    $("#protoNote").hidden = false;
    $("#protoNote").innerHTML =
      "<b>Read from " + data.source + ".</b> " +
      (data.imagesNotice || "Check every line before publishing.") +
      " Nothing reaches the guest menu until you press <b>Merge into my menu</b>.";
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

  /* A real read: shrink the photo in the browser, send it to our endpoint, and let
     the same review screen do the rest — nothing is written until the owner checks it. */
  async function startScan(file) {
    if (scanning) return;
    if (!file) return;
    if (/^application\/pdf$/i.test(file.type)) {
      toast("PDF reading is not built yet — photograph the page and upload that.");
      return;
    }
    if (!/^image\//i.test(file.type)) {
      toast("Use a photo — JPG, PNG or WebP.");
      return;
    }

    scanning = true;
    scanOn();
    toast("Reading " + (file.name || "your photo"));

    const progress = scanProgress(700);
    let data = null;
    try {
      const dataUrl = await shrinkPhoto(file);
      const token = await window.Auth.token();
      const res = await fetch(API_BASE + "/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ image: dataUrl })
      });
      data = await res.json();
      if (!res.ok && data && data.code === "NO_SESSION") location.replace("/login.html");
    } catch (e) {
      data = { ok: false, message: "We could not read that photo. Check your connection and try again." };
    }

    await progress;
    scanning = false;

    if (data && data.ok) showImportResult(data);
    else showImportFailure(data);
  }

  /** Downscale to something a model reads well and a 4.5 MB body can carry. */
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("IMAGE")); };
      img.src = url;
    });
  }

  function showSampleReview() {
    revBuild({ categories: DEMO_MENU.categories.slice(0, 5).map((c) => ({ name: c.name, items: c.items.slice(0, 2) })) }, true);
    renderReview();
    $("#review").hidden = false;
    $("#review").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function reloadOwnMenu() {
    try {
      const m = await window.Auth.api("/api/menu?mine=1", { cache: "no-store" });
      if (m.ok && m.data.categories) {
        state.menu = {
          categories: m.data.categories.map((c) => ({
            id: c.id, name: c.name, arName: c.arName || "", featured: !!c.featured,
            items: (c.items || []).map((it) => ({
              id: it.id, name: it.name, desc: it.description || "",
              arName: it.arName || "", arDesc: it.arDesc || "",
              price: it.price == null ? 0 : it.price, diet: null,
              image: it.image || null, soldOut: !!it.soldOut
            }))
          }))
        };
        state.menuImported = true;
        save();
      }
    } catch (e) {
      /* the editor shows what it has; the next load fixes it */
    }
  }

  $("#discard").addEventListener("click", () => {
    $("#review").hidden = true;
    $("#scan").hidden = true;
    $("#protoNote").hidden = true;
    pendingImport = null;
  });

  $("#applyImport").addEventListener("click", async () => {
    const picked = rev.rows.filter((r) => r.ticked);
    if (!picked.length) { toast("Select at least one dish"); return; }

    /* the sample rows are a demonstration, not a menu: never write them */
    if (rev.sample) {
      toast(picked.length + " sample dishes applied");
      state.menu = JSON.parse(JSON.stringify(DEMO_MENU));
      state.menuImported = true;
      save();
      showView("menu");
      return;
    }

    const btn = $("#applyImport");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = rev.replace ? "Replacing…" : "Merging…";

    let r;

    if (rev.replace) {
      /* the only destructive path left, and it is a deliberate, guarded choice */
      const order = [];
      const byCat = new Map();
      picked.forEach((row) => {
        if (!byCat.has(row.cat)) { byCat.set(row.cat, []); order.push(row.cat); }
        byCat.get(row.cat).push(row);
      });
      const categories = order.map((name, ci) => ({
        id: "c" + ci, name,
        items: byCat.get(name).map((row, j) => ({
          id: "i" + ci + "x" + j,
          name: row.name, desc: row.desc || "",
          price: row.price == null ? 0 : row.price,
          diet: null, image: row.image || null, soldOut: false,
          source: (pendingImport && pendingImport.source) || "manual", sourceId: null
        }))
      }));
      r = await window.Auth.api("/api/menu?op=save", { method: "POST", body: JSON.stringify({ categories }) });
    } else {
      /* merge: same key the server matches on, no deletes */
      const rows = picked.map((row) => ({
        category: row.cat, name: row.name, price: row.price,
        description: row.desc || "", image: row.image || ""
      }));
      r = await window.Auth.api("/api/menu?op=edit", {
        method: "POST",
        body: JSON.stringify({ action: "importRows", rows })
      });
    }

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) {
      toast(r.data.message || "The database refused that. Nothing was changed.");
      return;
    }

    if (rev.replace) {
      toast(picked.length + " dishes — the menu was replaced");
    } else {
      const d = r.data || {};
      toast((d.createdItems || 0) + " new · " + (d.updatedItems || 0) + " updated · nothing deleted");
    }

    rev.rows = [];
    pendingImport = null;
    rev.replace = false;
    $("#review").hidden = true;
    $("#protoNote").hidden = true;
    const rep = $("#revReplace");
    if (rep) rep.checked = false;

    await reloadOwnMenu();
    showView("menu");
  });

  /* ---------------- qr pane ---------------- */

  /* The guest page needs the restaurant in the address. menu.html on its own is
     the page with no restaurant, which is the "This menu is not available"
     screen — so every "open the menu" link points at the permanent address the
     QR encodes, /<handle>, and never at the bare page. */
  function renderGuestLinks() {
    const href = state.handle ? "/" + encodeURIComponent(state.handle) : "/menu.html";
    ["#guestViewLink", "#guestViewTop", "#guestViewMore"].forEach((sel) => {
      const el = $(sel);
      if (el) el.href = href;
    });
  }

  function renderQrPane() {
    renderGuestLinks();
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

  /* This card has no save button, and the field used to write only to this
     browser's storage — so the link looked saved and came back blank on the
     next load, when the restaurant was read from the server again. Persist it
     on change (blur or Enter), not on every keystroke. */
  $("#mapsUrl").addEventListener("input", (e) => {
    state.restaurant.mapsUrl = e.target.value.trim();
    save();
    renderOverview();
  });

  $("#mapsUrl").addEventListener("change", async (e) => {
    const v = e.target.value.trim();
    state.restaurant.mapsUrl = v;
    const r = await window.Auth.api("/api/restaurant", {
      method: "POST", body: JSON.stringify({ maps_url: v || null })
    });
    if (!r.ok) { toast(r.data.message || "That link was not saved."); return; }
    if (r.data.restaurant) applyRestaurant(r.data.restaurant);
    renderDocs();
    renderOverview();
    toast(v ? "Maps link saved" : "Maps link removed");
  });


  /* ---------------- guest page identity ---------------- */

  function renderProfile() {
    const set = (sel, val) => { const el = $(sel); if (el) el.value = val || ""; };
    set("#setRestName", state.restaurant.name);
    set("#setTagline", state.restaurant.tagline);
    set("#setAddress", state.restaurant.address);
    set("#setCurrency", state.currency || "AED");
    const waSplit = DigiPhone.split(state.restaurant.whatsapp || "");
    if (waSplit.dial) {
      const cc = $("#setWaCC"), num = $("#setWaNum");
      if (cc) cc.value = waSplit.dial;
      if (num) num.value = waSplit.national || "";
    }
    const prev = $("#coverPreview");
    if (prev) {
      const url = state.restaurant.coverUrl;
      prev.style.backgroundImage = url ? 'url("' + url + '")' : "";
      prev.classList.toggle("has", Boolean(url));
    }

    const soc = state.social || {};
    set("#setIg", soc.instagram);
    set("#setFb", soc.facebook);
    set("#setTt", soc.tiktok);
    set("#setWeb", soc.website);
    renderPalette();
    renderAppearance();
  }

  /* ---------------- appearance ----------------
     The guest page's own look, mirrored from menu2.css: three grounds, two ink
     tones, three display faces. The values are duplicated here on purpose — the
     preview has to paint what the real sheet paints, and the sheet cannot be
     read from this page. A mismatch shows up as a preview that promises
     something the menu will not do, so change both together. */
  const GROUNDS = {
    light: { title: "Bone", paper: "#FBF7F0", paper2: "#F3ECE1", ink: "#17140F", ink3: "#6C6357", rule: "#E4DACA" },
    dark: { title: "Charcoal", paper: "#14171A", paper2: "#1B1F24", ink: "#F3EFE7", ink3: "#9CA4AC", rule: "#262C33" },
    clay: { title: "Clay", paper: "#EFE2D0", paper2: "#E6D6BE", ink: "#241C14", ink3: "#7A6A57", rule: "#D6C3A9" }
  };

  const FACES = {
    serif: '"Fraunces", Georgia, serif',
    grotesk: '"Outfit", system-ui, sans-serif',
    satoshi: '"Satoshi", system-ui, sans-serif'
  };

  function appearance() {
    const t = state.theme && typeof state.theme === "object" ? state.theme : {};
    return {
      ground: GROUNDS[t.ground] ? t.ground : "dark",
      ink: t.ink === "strong" ? "strong" : "soft",
      font: FACES[t.font] ? t.font : "serif"
    };
  }

  function renderAppearance() {
    const a = appearance();
    const g = GROUNDS[a.ground];
    const mark = (sel, key) => $$(sel).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset[key] === a[key])));

    mark("[data-ground]", "ground");
    mark("[data-ink]", "ink");
    mark("[data-font]", "font");

    const look = $("#lookPreview");
    if (look) {
      look.style.setProperty("--look-paper", g.paper);
      look.style.setProperty("--look-paper-2", g.paper2);
      look.style.setProperty("--look-ink", a.ink === "strong" ? (a.ground === "dark" ? "#FFFFFF" : "#000000") : g.ink);
      look.style.setProperty("--look-ink-3", g.ink3);
      look.style.setProperty("--look-rule", g.rule);
      look.style.setProperty("--look-brand", state.accent || "#F7941D");
      look.style.setProperty("--look-accent-ink", accentInk(state.accent));
      look.style.setProperty("--look-font", FACES[a.font]);
    }

    const nm = $("#lookName");
    if (nm) nm.textContent = state.restaurant.name || "Your restaurant";
    const tag = $("#lookTag");
    if (tag) tag.textContent = g.title + (a.ink === "strong" ? " · high contrast" : "");
  }

  /* one delegated listener for the three choice rows */
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-ground],[data-ink],[data-font]");
    if (!el) return;
    const t = Object.assign({}, state.theme || {});
    if (el.dataset.ground) t.ground = el.dataset.ground;
    if (el.dataset.ink) t.ink = el.dataset.ink;
    if (el.dataset.font) t.font = el.dataset.font;
    state.theme = t;
    save();
    renderAppearance();
  });

  const saveLook = $("#saveAppearance");
  if (saveLook) {
    saveLook.addEventListener("click", async () => {
      const label = saveLook.textContent;
      saveLook.disabled = true;
      saveLook.textContent = "Saving…";
      const r = await window.Auth.api("/api/restaurant", {
        method: "POST",
        body: JSON.stringify({ accent: state.accent, theme: appearance() })
      });
      saveLook.disabled = false;
      saveLook.textContent = label;
      if (!r.ok) { toast(r.data.message || "Could not save the appearance."); return; }
      if (r.data && r.data.restaurant) applyRestaurant(r.data.restaurant);
      toast("Appearance saved — your guest page is updated");
    });
  }

  /* ---------------- menu colour ----------------
     restaurants.accent is already what the guest page paints with — the order
     buttons, the live category chip, the cart — and /api/restaurant already
     accepts it on every save. What was missing was a way to choose it: the
     colour could only ever be decided by uploading a logo. Six presets, plus
     whatever the logo's own palette produced, offered first. */
  const PALETTES = [
    { name: "Saffron", hex: "#F7941D" },
    { name: "Chili", hex: "#D9483B" },
    { name: "Olive", hex: "#7C8B3B" },
    { name: "Teal", hex: "#2F8B84" },
    { name: "Clay", hex: "#B5643C" },
    { name: "Slate", hex: "#5D7285" }
  ];

  /* white or near-black on the accent, whichever is readable — the same rule the
     guest page runs, so the preview cannot promise something the menu won't do */
  function accentInk(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "#14120E";
    const n = parseInt(m[1], 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    return L > 0.32 ? "#14120E" : "#FFFFFF";
  }

  function renderPalette() {
    const host = $("#swatches");
    if (!host) return;
    const current = String(state.accent || "").toLowerCase();
    const fromLogo = (state.swatches || [])
      .filter((h) => /^#[0-9a-f]{6}$/i.test(String(h)))
      .map((h) => ({ name: "Logo", hex: h }));

    const seen = new Set();
    const list = fromLogo.concat(PALETTES).filter((p) => {
      const k = String(p.hex).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    /* a colour that is set but sits outside the list — the seed default, or one
       this build no longer offers — still has to look chosen, or the row opens
       with nothing selected and reads as broken. It goes last as "Custom" so the
       presets keep their own names and positions. */
    if (/^#[0-9a-f]{6}$/i.test(String(state.accent || "")) && !seen.has(current)) {
      list.push({ name: "Custom", hex: state.accent });
      seen.add(current);
    }

    host.innerHTML = list.map((p) => {
      const on = String(p.hex).toLowerCase() === current;
      return '<button type="button" class="swatch' + (on ? " on" : "") + '" data-accent="' + esc(p.hex) +
        '" aria-pressed="' + on + '" title="' + esc(p.name) + " " + esc(p.hex) + '">' +
        '<i style="background:' + esc(p.hex) + '"></i><span>' + esc(p.name) + "</span></button>";
    }).join("");

    const prev = $("#swatchPreview");
    if (prev) {
      prev.style.setProperty("--brand", state.accent || "#F7941D");
      prev.style.setProperty("--accent-ink", accentInk(state.accent));
    }
  }

  /* delegated: the swatch row is rebuilt on every paint of the guest-page card */
  document.addEventListener("click", (e) => {
    const sw = e.target.closest("[data-accent]");
    if (!sw) return;
    state.accent = sw.dataset.accent;
    save();
    renderPalette();
    renderAppearance();
    toast("Colour set to " + sw.dataset.accent + " — press Save appearance");
  });

  const cleanBtn = $("#cleanFiles");
  if (cleanBtn) {
    cleanBtn.addEventListener("click", async () => {
      cleanBtn.disabled = true;
      cleanBtn.textContent = "Checking…";
      const dry = await window.Auth.api("/api/restaurant?upload=1&action=sweep");
      const list = (dry.data && dry.data.wouldDelete) || [];
      cleanBtn.textContent = "Clean up unused files";
      cleanBtn.disabled = false;

      if (!dry.ok) { toast(dry.data.message || "Could not check the storage."); return; }
      if (!list.length) { toast("Nothing to clean — every file is in use"); return; }
      if (!confirm(list.length + " unused file" + (list.length === 1 ? "" : "s") + " will be deleted. Continue?")) return;

      const done = await window.Auth.api("/api/restaurant?upload=1&action=sweep&go=1");
      if (!done.ok) { toast(done.data.message || "Cleanup failed."); return; }
      toast((done.data.deleted || []).length + " unused files removed");
    });
  }

  const coverInput = $("#coverFile");
  if (coverInput) {
    coverInput.addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      toast("Uploading…");
      const url = await uploadTo("cover", f);
      if (url) {
        state.restaurant.coverUrl = url;
        save();
        renderProfile();
        toast("Cover uploaded — it is the background of your guest page");
      }
    });
  }

  $("#saveProfile").addEventListener("click", async () => {
    const btn = $("#saveProfile");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";

    const payload = {
      name: $("#setRestName").value.trim(),
      tagline: $("#setTagline").value.trim(),
      address_line: $("#setAddress").value.trim(),
      currency: $("#setCurrency").value,
      /* the colour chosen in this card: the guest page repaints from
         restaurants.accent, so it has to travel with the rest of the profile */
      accent: state.accent,
      instagram: $("#setIg").value.trim(),
      facebook: $("#setFb").value.trim(),
      tiktok: $("#setTt").value.trim(),
      website: $("#setWeb").value.trim()
    };

    /* only send the number when one was typed: an empty box must not wipe the
       line the orders already go to */
    const waNum = ($("#setWaNum").value || "").trim();
    if (waNum.replace(/\D/g, "").length >= 6) {
      payload.whatsapp_e164 = DigiPhone.toE164($("#setWaCC").value, waNum);
    }

    const r = await window.Auth.api("/api/restaurant", { method: "POST", body: JSON.stringify(payload) });

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) { toast(r.data.message || "Could not save the guest page."); return; }

    applyRestaurant(r.data.restaurant);
    renderProfile();
    toast("Guest page updated");
  });

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
      const m = await window.Auth.api("/api/menu?mine=1", { cache: "no-store" });
      if (!m.ok || !m.data.categories) return false;
      state.menu = {
        categories: m.data.categories.map((c) => ({
          id: c.id,
          name: c.name,
          arName: c.arName || "",
          featured: !!c.featured,
          items: c.items.map((it) => ({
            id: it.id,
            name: it.name,
            arName: it.arName || "",
            desc: it.description || "",
            arDesc: it.arDesc || "",
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
      $("#pickerBody").innerHTML =
        '<input class="input picker-search" id="pickerSearch" type="search" placeholder="Search ' +
        pool.length + ' dishes…" autocomplete="off">' +
        pool.map((x) => `
        <label class="picker-row" data-name="${esc(String(x.item.name).toLowerCase())}">
          <input type="checkbox" data-pick="${x.item.id}">
          <span class="pn">${esc(x.item.name)}</span>
          <span class="pp">${priceLabel(x.item.price)}</span>
          <span class="pc">${esc(x.firstCat)}</span>
        </label>`).join("");

      const refresh = () => {
        const n = $$("[data-pick]").filter((x) => x.checked).length;
        const shown = $$(".picker-row").filter((r) => r.style.display !== "none").length;
        $("#pickerCount").textContent = n + " selected · " + shown + " shown";
        $("#pickerAdd").disabled = n === 0;
      };

      $("#pickerCount").textContent = "0 selected";
      $("#pickerAdd").disabled = true;

      $$("[data-pick]").forEach((cb) => cb.addEventListener("change", refresh));

      const search = $("#pickerSearch");
      if (search) {
        search.addEventListener("input", () => {
          const q = search.value.trim().toLowerCase();
          $$(".picker-row").forEach((row) => {
            row.style.display = !q || row.dataset.name.indexOf(q) !== -1 ? "" : "none";
          });
          refresh();
        });
        search.focus();
      }
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
    /* the guest page's look, when the row has one */
    if (r.theme && typeof r.theme === "object") state.theme = r.theme;
    state.status = r.status || "trial";
    /* The logo and the licence live in the row, and the publish gate reads the
       row. The checklist must read the same place: a document sitting in this
       browser's storage is not uploaded, and "Done" beside a setting the server
       cannot see is how publishing answered "Still needed: logo, licence". */
    state.docs = { logo: r.logo_url || null, license: r.licence_url || null };
    /* the free week: kept in state so the overview can say how long is left */
    state.trialEnds = r.trial_ends || null;
    state.paidThrough = r.paid_through || null;
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
    renderGuestLinks();
  }

  function blankState(account) {
    return {
      account: account || null,
      restaurant: { name: "", ownerName: "", purposes: ["Dine In", "Take Away"], whatsapp: "", orderEmail: "", mapsUrl: "" },
      docs: { logo: null, license: null },
      handle: "",
      accent: "#f0485f",
      menuImported: false,
      menu: null,
      onboarded: false
    };
  }

  const obParam = new URLSearchParams(location.search).get("onboard");

  (async function boot() {
    /* the landing page's picture of the product: sample data, no API, no writes */
    if (DEMO) {
      $("#shell").style.display = "";
      renderOverview();
      showView("overview");
      return;
    }

    /* sample data must never leak into a real account */
    if (!state.restaurantId) {
      const u = window.Auth.user() || {};
      const meta = u.user_metadata || {};
      const acct = state.account || (u.email ? { name: meta.name || meta.full_name || "", email: u.email, mobile_e164: meta.mobile_e164 || "" } : null);
      state = blankState(acct);
      if (acct && acct.name) state.restaurant.ownerName = acct.name;
      saveState(state);
    }

    let saved = null;
    try {
      const r = await window.Auth.api("/api/restaurant");
      if (r.ok) {
        saved = r.data.restaurant;
        /* owner, or a staff login from 0008 — the server decides, and the page
           only makes it visible: what is hidden here is refused there anyway */
        state.role = r.data.role || "owner";
      }
    } catch (e) {
      /* api() already sent us to the sign-in page on 401 */
    }

    document.body.dataset.role = state.role || "owner";

    if (saved) {
      applyRestaurant(saved);

      /* the address is the restaurant. Someone signed in as one restaurant who
         opens another restaurant's dashboard is sent to their own, so a copied
         link never shows a menu they were not given. */
      const seg = (location.pathname || "").split("/").filter(Boolean);
      const atHandle = seg.length === 2 && /^dashboard$/i.test(seg[1]) ? seg[0].toLowerCase() : "";
      if (atHandle && saved.handle && atHandle !== String(saved.handle).toLowerCase()) {
        location.replace("/" + saved.handle + "/dashboard");
        return;
      }

      /* the menu lives in Postgres; pull it back so the editor shows what the
         guest page shows, trial or not */
      try {
        const m = await window.Auth.api("/api/menu?mine=1", { cache: "no-store" });
        if (m.ok && m.data.categories && m.data.categories.length) {
          state.menu = {
            categories: m.data.categories.map((c, i) => ({
              id: c.id,
              name: c.name,
              featured: !!c.featured,
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

    /* No restaurant yet: the wizard. An owner who already has one is never put
       back into it — ?onboard=2 survives in history after signup, so a Back
       button used to reopen step 3 where their own handle read as "taken" and
       "Open my dashboard" could not be clicked again. */
    if (!saved) {
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

    /* ---------------- password ---------------- */

    /* No forced prompt: the emailed password signs them in and works like any
       other. "Your sign-in" sits in Documents for whenever they want to change it. */

    /* A Google-only account has no password to change — say "set" and mean it:
       it is the one way an owner can hand a login to a manager without an
       invite system. Detected from the providers Supabase puts on the token. */
    const me = window.Auth.user() || {};
    const providers = (me.app_metadata && me.app_metadata.providers) || [];
    const googleOnly = providers.length > 0 && providers.indexOf("email") === -1;
    if (googleOnly) {
      if ($("#pwLede")) $("#pwLede").textContent = "You sign in with Google. This account has no password yet — set one and the same email will also work with it.";
      if ($("#pwGoogleHint")) $("#pwGoogleHint").hidden = false;
      if ($("#pwSave")) $("#pwSave").textContent = "Set password";
    }

    const pwSave = $("#pwSave");
    if (pwSave) {
      pwSave.addEventListener("click", async () => {
        const a = $("#newPass"), b = $("#newPass2");
        let ok = true;
        ok = markErr(a, $("#newPassErr"), a.value.length < 8) && ok;
        ok = markErr(b, $("#newPass2Err"), b.value !== a.value) && ok;
        if (!ok) return;
        const label = pwSave.textContent;
        pwSave.disabled = true;
        pwSave.textContent = "Saving…";
        const r = await window.Auth.changePassword(a.value, true);
        pwSave.disabled = false;
        pwSave.textContent = label;
        if (!r.ok) {
          a.classList.add("err");
          $("#newPassErr").textContent = r.message;
          $("#newPassErr").classList.add("show");
          return;
        }
        a.value = ""; b.value = "";
        $("#newPassErr").classList.remove("show");
        $("#newPass2Err").classList.remove("show");
        if ($("#tempPwNote")) $("#tempPwNote").hidden = true;
        toast(googleOnly
          ? "Password set — this email now signs in with it as well as Google."
          : "Password changed — use the new one next time you sign in.");
      });
    }

    function markErr(input, errEl, bad) {
      input.classList.toggle("err", !!bad);
      errEl.classList.toggle("show", !!bad);
      return !bad;
    }
  })();
})();

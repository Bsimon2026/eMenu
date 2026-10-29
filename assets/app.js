/* ===========================================================
   DigiMenu — onboarding front end
   Vanilla JS, no build step. State persists in localStorage so
   the guest page (menu.html) reads the same record.
   =========================================================== */

(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    account: { name: "", mobile: "", email: "", password: "" },
    restaurant: { name: "", ownerName: "", purposes: ["Dine In", "Take Away"], whatsapp: "+971", mapsUrl: "" },
    docs: { logo: null, license: null },
    handle: "",
    accent: "#7c2231",
    swatches: [],
    menuUploaded: false,
    step: 1
  };

  let saved = loadState();
  if (saved) Object.assign(state, saved);
  if (!state.docs) state.docs = { logo: null, license: null };

  const STEPS = ["You", "Restaurant", "Documents", "Link"];

  /* ---------------- stepper ---------------- */

  function renderSteppers() {
    const current = state.step;
    [$("#stepper"), $("#stepper2")].forEach((host) => {
      if (!host) return;
      host.innerHTML = STEPS.map((label, i) => {
        const n = i + 1;
        const st = n < current ? "done" : n === current ? "current" : "todo";
        return `<span class="step" data-state="${st}">
            <span class="n">${n < current ? "✓" : n}</span>
            <span class="lbl">${label}</span>
          </span>${i < STEPS.length - 1 ? '<span class="step-line"></span>' : ""}`;
      }).join("");
    });
  }

  /* ---------------- live menu card ---------------- */

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "R";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function renderCard() {
    const card = $("#menuCard");
    if (!card) return;
    const name = state.restaurant.name || "Your restaurant";
    const purposes = (state.restaurant.purposes && state.restaurant.purposes.length)
      ? state.restaurant.purposes.map((p) => (p === "Dine In" ? "Dine in" : p)).join(" · ")
      : "Add your channels";

    $("#cardName").textContent = name;
    $("#cardMeta").textContent = "Abu Dhabi · " + purposes;
    $("#cardFoot").textContent = state.handle
      ? "ogle.live/digimenu/" + state.handle
      : "Scan to order on WhatsApp";

    const logo = $("#cardLogo");
    if (state.docs.logo) {
      logo.innerHTML = `<img src="${state.docs.logo}" alt="">`;
      logo.style.background = "#fff";
    } else {
      logo.textContent = initials(state.restaurant.name || state.account.name);
      logo.style.background = state.accent;
      logo.style.color = readableInk(state.accent);
    }

    card.style.setProperty("--brand", state.accent);

    const body = $("#cardBody");
    body.innerHTML = CARD_PREVIEW.map(
      (sec) => `
      <div>
        <div class="mcat">${sec.cat}<span>${sec.items.length}${sec.items.length === 1 ? " item" : " items"}</span></div>
        ${sec.items
          .map(
            ([nm, pr]) => `<div class="mrow"><span class="nm">${nm}</span><span class="lead"></span><span class="pr">${pr}</span></div>`
          )
          .join("")}
      </div>`
    ).join("");

    // the little QR glyph in the card foot, as a purely graphic mark
    const qm = $(".qr-mini");
    if (qm && !qm.childElementCount) {
      const bits = [1,1,1,0,1,0,1,1,1,0,1,0,1,1,1,1,0,1,0,1,1,1,1,0,1];
      qm.innerHTML = bits.map((b) => `<i style="opacity:${b ? 0.62 : 0}"></i>`).join("");
    }
  }

  function setAccent(hex) {
    state.accent = hex;
    renderCard();
  }

  /* ---------------- view switching ---------------- */

  const VIEWS = { auth: "#viewAuth", onboarding: "#viewOnboard", dash: "#viewDash" };

  function show(view) {
    Object.values(VIEWS).forEach((sel) => $(sel).classList.remove("is-active"));
    $(VIEWS[view]).classList.add("is-active");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function showAuthTab(which) {
    $("#authIn").hidden = which !== "in";
    $("#authUp").hidden = which !== "up";
    $$(".seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.auth === which)));
    if (which === "up") {
      state.step = 1;
      renderSteppers();
    }
  }

  function showStep(n) {
    show("onboarding");
    state.step = n;
    renderSteppers();
    [2, 3, 4].forEach((s) => ($("#step" + s).hidden = s !== n));
    if (n === 3) renderDocs();
    if (n === 4) {
      const h = $("#handle");
      if (!h.value) {
        h.value = slugify(state.restaurant.name || state.account.name);
        checkHandle(h.value);
      }
    }
    const focusTarget = n === 2 ? $("#restName") : n === 3 ? $("#toStep4") : $("#handle");
    if (focusTarget) setTimeout(() => focusTarget.focus({ preventScroll: true }), 320);
  }

  /* ---------------- validation helpers ---------------- */

  function markErr(input, errEl, bad) {
    input.classList.toggle("err", !!bad);
    if (errEl) errEl.classList.toggle("show", !!bad);
    return !bad;
  }

  function emailOk(v) {
    return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.trim());
  }

  function digits(v) {
    return String(v).replace(/\D/g, "");
  }

  /* ---------------- step 1 ---------------- */

  $("#formAccount").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#accName");
    const mobile = $("#accMobile");
    const email = $("#accEmail");
    const pass = $("#accPass");

    let ok = true;
    ok = markErr(name, $("#accNameErr"), !name.value.trim()) && ok;
    ok = markErr(mobile, $("#accMobileErr"), digits(mobile.value).length < 7) && ok;
    ok = markErr(email, $("#accEmailErr"), !emailOk(email.value)) && ok;
    ok = markErr(pass, $("#accPassErr"), pass.value.length < 8) && ok;
    if (!ok) return;

    state.account = {
      name: name.value.trim(),
      mobile: digits(mobile.value),
      email: email.value.trim(),
      password: pass.value
    };
    saveState(state);
    showStep(2);

    const rn = $("#restName");
    if (!rn.value && state.restaurant.name) rn.value = state.restaurant.name;
    const on = $("#ownerName");
    if (!on.value) on.value = state.account.name;
    renderCard();
  });

  /* ---------------- step 2 ---------------- */

  const choiceLabels = $$("#purposeChoices .choice");
  function syncChoices() {
    choiceLabels.forEach((lab) => {
      const cb = $("input", lab);
      lab.dataset.checked = String(cb.checked);
    });
    state.restaurant.purposes = choiceLabels
      .filter((lab) => $("input", lab).checked)
      .map((lab) => $("input", lab).value);
    renderCard();
  }
  choiceLabels.forEach((lab) => $("input", lab).addEventListener("change", syncChoices));

  $("#restName").addEventListener("input", (e) => {
    state.restaurant.name = e.target.value;
    renderCard();
  });

  $("#formRestaurant").addEventListener("submit", (e) => {
    e.preventDefault();
    const rn = $("#restName");
    const wa = $("#waNum");

    let ok = true;
    ok = markErr(rn, $("#restNameErr"), !rn.value.trim()) && ok;
    ok = markErr(wa, $("#waErr"), digits(wa.value).length < 7) && ok;
    const noPurpose = state.restaurant.purposes.length === 0;
    $("#purposeErr").classList.toggle("show", noPurpose);
    ok = !noPurpose && ok;
    if (!ok) return;

    state.restaurant.name = rn.value.trim();
    state.restaurant.ownerName = $("#ownerName").value.trim();
    state.restaurant.whatsapp = $("#waCC").value + digits(wa.value);
    saveState(state);
    showStep(3);
  });

  /* ---------------- step 3: uploads ---------------- */

  function renderDocs() {
    const { logo, license } = state.docs;

    if (logo) {
      $("#thumbLogo").innerHTML = `<img src="${logo}" alt="">`;
      $("#udLogo").textContent = "Colours pulled from your logo";
      $("#udLogo").classList.add("ok");
      $("#pillLogo").className = "pill ok";
      $("#pillLogo").textContent = "Uploaded";
      $("#upLogo").classList.add("has-file");
    }
    if (license) {
      $("#thumbLic").innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.1"/><path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.1"/></svg>`;
      $("#udLic").textContent = "Received";
      $("#udLic").classList.add("ok");
      $("#pillLic").className = "pill ok";
      $("#pillLic").textContent = "Uploaded";
      $("#upLic").classList.add("has-file");
    }

    const gL = $("#gateLogo");
    const gC = $("#gateLic");
    if (gL) {
      gL.textContent = logo ? "✓ added" : "— missing";
      gL.style.color = logo ? "var(--veg)" : "var(--brand)";
    }
    if (gC) {
      gC.textContent = license ? "✓ added" : "— missing";
      gC.style.color = license ? "var(--veg)" : "var(--brand)";
    }
  }

  function wireFile(inputId, onFile, labelId) {
    const input = $(inputId);
    const label = labelId ? $(labelId) : null;
    if (!input) return;

    input.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) onFile(f);
    });

    if (label) {
      ["dragenter", "dragover"].forEach((ev) =>
        label.addEventListener(ev, (e) => {
          e.preventDefault();
          label.classList.add("dragover");
        })
      );
      ["dragleave", "drop"].forEach((ev) =>
        label.addEventListener(ev, (e) => {
          e.preventDefault();
          label.classList.remove("dragover");
        })
      );
      label.addEventListener("drop", (e) => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) onFile(f);
      });
    }
  }

  function readAsDataURL(file, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.readAsDataURL(file);
  }

  wireFile("#fileLogo", (f) => {
    readAsDataURL(f, (url) => {
      state.docs.logo = url;
      const img = new Image();
      img.onload = () => {
        extractPalette(img, (pal) => {
          if (pal) {
            setAccent(pal.hex);
            state.swatches = pal.swatches;
          }
          saveState(state);
          renderDocs();
        });
      };
      img.src = url;
    });
  }, "#upLogo");

  wireFile("#fileLic", (f) => {
    state.docs.license = f.name;
    saveState(state);
    renderDocs();
  }, "#upLic");

  $("#mapsUrl").addEventListener("input", (e) => {
    state.restaurant.mapsUrl = e.target.value.trim();
    const ud = $("#udMap");
    if (state.restaurant.mapsUrl) {
      ud.textContent = "Link saved — address and hours will be pulled at publish";
      ud.classList.add("ok");
    }
    saveState(state);
  });

  $("#toStep4").addEventListener("click", () => showStep(4));

  /* ---------------- step 4: handle + QR ---------------- */

  const handleInput = $("#handle");
  const handleStatus = $("#handleStatus");
  let handleTimer = null;
  let handleFree = false;

  function suggestionsFor(base) {
    const root = base || "your-restaurant";
    return [root + "-abudhabi", root + "-uae", root + "-menu", root + "1"];
  }

  function checkHandle(raw) {
    const v = slugify(raw);
    handleInput.value = v;
    $("#suggestions").innerHTML = "";
    if (!v || v.length < 3) {
      handleFree = false;
      handleStatus.className = "handle-status";
      handleStatus.textContent = v ? "At least 3 characters." : "";
      handleStatus.style.color = "var(--brand)";
      updateFinish();
      return;
    }
    handleStatus.className = "handle-status busy";
    handleStatus.textContent = "Checking availability…";
    handleStatus.style.color = "";

    clearTimeout(handleTimer);
    handleTimer = setTimeout(() => {
      const taken = TAKEN_HANDLES.indexOf(v) !== -1;
      if (taken) {
        handleFree = false;
        handleStatus.className = "handle-status taken";
        handleStatus.textContent = "ogle.live/digimenu/" + v + " is already taken.";
        $("#suggestions").innerHTML = suggestionsFor(v)
          .map((s) => `<button type="button" data-sug="${s}">${s}</button>`)
          .join("");
        $$("#suggestions button").forEach((b) =>
          b.addEventListener("click", () => checkHandle(b.dataset.sug))
        );
      } else {
        handleFree = true;
        handleStatus.className = "handle-status free";
        handleStatus.textContent = "Available. This is yours once you continue.";
        state.handle = v;
        saveState(state);
        renderCard();
        renderQR($("#qrWrap"), v);
        $("#qrLink").textContent = "ogle.live/digimenu/" + v;
        $("#dlQr").disabled = false;
      }
      updateFinish();
    }, 420);
  }

  handleInput.addEventListener("input", (e) => {
    const caretEnd = e.target.value.length;
    handleInput.value = handleInput.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (caretEnd !== handleInput.value.length) handleInput.setSelectionRange(caretEnd, caretEnd);
    checkHandle(handleInput.value);
  });

  function updateFinish() {
    $("#finish").disabled = !(handleFree && state.handle);
  }

  function renderQR(wrap, handle) {
    if (!wrap) return;
    wrap.innerHTML = "";
    try {
      const qr = window.qrcode(0, "M");
      qr.addData("https://ogle.live/digimenu/" + handle);
      qr.make();
      const n = qr.getModuleCount();
      const quiet = 2;
      const px = 10;
      const size = (n + quiet * 2) * px;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#191811";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
        }
      }
      canvas.style.width = "116px";
      canvas.style.height = "116px";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "QR code linking to ogle.live/digimenu/" + handle);

      // ship it as an <img> so it prints crisply and downloads without a live canvas
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/png");
      img.alt = "QR code linking to ogle.live/digimenu/" + handle;
      img.width = 116;
      img.height = 116;
      wrap.dataset.qr = img.src;
      wrap.appendChild(img);
    } catch (e) {
      fallbackQR(wrap, handle);
    }
  }

  function fallbackQR(wrap, handle) {
    wrap.innerHTML = `<div style="font-size:10px;line-height:1.35;text-align:center;color:#8d8778;padding:8px">
      QR could not be drawn<br><b style="color:#191811;font-size:9.5px">/digimenu/${handle}</b></div>`;
  }

  function downloadQR(wrapEl, handle) {
    const src = wrapEl && wrapEl.dataset ? wrapEl.dataset.qr : null;
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = "digimenu-qr-" + handle + ".png";
    a.click();
  }

  $("#dlQr").addEventListener("click", () => downloadQR($("#qrWrap"), state.handle));
  $("#dlQrDash").addEventListener("click", () => downloadQR($("#qrWrapDash"), state.handle));

  $("#finish").addEventListener("click", () => {
    if (!handleFree) return;
    saveState(state);
    openDashboard();
  });

  /* ---------------- dashboard ---------------- */

  function openDashboard() {
    show("dash");
    const rest = state.restaurant.name || "Your restaurant";
    $("#dashRest").textContent = rest;
    const who = [state.account.name, state.account.email].filter(Boolean).join(" · ");
    $("#dashWho").textContent = who || "Signed in";

    const docs = [
      { t: "Restaurant logo", ok: !!state.docs.logo },
      { t: "Trade licence copy", ok: !!state.docs.license },
      { t: "Google Maps listing", ok: !!state.restaurant.mapsUrl, optional: true }
    ];
    $("#statusList").innerHTML = docs
      .map(
        (d) => `<div class="status-row ${d.ok ? "done" : "todo"}">
          <span class="dot">✓</span>
          <span>${d.t}${d.optional ? ' <span class="pill" style="margin-left:6px">optional</span>' : ""}</span>
          <span class="pill ${d.ok ? "ok" : "warn"}">${d.ok ? "Received" : d.optional ? "Not added" : "Missing"}</span>
        </div>`
      )
      .join("");

    const readyToPublish = !!state.docs.logo && !!state.docs.license;
    $("#dashStatus").textContent = readyToPublish ? "Ready to publish" : "Trial · not published";

    if (state.handle) {
      $("#dashLink").textContent = "ogle.live/digimenu/" + state.handle;
      renderQR($("#qrWrapDash"), state.handle);
      $("#openMenu").href = "menu.html?r=" + encodeURIComponent(state.handle);
    }

    if (state.menuUploaded) {
      $("#menuMeta").textContent = "uploaded · 6 categories · review";
      $("#uploadZone").querySelector(".uz-t").textContent = "Replace the menu photo";
      runExtract(false);
    }
    $("#protoNote").hidden = false;
  }

  $("#signOut").addEventListener("click", () => {
    show("auth");
    showAuthTab("in");
  });

  const zone = $("#uploadZone");
  const fileMenu = $("#fileMenu");

  function pickMenu() { fileMenu.click(); }
  zone.addEventListener("click", pickMenu);
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickMenu(); }
  });
  ["dragover", "dragenter"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragover"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("dragover"); })
  );
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startScan(f.name);
  });
  fileMenu.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) startScan(f.name);
  });

  let scanning = false;

  function startScan(fileName) {
    if (scanning) return;
    scanning = true;
    state.menuUploaded = true;
    saveState(state);
    $("#menuMeta").textContent = "reading " + (fileName || "menu") + "…";
    $("#scan").classList.add("on");
    $("#extract").classList.remove("on");
    const steps = $$("#scanSteps div");
    steps.forEach((s) => s.classList.remove("on"));
    $("#scanBar").style.width = "8%";
    zone.querySelector(".uz-t").textContent = "Replace the menu photo";

    let i = 0;
    const tick = () => {
      if (i > 0) steps[i - 1].classList.add("on");
      $("#scanBar").style.width = Math.min(96, 8 + (i + 1) * 22) + "%";
      i++;
      if (i <= steps.length) {
        setTimeout(tick, i === steps.length ? 500 : 620);
      } else {
        steps.forEach((s) => s.classList.add("on"));
        $("#scanBar").style.width = "100%";
        setTimeout(() => {
          runExtract(true);
          scanning = false;
        }, 380);
      }
    };
    setTimeout(tick, 320);
  }

  function runExtract(fresh) {
    const rows = [];
    DEMO_MENU.categories.slice(0, 5).forEach((cat) => {
      cat.items.slice(0, 2).forEach((it) => {
        rows.push({ cat: cat.name, name: it.name, price: it.price, diet: it.diet });
      });
    });
    $("#extractRows").innerHTML = rows
      .map(
        (r, i) => `<div class="xrow">
          <span><span class="xcat">${r.cat}</span><br>${r.name}
            <span class="pill" style="margin-left:6px;font-size:9.5px">${r.diet === "veg" ? "veg" : "non-veg"}</span></span>
          <span style="text-align:right"><span class="pr">AED ${r.price}</span><br>
            <span class="xconf ${i > 7 ? "low" : ""}">${(98 - i * 1.7).toFixed(0)}%</span></span>
        </div>`
      )
      .join("");
    $("#extractCount").textContent = rows.length + " items · 5 categories";
    $("#extract").classList.add("on");
    $("#menuMeta").textContent = rows.length + " items · review before publishing";
    if (fresh) {
      $("#extract").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  /* ---------------- sign in ---------------- */

  $("#formSignIn").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("#siEmail");
    const pw = $("#siPass");
    let ok = true;
    ok = markErr(id, $("#siEmailErr"), id.value.trim().length < 4) && ok;
    ok = markErr(pw, $("#siPassErr"), pw.value.length < 4) && ok;
    if (!ok) return;

    if (!state.handle) {
      // demo account: seed a complete record so the dashboard is not empty
      state.restaurant.name = state.restaurant.name || "Spice Route";
      state.restaurant.whatsapp = state.restaurant.whatsapp === "+971" ? "971525757079" : state.restaurant.whatsapp;
      state.handle = "spice-route";
      state.accent = "#7c2231";
      state.account.name = state.account.name || "Owner";
      saveState(state);
    }
    openDashboard();
  });

  $("#forgot").addEventListener("click", () => {
    $("#siEmailErr").textContent = "Password reset links go to the registered email.";
    $("#siEmailErr").classList.add("show");
  });

  /* ---------------- tabs / nav ---------------- */

  $$(".seg button").forEach((b) => b.addEventListener("click", () => showAuthTab(b.dataset.auth)));
  $$("[data-auth-jump]").forEach((b) => b.addEventListener("click", () => showAuthTab(b.dataset.authJump)));
  $$("[data-back]").forEach((b) =>
    b.addEventListener("click", () => {
      const n = Number(b.dataset.back);
      if (n === 1) { show("auth"); showAuthTab("up"); state.step = 1; renderSteppers(); }
      else showStep(n);
    })
  );

  /* ---------------- boot ---------------- */

  renderCard();
  renderSteppers();
  syncChoices();

  // returning owner: refill everything already known
  if (state.account.name) $("#accName").value = state.account.name;
  if (state.account.mobile) $("#accMobile").value = state.account.mobile;
  if (state.account.email) $("#accEmail").value = state.account.email;
  if (state.restaurant.name) $("#restName").value = state.restaurant.name;
  if (state.restaurant.ownerName) $("#ownerName").value = state.restaurant.ownerName;
  if (state.restaurant.mapsUrl) $("#mapsUrl").value = state.restaurant.mapsUrl;

  const waDigits = String(state.restaurant.whatsapp || "").replace(/\D/g, "");
  if (waDigits.length > 6) {
    const cc = ["971", "966", "974", "968", "973", "965", "91", "44"]
      .find((c) => waDigits.startsWith(c)) || "971";
    const sel = $("#waCC");
    if (Array.from(sel.options).some((o) => o.value === cc)) sel.value = cc;
    $("#waNum").value = waDigits.slice(cc.length);
  }

  const seed = saved || (function () {
    const h = new URLSearchParams(location.search).get("handle");
    return h ? { handle: h } : null;
  })();
  if (seed && seed.handle) {
    $("#handle").value = seed.handle;
    checkHandle(seed.handle);
  }
})();

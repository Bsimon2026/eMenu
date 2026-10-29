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

  $("#applyImport").addEventListener("click", () => {
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
            soldOut: false
          });
        }
      });
      cursor += c.items.length;
      if (items.length) categories.push({ id: "c" + ci, name: c.name, items: items });
    });

    state.menu = { categories: categories };
    state.menuImported = true;
    save();
    toast(kept + " dishes added to your menu");
    showView("menu");
  });

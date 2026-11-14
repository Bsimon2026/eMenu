/* ==========================================================================
   DigiMenu landing — the small amount of behaviour the page needs.
   No framework, no library, no scroll listener per element.
   ========================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------------- nav ----
     One rAF-throttled scroll handler for the whole page: the header gains its
     blurred ground the moment the hero photo scrolls under it. */
  var nav = document.getElementById("nav");
  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      if (nav) nav.classList.toggle("on", window.scrollY > 24);
      ticking = false;
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------- reveals ---
     IntersectionObserver, not a scroll listener: each block lands once and is
     then forgotten. The delay comes from --d so a row can arrive in sequence. */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    /* no observer (or an old crawler): show everything rather than nothing */
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* -------------------------------------------------------------- pricing --
     One source per plan: the numbers live on the card as data attributes, so the
     toggle cannot disagree with the comparison table below it. Prices are whole
     dirhams and print without a separator — a mono "1,999" opens a gap at the
     comma that reads as two numbers. */
  var toggle = document.querySelector(".toggle");
  var plans = document.querySelectorAll(".plan[data-plan]");

  function setBilling(period) {
    plans.forEach(function (card) {
      var yearly = Number(card.getAttribute("data-annual"));
      var monthly = Number(card.getAttribute("data-monthly"));
      var priceEl = card.querySelector("[data-price]");
      var periodEl = card.querySelector("[data-period]");
      var saveEl = card.querySelector("[data-save]");
      if (!priceEl) return;

      var isMonthly = period === "monthly" && monthly && monthly !== yearly;
      var value = isMonthly ? monthly : yearly;

      priceEl.textContent = String(value);
      if (periodEl) periodEl.textContent = isMonthly ? "/ month" : "/ year";
      if (!saveEl) return;

      if (card.getAttribute("data-plan") === "qr") {
        saveEl.textContent = "Annual plan only · less than AED 9 a month";
      } else {
        var saved = monthly * 12 - value;
        saveEl.innerHTML = isMonthly
          ? "Billed monthly · cancel any time"
          : "Save AED " + saved + " a year · AED " + Math.round(value / 12) + " a month";
      }
    });

    if (toggle) {
      toggle.querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-bill") === period));
      });
    }
  }

  if (toggle) {
    toggle.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-bill]");
      if (!btn) return;
      setBilling(btn.getAttribute("data-bill"));
    });
    setBilling("yearly");
  }

  /* ------------------------------------------------------------------ faq ---
     <details> already opens and closes; this only makes one answer exclusive so
     the section never becomes a wall of open paragraphs. */
  var faq = document.querySelector(".faq");
  if (faq) {
    faq.addEventListener("toggle", function (e) {
      var open = e.target;
      if (!open.open) return;
      faq.querySelectorAll("details").forEach(function (d) {
        if (d !== open) d.open = false;
      });
    }, true);
  }

  /* ---------------------------------------------------------------- year --- */
  var yr = document.getElementById("yr");
  if (yr) yr.textContent = new Date().getFullYear();
})();

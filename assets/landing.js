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

  /* Pricing needs no script: the sheet's three plans are one table, and both
     the monthly and the annual price are rows in it. */

  /* -------------------------------------------------------------- pricing --
     Three cards, two billing states. The numbers live on the card as data
     attributes so the price, the per-period word and the saving cannot drift
     apart. QR Menu is sold by the year only, so in monthly mode it keeps its
     annual price and says so rather than showing a monthly figure it does not
     have. */
  var ppToggle = document.querySelector(".pp-toggle");
  var ppCards = document.querySelectorAll(".pp-card[data-plan]");

  function setBilling(period) {
    ppCards.forEach(function (card) {
      var yearly = card.getAttribute("data-annual");
      var monthly = card.getAttribute("data-monthly");
      var priceEl = card.querySelector("[data-price]");
      var perEl = card.querySelector("[data-per]");
      var saveEl = card.querySelector("[data-save]");
      if (!priceEl) return;

      var yearlyOnly = !monthly || monthly === "";
      var useMonthly = period === "monthly" && !yearlyOnly;
      var value = useMonthly ? Number(monthly) : Number(yearly);

      /* a 1,999 printed in the sheet's serif needs its separator */
      priceEl.textContent = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      if (perEl) perEl.textContent = useMonthly ? "/ month" : "/ year";

      if (card.getAttribute("data-plan") === "qr") {
        saveEl.textContent = yearlyOnly && period === "monthly"
          ? "Sold by the year only — less than AED 9 a month"
          : "Everything you need to go digital";
        return;
      }

      var saved = Number(monthly) * 12 - Number(yearly);
      saveEl.textContent = useMonthly
        ? "or AED " + Number(yearly).toLocaleString("en-US") + " a year — save AED " + saved
        : "Save AED " + saved + " compared with monthly";
    });

    if (ppToggle) {
      ppToggle.querySelectorAll("button").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-bill") === period));
      });
    }
  }

  if (ppToggle) {
    ppToggle.addEventListener("click", function (e) {
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

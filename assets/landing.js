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

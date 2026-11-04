/**
 * The contact band under the hero.
 *
 * One place to put the real details: fill a value and its button appears, leave
 * it empty and the button stays hidden. Nothing invented, nothing half-linked —
 * a CTA that opens a dead page is worse than a CTA that is not there.
 *
 *   call       tel: link        e.g. "+971 2 000 0000"
 *   whatsapp   wa.me link       digits only, e.g. "971500000000"
 *   maps       share link       https://maps.app.goo.gl/…
 *   review     place reviews    https://g.page/r/…/review
 *   instagram  profile URL      https://instagram.com/handle
 */
window.DIGIMENU_CONTACT = {
  call: "",
  whatsapp: "",
  maps: "",
  review: "",
  instagram: "",
  email: "connect@indubaicity.com"
};

(function () {
  "use strict";
  var c = window.DIGIMENU_CONTACT || {};
  var digits = function (s) { return String(s || "").replace(/[^\d]/g, ""); };

  var urls = {
    call: c.call ? "tel:" + String(c.call).replace(/[^\d+]/g, "") : "",
    whatsapp: digits(c.whatsapp) ? "https://wa.me/" + digits(c.whatsapp) : "",
    maps: c.maps || "",
    review: c.review || "",
    instagram: c.instagram || "",
    email: c.email ? "mailto:" + c.email : ""
  };

  var band = document.getElementById("contactBand");
  if (!band) return;

  var shown = 0;
  band.querySelectorAll("[data-k]").forEach(function (el) {
    var url = urls[el.getAttribute("data-k")];
    if (!url) { el.remove(); return; }
    el.setAttribute("href", url);
    if (url.indexOf("http") === 0) { el.target = "_blank"; el.rel = "noopener"; }
    shown++;
  });

  /* one lonely button is not a call to action — show the band only when it
     actually offers a choice of ways to reach us */
  if (shown < 2) {
    var section = band.closest ? band.closest("section") : band.parentNode;
    if (section) section.hidden = true;
  }
})();

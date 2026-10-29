/* Phone handling in one place.
 *
 * The WhatsApp number is the address of the whole product: the guest's phone
 * opens a chat on it, and the restaurant's order copy goes to the email beside
 * it. So the number is stored in E.164 only — "+971525757079" — and the
 * country code is never inferred from the rest of the digits.
 */
(function (global) {
  "use strict";

  var COUNTRIES = [
    { dial: "971", name: "UAE" },
    { dial: "966", name: "Saudi Arabia" },
    { dial: "974", name: "Qatar" },
    { dial: "965", name: "Kuwait" },
    { dial: "968", name: "Oman" },
    { dial: "973", name: "Bahrain" },
    { dial: "91", name: "India" },
    { dial: "92", name: "Pakistan" },
    { dial: "20", name: "Egypt" },
    { dial: "63", name: "Philippines" },
    { dial: "44", name: "United Kingdom" },
    { dial: "1", name: "United States" }
  ];

  var E164 = /^\+[1-9][0-9]{7,14}$/;

  function digits(v) {
    return String(v == null ? "" : v).replace(/\D/g, "");
  }

  /* Build E.164 from a dial code and whatever the person typed. Leading zeros
     are the usual mistake (people type 0525... out of habit). */
  function toE164(dial, national) {
    var cc = digits(dial);
    var n = digits(national);
    if (!cc || !n) return "";
    if (cc === "971") n = n.replace(/^0+/, "");
    else n = n.replace(/^0+/, "");
    return "+" + cc + n;
  }

  function isValid(e164) {
    return E164.test(String(e164 || ""));
  }

  /* Split a stored number back into the pair, for prefilling a form. */
  function split(e164) {
    var d = digits(e164);
    if (!d) return { dial: "971", national: "" };
    var match = COUNTRIES.slice().sort(function (a, b) {
      return b.dial.length - a.dial.length;
    }).find(function (c) {
      return d.indexOf(c.dial) === 0;
    });
    if (!match) return { dial: "971", national: d };
    return { dial: match.dial, national: d.slice(match.dial.length) };
  }

  /* UAE mobiles are 9 digits and start with 5. Other countries: leave it to
     the length check, but catch obvious short numbers everywhere. */
  function problem(dial, national) {
    var e164 = toE164(dial, national);
    if (!national || !digits(national).length) return "Enter the mobile number.";
    // people type 0525... out of habit; judge the number without its trunk zero
    var n = digits(national).replace(/^0+/, "");
    if (dial === "971" && !/^5[0-9]{8}$/.test(n)) {
      return "A UAE mobile is 9 digits starting with 5, e.g. 52 575 7079.";
    }
    if (!isValid(e164)) return "That number looks incomplete.";
    return "";
  }

  function format(e164) {
    var p = split(e164);
    return p.national ? "+" + p.dial + " " + p.national : "";
  }

  function options(selected) {
    return COUNTRIES.map(function (c) {
      return (
        '<option value="' + c.dial + '"' +
        (c.dial === String(selected) ? " selected" : "") +
        ">+" + c.dial + " " + c.name + "</option>"
      );
    }).join("");
  }

  global.DigiPhone = {
    COUNTRIES: COUNTRIES,
    toE164: toE164,
    isValid: isValid,
    split: split,
    problem: problem,
    format: format,
    options: options,
    digits: digits
  };
})(window);

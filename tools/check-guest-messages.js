#!/usr/bin/env node
/**
 * Renders the six guest messages from the real source and compares each to the
 * wording the client approved (docs/whatsapp-messages.md).
 *
 * Why a script and not a read-through: these are the only words a guest ever
 * sees from us, they are spread across two files and one Meta template, and a
 * misplaced comma is invisible in a diff. Run it after touching any of them:
 *
 *   node tools/check-guest-messages.js
 *
 * It evaluates the `say` block out of api/marketing.js rather than re-typing it,
 * so the assertion cannot drift from the code it is asserting.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const NAME = "Amina";
const PLACE = "Spice Route";

const expect = {
  withName: {
    thankyou:
      "Dear Amina, thank you for choosing us. We have received your order and our team is reviewing it now. We will confirm it here in just a moment.",
    accept:
      "Dear Amina, your order has been confirmed and is now being prepared by our kitchen team. We will keep you updated at every step. Thank you for your patience.",
    ready:
      "Dear Amina, your order is ready for collection. Please visit the counter at Spice Route at your convenience. Thank you for choosing us, and we look forward to seeing you.",
    delivery:
      "Dear Amina, your order has left our kitchen and is on its way to you. Our delivery partner will reach you shortly. Thank you for your patience.",
    meal:
      "Dear Amina, we hope you enjoy your meal. Should there be anything we can improve or assist you with, please reply here and we will be glad to help."
  },
  noName: {
    thankyou:
      "Hello, thank you for choosing us. We have received your order and our team is reviewing it now. We will confirm it here in just a moment.",
    accept:
      "Hello, your order has been confirmed and is now being prepared by our kitchen team. We will keep you updated at every step. Thank you for your patience.",
    ready:
      "Hello, your order is ready for collection. Please visit the counter at Spice Route at your convenience. Thank you for choosing us, and we look forward to seeing you.",
    delivery:
      "Hello, your order has left our kitchen and is on its way to you. Our delivery partner will reach you shortly. Thank you for your patience.",
    meal:
      "Hello, we hope you enjoy your meal. Should there be anything we can improve or assist you with, please reply here and we will be glad to help."
  }
};

/* ---------------------------------------------------------------- 1: thankYou
   Exercised for real: stubbed fetch, so the text captured is the text that
   would have gone to Meta. */
async function renderThankYou(name) {
  let sent = null;
  global.fetch = async (url, opt = {}) => {
    /* only the /messages door carries the payload we want to read; every other
       call here is the transport's own DB probe, which must not break the test */
    const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
    if (/\/messages$/.test(String(url)) && opt && opt.body) {
      sent = JSON.parse(opt.body);
      /* the transport reads the body as text and pulls the wamid out of it, so
         the stub has to answer text(), not json() */
      return ok(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }));
    }
    return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
  };
  const wa = require(path.join(ROOT, "api/_lib/wa-inbox.js"));
  const s = { id: "r1", wa_phone_number_id: "p1", wa_access_token: "t1" };
  await wa.thankYou(s, { from: "971500000000", type: "text", text: { body: "hi" } }, { id: "o1", guest_name: name });
  return sent && sent.text && sent.text.body;
}

/* ------------------------------------------------------ 3–6: the free-form set
   The `say` block is evaluated out of api/marketing.js with `dear` and `place`
   bound exactly as the handler binds them, so this tests the shipped literals. */
function renderFreeform(name) {
  const src = fs.readFileSync(path.join(ROOT, "api/marketing.js"), "utf8");
  const start = src.indexOf("const say = {");
  const end = src.indexOf("};", start);
  assert.ok(start > 0 && end > start, "could not find the `say` block in api/marketing.js");
  const who = String(name || "").trim().split(/\s+/)[0].slice(0, 40);
  const dear = (body) => (who ? "Dear " + who + ", " + body : "Hello, " + body);
  const place = PLACE;
  const block = src.slice(start, end + 2);
  return new Function("dear", "place", block + "\nreturn say;")(dear, place);
}

/* --------------------------------------------------------- 2: template wiring */
function checkTemplate() {
  const src = fs.readFileSync(path.join(ROOT, "api/marketing.js"), "utf8");
  assert.ok(
    /sendTemplate\(\s*s,\s*to,\s*"order_confirm",\s*\[first,\s*place,\s*lines,\s*total\]/.test(src),
    "the order_confirm parameters are no longer [first, place, lines, total]"
  );
  assert.ok(
    /String\(o\.guest_name \|\| "guest"\)/.test(src),
    "the template's {{1}} no longer falls back to \"guest\" for a blank name"
  );
  return "order_confirm → [first, place, lines, total], blank name → \"guest\"";
}

(async () => {
  const results = [];
  const check = (label, got, want) => {
    try {
      assert.strictEqual(got, want);
      results.push(["PASS", label]);
    } catch (e) {
      results.push(["FAIL", label + "\n   got:  " + got + "\n   want: " + want]);
    }
  };

  try {
    check("1 auto-acknowledgement (name)", await renderThankYou(NAME), expect.withName.thankyou);
    check("1 auto-acknowledgement (no name)", await renderThankYou(""), expect.noName.thankyou);
  } catch (e) {
    results.push(["FAIL", "1 auto-acknowledgement — " + e.message]);
  }

  for (const name of [NAME, ""]) {
    const set = name ? expect.withName : expect.noName;
    const label = name ? "(name)" : "(no name)";
    let say;
    try {
      say = renderFreeform(name);
    } catch (e) {
      results.push(["FAIL", "3–6 could not be rendered — " + e.message]);
      break;
    }
    check("3 accept " + label, say.accept, set.accept);
    check("4 ready " + label, say.ready, set.ready);
    check("5 delivery " + label, say.delivery, set.delivery);
    check("6 meal " + label, say.meal, set.meal);
  }

  try {
    results.push(["PASS", "2 template — " + checkTemplate()]);
  } catch (e) {
    results.push(["FAIL", "2 template — " + e.message]);
  }

  let failed = 0;
  for (const [state, line] of results) {
    if (state === "FAIL") failed++;
    console.log(state + "  " + line);
  }
  console.log("\n" + (failed ? failed + " failing" : "all " + results.length + " messages match"));
  process.exit(failed ? 1 : 0);
})();

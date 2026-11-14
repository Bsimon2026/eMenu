/**
 * The price list, in one place.
 *
 * The published plans (index.html, terms.html) and the money code had drifted
 * apart in three ways at once — Pro's monthly price was 99 in the ledger and 129
 * on the website, Ultra's yearly was 1990 in code and 1999 on the site, and the
 * database plan `pro` means the *Ultra* tier while the website's "Pro" is the
 * `order` row. An operator taking a payment for "Pro" from this table's names
 * would have given the customer Ultra.
 *
 * So: one table, imported by the operator console, the paywall and the menu.
 * The website cards carry `data-plan` / `data-annual` / `data-monthly`; they are
 * checked against this file by `tools/prices-check.js`.
 *
 * Database values stay what they are (`qr` | `order` | `pro`) because a migration
 * to nicer names is not worth the risk; `label` is what a human sees, and the two
 * paid tiers are named the way the website names them.
 */

const PLANS = {
  qr: {
    label: "QR Menu",
    price: { monthly: null, yearly: 99 },      /* sold by the year only */
    ordering: false,
    marketing: false,
    landing: false,
    customDomain: false,
    itemCap: 50,
    blurb: "the menu and its QR code"
  },
  order: {
    label: "Pro",
    price: { monthly: 129, yearly: 999 },
    ordering: true,
    marketing: true,
    landing: false,
    customDomain: false,
    itemCap: null,                              /* no cap */
    blurb: "ordering, reviews and WhatsApp"
  },
  pro: {
    label: "Ultra",
    price: { monthly: 249, yearly: 1999 },
    ordering: true,
    marketing: true,
    landing: true,
    customDomain: "addon",                      /* the domain itself is an add-on */
    itemCap: null,
    blurb: "the landing page and the custom domain"
  }
};

/* The free week is worth Pro, never Ultra: Ultra is sold, not sampled. */
const TRIAL_PLAN = "order";

/* The one add-on left. The marketing add-on is gone. */
const ADDONS = {
  customDomain: { label: "Custom domain", yearly: 99 }
};

const PLAN_KEYS = Object.keys(PLANS);

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** What a row bought, before the free week is considered. */
function planOf(row) {
  const key = String((row && row.plan) || "qr");
  return PLANS[key] ? key : "qr";
}

function priceOf(plan, billing) {
  const p = PLANS[planOf({ plan })] || PLANS.qr;
  return billing === "yearly" ? p.price.yearly : (p.price.monthly == null ? p.price.yearly : p.price.monthly);
}

/** Only what can be billed (`qr` has no monthly price). */
function billable(plan) {
  const p = PLANS[planOf({ plan })] || PLANS.qr;
  return { monthly: p.price.monthly, yearly: p.price.yearly };
}

/**
 * Every capability this restaurant has right now.
 *
 * Order matters: a paid period delivers exactly the plan bought; the free week
 * delivers Pro (ordering, reviews, WhatsApp — no landing page, no domain); with
 * neither, the plan's own limits apply and nothing that costs us money is on.
 */
function capabilities(row) {
  const r = row || {};
  const key = planOf(r);
  const bought = PLANS[key];
  const onTrial = Boolean(r.trial_ends && r.trial_ends >= today());
  const paid = Boolean(r.paid_through && r.paid_through >= today());
  const subscribed = paid || onTrial;
  /* what is entitled today: the paid plan, else the trial's Pro */
  const source = paid ? bought : (onTrial ? PLANS[TRIAL_PLAN] : null);

  return {
    plan: key,
    label: bought.label,
    onTrial,
    paid,
    subscribed,
    trialGrants: onTrial && !paid ? TRIAL_PLAN : null,
    /* a menu on a QR plan is still a menu: these decide what the page offers,
       never whether the page exists — that is isLive() below */
    ordering: Boolean(source && source.ordering),
    marketing: Boolean(source && source.marketing),
    landing: Boolean(source && source.landing),
    customDomain: Boolean(source && source.customDomain),
    /* the cap belongs to the plan bought; the free week is uncapped */
    itemCap: onTrial && !paid ? null : bought.itemCap
  };
}

/**
 * May a guest open this menu right now?
 *
 * The link goes dark when the free week ends and nothing has been paid — the
 * operator republishes it when the money is recorded (POST /api/superadmin
 * ?payments=1 sets status back to published). Read at the edge of every guest
 * request rather than by a nightly job: there is no scheduler, and a row that
 * says "published" is a decision somebody made, not a promise about today.
 */
function isLive(row) {
  if (!row) return false;
  if (String(row.status) !== "published") return false;
  return capabilities(row).subscribed;
}

/** Why a published row is shut, in words the owner can act on. */
function darkReason(row) {
  const cap = capabilities(row || {});
  if (cap.subscribed) return null;
  return "The free week has ended and no plan is active, so the menu link is unpublished. " +
    "It comes back as soon as the payment is recorded.";
}

/** A sentence naming what is left, for a paywall refusal. */
function upgradeLine(plan) {
  const key = planOf({ plan });
  if (key === "qr") {
    return "Keep the menu live on " + PLANS.qr.label + " at AED " + PLANS.qr.price.yearly +
      " a year, or take orders on " + PLANS.order.label + " at AED " + PLANS.order.price.monthly +
      " a month / AED " + PLANS.order.price.yearly + " a year.";
  }
  return "Renew " + PLANS[key].label + " at AED " + PLANS[key].price.yearly + " a year (or AED " +
    PLANS[key].price.monthly + " a month) and it reopens the same day.";
}

module.exports = {
  PLANS, ADDONS, PLAN_KEYS, TRIAL_PLAN,
  planOf, priceOf, billable, capabilities, isLive, darkReason, upgradeLine
};

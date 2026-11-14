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

/* One yearly line each, so an add-on can be seen and stopped without touching
   the menu subscription. */
const ADDONS = {
  customDomain: { label: "Custom domain", yearly: 99 },
  marketing: { label: "Marketing only", yearly: 299 }
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
 * The seven free days are the whole product — a new restaurant sees everything
 * before anybody pays for it — so a live trial overrides the plan's limits.
 */
function capabilities(row) {
  const r = row || {};
  const key = planOf(r);
  const p = PLANS[key];
  const onTrial = Boolean(r.trial_ends && r.trial_ends >= today());
  const paid = Boolean(r.paid_through && r.paid_through >= today());
  const subscribed = paid || onTrial;
  const addonMarketing = Boolean(r.addon_marketing);

  return {
    plan: key,
    label: p.label,
    onTrial,
    paid,
    subscribed,
    /* a menu on a QR plan is still a menu: the entitlement below decides what
       the page offers, never whether the page exists */
    ordering: subscribed ? (onTrial ? true : p.ordering) : false,
    marketing: subscribed ? (onTrial ? true : (p.marketing || addonMarketing)) : false,
    landing: subscribed ? (onTrial ? true : p.landing) : false,
    /* the domain add-on is bought separately, so it is not implied by the plan */
    customDomain: subscribed && (p.customDomain === true || p.customDomain === "addon"),
    itemCap: onTrial ? null : p.itemCap
  };
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

module.exports = { PLANS, ADDONS, PLAN_KEYS, planOf, priceOf, billable, capabilities, upgradeLine };

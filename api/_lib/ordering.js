/**
 * Can this restaurant take orders?
 *
 * ONE implementation, because this question was answered twice — by the menu
 * (which decides whether a guest is shown an order form) and by the order
 * handler (which decides whether the row may be written) — and the two drifted.
 * `api/menu.js` granted ordering during the seven free days; `api/order.js` read
 * the plan alone and refused every restaurant in its first week. A new tenant is
 * `plan: "qr"` on trial by default, so *every* new restaurant took orders that
 * never reached the panel: the guest saw "Order received" and the kitchen got an
 * empty screen.
 *
 * So this lives in one place and both callers import it. Nothing that decides
 * money or access gets written twice in this repo.
 */

/* The rule itself lives in api/_lib/plans.js: one table of prices and
   capabilities for the operator console, the paywall and the menu. This is the
   one-question wrapper, so a third caller cannot invent a third answer. */
const { capabilities, PLANS } = require("./plans");

/**
 * @param {{plan?:string, paid_through?:string|null, trial_ends?:string|null}} row
 * @returns {{ok:boolean, code?:string, message?:string, plan:string,
 *            onTrial:boolean, paid:boolean, planTakes:boolean}}
 */
function canTakeOrders(row) {
  const cap = capabilities(row);
  const planTakes = Boolean(PLANS[cap.plan] && PLANS[cap.plan].ordering);
  const base = { plan: cap.plan, onTrial: cap.onTrial, paid: cap.paid, planTakes };

  if (cap.ordering) return Object.assign({ ok: true }, base);

  /* a plan sold without ordering, versus a plan that includes it but is not
     current: two different sentences, and the owner needs the right one */
  if (!planTakes) {
    return Object.assign({
      ok: false,
      code: "ORDERING_NOT_INCLUDED",
      message: "This restaurant's menu is view-only. Call them to order."
    }, base);
  }
  return Object.assign({
    ok: false,
    code: "SUBSCRIPTION_INACTIVE",
    message: "Ordering is paused for this restaurant. Please call them."
  }, base);
}

module.exports = { canTakeOrders };

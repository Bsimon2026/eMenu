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

/* "order" includes ordering; "pro" is the same with no order cap. */
const ORDERING_PLANS = ["order", "pro"];

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {{plan?:string, paid_through?:string|null, trial_ends?:string|null}} row
 * @returns {{ok:boolean, code?:string, message?:string, plan:string,
 *            onTrial:boolean, paid:boolean, planTakes:boolean}}
 */
function canTakeOrders(row) {
  const r = row || {};
  const day = today();
  const plan = r.plan || "qr";
  /* the seven free days include ordering, so a new restaurant sees the whole
     product before anybody pays for it */
  const onTrial = Boolean(r.trial_ends && r.trial_ends >= day);
  const paid = Boolean(r.paid_through && r.paid_through >= day);
  const planTakes = ORDERING_PLANS.indexOf(plan) >= 0;

  if (onTrial) return { ok: true, plan, onTrial, paid, planTakes };
  if (!planTakes) {
    return {
      ok: false,
      code: "ORDERING_NOT_INCLUDED",
      message: "This restaurant's menu is view-only. Call them to order.",
      plan, onTrial, paid, planTakes
    };
  }
  if (!paid) {
    return {
      ok: false,
      code: "SUBSCRIPTION_INACTIVE",
      message: "Ordering is paused for this restaurant. Please call them.",
      plan, onTrial, paid, planTakes
    };
  }
  return { ok: true, plan, onTrial, paid, planTakes };
}

module.exports = { canTakeOrders, ORDERING_PLANS };

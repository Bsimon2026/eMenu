/**
 * Discount codes.
 *
 * One code: a percentage off, an optional cap in money, an optional minimum
 * spend, and once per customer — keyed on the phone number, because that is the
 * only identity a guest has here. Everything a guest could tamper with in the
 * page (the percentage, the amount, the total) is recomputed here from the row
 * in the database, so a hand-edited request cannot buy a cheaper dinner.
 */

const { rest } = require("./db");

function clean(v) {
  return String(v == null ? "" : v).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24);
}

function digits(v) {
  return String(v == null ? "" : v).replace(/[^\d]/g, "").slice(0, 20);
}

function money(n) {
  const v = Number(n) || 0;
  return Math.round(v * 100) / 100;
}

/* what the code is worth against this subtotal */
function quote(row, subtotal) {
  const base = Math.max(0, money(subtotal));
  if (!row) return { code: "", amount: 0, total: base, percent: 0 };
  let amount = base * (Number(row.percent) / 100);
  if (row.max_amount != null && Number(row.max_amount) > 0) {
    amount = Math.min(amount, Number(row.max_amount));
  }
  amount = Math.min(money(amount), base);
  return {
    code: String(row.code || "").toUpperCase(),
    percent: Number(row.percent) || 0,
    amount: amount,
    total: money(base - amount)
  };
}

async function find(rid, code) {
  const c = clean(code);
  if (!c) return null;
  const r = await rest(
    "discounts?restaurant_id=eq." + rid + "&code=eq." + encodeURIComponent(c) +
    "&select=id,code,percent,max_amount,min_order,active&limit=1"
  );
  if (!r.ok) return { missingTable: true };
  return (r.data || [])[0] || null;
}

async function usedBy(rid, discountId, phone) {
  const p = digits(phone);
  if (!p || !discountId) return false;
  const r = await rest(
    "discount_redemptions?restaurant_id=eq." + rid + "&discount_id=eq." + discountId +
    "&phone=eq." + encodeURIComponent(p) + "&select=id&limit=1"
  );
  return Boolean(r.ok && (r.data || []).length);
}

/* the whole decision, in one place: is this code usable for this basket? */
async function check(rid, code, subtotal, phone) {
  const row = await find(rid, code);
  if (row && row.missingTable) {
    return { ok: false, code: "NO_DISCOUNTS", message: "Discount codes are not switched on yet." };
  }
  if (!row) return { ok: false, code: "NO_CODE", message: "That code is not one of ours." };
  if (!row.active) return { ok: false, code: "INACTIVE", message: "That code is no longer running." };

  const base = money(subtotal);
  if (Number(row.min_order) > 0 && base < Number(row.min_order)) {
    return {
      ok: false, code: "MIN_ORDER",
      message: "That code needs an order of AED " + money(row.min_order).toFixed(0) + " or more."
    };
  }
  if (phone && (await usedBy(rid, row.id, phone))) {
    return { ok: false, code: "USED", message: "That code has already been used on this number." };
  }

  const q = quote(row, base);
  return {
    ok: true,
    id: row.id,
    code: q.code,
    percent: q.percent,
    maxAmount: row.max_amount == null ? null : Number(row.max_amount),
    amount: q.amount,
    total: q.total
  };
}

async function redeem(rid, discountId, code, phone, orderId, amount) {
  const p = digits(phone);
  if (!discountId || !p) return { ok: false };
  /* the unique index is the real rule: two orders racing on the same number
     still end up with one redemption */
  const r = await rest("discount_redemptions", {
    method: "POST",
    prefer: "return=minimal,resolution=ignore-duplicates",
    body: [{
      restaurant_id: rid, discount_id: discountId, code: clean(code),
      phone: p, order_id: orderId || null, amount: money(amount)
    }]
  });
  return { ok: r.ok, error: r.ok ? null : String(r.error || r.data).slice(0, 160) };
}

module.exports = { clean, digits, quote, find, usedBy, check, redeem, money };

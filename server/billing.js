// Single source of truth for "what does this booking cost" and "what's left to
// pay" — used by every route/page that shows a balance, so they can't drift
// out of sync with each other the way the reservation-detail page's totals
// used to (Booking Summary vs. Financials showing two different numbers).
const SALES_TAX_RATE = 0.0725;
const HIGHWAY_TAX_RATE = 0.08;
// What the real card processor actually takes on a "Payment through Swipe"
// payment — absorbed as a business expense, never billed to the customer
// (that's what makes it different from the Card method's customer-facing
// surcharge, which is a separate, adjustable rate entered per payment).
const SWIPE_FEE_RATE = 0.0275;

// Itemized rate x days estimate of a booking — the same line items Invoice
// Adjustments shows, each rounded to the cent. [] when there are no dates,
// no rate, or no days to bill. computeCharge falls back to the sum of these;
// the customer invoice prints them.
function computeLineItems(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at || !row.weekly_rate) return [];
  const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
  if (!(days > 0)) return [];
  const r = n => Math.round(n * 100) / 100;
  const dailyRate = row.weekly_rate / 7;
  const subtotal = r(dailyRate * days);
  const items = [
    { key: 'lease', label: 'Lease Rate', detail: `$${dailyRate.toFixed(2)}/day × ${days} day${days === 1 ? '' : 's'}`, amount: subtotal },
    { key: 'highway_tax', label: 'Highway Tax', detail: `${r(HIGHWAY_TAX_RATE * 100)}%`, amount: r(subtotal * HIGHWAY_TAX_RATE) },
    { key: 'sales_tax', label: 'Sales Tax', detail: `${r(SALES_TAX_RATE * 100)}%`, amount: r(subtotal * SALES_TAX_RATE) },
  ];
  // Admin, travel, and insurance fees are added on top of the taxed
  // rental total — they're not part of the lease rate and aren't
  // themselves taxed. Admin and insurance are daily rates x days;
  // travel is a single flat fee.
  const adminRate = Number(row.admin_fee_rate) || 0;
  if (adminRate) items.push({ key: 'admin', label: 'Admin Fee', detail: `$${adminRate.toFixed(2)}/day × ${days}`, amount: r(adminRate * days) });
  const insuranceRate = Number(row.insurance_fee_rate) || 0;
  if (insuranceRate) items.push({ key: 'insurance', label: 'Insurance Fee', detail: `$${insuranceRate.toFixed(2)}/day × ${days}`, amount: r(insuranceRate * days) });
  // Travel, processing, misc and tolls are flat, one-time amounts stored as
  // entered — processing fee was computed once (2.75% of the invoice at the
  // time it was enabled), not recomputed here, so it doesn't compound if
  // other fees change later. Misc/Tolls are Invoice Adjustments' own ad-hoc
  // line items, separate from the vehicle_maintenance toll log.
  [['travel_fee', 'travel', 'Travel Fee'], ['processing_fee', 'processing', 'Processing Fee'],
   ['misc_fee', 'misc', 'Miscellaneous'], ['toll_fee', 'tolls', 'Tolls']].forEach(([col, key, label]) => {
    const amount = r(Number(row[col]) || 0);
    if (amount) items.push({ key, label, amount });
  });
  const discount = r(Number(row.discount) || 0);
  if (discount) items.push({ key: 'discount', label: 'Discount', amount: -discount });
  return items;
}

// Line items for just part of a booking — an invoice period of [from, to)
// billed the same way (rate x days in the period), with the booking's flat
// one-time charges (travel, processing, misc, tolls, discount) only when
// includeOneTime is set, so a weekly invoice doesn't re-bill them.
function computePeriodLineItems(row, from, to, includeOneTime) {
  const oneTime = includeOneTime ? {} : { travel_fee: 0, processing_fee: 0, misc_fee: 0, toll_fee: 0, discount: 0 };
  return computeLineItems({ ...row, ...oneTime, pickup_scheduled_at: from, rental_end_at: to });
}

// A booking's charge is whatever was actually invoiced/quoted if that exists;
// only falls back to a live rate x days estimate before a number's been set.
// A lead/application with no confirmed pickup and return dates yet owes
// nothing, even if a quote (total_due_at_pickup) was already presented —
// there's nothing to bill against until dates are actually set.
function computeCharge(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at) return 0;
  if (row.invoice_amount) return Math.round(Number(row.invoice_amount) * 100) / 100;
  if (row.total_due_at_pickup) return Math.round(Number(row.total_due_at_pickup) * 100) / 100;
  return Math.round(computeLineItems(row).reduce((sum, i) => sum + i.amount, 0) * 100) / 100;
}

// Signed: positive means the customer still owes money, negative means
// they've overpaid and are owed a credit. A rejected lead never became a
// real rental — no charge, no balance, regardless of what dates might be
// sitting on the row from a change of heart mid-application. Active and
// completed bookings both show their true balance, including a credit if
// the customer overpaid — marking a booking "completed" (checking it in)
// doesn't erase an unresolved balance, it just means the car came back.
function computeOwed(row, paidTotal) {
  if (row.status === 'rejected') return 0;
  const charge = computeCharge(row);
  return Math.round((charge - Number(paidTotal || 0)) * 100) / 100;
}

// The revenue-eligible portion of a booking's own charge — lease subtotal +
// admin fee + travel fee + misc fee, minus discount. Same components (and
// same definition of "revenue") getAccruedRevenueDays() in db.js sums
// day-by-day for reports; this is that same total for one booking, not
// spread across days. Sales tax, highway tax, insurance fee, processing
// fee, and tolls are excluded (pass-through/surplus, not profit) — same as
// everywhere else revenue is computed.
function computeRevenueEligible(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at || !row.weekly_rate) return 0;
  const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
  if (days <= 0) return 0;
  const dailyRate = row.weekly_rate / 7;
  const subtotal = Math.round(dailyRate * days * 100) / 100;
  const adminFee = Math.round((Number(row.admin_fee_rate) || 0) * days * 100) / 100;
  const travelFee = Math.round((Number(row.travel_fee) || 0) * 100) / 100;
  const miscFee = Math.round((Number(row.misc_fee) || 0) * 100) / 100;
  const discount = Math.round((Number(row.discount) || 0) * 100) / 100;
  return Math.round((subtotal + adminFee + travelFee + miscFee - discount) * 100) / 100;
}

module.exports = {
  SALES_TAX_RATE, HIGHWAY_TAX_RATE, SWIPE_FEE_RATE, computeLineItems, computePeriodLineItems, computeCharge, computeOwed, computeRevenueEligible,
};

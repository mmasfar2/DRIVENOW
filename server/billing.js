// Single source of truth for "what does this booking cost" and "what's left to
// pay" — used by every route/page that shows a balance, so they can't drift
// out of sync with each other the way the reservation-detail page's totals
// used to (Booking Summary vs. Financials showing two different numbers).
const SALES_TAX_RATE = 0.0725;
const HIGHWAY_TAX_RATE = 0.08;

// A booking's charge is whatever was actually invoiced/quoted if that exists;
// only falls back to a live rate x days estimate before a number's been set.
// A lead/application with no confirmed pickup and return dates yet owes
// nothing, even if a quote (total_due_at_pickup) was already presented —
// there's nothing to bill against until dates are actually set.
function computeCharge(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at) return 0;
  if (row.invoice_amount) return Math.round(Number(row.invoice_amount) * 100) / 100;
  if (row.total_due_at_pickup) return Math.round(Number(row.total_due_at_pickup) * 100) / 100;
  if (row.weekly_rate) {
    const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
    if (days > 0) {
      const dailyRate = row.weekly_rate / 7;
      const subtotal = Math.round(dailyRate * days * 100) / 100;
      const highwayTax = Math.round(subtotal * HIGHWAY_TAX_RATE * 100) / 100;
      const salesTax = Math.round(subtotal * SALES_TAX_RATE * 100) / 100;
      // Admin, travel, and insurance fees are added on top of the taxed
      // rental total — they're not part of the lease rate and aren't
      // themselves taxed. Admin and insurance are daily rates x days;
      // travel is a single flat fee.
      const adminFee = Math.round((Number(row.admin_fee_rate) || 0) * days * 100) / 100;
      const travelFee = Math.round((Number(row.travel_fee) || 0) * 100) / 100;
      const insuranceFee = Math.round((Number(row.insurance_fee_rate) || 0) * days * 100) / 100;
      // Processing fee is a flat amount computed once (2.75% of the invoice
      // at the time it was enabled) and stored like travel_fee — not
      // recomputed here, so it doesn't compound if other fees change later.
      const processingFee = Math.round((Number(row.processing_fee) || 0) * 100) / 100;
      const discount = Math.round((Number(row.discount) || 0) * 100) / 100;
      return Math.round((subtotal + highwayTax + salesTax + adminFee + travelFee + insuranceFee + processingFee - discount) * 100) / 100;
    }
  }
  return 0;
}

// Signed: positive means the customer still owes money, negative means
// they've overpaid and are owed a credit. Only applies to active bookings —
// once rejected/completed the balance is considered settled either way.
function computeOwed(row, paidTotal) {
  if (row.status !== 'active') return 0;
  const charge = computeCharge(row);
  return Math.round((charge - Number(paidTotal || 0)) * 100) / 100;
}

// The revenue-eligible portion of a booking's own charge — lease subtotal +
// admin fee + travel fee, minus discount. Same components (and same
// definition of "revenue") getAccruedRevenueDays() in db.js sums day-by-day
// for reports; this is that same total for one booking, not spread across
// days. Sales tax, highway tax, insurance fee, and processing fee are
// excluded, same as everywhere else revenue is computed.
function computeRevenueEligible(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at || !row.weekly_rate) return 0;
  const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
  if (days <= 0) return 0;
  const dailyRate = row.weekly_rate / 7;
  const subtotal = Math.round(dailyRate * days * 100) / 100;
  const adminFee = Math.round((Number(row.admin_fee_rate) || 0) * days * 100) / 100;
  const travelFee = Math.round((Number(row.travel_fee) || 0) * 100) / 100;
  const discount = Math.round((Number(row.discount) || 0) * 100) / 100;
  return Math.round((subtotal + adminFee + travelFee - discount) * 100) / 100;
}

// A booking's payments are logged as one lump sum against the whole
// invoice, not itemized against a specific line — so there's no literal
// fact about how much of what's been paid was "for" the rent versus "for"
// tax. The standard way to estimate that split is pro-rata: apply the same
// revenue-vs-tax/fees ratio the full invoice has to whatever's actually
// been paid so far. This is the one place that split is computed, so
// "revenue collected" means the same thing everywhere it's shown.
function computeCollectionSplit(row, paidTotal) {
  const totalCharge = computeCharge(row);
  const revenueEligible = computeRevenueEligible(row);
  if (totalCharge <= 0) {
    return { revenueEligible, revenueCollected: 0, revenueOutstanding: revenueEligible };
  }
  const paid = Math.max(0, Math.min(Number(paidTotal) || 0, totalCharge));
  const revenueShare = revenueEligible / totalCharge;
  const revenueCollected = Math.round(paid * revenueShare * 100) / 100;
  const revenueOutstanding = Math.round((revenueEligible - revenueCollected) * 100) / 100;
  return { revenueEligible, revenueCollected, revenueOutstanding };
}

module.exports = {
  SALES_TAX_RATE, HIGHWAY_TAX_RATE, computeCharge, computeOwed,
  computeRevenueEligible, computeCollectionSplit,
};

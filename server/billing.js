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
      return Math.round((subtotal + highwayTax + salesTax + adminFee + travelFee + insuranceFee + processingFee) * 100) / 100;
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

// "Revenue" is narrower than "charge" — only the portion that's actually the
// company's earnings: the car's own daily rate, the travel fee, and the
// admin fee. Sales tax and highway tax are pass-through taxes, and insurance
// fee/processing fee are ancillary charges — none of those count as
// revenue/profit even though they're part of what's invoiced and collected.
// (Forfeited security deposits count as revenue too, but aren't part of a
// booking's invoice at all — see getForfeitedDeposits in db.js.)
function computeRevenueEligible(row) {
  if (!row.pickup_scheduled_at || !row.rental_end_at || !row.weekly_rate) return 0;
  const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
  if (days <= 0) return 0;
  const subtotal = Math.round((row.weekly_rate / 7) * days * 100) / 100;
  const adminFee = Math.round((Number(row.admin_fee_rate) || 0) * days * 100) / 100;
  const travelFee = Math.round((Number(row.travel_fee) || 0) * 100) / 100;
  return Math.round((subtotal + adminFee + travelFee) * 100) / 100;
}

// Revenue actually recognized from what's been paid so far — proportional to
// how much of the full charge the revenue-eligible portion represents, so a
// partial payment only counts its revenue-eligible share rather than being
// treated as 100% rent or 100% tax. Once a booking is paid in full, this
// equals computeRevenueEligible(row) exactly.
function computeRevenue(row, paidTotal) {
  const charge = computeCharge(row);
  if (charge <= 0) return 0;
  const fraction = computeRevenueEligible(row) / charge;
  return Math.round(Number(paidTotal || 0) * fraction * 100) / 100;
}

module.exports = { SALES_TAX_RATE, HIGHWAY_TAX_RATE, computeCharge, computeOwed, computeRevenueEligible, computeRevenue };

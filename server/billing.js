// Single source of truth for "what does this booking cost" and "what's left to
// pay" — used by every route/page that shows a balance, so they can't drift
// out of sync with each other the way the reservation-detail page's totals
// used to (Booking Summary vs. Financials showing two different numbers).
const SALES_TAX_RATE = 0.0725;

// A booking's charge is whatever was actually invoiced/quoted if that exists;
// only falls back to a live rate x days estimate before a number's been set.
function computeCharge(row) {
  if (row.invoice_amount) return Math.round(Number(row.invoice_amount) * 100) / 100;
  if (row.total_due_at_pickup) return Math.round(Number(row.total_due_at_pickup) * 100) / 100;
  if (row.weekly_rate && row.pickup_scheduled_at && row.rental_end_at) {
    const days = Math.round((new Date(row.rental_end_at) - new Date(row.pickup_scheduled_at)) / 86400000);
    if (days > 0) {
      const dailyRate = row.weekly_rate / 7;
      const subtotal = Math.round(dailyRate * days * 100) / 100;
      const salesTax = Math.round(subtotal * SALES_TAX_RATE * 100) / 100;
      return Math.round((subtotal + salesTax) * 100) / 100;
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

module.exports = { SALES_TAX_RATE, computeCharge, computeOwed };

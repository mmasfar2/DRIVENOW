const express = require('express');
const { db } = require('../db');
const { computeCharge, computePeriodLineItems } = require('../billing');

const router = express.Router();
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// What this invoice bills beyond the reservation's own amounts (see the
// `extra` column in db.js). Invoices from before that column existed only
// had added charges, which were folded into the reservation once sent.
function invoiceExtra(inv) {
  if (inv.extra != null) return inv.extra;
  if (!inv.added_json || inv.charges_applied_at) return 0;
  return JSON.parse(inv.added_json).reduce((sum, c) => sum + (c.field === 'discount' ? -1 : 1) * c.amount, 0);
}

// What the customer owes as of this invoice, so the page adds up on its own:
//   amount_due       = the reservation's charges through the end of this
//                      invoice's period, plus what this and earlier sent
//                      invoices billed beyond the reservation (invoiceExtra),
//                      less every payment so far;
//   previous_balance = amount_due - this invoice's total (anything left
//                      unpaid from before, or a credit if they paid ahead);
//   remaining        = the same for the whole rental, including later
//                      periods not invoiced yet.
// Later periods are priced at the reservation's rates without one-time
// charges, the same way their own invoices will be.
function invoiceAmounts(app, inv, paidTotal) {
  const others = db.prepare('SELECT * FROM invoices WHERE application_id = ? AND id != ? AND sent_at IS NOT NULL').all(app.id, inv.id);
  const earlierExtra = others.filter(o => o.period_to <= inv.period_from).reduce((sum, o) => sum + invoiceExtra(o), 0);
  const allExtra = others.reduce((sum, o) => sum + invoiceExtra(o), 0) + invoiceExtra(inv);
  const rentalCharge = computeCharge(app);
  const rentalEnd = app.rental_end_at ? app.rental_end_at.slice(0, 10) : null;
  const later = rentalEnd && inv.period_to < rentalEnd
    ? computePeriodLineItems(app, inv.period_to, rentalEnd, false).reduce((sum, i) => sum + i.amount, 0)
    : 0;
  const amountDue = round2(rentalCharge - later + earlierExtra + invoiceExtra(inv) - paidTotal);
  return {
    amount_due: amountDue,
    previous_balance: round2(amountDue - inv.total),
    remaining: round2(rentalCharge + allExtra - paidTotal),
  };
}

// PUBLIC — no login. The customer's private invoice link lands here; the
// random token is the only key, and only what the invoice itself needs is
// returned (no phone, email, license or other booking details).
router.get('/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE token = ?').get(req.params.token);
  const app = inv && db.prepare('SELECT * FROM applications WHERE id = ?').get(inv.application_id);
  if (!app) return res.status(404).json({ error: 'Invoice not found' });
  const vehicle = app.assigned_vehicle_id
    ? db.prepare('SELECT year, make, model, license_plate FROM vehicles WHERE id = ?').get(app.assigned_vehicle_id)
    : null;
  const payments = db.prepare('SELECT amount, paid_at, method FROM payments WHERE application_id = ? ORDER BY paid_at, id').all(app.id);
  const paidTotal = Math.round(payments.reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100;
  res.json({
    number: `${app.id}-${inv.id}`,
    issued_at: inv.created_at,
    period_from: inv.period_from,
    period_to: inv.period_to,
    items: JSON.parse(inv.items_json),
    total: inv.total,
    customer: `${app.first_name} ${app.last_name}`,
    reservation_id: app.id,
    vehicle: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
    license_plate: vehicle ? vehicle.license_plate : null,
    rental_from: app.pickup_scheduled_at,
    rental_to: app.rental_end_at,
    payments: payments.map(p => ({ amount: Math.round(p.amount * 100) / 100, paid_at: p.paid_at, method: p.method })),
    paid_total: paidTotal,
    ...invoiceAmounts(app, inv, paidTotal),
  });
});

module.exports = router;
module.exports.invoiceAmounts = invoiceAmounts;

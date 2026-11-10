const express = require('express');
const { db } = require('../db');
const { computeOwed } = require('../billing');

const router = express.Router();

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
    account_balance: computeOwed(app, paidTotal),
  });
});

module.exports = router;

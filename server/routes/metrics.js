const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeCharge, computeOwed } = require('../billing');

const router = express.Router();

const BALANCE_FLAG_THRESHOLD = 250;

router.get('/cashflow', requireAuth, (req, res) => {
  // Balance here is computeOwed (invoice total minus paid) — the exact same
  // definition used on the reservation detail page, the Reservations list,
  // and every report. This used to be its own "expected-to-date pace"
  // formula (daily rate x days since pickup, minus paid), which produced a
  // completely different number than everywhere else showing "balance" for
  // the same booking — that's what was confusing here.
  const activeRenters = db.prepare(`
    SELECT a.*, v.year, v.make, v.model
    FROM applications a
    JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE v.status = 'rented' AND a.weekly_rate IS NOT NULL
  `).all().map(r => {
    const daily_rate = r.weekly_rate / 7;
    const paidToDate = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE application_id = ?`).get(r.id).total;
    const charge = computeCharge(r);
    const balance = computeOwed(r, paidToDate);
    return {
      id: r.id, first_name: r.first_name, last_name: r.last_name, year: r.year, make: r.make, model: r.model,
      weekly_rate: r.weekly_rate, daily_rate, charge, paidToDate, balance,
    };
  });

  const flaggedRenters = activeRenters.filter(r => r.balance > BALANCE_FLAG_THRESHOLD);

  const expectedDailyTotal = activeRenters.reduce((sum, r) => sum + r.daily_rate, 0);

  // Held security deposits are a liability, not revenue — kept separate from
  // any revenue figure so it never gets mixed into P&L reporting.
  const depositsHeld = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'held'`).get().total;

  res.json({ activeRenters, flaggedRenters, expectedDailyTotal, depositsHeld });
});

module.exports = router;

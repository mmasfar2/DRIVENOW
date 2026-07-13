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
  // a.status = 'active' matters as much as v.status = 'rented' here — a
  // vehicle can carry the same 'rented' status while a *later* renter is
  // checked out on it, but the vehicle_id on an older, already-checked-in
  // (status = 'completed') application never changes, so without this it
  // joins in every past renter that vehicle ever had, not just whoever's
  // actually driving it right now.
  const activeRenters = db.prepare(`
    SELECT a.*, v.year, v.make, v.model
    FROM applications a
    JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE v.status = 'rented' AND a.status = 'active' AND a.weekly_rate IS NOT NULL
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

  // What's actually owed right now across every currently active renter —
  // the same `balance` shown in the table below, just totaled. This used to
  // be a projected daily-rate sum (what a full day's rent from everyone
  // *would* be), which didn't correspond to any real number anywhere else
  // on the page.
  const outstandingBalance = Math.round(activeRenters.reduce((sum, r) => sum + r.balance, 0) * 100) / 100;

  // Held security deposits are a liability, not revenue — kept separate from
  // any revenue figure so it never gets mixed into P&L reporting.
  const depositsHeld = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'held'`).get().total;

  res.json({ activeRenters, flaggedRenters, outstandingBalance, depositsHeld });
});

module.exports = router;

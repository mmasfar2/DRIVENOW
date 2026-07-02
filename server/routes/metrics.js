const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const BALANCE_FLAG_THRESHOLD = 250;

router.get('/cashflow', requireAuth, (req, res) => {
  const today = new Date();
  const todayDateOnlyStr = today.toISOString().slice(0, 10);

  const activeRenters = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.weekly_rate, a.pickup_scheduled_at, v.year, v.make, v.model
    FROM applications a
    JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE v.status = 'rented' AND a.weekly_rate IS NOT NULL
  `).all().map(r => {
    const daily_rate = r.weekly_rate / 7;
    const rentalStart = r.pickup_scheduled_at ? r.pickup_scheduled_at.slice(0, 10) : todayDateOnlyStr;
    const daysSinceStart = Math.max(1, Math.floor((new Date(todayDateOnlyStr) - new Date(rentalStart)) / 86400000) + 1);
    const expectedToDate = daily_rate * daysSinceStart;
    const paidToDate = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE application_id = ?`).get(r.id).total;
    const balance = Math.round((expectedToDate - paidToDate) * 100) / 100;
    return { ...r, daily_rate, expectedToDate, paidToDate, balance };
  });

  const flaggedRenters = activeRenters.filter(r => r.balance > BALANCE_FLAG_THRESHOLD);

  const expectedDailyTotal = activeRenters.reduce((sum, r) => sum + r.daily_rate, 0);

  // Held security deposits are a liability, not revenue — kept separate from
  // any revenue figure so it never gets mixed into P&L reporting.
  const depositsHeld = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'held'`).get().total;

  res.json({ activeRenters, flaggedRenters, expectedDailyTotal, depositsHeld });
});

module.exports = router;

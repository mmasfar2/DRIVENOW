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

  const dayOfWeek = (today.getDay() + 6) % 7; // days elapsed this week, Monday = 0
  const daysElapsedThisWeek = dayOfWeek + 1;
  const daysElapsedThisMonth = today.getDate();
  const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  const todayStr = today.toISOString().slice(0, 10);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - dayOfWeek);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const monthStartStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;

  const actualToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE paid_at = ?
  `).get(todayStr).total;
  const actualWeek = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE paid_at >= ? AND paid_at <= ?
  `).get(weekStartStr, todayStr).total;
  const actualMonth = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE paid_at >= ? AND paid_at <= ?
  `).get(monthStartStr, todayStr).total;

  // Card processing fees are collected on top of rental revenue (not counted
  // toward a renter's balance) — tracked separately so they can be reconciled
  // against the processor's statement instead of mixed into rental income.
  const feesToday = db.prepare(`
    SELECT COALESCE(SUM(processing_fee), 0) as total FROM payments WHERE paid_at = ? AND method = 'card'
  `).get(todayStr).total;
  const feesWeek = db.prepare(`
    SELECT COALESCE(SUM(processing_fee), 0) as total FROM payments WHERE paid_at >= ? AND paid_at <= ? AND method = 'card'
  `).get(weekStartStr, todayStr).total;
  const feesMonth = db.prepare(`
    SELECT COALESCE(SUM(processing_fee), 0) as total FROM payments WHERE paid_at >= ? AND paid_at <= ? AND method = 'card'
  `).get(monthStartStr, todayStr).total;

  const expensesToday = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance WHERE performed_at = ?
  `).get(todayStr).total;
  const expensesWeek = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance WHERE performed_at >= ? AND performed_at <= ?
  `).get(weekStartStr, todayStr).total;
  const expensesMonth = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance WHERE performed_at >= ? AND performed_at <= ?
  `).get(monthStartStr, todayStr).total;

  const periods = {
    daily: {
      expected: expectedDailyTotal,
      actual: actualToday,
      expenses: expensesToday,
      cardFees: feesToday,
    },
    weekly: {
      expected: expectedDailyTotal * daysElapsedThisWeek,
      expectedFull: expectedDailyTotal * 7,
      actual: actualWeek,
      expenses: expensesWeek,
      cardFees: feesWeek,
    },
    monthly: {
      expected: expectedDailyTotal * daysElapsedThisMonth,
      expectedFull: expectedDailyTotal * daysInThisMonth,
      actual: actualMonth,
      expenses: expensesMonth,
      cardFees: feesMonth,
    },
  };
  for (const p of Object.values(periods)) {
    p.netActual = p.actual - p.expenses;
    p.variance = p.netActual - p.expected;
  }

  res.json({ activeRenters, flaggedRenters, expectedDailyTotal, periods });
});

module.exports = router;

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/cashflow', requireAuth, (req, res) => {
  const activeRenters = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.weekly_rate, v.year, v.make, v.model
    FROM applications a
    JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE v.status = 'rented' AND a.weekly_rate IS NOT NULL
  `).all().map(r => ({ ...r, daily_rate: r.weekly_rate / 7 }));

  const expectedDailyTotal = activeRenters.reduce((sum, r) => sum + r.daily_rate, 0);

  const today = new Date();
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
    },
    weekly: {
      expected: expectedDailyTotal * daysElapsedThisWeek,
      expectedFull: expectedDailyTotal * 7,
      actual: actualWeek,
      expenses: expensesWeek,
    },
    monthly: {
      expected: expectedDailyTotal * daysElapsedThisMonth,
      expectedFull: expectedDailyTotal * daysInThisMonth,
      actual: actualMonth,
      expenses: expensesMonth,
    },
  };
  for (const p of Object.values(periods)) {
    p.netActual = p.actual - p.expenses;
    p.variance = p.netActual - p.expected;
  }

  res.json({ activeRenters, expectedDailyTotal, periods });
});

module.exports = router;

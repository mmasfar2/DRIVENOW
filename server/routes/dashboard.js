const express = require('express');
const { db, getForfeitedDeposits, getAccruedRevenueDays } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeOwed } = require('../billing');
const { todayStr, daysAgoStr } = require('../timezone');

const router = express.Router();

const STAGE_NAMES = {
  1: 'Customer Application',
  2: 'Initial Screening',
  3: 'Background Check',
  4: 'Insurance Quote',
  5: 'Quote Presentation',
  6: 'Rental Agreement',
  7: 'Invoice & Payment Sent',
  8: 'Payment Verification',
};

router.get('/summary', requireAuth, (req, res) => {
  // Pipeline overview: count of active applications per stage
  const pipeline = [];
  for (let stage = 1; stage <= 8; stage++) {
    const count = db.prepare("SELECT COUNT(*) as c FROM applications WHERE stage = ? AND status = 'active'").get(stage).c;
    pipeline.push({ stage, name: STAGE_NAMES[stage], count });
  }

  // Revenue & payments — sourced from the `payments` table (same definition
  // used everywhere else: Reservations, Reservation Detail, Customer Profile,
  // Metrics) rather than the legacy `applications.payment_amount` column,
  // which only ever gets set by one pipeline path (Stage 8 "Payment
  // Verification") and not by manual/walk-in bookings approved through
  // Reservations — those were previously invisible here.
  //
  // Not every dollar collected is revenue, though — sales tax, highway tax,
  // insurance fee, and processing fee are pass-through/ancillary and are
  // excluded. And revenue is counted as of the nights the booking itself
  // covers (its own daily rate, night by night), not whenever a payment
  // against it happened to be logged — a booking paid on July 11 for a May
  // 12–June 14 rental still shows its revenue spread across those May/June
  // nights (see getAccruedRevenueDays in db.js), gated by how much has
  // actually been paid — FIFO, oldest night first — so a night that hasn't
  // been paid for yet earns nothing. That also means extending an active
  // booking's return date further out never retroactively moves revenue
  // already recognized for its earlier, already-paid-for nights — the
  // extension only adds new, as-yet-unpaid-for nights at the end. Forfeited
  // security deposits count as revenue too, as of the booking's return date
  // (held deposits stay a liability, excluded), and so do insurance claim
  // payouts and vehicle sales, each as of its own date (matching the
  // Revenue by Vehicle report's treatment) — a vehicle wrecked-and-paid-out,
  // or sold outright, actually earned that money back. Every revenue figure
  // below reads from these same queries so a forfeiture, a payout, a sale,
  // or a fee can't show up as revenue in one place and not another.
  const accruedDays = getAccruedRevenueDays();
  const forfeitedDeposits = getForfeitedDeposits();
  const forfeitedTotal = forfeitedDeposits.reduce((sum, d) => sum + Number(d.forfeited_amount), 0);
  const insurancePayouts = db.prepare(`
    SELECT payout_date as date, insurance_payout as amount FROM claims
    WHERE insurance_payout IS NOT NULL AND payout_date IS NOT NULL
  `).all();
  const payoutTotal = insurancePayouts.reduce((sum, d) => sum + Number(d.amount), 0);
  const vehicleSales = db.prepare(`
    SELECT sale_date as date, sale_amount as amount FROM vehicles
    WHERE sale_amount IS NOT NULL AND sale_date IS NOT NULL
  `).all();
  const saleTotal = vehicleSales.reduce((sum, d) => sum + Number(d.amount), 0);
  const sevenDaysAgoStr = daysAgoStr(7);
  const forfeitedThisWeek = forfeitedDeposits
    .filter(d => d.date >= sevenDaysAgoStr)
    .reduce((sum, d) => sum + Number(d.forfeited_amount), 0);
  const payoutThisWeek = insurancePayouts
    .filter(d => d.date >= sevenDaysAgoStr)
    .reduce((sum, d) => sum + Number(d.amount), 0);
  const saleThisWeek = vehicleSales
    .filter(d => d.date >= sevenDaysAgoStr)
    .reduce((sum, d) => sum + Number(d.amount), 0);

  const totalRevenue = Math.round((accruedDays.reduce((sum, d) => sum + d.amount, 0) + forfeitedTotal + payoutTotal + saleTotal) * 100) / 100;
  const paidThisWeek = Math.round((
    accruedDays.filter(d => d.date >= sevenDaysAgoStr).reduce((sum, d) => sum + d.amount, 0) + forfeitedThisWeek + payoutThisWeek + saleThisWeek
  ) * 100) / 100;

  // Pending/overdue invoices — net out payments already made (via billing.js's
  // computeOwed) instead of counting the full invoice_amount regardless of
  // partial payments already logged.
  const invoicedApps = db.prepare(`
    SELECT a.*, COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.application_id = a.id), 0) as paid_total
    FROM applications a
    WHERE a.invoice_sent_at IS NOT NULL AND a.status = 'active'
  `).all().map(a => ({ ...a, owed: computeOwed(a, a.paid_total) })).filter(a => a.owed > 0);
  const pendingInvoices = Math.round(invoicedApps.reduce((sum, a) => sum + a.owed, 0) * 100) / 100;

  // Fleet status
  const fleetStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM vehicles GROUP BY status
  `).all();

  // Recent activity
  const recentActivity = db.prepare(`
    SELECT a.application_id, a.message, a.created_at, ap.first_name, ap.last_name
    FROM activity_log a
    LEFT JOIN applications ap ON ap.id = a.application_id
    ORDER BY a.created_at DESC LIMIT 20
  `).all();

  const totalApplications = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
  const activeApplications = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'active'").get().c;
  const rejectedApplications = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'rejected'").get().c;
  const completedApplications = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'completed'").get().c;

  // Overview tiles (iFleet-style dashboard) — a sold or totaled vehicle
  // isn't part of the fleet anymore, so both are excluded from Total
  // Vehicles (and, by extension, from the utilization rate's denominator too).
  const totalVehicles = db.prepare("SELECT COUNT(*) as c FROM vehicles WHERE status NOT IN ('sold', 'totaled', 'removed')").get().c;
  const availableVehicles = db.prepare("SELECT COUNT(*) as c FROM vehicles WHERE status = 'available'").get().c;
  const rentedVehicles = db.prepare("SELECT COUNT(*) as c FROM vehicles WHERE status = 'rented'").get().c;
  const utilizationRate = totalVehicles > 0 ? Math.round((rentedVehicles / totalVehicles) * 100) : 0;

  // Revenue earned resets at the start of every calendar month
  const thisMonthStr = todayStr().slice(0, 7);
  const forfeitedThisMonth = forfeitedDeposits
    .filter(d => d.date && d.date.slice(0, 7) === thisMonthStr)
    .reduce((sum, d) => sum + Number(d.forfeited_amount), 0);
  const payoutThisMonth = insurancePayouts
    .filter(d => d.date && d.date.slice(0, 7) === thisMonthStr)
    .reduce((sum, d) => sum + Number(d.amount), 0);
  const saleThisMonth = vehicleSales
    .filter(d => d.date && d.date.slice(0, 7) === thisMonthStr)
    .reduce((sum, d) => sum + Number(d.amount), 0);
  const revenueThisMonth = Math.round((
    accruedDays.filter(d => d.date && d.date.slice(0, 7) === thisMonthStr).reduce((sum, d) => sum + d.amount, 0) + forfeitedThisMonth + payoutThisMonth + saleThisMonth
  ) * 100) / 100;

  const overdueIds = new Set(
    db.prepare(`
      SELECT id FROM applications
      WHERE status = 'active' AND invoice_sent_at IS NOT NULL AND invoice_sent_at <= datetime('now', '-7 days')
    `).all().map(r => r.id)
  );
  const overdueApps = invoicedApps.filter(a => overdueIds.has(a.id));
  const overdue = { c: overdueApps.length, total: Math.round(overdueApps.reduce((sum, a) => sum + a.owed, 0) * 100) / 100 };

  const customers = db.prepare(`
    SELECT COUNT(*) as c FROM applications WHERE payment_status = 'paid' OR status = 'completed'
  `).get().c;
  const newCustomersThisMonth = db.prepare(`
    SELECT COUNT(*) as c FROM applications
    WHERE (payment_status = 'paid' OR status = 'completed') AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')
  `).get().c;

  const activeBookings = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'active' AND stage >= 6").get().c;

  // Average daily rate = average of (weekly_rate / 7) across vehicles currently rented out.
  // Only includes the base daily rate — no taxes or fees.
  const avgDailyRateRow = db.prepare(`
    SELECT AVG(weekly_rate / 7.0) as adr FROM vehicles
    WHERE status = 'rented' AND weekly_rate IS NOT NULL
  `).get();
  const avgDailyRate = Math.round((avgDailyRateRow.adr || 0) * 100) / 100;

  const maintenanceCostThisMonth = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance
    WHERE strftime('%Y-%m', COALESCE(performed_at, created_at)) = strftime('%Y-%m', 'now')
  `).get().total;
  const maintenanceCostLastMonth = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance
    WHERE strftime('%Y-%m', COALESCE(performed_at, created_at)) = strftime('%Y-%m', datetime('now', '-1 month'))
  `).get().total;

  // Window starts at the first day of last month (not 12 months back) and
  // just keeps going forward — last month, this month, and whatever
  // "coming months" accumulate data as time passes — rather than a fixed
  // trailing-12-months lookback.
  const [todayY, todayM] = todayStr().split('-').map(Number);
  const lastMonthStartStr = new Date(Date.UTC(todayY, todayM - 2, 1)).toISOString().slice(0, 10);
  const monthlyAccruedMap = new Map();
  accruedDays.forEach(d => {
    if (!d.date || d.date < lastMonthStartStr) return;
    const month = d.date.slice(0, 7);
    monthlyAccruedMap.set(month, (monthlyAccruedMap.get(month) || 0) + d.amount);
  });
  const forfeitedByMonth = new Map();
  forfeitedDeposits.forEach(d => {
    if (!d.date || d.date < lastMonthStartStr) return;
    const month = d.date.slice(0, 7);
    forfeitedByMonth.set(month, (forfeitedByMonth.get(month) || 0) + Number(d.forfeited_amount));
  });
  const payoutByMonth = new Map();
  insurancePayouts.forEach(d => {
    if (!d.date || d.date < lastMonthStartStr) return;
    const month = d.date.slice(0, 7);
    payoutByMonth.set(month, (payoutByMonth.get(month) || 0) + Number(d.amount));
  });
  const saleByMonth = new Map();
  vehicleSales.forEach(d => {
    if (!d.date || d.date < lastMonthStartStr) return;
    const month = d.date.slice(0, 7);
    saleByMonth.set(month, (saleByMonth.get(month) || 0) + Number(d.amount));
  });
  const monthSet = new Set([...monthlyAccruedMap.keys(), ...forfeitedByMonth.keys(), ...payoutByMonth.keys(), ...saleByMonth.keys()]);
  const monthlyRevenue = [...monthSet].sort().map(month => {
    const base = monthlyAccruedMap.get(month) || 0;
    const forfeited = forfeitedByMonth.get(month) || 0;
    const payout = payoutByMonth.get(month) || 0;
    const sale = saleByMonth.get(month) || 0;
    return { month, total: Math.round((base + forfeited + payout + sale) * 100) / 100 };
  });

  const overdueList = overdueApps
    .sort((a, b) => (a.invoice_sent_at < b.invoice_sent_at ? -1 : 1))
    .slice(0, 5)
    .map(a => ({ id: a.id, first_name: a.first_name, last_name: a.last_name, invoice_amount: a.owed, invoice_sent_at: a.invoice_sent_at }));

  const pendingBookingsList = db.prepare(`
    SELECT id, first_name, last_name, stage, pickup_scheduled_at FROM applications
    WHERE status = 'active' AND stage >= 6
    ORDER BY updated_at DESC LIMIT 5
  `).all();

  res.json({
    pipeline,
    revenue: { totalRevenue, pendingInvoices, paidThisWeek },
    fleetStatus,
    recentActivity,
    counts: { totalApplications, activeApplications, rejectedApplications, completedApplications },
    overview: {
      totalVehicles, availableVehicles, rentedVehicles, utilizationRate,
      revenueThisMonth,
      overdueCount: overdue.c, overdueBalance: overdue.total, overdueList,
      customers, newCustomersThisMonth,
      activeBookings, pendingBookingsList,
      maintenanceCostThisMonth, maintenanceCostLastMonth,
      monthlyRevenue, avgDailyRate,
    },
  });
});

router.get('/adr-breakdown', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.pickup_scheduled_at, a.rental_end_at,
           a.weekly_rate as app_weekly_rate,
           v.year, v.make, v.model, v.license_plate, v.weekly_rate as veh_weekly_rate
    FROM applications a
    LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE a.status = 'active' AND a.stage >= 6
      AND v.status = 'rented'
      AND a.pickup_scheduled_at IS NOT NULL AND a.rental_end_at IS NOT NULL
  `).all();

  const result = rows.map(r => {
    const days = Math.round((new Date(r.rental_end_at) - new Date(r.pickup_scheduled_at)) / 86400000);
    // Use the invoice amount (what they're actually being charged) divided by rental days.
    // Fall back to the vehicle's weekly rate / 7 if no invoice yet.
    const weekly = Number(r.app_weekly_rate || r.veh_weekly_rate) || 0;
    const dailyRate = Math.round(weekly / 7 * 100) / 100;
    return {
      name: `${r.first_name} ${r.last_name}`,
      vehicle: `${r.year} ${r.make} ${r.model}`,
      license_plate: r.license_plate || '—',
      daily_rate: dailyRate,
      days,
    };
  }).sort((a, b) => b.daily_rate - a.daily_rate);

  res.json(result);
});

module.exports = router;

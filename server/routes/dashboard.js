const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeOwed } = require('../billing');

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
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM payments').get().total;
  const paidThisWeek = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE paid_at >= date('now', '-7 days')
  `).get().total;

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

  // Overview tiles (iFleet-style dashboard)
  const totalVehicles = db.prepare('SELECT COUNT(*) as c FROM vehicles').get().c;
  const availableVehicles = db.prepare("SELECT COUNT(*) as c FROM vehicles WHERE status = 'available'").get().c;
  const rentedVehicles = db.prepare("SELECT COUNT(*) as c FROM vehicles WHERE status = 'rented'").get().c;
  const utilizationRate = totalVehicles > 0 ? Math.round((rentedVehicles / totalVehicles) * 100) : 0;

  // Revenue earned resets at the start of every calendar month
  const revenueThisMonth = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE strftime('%Y-%m', paid_at) = strftime('%Y-%m', 'now')
  `).get().total;

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

  const maintenanceCostThisMonth = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance
    WHERE strftime('%Y-%m', COALESCE(performed_at, created_at)) = strftime('%Y-%m', 'now')
  `).get().total;
  const maintenanceCostLastMonth = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance
    WHERE strftime('%Y-%m', COALESCE(performed_at, created_at)) = strftime('%Y-%m', datetime('now', '-1 month'))
  `).get().total;

  const monthlyRevenue = db.prepare(`
    SELECT strftime('%Y-%m', paid_at) as month, COALESCE(SUM(amount), 0) as total
    FROM payments
    WHERE paid_at >= date('now', '-12 months')
    GROUP BY month ORDER BY month ASC
  `).all();

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
      monthlyRevenue,
    },
  });
});

module.exports = router;

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

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

  // Revenue & payments
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(payment_amount), 0) as total FROM applications WHERE payment_status = 'paid'").get().total;
  const pendingInvoices = db.prepare("SELECT COALESCE(SUM(invoice_amount), 0) as total FROM applications WHERE invoice_sent_at IS NOT NULL AND payment_status = 'unpaid'").get().total;
  const paidThisWeek = db.prepare(`
    SELECT COALESCE(SUM(payment_amount), 0) as total FROM applications
    WHERE payment_status = 'paid' AND payment_received_at >= datetime('now', '-7 days')
  `).get().total;

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
    SELECT COALESCE(SUM(payment_amount), 0) as total FROM applications
    WHERE payment_status = 'paid' AND strftime('%Y-%m', payment_received_at) = strftime('%Y-%m', 'now')
  `).get().total;

  const overdue = db.prepare(`
    SELECT COUNT(*) as c, COALESCE(SUM(invoice_amount), 0) as total FROM applications
    WHERE payment_status = 'unpaid' AND invoice_sent_at IS NOT NULL AND invoice_sent_at <= datetime('now', '-7 days')
  `).get();

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
    SELECT strftime('%Y-%m', payment_received_at) as month, COALESCE(SUM(payment_amount), 0) as total
    FROM applications
    WHERE payment_status = 'paid' AND payment_received_at >= datetime('now', '-12 months')
    GROUP BY month ORDER BY month ASC
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
      overdueCount: overdue.c, overdueBalance: overdue.total,
      customers, newCustomersThisMonth,
      activeBookings,
      maintenanceCostThisMonth, maintenanceCostLastMonth,
      monthlyRevenue,
    },
  });
});

module.exports = router;

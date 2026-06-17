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

  res.json({
    pipeline,
    revenue: { totalRevenue, pendingInvoices, paidThisWeek },
    fleetStatus,
    recentActivity,
    counts: { totalApplications, activeApplications, rejectedApplications, completedApplications },
  });
});

module.exports = router;

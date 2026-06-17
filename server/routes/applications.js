const express = require('express');
const multer = require('multer');
const path = require('path');
const { db, logActivity, queueMessage } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.fieldname}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── PUBLIC: Stage 1 — Customer Application Submission ──
router.post('/', upload.fields([{ name: 'license' }, { name: 'insurance' }]), (req, res) => {
  const { first_name, last_name, phone, email, address, occupation, intended_use, license_number, license_state, consent_background } = req.body;

  if (!first_name || !last_name || !phone || !email) {
    return res.status(400).json({ error: 'First name, last name, phone, and email are required' });
  }
  if (!consent_background || consent_background === 'false') {
    return res.status(400).json({ error: 'Consent to background check is required' });
  }

  const licensePath = req.files?.license?.[0]?.filename || null;
  const insurancePath = req.files?.insurance?.[0]?.filename || null;

  const result = db.prepare(`
    INSERT INTO applications
      (first_name, last_name, phone, email, address, occupation, intended_use, license_number, license_state, license_path, insurance_path, consent_background, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `).run(first_name, last_name, phone, email, address || null, occupation || null, intended_use || null, license_number || null, license_state || null, licensePath, insurancePath);

  const appId = result.lastInsertRowid;
  logActivity(appId, `New application submitted by ${first_name} ${last_name}`);
  queueMessage(appId, 'sms', phone, "We've received your application and are currently reviewing it.");

  res.status(201).json({ id: appId, message: 'Application received' });
});

// ── AUTHED: List applications (filterable by stage/status) ──
router.get('/', requireAuth, (req, res) => {
  const { stage, status } = req.query;
  let query = 'SELECT * FROM applications WHERE 1=1';
  const params = [];
  if (stage) { query += ' AND stage = ?'; params.push(stage); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// ── AUTHED: Get single application + its activity log ──
router.get('/:id', requireAuth, (req, res) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const activity = db.prepare('SELECT * FROM activity_log WHERE application_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...app, activity });
});

// ── AUTHED: Stage 2 — Initial Screening decision ──
router.post('/:id/screening', requireAuth, (req, res) => {
  const { license_valid, age_ok, address_match, red_flags, vehicle_available, notes, decision, rejection_reason } = req.body;
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE applications SET
      screening_license_valid = ?, screening_age_ok = ?, screening_address_match = ?,
      screening_red_flags = ?, screening_vehicle_available = ?, screening_notes = ?,
      screening_decision = ?, rejection_reason = ?,
      stage = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    license_valid ? 1 : 0, age_ok ? 1 : 0, address_match ? 1 : 0,
    red_flags || null, vehicle_available ? 1 : 0, notes || null,
    decision, decision === 'reject' ? rejection_reason : null,
    decision === 'pass' ? 3 : 2,
    decision === 'reject' ? 'rejected' : 'active',
    id
  );

  if (decision === 'reject') {
    logActivity(id, `Application rejected at initial screening: ${rejection_reason || 'no reason given'}`);
    queueMessage(id, 'sms', app.phone, "After review, we're unable to move forward with your application at this time.");
  } else {
    logActivity(id, 'Passed initial screening — moving to background check');
  }

  res.json({ ok: true });
});

// ── AUTHED: Stage 3 — Background Check result (manual entry by VA) ──
router.post('/:id/background-check', requireAuth, (req, res) => {
  const { background_status, background_notes } = req.body;
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  const nextStage = background_status === 'declined' ? app.stage : 4;
  const nextStatus = background_status === 'declined' ? 'rejected' : 'active';

  db.prepare(`
    UPDATE applications SET background_status = ?, background_notes = ?, stage = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(background_status, background_notes || null, nextStage, nextStatus, id);

  logActivity(id, `Background check result: ${background_status}`);

  if (background_status === 'approved' || background_status === 'conditional') {
    queueMessage(id, 'sms', app.phone, "Good news — your background check has been approved. We'll be sending your rental agreement shortly.");
  } else if (background_status === 'declined') {
    queueMessage(id, 'sms', app.phone, "After your background check, we're unable to move forward with your application at this time.");
  }

  res.json({ ok: true });
});

// ── AUTHED: Stage 4 — Insurance Quote (manual entry by admin for now) ──
router.post('/:id/insurance-quote', requireAuth, (req, res) => {
  const { insurance_quote_amount, insurance_notes } = req.body;
  const id = req.params.id;
  db.prepare(`
    UPDATE applications SET insurance_quote_amount = ?, insurance_notes = ?, stage = 5, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(insurance_quote_amount, insurance_notes || null, id);
  logActivity(id, `Insurance quote received: $${insurance_quote_amount}`);
  res.json({ ok: true });
});

// ── AUTHED: Stage 5 — Quote Presentation (vehicle + pricing) ──
router.post('/:id/quote', requireAuth, (req, res) => {
  const { assigned_vehicle_id, weekly_rate, total_due_at_pickup } = req.body;
  const id = req.params.id;
  db.prepare(`
    UPDATE applications SET assigned_vehicle_id = ?, weekly_rate = ?, total_due_at_pickup = ?, stage = 6, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(assigned_vehicle_id || null, weekly_rate, total_due_at_pickup, id);
  if (assigned_vehicle_id) {
    db.prepare("UPDATE vehicles SET status = 'reserved' WHERE id = ?").run(assigned_vehicle_id);
  }
  logActivity(id, `Quote presented — $${weekly_rate}/week, $${total_due_at_pickup} due at pickup`);
  res.json({ ok: true });
});

// ── AUTHED: Stage 6 — Agreement sent / signed ──
router.post('/:id/agreement/send', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  db.prepare(`UPDATE applications SET agreement_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  logActivity(id, 'Rental agreement sent for e-signature');
  queueMessage(id, 'sms', app.phone, 'Your rental agreement is ready to sign. Check your email/text for the link.');
  res.json({ ok: true });
});

router.post('/:id/agreement/signed', requireAuth, (req, res) => {
  const id = req.params.id;
  db.prepare(`UPDATE applications SET agreement_signed_at = CURRENT_TIMESTAMP, stage = 7, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  logActivity(id, 'Customer signed rental agreement');
  res.json({ ok: true });
});

// ── AUTHED: Stage 7 — Invoice sent ──
router.post('/:id/invoice', requireAuth, (req, res) => {
  const { invoice_amount } = req.body;
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  db.prepare(`
    UPDATE applications SET invoice_amount = ?, invoice_sent_at = CURRENT_TIMESTAMP, stage = 8, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(invoice_amount, id);
  logActivity(id, `Invoice sent for $${invoice_amount}`);
  queueMessage(id, 'sms', app.phone, `Your invoice for $${invoice_amount} is ready. Please complete payment to reserve your vehicle.`);
  res.json({ ok: true });
});

// ── AUTHED: Stage 8 — Payment verification ──
router.post('/:id/payment', requireAuth, (req, res) => {
  const { payment_amount, pickup_scheduled_at } = req.body;
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);

  db.prepare(`
    UPDATE applications SET
      payment_status = 'paid', payment_amount = ?, payment_received_at = CURRENT_TIMESTAMP,
      pickup_scheduled_at = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(payment_amount, pickup_scheduled_at || null, id);

  if (app.assigned_vehicle_id) {
    db.prepare("UPDATE vehicles SET status = 'rented' WHERE id = ?").run(app.assigned_vehicle_id);
  }

  logActivity(id, `Payment verified ($${payment_amount}) — vehicle reserved, pickup scheduled`);
  queueMessage(id, 'sms', app.phone, "Payment received! Your vehicle is reserved. We'll see you at pickup.");

  res.json({ ok: true });
});

// ── AUTHED: General notes / edit ──
router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['first_name', 'last_name', 'phone', 'email', 'address', 'occupation', 'intended_use'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE applications SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

module.exports = router;

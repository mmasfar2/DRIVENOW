const express = require('express');
const multer = require('multer');
const { db, logActivity, queueMessage, upsertCustomer } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR } = require('../paths');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.fieldname}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── PUBLIC: Stage 1 — Customer Application Submission ──
router.post('/', upload.fields([{ name: 'license' }, { name: 'insurance' }]), (req, res) => {
  const { first_name, last_name, phone, email, address, city, state, zip_code, dob, occupation, use_type, license_number, consent_background, vehicle_id, has_own_insurance, rental_duration, notes } = req.body;

  if (!first_name || !last_name || !phone || !email) {
    return res.status(400).json({ error: 'First name, last name, phone, and email are required' });
  }
  if (!consent_background || consent_background === 'false') {
    return res.status(400).json({ error: 'Consent to background check is required' });
  }
  if (phone.replace(/\D/g, '').length !== 10) {
    return res.status(400).json({ error: 'Phone number must contain exactly 10 digits' });
  }
  if (license_number && license_number.replace(/[^0-9A-Za-z]/g, '').length < 4) {
    return res.status(400).json({ error: 'License number looks too short — please check and try again' });
  }
  if (!zip_code || zip_code.replace(/\D/g, '').length !== 5) {
    return res.status(400).json({ error: 'ZIP code must contain exactly 5 digits' });
  }

  const licensePath = req.files?.license?.[0]?.filename || null;
  const insurancePath = req.files?.insurance?.[0]?.filename || null;
  const assignedVehicleId = vehicle_id ? Number(vehicle_id) : null;

  const result = db.prepare(`
    INSERT INTO applications
      (first_name, last_name, phone, email, address, city, state, zip_code, dob, occupation, use_type, license_number, license_path, insurance_path, consent_background, has_own_insurance, assigned_vehicle_id, rental_duration, notes, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
  `).run(first_name, last_name, phone, email, address || null, city || null, state || null, zip_code || null, dob || null, occupation || null, use_type || null, license_number || null, licensePath, insurancePath, has_own_insurance === 'yes' ? 1 : 0, assignedVehicleId, rental_duration || null, notes || null);

  const appId = result.lastInsertRowid;
  if (assignedVehicleId) {
    db.prepare("UPDATE vehicles SET status = 'reserved' WHERE id = ? AND status = 'available'").run(assignedVehicleId);
  }
  upsertCustomer({ email, first_name, last_name, phone, address, city, state, zip_code, dob });
  logActivity(appId, `New application submitted by ${first_name} ${last_name}`);
  queueMessage(appId, 'sms', phone, "We've received your application and are currently reviewing it.");

  res.status(201).json({ id: appId, message: 'Application received' });
});

// ── AUTHED: Approve a new lead — moves it into Reservations as a Potential Arrival ──
router.post('/:id/move-to-arrivals', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (!app.assigned_vehicle_id) return res.status(400).json({ error: 'This lead has no vehicle selected yet' });

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(app.assigned_vehicle_id);
  if (!vehicle) return res.status(404).json({ error: 'Assigned vehicle not found' });

  const amount = app.invoice_amount || app.total_due_at_pickup || vehicle.weekly_rate;
  db.prepare(`
    UPDATE applications SET
      stage = 5, status = 'active', payment_status = 'unpaid',
      weekly_rate = COALESCE(weekly_rate, ?), invoice_amount = ?, total_due_at_pickup = COALESCE(total_due_at_pickup, ?),
      lead_decision = 'approved', lead_decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(vehicle.weekly_rate, amount, amount, id);
  db.prepare("UPDATE vehicles SET status = 'reserved' WHERE id = ?").run(vehicle.id);

  logActivity(id, 'Lead approved — moved to Potential Arrivals in Reservations');
  res.json({ ok: true });
});

// ── AUTHED: Reject a new lead — moves it to the Former Leads tab ──
router.post('/:id/reject-lead', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT id FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare(`
    UPDATE applications SET
      status = 'rejected', rejection_reason = 'Rejected from Leads',
      lead_decision = 'rejected', lead_decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
  logActivity(id, 'Lead rejected — moved to Former Leads');
  res.json({ ok: true });
});

// ── AUTHED: Undo a former-leads decision — sends the lead back to New Leads ──
router.post('/:id/undo-lead-decision', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });

  if (app.lead_decision === 'approved') {
    db.prepare(`
      UPDATE applications SET
        stage = 1, status = 'active', payment_status = 'unpaid',
        weekly_rate = NULL, invoice_amount = NULL, total_due_at_pickup = NULL,
        lead_decision = NULL, lead_decided_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  } else {
    db.prepare(`
      UPDATE applications SET
        stage = 1, status = 'active', rejection_reason = NULL,
        lead_decision = NULL, lead_decided_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  logActivity(id, 'Former lead decision undone — sent back to New Leads');
  res.json({ ok: true });
});

// ── AUTHED: List applications (filterable by stage/status) ──
router.get('/', requireAuth, (req, res) => {
  const { stage, status, decided } = req.query;
  let query = `
    SELECT a.*, v.make as vehicle_make, v.model as vehicle_model, v.year as vehicle_year
    FROM applications a
    LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE 1=1
  `;
  const params = [];
  if (stage) { query += ' AND a.stage = ?'; params.push(stage); }
  if (status) { query += ' AND a.status = ?'; params.push(status); }
  if (decided === '1') { query += ' AND a.lead_decision IS NOT NULL'; }
  query += decided === '1' ? ' ORDER BY a.lead_decided_at ASC' : ' ORDER BY a.created_at DESC';
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

// ── AUTHED: Payment Log — manually recorded payments for a booking ──
router.get('/:id/payments', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY paid_at DESC, id DESC').all(req.params.id);
  res.json(rows);
});

router.post('/:id/payments', requireAuth, (req, res) => {
  const { amount, paid_at } = req.body;
  const id = req.params.id;
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid amount is required' });

  db.prepare('INSERT INTO payments (application_id, amount, paid_at) VALUES (?, ?, ?)')
    .run(id, amount, paid_at || new Date().toISOString().slice(0, 10));
  logActivity(id, `Payment of $${amount} recorded`);
  res.status(201).json({ ok: true });
});

// ── AUTHED: Full reservation detail (booking + vehicle + payments + notes) ──
router.get('/:id/detail', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT a.*, v.id as vehicle_id, v.make, v.model, v.year, v.status as vehicle_status,
           v.vin, v.license_plate, v.color, v.fuel_type, v.transmission
    FROM applications a
    LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const payments = db.prepare('SELECT * FROM payments WHERE application_id = ? ORDER BY paid_at DESC, id DESC').all(req.params.id);
  const notes = db.prepare('SELECT * FROM booking_notes WHERE application_id = ? ORDER BY created_at DESC').all(req.params.id);
  const paidTotal = Math.round(payments.reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100;
  const charge = row.invoice_amount || row.total_due_at_pickup || 0;
  const owed = row.status === 'active' ? Math.max(0, Math.round((charge - paidTotal) * 100) / 100) : 0;

  res.json({ ...row, payments, paid_total: paidTotal, owed, notes });
});

// ── AUTHED: Booking notes (internal, VA/owner only) ──
router.get('/:id/notes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM booking_notes WHERE application_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

router.post('/:id/notes', requireAuth, (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
  const id = req.params.id;
  const app = db.prepare('SELECT id FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT INTO booking_notes (application_id, note) VALUES (?, ?)').run(id, note.trim());
  res.status(201).json({ ok: true });
});

// ── AUTHED: General notes / edit ──
router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['first_name', 'last_name', 'phone', 'email', 'address', 'occupation', 'intended_use', 'rental_end_at', 'odometer_out', 'odometer_in', 'pickup_location', 'dropoff_location'];
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

  // Extending the rental term changes how much is owed — recompute the exact charge
  // from the weekly rate rather than leaving the original quote's total stale.
  if (req.body.rental_end_at !== undefined) {
    const id = req.params.id;
    const app = db.prepare('SELECT pickup_scheduled_at, weekly_rate FROM applications WHERE id = ?').get(id);
    if (app && app.pickup_scheduled_at && app.weekly_rate) {
      const days = Math.round((new Date(req.body.rental_end_at) - new Date(app.pickup_scheduled_at)) / 86400000);
      const dailyRateExact = app.weekly_rate / 7;
      const subtotal = Math.round(dailyRateExact * days * 100) / 100;
      const salesTax = Math.round(subtotal * 0.0725 * 100) / 100;
      const total = Math.round((subtotal + salesTax) * 100) / 100;
      db.prepare('UPDATE applications SET total_due_at_pickup = ? WHERE id = ?').run(total, id);
      logActivity(id, `Reservation extended to ${req.body.rental_end_at} — balance recalculated to $${total}`);
    }
  }

  res.json({ ok: true });
});

// ── AUTHED: Approve a potential arrival — marks it paid and checks the vehicle out, moving it to On Lease ──
router.post('/:id/approve-arrival', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT assigned_vehicle_id FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE applications SET payment_status = 'paid' WHERE id = ?").run(id);
  if (app.assigned_vehicle_id) {
    db.prepare("UPDATE vehicles SET status = 'rented' WHERE id = ?").run(app.assigned_vehicle_id);
  }
  logActivity(id, 'Potential arrival approved — vehicle checked out, now on lease');
  res.json({ ok: true });
});

// ── AUTHED: Send an on-lease booking back to Potential Arrivals ──
router.post('/:id/revert-arrival', requireAuth, (req, res) => {
  const id = req.params.id;
  const app = db.prepare('SELECT assigned_vehicle_id FROM applications WHERE id = ?').get(id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE applications SET payment_status = 'unpaid' WHERE id = ?").run(id);
  if (app.assigned_vehicle_id) {
    db.prepare("UPDATE vehicles SET status = 'reserved' WHERE id = ?").run(app.assigned_vehicle_id);
  }
  logActivity(id, 'Booking sent back to potential arrivals');
  res.json({ ok: true });
});

// ── AUTHED: Bookings/Reservations — applications that have an assigned vehicle ──
router.get('/bookings/all', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.phone, a.email, a.weekly_rate, a.total_due_at_pickup,
           a.payment_status, a.invoice_amount, a.invoice_sent_at, a.pickup_scheduled_at, a.rental_end_at, a.status, a.updated_at,
           v.id as vehicle_id, v.make, v.model, v.year, v.status as vehicle_status,
           COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.application_id = a.id), 0) as paid_total
    FROM applications a
    JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE a.assigned_vehicle_id IS NOT NULL
    ORDER BY a.updated_at DESC
  `).all();

  const bookings = rows.map(r => {
    const charge = r.invoice_amount || r.total_due_at_pickup || 0;
    const owed = r.status === 'active' ? Math.max(0, Math.round((charge - r.paid_total) * 100) / 100) : 0;
    let bucket;
    if (r.payment_status === 'unpaid' && r.invoice_amount) bucket = 'potential_arrival';
    else if (r.vehicle_status === 'rented') bucket = 'on_rental';
    else if (r.vehicle_status === 'reserved') bucket = 'upcoming';
    else bucket = 'completed';
    return { ...r, owed, bucket };
  });

  const totalBookings = bookings.length;
  const upcoming = bookings.filter(b => b.bucket === 'upcoming').length;
  const onRental = bookings.filter(b => b.bucket === 'on_rental').length;
  const outstandingBalance = bookings.reduce((sum, b) => sum + b.owed, 0);

  res.json({ bookings, stats: { totalBookings, upcoming, onRental, outstandingBalance } });
});

// ── AUTHED: Search existing customers by name/phone/email (for manual booking) ──
router.get('/customers/search', requireAuth, (req, res) => {
  const term = `%${(req.query.q || '').toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT id, first_name, last_name, phone, email, license_number, address, dob
    FROM applications
    WHERE lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(email) LIKE ? OR lower(phone) LIKE ?
    ORDER BY created_at DESC LIMIT 10
  `).all(term, term, term, term);
  res.json(rows);
});

// ── AUTHED: Manual Booking — VA/owner creates a reservation directly ──
const uploadManual = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.fieldname}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
}).fields([{ name: 'license' }, { name: 'insurance_private' }, { name: 'insurance_policies' }]);

router.post('/manual-booking', requireAuth, uploadManual, (req, res) => {
  const {
    first_name, last_name, phone, email,
    assigned_vehicle_id, weekly_rate, total_due_at_pickup,
    pickup_scheduled_at, rental_end_at, source,
    dob, license_number, address,
  } = req.body;

  if (!first_name || !last_name || !phone || !email) {
    return res.status(400).json({ error: 'First name, last name, phone, and email are required' });
  }
  if (!assigned_vehicle_id || !weekly_rate || !pickup_scheduled_at || !rental_end_at) {
    return res.status(400).json({ error: 'Vehicle, weekly rate, and dates are required' });
  }

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(assigned_vehicle_id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  const bookingSource = source === 'online' ? 'manual_booking_online' : 'manual_booking_in_person';
  const licensePath = req.files?.license?.[0]?.filename || null;
  const insurancePrivatePath = req.files?.insurance_private?.[0]?.filename || null;
  const insurancePolicyPath = req.files?.insurance_policies?.[0]?.filename || null;

  const result = db.prepare(`
    INSERT INTO applications
      (first_name, last_name, phone, email, consent_background, stage, status,
       assigned_vehicle_id, weekly_rate, total_due_at_pickup, invoice_amount, payment_status, pickup_scheduled_at, rental_end_at, source,
       dob, license_number, address, license_path, insurance_path, insurance_private_path)
    VALUES (?, ?, ?, ?, 1, 6, 'active', ?, ?, ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    first_name, last_name, phone, email, assigned_vehicle_id, weekly_rate, total_due_at_pickup || null, total_due_at_pickup || null,
    pickup_scheduled_at, rental_end_at, bookingSource,
    dob || null, license_number || null, address || null, licensePath, insurancePolicyPath, insurancePrivatePath
  );

  const appId = result.lastInsertRowid;
  db.prepare("UPDATE vehicles SET status = 'reserved' WHERE id = ?").run(assigned_vehicle_id);
  upsertCustomer({ email, first_name, last_name, phone, address, dob });
  logActivity(appId, `Manual reservation created for ${first_name} ${last_name} — ${vehicle.make} ${vehicle.model} at $${weekly_rate}/week`);

  res.status(201).json({ id: appId, message: 'Reservation created' });
});

module.exports = router;

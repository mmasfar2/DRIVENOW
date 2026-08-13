const express = require('express');
const multer = require('multer');
const { db, upsertCustomer, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeCharge, computeOwed } = require('../billing');
const { UPLOADS_DIR } = require('../paths');

const licenseUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-license-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = express.Router();

// Every booking tied to this customer. Primarily matched via
// applications.customer_id — set once, directly, at booking-creation time
// (see upsertCustomer's call sites in applications.js) — rather than
// re-guessing the link by matching email/name/address every time this page
// loads. Falls back to email-or-name+address for older rows that predate
// that column (backfilled on startup in db.js where possible), then
// name+phone — not restricted to "no address on either side", since a
// customer with an address on file from a different visit than this booking
// is still the same person. Deliberately never falls back to phone alone
// without a name match too — two different people (family, a shared
// business line) can share one phone number, which would incorrectly pull
// in a stranger's bookings.
function buildProfile(customer) {
  if (!customer) return null;
  const bookings = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.status, a.payment_status, a.invoice_amount, a.total_due_at_pickup, a.weekly_rate,
           a.pickup_scheduled_at, a.rental_end_at, a.created_at, a.license_path, a.insurance_path,
           a.occupation, a.use_type, a.rental_duration, a.notes, a.has_own_insurance,
           v.make, v.model, v.year, v.status as vehicle_status,
           COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.application_id = a.id), 0) as paid_total
    FROM applications a
    LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE a.customer_id = ?
       OR (
         a.customer_id IS NULL AND (
           (a.email != '' AND ? IS NOT NULL AND lower(a.email) = lower(?))
           OR (
             ? != '' AND a.address IS NOT NULL AND a.address != ''
             AND lower(trim(a.first_name)) = ? AND lower(trim(a.last_name)) = ? AND lower(trim(a.address)) = ?
           )
           OR (
             lower(trim(a.first_name)) = ? AND lower(trim(a.last_name)) = ?
             AND ? != '' AND a.phone IS NOT NULL AND a.phone != ''
             AND replace(replace(replace(replace(replace(a.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') = ?
           )
         )
       )
    ORDER BY a.created_at DESC
  `).all(
    customer.id,
    customer.email, customer.email || '',
    (customer.address || '').trim().toLowerCase(),
    (customer.first_name || '').trim().toLowerCase(), (customer.last_name || '').trim().toLowerCase(), (customer.address || '').trim().toLowerCase(),
    (customer.first_name || '').trim().toLowerCase(), (customer.last_name || '').trim().toLowerCase(),
    (customer.phone || '').replace(/\D/g, ''), (customer.phone || '').replace(/\D/g, '')
  ).map(b => {
    const charge = computeCharge(b);
    const owed = computeOwed(b, b.paid_total);
    let stageLabel;
    if (b.status === 'rejected') stageLabel = 'Rejected';
    else if (b.status === 'completed') stageLabel = 'Completed';
    else if (!b.vehicle_status) stageLabel = 'Application';
    else if (b.payment_status === 'unpaid' && b.invoice_amount) stageLabel = 'Pending Payment';
    else if (b.vehicle_status === 'rented') stageLabel = 'Active Rental';
    else stageLabel = 'Pending Customer';
    return { ...b, owed, charge, stageLabel };
  });

  const completed = bookings.filter(b => b.status === 'completed');
  const totalSpent = Math.round(bookings.reduce((sum, b) => sum + b.paid_total, 0) * 100) / 100;
  const avgPerRental = completed.length ? Math.round((completed.reduce((sum, b) => sum + b.charge, 0) / completed.length) * 100) / 100 : null;
  const outstanding = Math.round(bookings.reduce((sum, b) => sum + Math.max(0, b.owed), 0) * 100) / 100;

  const tags = db.prepare('SELECT * FROM customer_tags WHERE customer_id = ? ORDER BY created_at ASC').all(customer.id);
  const insuranceRecords = db.prepare('SELECT * FROM insurance_records WHERE customer_id = ? ORDER BY type').all(customer.id);
  const notes = db.prepare('SELECT * FROM customer_notes WHERE customer_id = ? ORDER BY created_at DESC').all(customer.id);

  return {
    ...customer,
    isNew: completed.length === 0,
    leadId: bookings.length ? bookings[bookings.length - 1].id : null,
    stats: {
      totalSpent,
      totalBookings: bookings.length,
      completedRentals: completed.length,
      avgPerRental,
      outstanding,
    },
    bookings,
    insurance_records: insuranceRecords,
    tags,
    notes,
  };
}

function getProfileByEmail(email) {
  let customer = db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(email);
  if (!customer) {
    const app = db.prepare('SELECT * FROM applications WHERE lower(email) = lower(?) ORDER BY created_at ASC LIMIT 1').get(email);
    if (!app) return null;
    const newCustomerId = upsertCustomer(app);
    if (!app.customer_id) db.prepare('UPDATE applications SET customer_id = ? WHERE id = ?').run(newCustomerId, app.id);
    customer = db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(email);
  }
  return buildProfile(customer);
}

function getProfileById(id) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return buildProfile(customer);
}

// Matches a booking to a customer via applications.customer_id first
// (same reasoning as buildProfile above), falling back to email-or-
// name+address for older rows without it, then name+phone — not restricted
// to "no address on either side" (see buildProfile/CUSTOMER_JOIN for why).
// Deliberately not phone alone.
const CUSTOMER_MATCH = `
  a.customer_id = c.id
  OR (
    a.customer_id IS NULL AND (
      (a.email != '' AND c.email IS NOT NULL AND lower(a.email) = lower(c.email))
      OR (
        c.address IS NOT NULL AND c.address != '' AND a.address IS NOT NULL AND a.address != ''
        AND lower(trim(a.first_name)) = lower(trim(c.first_name))
        AND lower(trim(a.last_name)) = lower(trim(c.last_name))
        AND lower(trim(a.address)) = lower(trim(c.address))
      )
      OR (
        lower(trim(a.first_name)) = lower(trim(c.first_name))
        AND lower(trim(a.last_name)) = lower(trim(c.last_name))
        AND c.phone IS NOT NULL AND c.phone != '' AND a.phone IS NOT NULL AND a.phone != ''
        AND replace(replace(replace(replace(replace(c.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') =
            replace(replace(replace(replace(replace(a.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '')
      )
    )
  )
`;

router.get('/', requireAuth, (req, res) => {
  const customers = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.blacklisted,
      (SELECT COUNT(*) FROM applications a WHERE ${CUSTOMER_MATCH}) as total_bookings,
      (SELECT COUNT(*) FROM applications a JOIN vehicles v ON v.id = a.assigned_vehicle_id WHERE (${CUSTOMER_MATCH}) AND a.status = 'active' AND v.status = 'rented') as active_rentals,
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN applications a ON a.id = p.application_id WHERE ${CUSTOMER_MATCH}) as total_spent
    FROM customers c
    ORDER BY c.last_name, c.first_name
  `).all().map(c => ({ ...c, status: c.active_rentals > 0 ? 'current' : 'previous' }));
  res.json(customers);
});

router.get('/by-email/:email', requireAuth, (req, res) => {
  const profile = getProfileByEmail(req.params.email);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profile);
});

// Preferred lookup — email can be null (walk-in customers with no email on
// file), so a customer's own numeric id is the only identifier guaranteed
// to always resolve them.
router.get('/id/:id', requireAuth, (req, res) => {
  const profile = getProfileById(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profile);
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip_code', 'dob', 'internal_notes', 'blacklisted', 'license_number'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      let value = req.body[key];
      if (key === 'email') value = value ? value.trim() || null : null;
      if (key === 'phone') value = value ? value.replace(/\D/g, '') : null;
      updates.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  if (req.body.email) {
    const clash = db.prepare('SELECT id FROM customers WHERE lower(email) = lower(?) AND id != ?').get(req.body.email, req.params.id);
    if (clash) return res.status(400).json({ error: 'Another customer already uses that email' });
  }
  params.push(req.params.id);
  db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ── Customer notes (internal, VA/owner only) — a running timestamped log,
// same shape as applications.js's booking_notes ──
router.get('/:id/notes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM customer_notes WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

router.post('/', requireAuth, (req, res) => {
  const { first_name, last_name, phone, email, address, city, state, zip_code, dob } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name are required.' });
  const normalizedPhone = phone ? phone.replace(/\D/g, '') : null;
  const existing = email ? db.prepare('SELECT id FROM customers WHERE lower(email)=lower(?)').get(email) : null;
  if (existing) return res.status(400).json({ error: 'A customer with that email already exists.' });
  const result = db.prepare(`
    INSERT INTO customers (first_name, last_name, phone, email, address, city, state, zip_code, dob)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(first_name, last_name, normalizedPhone || null, email || null, address || null, city || null, state || null, zip_code || null, dob || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.post('/:id/license', requireAuth, licenseUpload.single('license'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  db.prepare('UPDATE customers SET license_path = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ filename: req.file.filename });
});

router.post('/:id/notes', requireAuth, (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ error: 'Note text is required' });
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT INTO customer_notes (customer_id, note) VALUES (?, ?)').run(req.params.id, note.trim());
  res.status(201).json({ ok: true });
});

// Removes a client from the Clients list — for cleaning up duplicate/ghost
// entries (a customer record with no booking history, e.g. left behind by
// a matching edge case elsewhere). Blocked when the client has any bookings
// on file: those bookings are real revenue/rental history, and simply
// detaching them (customer_id back to NULL) doesn't actually stick — the
// startup backfill that guarantees every booking has a customer would just
// recreate a fresh profile for it on the very next restart, silently
// undoing the deletion. Delete or reassign those bookings first.
router.delete('/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!customer) return res.status(404).json({ error: 'Not found' });

  const bookingCount = db.prepare('SELECT COUNT(*) as c FROM applications WHERE customer_id = ?').get(id).c;
  if (bookingCount > 0) {
    return res.status(400).json({ error: `This client has ${bookingCount} booking(s) on file — delete those first before removing the client.` });
  }

  const tags = db.prepare('SELECT * FROM customer_tags WHERE customer_id = ?').all(id);
  const insuranceRecords = db.prepare('SELECT * FROM insurance_records WHERE customer_id = ?').all(id);

  logUndo('customer_delete', `Deleted client ${customer.first_name} ${customer.last_name}`, {
    customer, tags, insuranceRecords,
  });

  db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM insurance_records WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/:id/tags', requireAuth, (req, res) => {
  const { tag } = req.body;
  if (!tag || !tag.trim()) return res.status(400).json({ error: 'Tag text is required' });
  db.prepare('INSERT INTO customer_tags (customer_id, tag) VALUES (?, ?)').run(req.params.id, tag.trim());
  res.status(201).json({ ok: true });
});

router.delete('/:id/tags/:tagId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM customer_tags WHERE id = ? AND customer_id = ?').run(req.params.tagId, req.params.id);
  res.json({ ok: true });
});

module.exports = router;

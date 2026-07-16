const express = require('express');
const { db, upsertCustomer } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { computeCharge, computeOwed } = require('../billing');

const router = express.Router();

// Every booking tied to this customer, matched by phone OR email — phone
// because it's required on every booking path (email is optional on
// manual/walk-in bookings, and customers.email can now be NULL), email as a
// second signal. Phone is stored digits-only on both sides (see
// normalizePhone in db.js).
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
    WHERE (a.phone != '' AND a.phone = ?)
       OR (a.email != '' AND ? IS NOT NULL AND lower(a.email) = lower(?))
    ORDER BY a.created_at DESC
  `).all(customer.phone || '', customer.email, customer.email || '').map(b => {
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
  };
}

function getProfileByEmail(email) {
  let customer = db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(email);
  if (!customer) {
    const app = db.prepare('SELECT * FROM applications WHERE lower(email) = lower(?) ORDER BY created_at ASC LIMIT 1').get(email);
    if (!app) return null;
    upsertCustomer(app);
    customer = db.prepare('SELECT * FROM customers WHERE lower(email) = lower(?)').get(email);
  }
  return buildProfile(customer);
}

function getProfileById(id) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return buildProfile(customer);
}

router.get('/', requireAuth, (req, res) => {
  const customers = db.prepare(`
    SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.blacklisted,
      (SELECT COUNT(*) FROM applications a WHERE (a.phone != '' AND a.phone = c.phone) OR (a.email != '' AND c.email IS NOT NULL AND lower(a.email) = lower(c.email))) as total_bookings,
      (SELECT COUNT(*) FROM applications a JOIN vehicles v ON v.id = a.assigned_vehicle_id WHERE ((a.phone != '' AND a.phone = c.phone) OR (a.email != '' AND c.email IS NOT NULL AND lower(a.email) = lower(c.email))) AND a.status = 'active' AND v.status = 'rented') as active_rentals,
      (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN applications a ON a.id = p.application_id WHERE (a.phone != '' AND a.phone = c.phone) OR (a.email != '' AND c.email IS NOT NULL AND lower(a.email) = lower(c.email))) as total_spent
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

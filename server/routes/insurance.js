const express = require('express');
const multer = require('multer');
const { db, logUndo } = require('../db');
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

// ── AUTHED: Insurance Records — one row per customer per coverage type
// ('private' = customer's own policy, 'our_policy' = DriveNow-provided
// coverage). This is the single place insurance documents/details live —
// other pages (customer profile, reservation detail) read from here so
// they can't show stale or conflicting insurance info. ──
router.get('/', requireAuth, (req, res) => {
  const { type } = req.query;
  const rows = type
    ? db.prepare(`
        SELECT ir.*, c.first_name, c.last_name, c.email
        FROM insurance_records ir JOIN customers c ON c.id = ir.customer_id
        WHERE ir.type = ?
        ORDER BY c.last_name, c.first_name
      `).all(type)
    : db.prepare(`
        SELECT ir.*, c.first_name, c.last_name, c.email
        FROM insurance_records ir JOIN customers c ON c.id = ir.customer_id
        ORDER BY c.last_name, c.first_name
      `).all();
  res.json(rows);
});

router.get('/by-customer-email/:email', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT ir.* FROM insurance_records ir
    JOIN customers c ON c.id = ir.customer_id
    WHERE lower(c.email) = lower(?)
    ORDER BY ir.type
  `).all(req.params.email);
  res.json(rows);
});

router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT ir.*, c.first_name, c.last_name, c.email, c.phone
    FROM insurance_records ir JOIN customers c ON c.id = ir.customer_id
    WHERE ir.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requireAuth, (req, res) => {
  const { customer_id, type, carrier, protection_type, policy_number, last_verified_at, next_payment_date, notes, status } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'A customer is required' });
  if (type !== 'private' && type !== 'our_policy') return res.status(400).json({ error: 'Invalid insurance type' });
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const result = db.prepare(`
    INSERT INTO insurance_records (customer_id, type, carrier, protection_type, policy_number, last_verified_at, next_payment_date, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(customer_id, type, carrier || null, protection_type || null, policy_number || null, last_verified_at || null, next_payment_date || null, notes || null, status || 'Active');
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['carrier', 'protection_type', 'policy_number', 'last_verified_at', 'next_payment_date', 'notes', 'status'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(req.body[key] || null);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  const result = db.prepare(`UPDATE insurance_records SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/:id/document', requireAuth, upload.single('document'), (req, res) => {
  const row = db.prepare('SELECT id FROM insurance_records WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  db.prepare('UPDATE insurance_records SET document_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ ok: true, document_path: req.file.filename });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM insurance_records WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  logUndo('insurance_delete', `Deleted an insurance record`, { record: row });
  db.prepare('DELETE FROM insurance_records WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

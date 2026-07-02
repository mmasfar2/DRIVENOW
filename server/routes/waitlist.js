const express = require('express');
const { db, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const { status } = req.query;
  let query = 'SELECT * FROM waitlist WHERE 1=1';
  const params = [];
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

router.post('/', requireAuth, (req, res) => {
  const { first_name, last_name, phone, email, desired_vehicle, notes } = req.body;
  if (!first_name || !last_name || !phone) {
    return res.status(400).json({ error: 'First name, last name, and phone are required' });
  }
  const result = db.prepare(`
    INSERT INTO waitlist (first_name, last_name, phone, email, desired_vehicle, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(first_name, last_name, phone, email || null, desired_vehicle || null, notes || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['first_name', 'last_name', 'phone', 'email', 'desired_vehicle', 'notes', 'status'];
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
  db.prepare(`UPDATE waitlist SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  logUndo('waitlist_delete', `Removed ${entry.first_name} ${entry.last_name} from the waitlist`, { entry });
  db.prepare('DELETE FROM waitlist WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

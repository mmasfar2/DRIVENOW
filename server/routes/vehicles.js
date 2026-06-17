const express = require('express');
const { db, logActivity } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicles ORDER BY created_at DESC').all());
});

router.post('/', requireAuth, (req, res) => {
  const { make, model, year, weekly_rate, notes } = req.body;
  if (!make || !model || !year || !weekly_rate) {
    return res.status(400).json({ error: 'Make, model, year, and weekly rate are required' });
  }
  const result = db.prepare('INSERT INTO vehicles (make, model, year, weekly_rate, notes) VALUES (?, ?, ?, ?, ?)')
    .run(make, model, year, weekly_rate, notes || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['make', 'model', 'year', 'weekly_rate', 'status', 'notes'];
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
  db.prepare(`UPDATE vehicles SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

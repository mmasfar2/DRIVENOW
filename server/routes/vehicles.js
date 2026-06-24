const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR } = require('../paths');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-vehicle-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Public, unauthenticated — used by the marketing site to show fleet photos/pricing
router.get('/public', (req, res) => {
  const rows = db.prepare(`
    SELECT id, make, model, year, weekly_rate, status, photo_path
    FROM vehicles
    ORDER BY created_at ASC
  `).all();
  res.json(rows);
});

router.get('/', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicles ORDER BY created_at DESC').all());
});

router.post('/:id/photo', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
  db.prepare('UPDATE vehicles SET photo_path = ? WHERE id = ?').run(req.file.filename, req.params.id);
  res.json({ ok: true, photo_path: req.file.filename });
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
  const allowed = ['make', 'model', 'year', 'weekly_rate', 'status', 'notes', 'vin', 'license_plate', 'color', 'fuel_type', 'transmission'];
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

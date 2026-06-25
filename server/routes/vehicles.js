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
  const rows = db.prepare('SELECT * FROM vehicles ORDER BY created_at DESC').all();
  const withPhotos = rows.map(v => ({
    ...v,
    photos: db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at ASC').all(v.id),
  }));
  res.json(withPhotos);
});

router.get('/:id/photos', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at ASC').all(req.params.id));
});

router.post('/:id/photo', requireAuth, upload.array('photos', 20), (req, res) => {
  const files = req.files && req.files.length ? req.files : (req.file ? [req.file] : []);
  if (!files.length) return res.status(400).json({ error: 'No photo uploaded' });
  const insert = db.prepare('INSERT INTO vehicle_photos (vehicle_id, photo_path) VALUES (?, ?)');
  for (const file of files) insert.run(req.params.id, file.filename);
  // Keep the legacy single-photo column pointed at the most recent upload —
  // the public marketing site's fleet page only displays one cover photo.
  db.prepare('UPDATE vehicles SET photo_path = ? WHERE id = ?').run(files[files.length - 1].filename, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id/photo/:photoId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM vehicle_photos WHERE id = ? AND vehicle_id = ?').run(req.params.photoId, req.params.id);
  const latest = db.prepare('SELECT photo_path FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  db.prepare('UPDATE vehicles SET photo_path = ? WHERE id = ?').run(latest ? latest.photo_path : null, req.params.id);
  res.json({ ok: true });
});

router.post('/', requireAuth, (req, res) => {
  const {
    make, model, year, weekly_rate, notes, status,
    stock_number, license_plate, vin, color, vehicle_class,
    purchase_date, purchase_price, mileage,
  } = req.body;
  if (!make || !model || !year || !weekly_rate) {
    return res.status(400).json({ error: 'Make, model, year, and weekly rate are required' });
  }
  const result = db.prepare(`
    INSERT INTO vehicles (
      make, model, year, weekly_rate, notes, status,
      stock_number, license_plate, vin, color, vehicle_class,
      purchase_date, purchase_price, mileage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    make, model, year, weekly_rate, notes || null, status || 'available',
    stock_number || null, license_plate || null, vin || null, color || null, vehicle_class || null,
    purchase_date || null, purchase_price || null, mileage || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = [
    'make', 'model', 'year', 'weekly_rate', 'status', 'notes', 'vin', 'license_plate', 'color', 'fuel_type', 'transmission',
    'stock_number', 'vehicle_class', 'purchase_date', 'purchase_price', 'mileage',
  ];
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

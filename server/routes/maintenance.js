const express = require('express');
const multer = require('multer');
const { db, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR } = require('../paths');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-maint-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.get('/', requireAuth, (req, res) => {
  const { vehicle_id } = req.query;
  let query = `
    SELECT m.*, v.make, v.model, v.year,
      (SELECT COUNT(*) FROM maintenance_photos p WHERE p.maintenance_id = m.id) as photo_count
    FROM vehicle_maintenance m
    JOIN vehicles v ON v.id = m.vehicle_id
  `;
  const params = [];
  if (vehicle_id) {
    query += ' WHERE m.vehicle_id = ?';
    params.push(vehicle_id);
  }
  query += ' ORDER BY m.performed_at DESC, m.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

router.get('/:id', requireAuth, (req, res) => {
  const record = db.prepare(`
    SELECT m.*, v.make, v.model, v.year FROM vehicle_maintenance m
    JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?
  `).get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  const photos = db.prepare('SELECT * FROM maintenance_photos WHERE maintenance_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ ...record, photos });
});

router.post('/', requireAuth, upload.array('photos', 10), (req, res) => {
  const { vehicle_id, description, cost, performed_at, notes, category } = req.body;
  if (!vehicle_id || !description) {
    return res.status(400).json({ error: 'Vehicle and description are required' });
  }
  const result = db.prepare(`
    INSERT INTO vehicle_maintenance (vehicle_id, description, cost, performed_at, notes, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(vehicle_id, description, cost || null, performed_at || null, notes || null, category || null);

  const maintenanceId = result.lastInsertRowid;
  const insertPhoto = db.prepare('INSERT INTO maintenance_photos (maintenance_id, photo_path) VALUES (?, ?)');
  (req.files || []).forEach(f => insertPhoto.run(maintenanceId, f.filename));

  res.status(201).json({ id: maintenanceId });
});

router.delete('/:id', requireAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM vehicle_maintenance WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  const photos = db.prepare('SELECT * FROM maintenance_photos WHERE maintenance_id = ?').all(req.params.id);

  logUndo('maintenance_delete', `Removed maintenance: ${record.description}`, { record, photos });

  db.prepare('DELETE FROM maintenance_photos WHERE maintenance_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vehicle_maintenance WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

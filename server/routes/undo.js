const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const row = db.prepare('SELECT entity_type, label FROM undo_log ORDER BY id DESC LIMIT 1').get();
  res.json(row ? { action: row.entity_type, label: row.label } : null);
});

router.post('/', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM undo_log ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.status(400).json({ error: 'Nothing to undo' });
  const payload = JSON.parse(row.payload);

  if (row.entity_type === 'vehicle_delete') {
    const { vehicle, photos, maintenance } = payload;
    db.prepare(`
      INSERT INTO vehicles (id, make, model, year, weekly_rate, status, notes, created_at, photo_path, vin, license_plate, color, fuel_type, transmission, stock_number, vehicle_class, purchase_date, purchase_price, mileage, next_service_at)
      VALUES (@id, @make, @model, @year, @weekly_rate, @status, @notes, @created_at, @photo_path, @vin, @license_plate, @color, @fuel_type, @transmission, @stock_number, @vehicle_class, @purchase_date, @purchase_price, @mileage, @next_service_at)
    `).run(vehicle);
    const insPhoto = db.prepare('INSERT INTO vehicle_photos (id, vehicle_id, photo_path, created_at) VALUES (?, ?, ?, ?)');
    photos.forEach(p => insPhoto.run(p.id, p.vehicle_id, p.photo_path, p.created_at));
    const insMaint = db.prepare('INSERT INTO vehicle_maintenance (id, vehicle_id, description, cost, performed_at, notes, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    maintenance.forEach(m => insMaint.run(m.id, m.vehicle_id, m.description, m.cost, m.performed_at, m.notes, m.category, m.created_at));
  } else if (row.entity_type === 'maintenance_delete') {
    const { record, photos } = payload;
    db.prepare(`
      INSERT INTO vehicle_maintenance (id, vehicle_id, description, cost, performed_at, notes, category, created_at)
      VALUES (@id, @vehicle_id, @description, @cost, @performed_at, @notes, @category, @created_at)
    `).run(record);
    const insPhoto = db.prepare('INSERT INTO maintenance_photos (id, maintenance_id, photo_path, caption, created_at) VALUES (?, ?, ?, ?, ?)');
    photos.forEach(p => insPhoto.run(p.id, p.maintenance_id, p.photo_path, p.caption, p.created_at));
  } else if (row.entity_type === 'vehicle_photo_delete') {
    const p = payload;
    db.prepare('INSERT INTO vehicle_photos (id, vehicle_id, photo_path, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.vehicle_id, p.photo_path, p.created_at);
    db.prepare('UPDATE vehicles SET photo_path = ? WHERE id = ?').run(p.photo_path, p.vehicle_id);
  }

  db.prepare('DELETE FROM undo_log WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;

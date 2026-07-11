const express = require('express');
const multer = require('multer');
const { db, logUndo, getForfeitedDeposits } = require('../db');
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

router.get('/:id', requireAuth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Not found' });

  const photos = db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at ASC').all(req.params.id);
  const maintenance = db.prepare('SELECT * FROM vehicle_maintenance WHERE vehicle_id = ? ORDER BY performed_at DESC').all(req.params.id);

  // Revenue per booking is what was actually collected (payments table),
  // not an untaxed rate x days estimate — matches the definition used
  // everywhere else (Reservations, Metrics, Customer Profile), and excludes
  // rejected applications that never became a real rental. Any forfeited
  // security deposit tied to the booking counts toward revenue too, as of
  // when it was resolved — held deposits stay excluded as a liability.
  const forfeitedByApp = new Map();
  getForfeitedDeposits().forEach(d => {
    if (d.vehicle_id !== Number(req.params.id)) return;
    forfeitedByApp.set(d.application_id, (forfeitedByApp.get(d.application_id) || 0) + Number(d.forfeited_amount));
  });
  const applications = db.prepare(`
    SELECT a.*, COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.application_id = a.id), 0) as paid_total
    FROM applications a
    WHERE a.assigned_vehicle_id = ? AND a.status != 'rejected'
  `).all(req.params.id);
  const bookings = applications.map(a => {
    const pickup = a.pickup_scheduled_at || null;
    const dropoff = a.rental_end_at || null;
    let days = 0;
    if (pickup && dropoff) {
      days = Math.round((new Date(dropoff) - new Date(pickup)) / 86400000);
    }
    return {
      applicant: `${a.first_name} ${a.last_name}`,
      pickup,
      dropoff,
      days,
      revenue: Math.round((Number(a.paid_total) + (forfeitedByApp.get(a.id) || 0)) * 100) / 100,
    };
  });

  const totalRevenue = Math.round(bookings.reduce((sum, b) => sum + b.revenue, 0) * 100) / 100;
  const totalExpense = Math.round(maintenance.reduce((sum, m) => sum + (Number(m.cost) || 0), 0) * 100) / 100;
  // Profit = revenue minus everything spent on the vehicle — both what it cost
  // to acquire (purchase price) and what's been spent on it since (maintenance).
  // Can go negative if the vehicle hasn't earned back what was put into it yet.
  const totalProfit = Math.round((totalRevenue - (Number(vehicle.purchase_price) || 0) - totalExpense) * 100) / 100;
  const lastServicedRow = maintenance.find(m => m.performed_at);
  const lastServiced = lastServicedRow ? lastServicedRow.performed_at : null;

  res.json({
    ...vehicle,
    photos,
    maintenance,
    bookings,
    totalRevenue,
    totalExpense,
    totalProfit,
    lastServiced,
  });
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
  const photo = db.prepare('SELECT * FROM vehicle_photos WHERE id = ? AND vehicle_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  logUndo('vehicle_photo_delete', 'Removed vehicle photo', photo);
  db.prepare('DELETE FROM vehicle_photos WHERE id = ? AND vehicle_id = ?').run(req.params.photoId, req.params.id);
  const latest = db.prepare('SELECT photo_path FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.id);
  db.prepare('UPDATE vehicles SET photo_path = ? WHERE id = ?').run(latest ? latest.photo_path : null, req.params.id);
  res.json({ ok: true });
});

router.post('/', requireAuth, (req, res) => {
  const {
    make, model, year, weekly_rate, notes, status,
    stock_number, license_plate, vin, color, vehicle_class,
    purchase_date, purchase_price, mileage, purchase_mileage,
  } = req.body;
  if (!make || !model || !year || !weekly_rate) {
    return res.status(400).json({ error: 'Make, model, year, and weekly rate are required' });
  }
  const result = db.prepare(`
    INSERT INTO vehicles (
      make, model, year, weekly_rate, notes, status,
      stock_number, license_plate, vin, color, vehicle_class,
      purchase_date, purchase_price, mileage, purchase_mileage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    make, model, year, weekly_rate, notes || null, status || 'available',
    stock_number || null, license_plate || null, vin || null, color || null, vehicle_class || null,
    purchase_date || null, purchase_price || null, mileage || null, purchase_mileage || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = [
    'make', 'model', 'year', 'weekly_rate', 'status', 'notes', 'vin', 'license_plate', 'color', 'fuel_type', 'transmission',
    'stock_number', 'vehicle_class', 'purchase_date', 'purchase_price', 'mileage', 'purchase_mileage', 'next_service_at',
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
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Not found' });
  const photos = db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ?').all(req.params.id);
  const maintenance = db.prepare('SELECT * FROM vehicle_maintenance WHERE vehicle_id = ?').all(req.params.id);

  logUndo('vehicle_delete', `Removed ${vehicle.year} ${vehicle.make} ${vehicle.model}`, { vehicle, photos, maintenance });

  db.prepare('DELETE FROM vehicle_photos WHERE vehicle_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vehicle_maintenance WHERE vehicle_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

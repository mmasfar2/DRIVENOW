const express = require('express');
const multer = require('multer');
const { db, logUndo, getForfeitedDeposits, getCollectedRevenueDays, getLastOilChangeByVehicle, withOilChangeStatus } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { UPLOADS_DIR } = require('../paths');
const { computeRevenueEligible } = require('../billing');

const router = express.Router();

// A toll is a pass-through cost — paid out, then recovered from the
// customer — not money actually lost on the vehicle, so it's excluded
// from Expense/Profit even though it's still logged via the maintenance
// table. Same condition the Toll Report (reports.js) uses to find tolls.
function isTollRecord(m) {
  return m.category === 'toll' || (m.description || '').toLowerCase().includes('toll');
}

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
  const lastOilChangeByVehicle = getLastOilChangeByVehicle();
  const withPhotos = rows.map(v => ({
    ...withOilChangeStatus(v, lastOilChangeByVehicle),
    photos: db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at ASC').all(v.id),
  }));
  res.json(withPhotos);
});

router.get('/:id', requireAuth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Not found' });

  const photos = db.prepare('SELECT * FROM vehicle_photos WHERE vehicle_id = ? ORDER BY created_at ASC').all(req.params.id);
  const maintenance = db.prepare('SELECT * FROM vehicle_maintenance WHERE vehicle_id = ? ORDER BY performed_at DESC').all(req.params.id);
  // Business expenses attributed to this specific vehicle — currently just
  // Swipe card-processing fees auto-traced through payment -> application ->
  // assigned_vehicle_id (see syncSwipeExpense in applications.js), plus any
  // manually-attributed entries. Counted in Expense/Profit below alongside
  // maintenance, since this is a real absorbed cost, not a pass-through.
  const businessExpenses = db.prepare('SELECT * FROM business_expenses WHERE vehicle_id = ? ORDER BY expense_date DESC').all(req.params.id);

  // Revenue per booking is cash-basis — the car's daily rate, travel fee,
  // and admin fee only (sales tax, highway tax, insurance fee, and
  // processing fee excluded), recognized as of the date each payment was
  // actually collected rather than the rental nights it happens to cover
  // (see getCollectedRevenueDays in db.js). An unpaid balance hasn't been
  // earned yet. Matches the definition used everywhere else (Dashboard,
  // Reports), and excludes rejected applications that never became a real
  // rental. Any forfeited security deposit tied to the booking counts
  // toward revenue too, in full, as of the booking's return date —
  // forfeiting only ever happens against a deposit already collected up
  // front, so it's never partly unpaid. Held deposits stay excluded as a
  // liability.
  const forfeitedByApp = new Map();
  getForfeitedDeposits().forEach(d => {
    if (d.vehicle_id !== Number(req.params.id)) return;
    forfeitedByApp.set(d.application_id, (forfeitedByApp.get(d.application_id) || 0) + Number(d.forfeited_amount));
  });
  const collectedByApp = new Map();
  getCollectedRevenueDays().forEach(d => {
    if (d.vehicle_id !== Number(req.params.id)) return;
    collectedByApp.set(d.application_id, (collectedByApp.get(d.application_id) || 0) + d.amount);
  });
  const applications = db.prepare(`
    SELECT * FROM applications a
    WHERE a.assigned_vehicle_id = ? AND a.status != 'rejected'
  `).all(req.params.id);
  const bookings = applications.map(a => {
    const pickup = a.pickup_scheduled_at || null;
    const dropoff = a.rental_end_at || null;
    let days = 0;
    if (pickup && dropoff) {
      days = Math.round((new Date(dropoff) - new Date(pickup)) / 86400000);
    }
    const forfeited = forfeitedByApp.get(a.id) || 0;
    const revenue = Math.round(((collectedByApp.get(a.id) || 0) + forfeited) * 100) / 100;
    // Outstanding is the revenue-eligible portion of the invoice not yet
    // paid for — computed against the same summed `revenue` figure above
    // (not re-derived independently) so the two always add up exactly to
    // what the booking would earn if paid in full, with no rounding drift
    // between them. Forfeited has no outstanding side, since forfeiting
    // only ever happens against a deposit already collected up front.
    const outstanding = Math.round((computeRevenueEligible(a) - (collectedByApp.get(a.id) || 0)) * 100) / 100;
    return {
      applicant: `${a.first_name} ${a.last_name}`,
      pickup,
      dropoff,
      days,
      revenue,
      outstanding,
    };
  });

  // An insurance payout is money the vehicle actually earned back on a claim
  // — counted as revenue, same as the Revenue by Vehicle report treats it.
  // The deductible paid to file that claim is counted as an expense the same
  // way, so this tab's Profit always matches that report's.
  const claimPayouts = db.prepare(`
    SELECT id, incident_type, damage_reported_at, payout_date, insurance_payout, deductible_amount
    FROM claims
    WHERE vehicle_id = ? AND insurance_payout IS NOT NULL
    ORDER BY payout_date DESC
  `).all(req.params.id);
  const claimPayoutTotal = Math.round(claimPayouts.reduce((sum, c) => sum + Number(c.insurance_payout), 0) * 100) / 100;
  const claimDeductibleTotal = Math.round((db.prepare(`
    SELECT COALESCE(SUM(deductible_amount), 0) as total FROM claims WHERE vehicle_id = ? AND deductible_amount IS NOT NULL
  `).get(req.params.id).total) * 100) / 100;

  // A vehicle sale is its own revenue category too, same treatment as an
  // insurance payout — money the vehicle actually brought in, just not from
  // renting it out.
  const saleAmount = Math.round((Number(vehicle.sale_amount) || 0) * 100) / 100;

  const totalRevenue = Math.round((bookings.reduce((sum, b) => sum + b.revenue, 0) + claimPayoutTotal + saleAmount) * 100) / 100;
  // Tolls are excluded from expense — they're a pass-through cost recovered
  // from the customer, not money actually lost on the vehicle (see
  // isTollRecord below; the same records still show up in the Maintenance
  // log and the dedicated Toll Report, just not dragging down Profit here).
  const maintenanceTotal = Math.round(maintenance.filter(m => !isTollRecord(m)).reduce((sum, m) => sum + (Number(m.cost) || 0), 0) * 100) / 100;
  const businessExpenseTotal = Math.round(businessExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0) * 100) / 100;
  const totalExpense = Math.round((maintenanceTotal + businessExpenseTotal + claimDeductibleTotal) * 100) / 100;
  // Profit = revenue minus everything spent on the vehicle — both what it cost
  // to acquire (purchase price) and what's been spent on it since (maintenance).
  // Can go negative if the vehicle hasn't earned back what was put into it yet.
  const totalProfit = Math.round((totalRevenue - (Number(vehicle.purchase_price) || 0) - totalExpense) * 100) / 100;
  const lastServicedRow = maintenance.find(m => m.performed_at);
  const lastServiced = lastServicedRow ? lastServicedRow.performed_at : null;

  res.json({
    ...withOilChangeStatus(vehicle, getLastOilChangeByVehicle()),
    photos,
    maintenance,
    businessExpenses,
    bookings,
    claimPayouts,
    claimPayoutTotal,
    claimDeductibleTotal,
    totalRevenue,
    totalExpense,
    maintenanceTotal,
    businessExpenseTotal,
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
    sale_amount, sale_date,
  } = req.body;
  if (!make || !model || !year || !weekly_rate) {
    return res.status(400).json({ error: 'Make, model, year, and weekly rate are required' });
  }
  const result = db.prepare(`
    INSERT INTO vehicles (
      make, model, year, weekly_rate, notes, status,
      stock_number, license_plate, vin, color, vehicle_class,
      purchase_date, purchase_price, mileage, purchase_mileage, sale_amount, sale_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    make, model, year, weekly_rate, notes || null, status || 'available',
    stock_number || null, license_plate || null, vin || null, color || null, vehicle_class || null,
    purchase_date || null, purchase_price || null, mileage || null, purchase_mileage || null,
    sale_amount || null, sale_date || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = [
    'make', 'model', 'year', 'weekly_rate', 'status', 'notes', 'vin', 'license_plate', 'color', 'fuel_type', 'transmission',
    'stock_number', 'vehicle_class', 'purchase_date', 'purchase_price', 'mileage', 'purchase_mileage', 'next_service_at',
    'sale_amount', 'sale_date',
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

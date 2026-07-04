const express = require('express');
const { db, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ACTIVE_STATUSES = ['open', 'in_progress'];

const DOWNTIME_SELECT = `
  SELECT d.*, v.make, v.model, v.year, v.color, v.license_plate
  FROM downtime_events d
  JOIN vehicles v ON v.id = d.vehicle_id
`;

// A downtime event with "remove from availability" on takes the vehicle out
// of service while it's actively open, and hands it back once the event is
// snoozed/closed — but only if the vehicle is still sitting in the
// `maintenance` state this event (or one like it) put it in, and never by
// pulling a vehicle out from under an active rental.
function syncVehicleAvailability(vehicleId, removeFromAvailability, status) {
  if (!removeFromAvailability) return;
  const vehicle = db.prepare('SELECT status FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) return;
  const active = ACTIVE_STATUSES.includes(status);
  if (active && vehicle.status === 'available') {
    db.prepare("UPDATE vehicles SET status = 'maintenance' WHERE id = ?").run(vehicleId);
  } else if (!active && vehicle.status === 'maintenance') {
    db.prepare("UPDATE vehicles SET status = 'available' WHERE id = ?").run(vehicleId);
  }
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`${DOWNTIME_SELECT} ORDER BY d.date_reported DESC, d.id DESC`).all();
  res.json(rows);
});

router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare(`${DOWNTIME_SELECT} WHERE d.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requireAuth, (req, res) => {
  const {
    vehicle_id, service_type, status, date_reported, clearance_eta,
    vendor, est_cost, notes, remove_from_availability,
  } = req.body;

  if (!vehicle_id) return res.status(400).json({ error: 'A vehicle is required' });
  if (!service_type) return res.status(400).json({ error: 'Service type is required' });
  if (!date_reported) return res.status(400).json({ error: 'Date reported is required' });
  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicle_id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  const removeFlag = remove_from_availability ? 1 : 0;
  const finalStatus = status || 'open';
  const result = db.prepare(`
    INSERT INTO downtime_events
      (vehicle_id, service_type, status, date_reported, clearance_eta, vendor, est_cost, notes, remove_from_availability)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vehicle_id, service_type, finalStatus, date_reported, clearance_eta || null,
    vendor || null, est_cost || null, notes || null, removeFlag
  );

  syncVehicleAvailability(vehicle_id, removeFlag, finalStatus);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM downtime_events WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const allowed = ['service_type', 'status', 'date_reported', 'clearance_eta', 'vendor', 'est_cost', 'notes', 'remove_from_availability'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(key === 'remove_from_availability' ? (req.body[key] ? 1 : 0) : (req.body[key] || null));
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE downtime_events SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const removeFlag = req.body.remove_from_availability !== undefined ? (req.body.remove_from_availability ? 1 : 0) : existing.remove_from_availability;
  const newStatus = req.body.status || existing.status;
  syncVehicleAvailability(existing.vehicle_id, removeFlag, newStatus);

  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM downtime_events WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  logUndo('downtime_delete', `Deleted downtime event for ${record.service_type}`, { record });
  db.prepare('DELETE FROM downtime_events WHERE id = ?').run(req.params.id);
  syncVehicleAvailability(record.vehicle_id, record.remove_from_availability, 'closed');
  res.json({ ok: true });
});

module.exports = router;

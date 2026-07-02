const express = require('express');
const { db, logActivity, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CLAIM_SELECT = `
  SELECT cl.*, v.make, v.model, v.year, v.color, v.license_plate,
         ir.carrier as insurance_carrier, ir.type as insurance_type,
         u.name as assigned_to_name,
         a.first_name as customer_first_name, a.last_name as customer_last_name
  FROM claims cl
  JOIN vehicles v ON v.id = cl.vehicle_id
  LEFT JOIN insurance_records ir ON ir.id = cl.insurance_record_id
  LEFT JOIN users u ON u.id = cl.assigned_to
  LEFT JOIN applications a ON a.id = cl.application_id
`;

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`${CLAIM_SELECT} ORDER BY cl.damage_reported_at DESC, cl.id DESC`).all();
  res.json(rows);
});

router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare(`${CLAIM_SELECT} WHERE cl.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', requireAuth, (req, res) => {
  const {
    vehicle_id, application_id, insurance_record_id, assigned_to,
    status, detailed_status, incident_type, external_reference_id,
    event_source, damage_notes, damage_reported_at, next_task,
  } = req.body;

  if (!vehicle_id) return res.status(400).json({ error: 'A vehicle is required' });
  if (!incident_type) return res.status(400).json({ error: 'Claim incident type is required' });
  const vehicle = db.prepare('SELECT id FROM vehicles WHERE id = ?').get(vehicle_id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  const result = db.prepare(`
    INSERT INTO claims
      (vehicle_id, application_id, insurance_record_id, assigned_to, status, detailed_status,
       incident_type, external_reference_id, event_source, damage_notes, damage_reported_at, next_task)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vehicle_id, application_id || null, insurance_record_id || null, assigned_to || null,
    status || 'initial_claim', detailed_status || null, incident_type,
    external_reference_id || null, event_source || null, damage_notes || null,
    damage_reported_at || new Date().toISOString().slice(0, 10), next_task || null
  );

  if (application_id) {
    logActivity(application_id, `Claim #${result.lastInsertRowid} opened for damage — ${incident_type}`);
  }
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = [
    'application_id', 'insurance_record_id', 'assigned_to', 'status', 'detailed_status',
    'incident_type', 'external_reference_id', 'event_source', 'damage_notes',
    'damage_reported_at', 'next_task',
  ];
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
  const result = db.prepare(`UPDATE claims SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Not found' });
  logUndo('claim_delete', `Deleted claim #${claim.id}`, { claim });
  db.prepare('DELETE FROM claims WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

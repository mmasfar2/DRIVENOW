const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, a.first_name, a.last_name
    FROM messages_outbox m
    LEFT JOIN applications a ON a.id = m.application_id
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

module.exports = router;

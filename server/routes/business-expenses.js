const express = require('express');
const { db, logUndo } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const { from, to, category } = req.query;
  let query = 'SELECT * FROM business_expenses';
  const clauses = [];
  const params = [];
  if (from && to) {
    clauses.push('expense_date BETWEEN ? AND ?');
    params.push(from, to);
  }
  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (clauses.length) query += ' WHERE ' + clauses.join(' AND ');
  query += ' ORDER BY expense_date DESC, created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// Previously-used categories, for an autocomplete list on the form —
// category is free text, so this is how new ones show up as suggestions
// without any code change.
router.get('/categories', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT DISTINCT category FROM business_expenses ORDER BY category').all().map(r => r.category));
});

router.post('/', requireAuth, (req, res) => {
  const { category, amount, expense_date, notes } = req.body;
  if (!category || !category.trim()) return res.status(400).json({ error: 'A category is required' });
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid amount is required' });
  if (!expense_date) return res.status(400).json({ error: 'A date is required' });
  const result = db.prepare(`
    INSERT INTO business_expenses (category, amount, expense_date, notes)
    VALUES (?, ?, ?, ?)
  `).run(category.trim(), Number(amount), expense_date, notes || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/:id', requireAuth, (req, res) => {
  const allowed = ['category', 'amount', 'expense_date', 'notes'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(req.params.id);
  const result = db.prepare(`UPDATE business_expenses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM business_expenses WHERE id = ?').get(req.params.id);
  if (!record) return res.status(404).json({ error: 'Not found' });
  logUndo('business_expense_delete', `Removed business expense: ${record.category} ($${record.amount})`, { record });
  db.prepare('DELETE FROM business_expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

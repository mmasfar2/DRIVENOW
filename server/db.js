const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'va', -- 'owner' | 'va'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  weekly_rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | reserved | rented | maintenance
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT,
  occupation TEXT,
  intended_use TEXT,
  license_path TEXT,
  insurance_path TEXT,
  consent_background INTEGER DEFAULT 0,

  stage INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active', -- active | rejected | completed

  -- Stage 2: Initial Screening
  screening_license_valid INTEGER,
  screening_age_ok INTEGER,
  screening_address_match INTEGER,
  screening_red_flags TEXT,
  screening_vehicle_available INTEGER,
  screening_notes TEXT,
  screening_decision TEXT, -- pass | reject
  rejection_reason TEXT,

  -- Stage 3: Background Check
  background_status TEXT, -- pending | approved | conditional | declined
  background_notes TEXT,

  -- Stage 4: Insurance Quote
  insurance_quote_amount REAL,
  insurance_notes TEXT,

  -- Stage 5: Quote Presentation
  assigned_vehicle_id INTEGER,
  weekly_rate REAL,
  total_due_at_pickup REAL,

  -- Stage 6: Agreement
  agreement_sent_at TEXT,
  agreement_signed_at TEXT,

  -- Stage 7: Invoice
  invoice_sent_at TEXT,
  invoice_amount REAL,

  -- Stage 8: Payment
  payment_status TEXT DEFAULT 'unpaid', -- unpaid | paid
  payment_amount REAL,
  payment_received_at TEXT,
  pickup_scheduled_at TEXT,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (assigned_vehicle_id) REFERENCES vehicles(id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS messages_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER,
  channel TEXT NOT NULL, -- sms | email
  to_value TEXT,
  body TEXT,
  status TEXT DEFAULT 'queued', -- queued | sent (real sending wired up Day 3)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);
`);

// Seed owner account if no users exist
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const defaultEmail = process.env.OWNER_EMAIL || 'mmasfar2@gmail.com';
  const defaultPassword = process.env.OWNER_PASSWORD || 'DriveNow2024!';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(defaultEmail, hash, 'Owner', 'owner');
  console.log(`Seeded owner account: ${defaultEmail} / ${defaultPassword} (change this password after first login)`);
}

// Seed fleet vehicles to match the public site if empty
const vehicleCount = db.prepare('SELECT COUNT(*) as c FROM vehicles').get().c;
if (vehicleCount === 0) {
  const seedVehicles = [
    ['Honda', 'Accord LX', 2013, 380, 'available'],
    ['Toyota', 'Camry SE', 2014, 370, 'available'],
    ['Honda', 'Accord Sport', 2015, 420, 'available'],
    ['Toyota', 'Camry LE', 2012, 350, 'available'],
    ['Honda', 'Accord EX', 2011, 350, 'available'],
    ['Toyota', 'Camry XSE', 2015, 450, 'available'],
  ];
  const insert = db.prepare('INSERT INTO vehicles (make, model, year, weekly_rate, status) VALUES (?, ?, ?, ?, ?)');
  seedVehicles.forEach(v => insert.run(...v));
}

function logActivity(applicationId, message) {
  db.prepare('INSERT INTO activity_log (application_id, message) VALUES (?, ?)').run(applicationId, message);
}

function queueMessage(applicationId, channel, to, body) {
  db.prepare('INSERT INTO messages_outbox (application_id, channel, to_value, body) VALUES (?, ?, ?, ?)')
    .run(applicationId, channel, to, body);
}

module.exports = { db, logActivity, queueMessage };

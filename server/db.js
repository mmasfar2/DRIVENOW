const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { DATA_DIR } = require('./paths');

const db = new Database(path.join(DATA_DIR, 'data.db'));
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
  license_number TEXT,
  license_state TEXT,
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

CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  cost REAL,
  performed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  desired_vehicle TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | contacted | fulfilled | cancelled
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  paid_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS maintenance_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_id INTEGER NOT NULL,
  photo_path TEXT NOT NULL,
  caption TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (maintenance_id) REFERENCES vehicle_maintenance(id)
);

CREATE TABLE IF NOT EXISTS vehicle_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  photo_path TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);
`);

// Lightweight migration: add columns introduced after initial release
const existingCols = db.prepare("PRAGMA table_info(applications)").all().map(c => c.name);
if (!existingCols.includes('license_number')) {
  db.exec('ALTER TABLE applications ADD COLUMN license_number TEXT');
}
if (!existingCols.includes('license_state')) {
  db.exec('ALTER TABLE applications ADD COLUMN license_state TEXT');
}
if (!existingCols.includes('rental_end_at')) {
  db.exec('ALTER TABLE applications ADD COLUMN rental_end_at TEXT');
}
if (!existingCols.includes('source')) {
  db.exec("ALTER TABLE applications ADD COLUMN source TEXT DEFAULT 'public_form'");
}
if (!existingCols.includes('dob')) {
  db.exec('ALTER TABLE applications ADD COLUMN dob TEXT');
}
if (!existingCols.includes('insurance_private_path')) {
  db.exec('ALTER TABLE applications ADD COLUMN insurance_private_path TEXT');
}

if (!existingCols.includes('odometer_out')) {
  db.exec('ALTER TABLE applications ADD COLUMN odometer_out REAL');
}
if (!existingCols.includes('odometer_in')) {
  db.exec('ALTER TABLE applications ADD COLUMN odometer_in REAL');
}
if (!existingCols.includes('pickup_location')) {
  db.exec('ALTER TABLE applications ADD COLUMN pickup_location TEXT');
}
if (!existingCols.includes('dropoff_location')) {
  db.exec('ALTER TABLE applications ADD COLUMN dropoff_location TEXT');
}
if (!existingCols.includes('vehicle_class')) {
  db.exec('ALTER TABLE applications ADD COLUMN vehicle_class TEXT');
}
if (!existingCols.includes('state')) {
  db.exec('ALTER TABLE applications ADD COLUMN state TEXT');
}
if (!existingCols.includes('has_own_insurance')) {
  db.exec('ALTER TABLE applications ADD COLUMN has_own_insurance INTEGER');
}
if (!existingCols.includes('use_type')) {
  db.exec("ALTER TABLE applications ADD COLUMN use_type TEXT");
}
if (!existingCols.includes('lead_decision')) {
  db.exec("ALTER TABLE applications ADD COLUMN lead_decision TEXT"); // 'approved' | 'rejected'
}
if (!existingCols.includes('lead_decided_at')) {
  db.exec('ALTER TABLE applications ADD COLUMN lead_decided_at TEXT');
}
if (!existingCols.includes('city')) {
  db.exec('ALTER TABLE applications ADD COLUMN city TEXT');
}
if (!existingCols.includes('rental_duration')) {
  db.exec('ALTER TABLE applications ADD COLUMN rental_duration TEXT');
}
if (!existingCols.includes('notes')) {
  db.exec('ALTER TABLE applications ADD COLUMN notes TEXT');
}

const vehicleCols = db.prepare("PRAGMA table_info(vehicles)").all().map(c => c.name);
if (!vehicleCols.includes('photo_path')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN photo_path TEXT');
}
if (!vehicleCols.includes('vin')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN vin TEXT');
}
if (!vehicleCols.includes('license_plate')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN license_plate TEXT');
}
if (!vehicleCols.includes('color')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN color TEXT');
}
if (!vehicleCols.includes('fuel_type')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN fuel_type TEXT');
}
if (!vehicleCols.includes('transmission')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN transmission TEXT');
}
if (!vehicleCols.includes('stock_number')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN stock_number TEXT');
}
if (!vehicleCols.includes('vehicle_class')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN vehicle_class TEXT');
}
if (!vehicleCols.includes('purchase_date')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN purchase_date TEXT');
}
if (!vehicleCols.includes('purchase_price')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN purchase_price REAL');
}
if (!vehicleCols.includes('mileage')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN mileage REAL');
}

db.exec(`
CREATE TABLE IF NOT EXISTS booking_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  dob TEXT,
  blacklisted INTEGER DEFAULT 0,
  internal_notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
`);

const customerCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
if (!customerCols.includes('city')) {
  db.exec('ALTER TABLE customers ADD COLUMN city TEXT');
}
if (!customerCols.includes('state')) {
  db.exec('ALTER TABLE customers ADD COLUMN state TEXT');
}
if (!customerCols.includes('zip_code')) {
  db.exec('ALTER TABLE customers ADD COLUMN zip_code TEXT');
}
if (!customerCols.includes('dob')) {
  db.exec('ALTER TABLE customers ADD COLUMN dob TEXT');
}
if (!customerCols.includes('blacklisted')) {
  db.exec('ALTER TABLE customers ADD COLUMN blacklisted INTEGER DEFAULT 0');
}
if (!customerCols.includes('internal_notes')) {
  db.exec('ALTER TABLE customers ADD COLUMN internal_notes TEXT');
}

// Backfill: build a customers record for every distinct email already in
// applications, so existing leads/bookings get a profile retroactively.
const existingCustomerEmails = new Set(db.prepare('SELECT lower(email) as e FROM customers').all().map(r => r.e));
const distinctApplicants = db.prepare(`
  SELECT first_name, last_name, phone, email, address, dob, MIN(created_at) as first_seen
  FROM applications
  WHERE email IS NOT NULL AND email != ''
  GROUP BY lower(email)
`).all();
const insertCustomer = db.prepare(`
  INSERT INTO customers (email, first_name, last_name, phone, address, dob, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
for (const a of distinctApplicants) {
  if (existingCustomerEmails.has(a.email.toLowerCase())) continue;
  insertCustomer.run(a.email, a.first_name, a.last_name, a.phone, a.address || null, a.dob || null, a.first_seen);
}

// Backfill: fill in any missing contact details on existing customer records
// from their most recent application, now that the apply form sends city/state/dob.
const customersMissingDetails = db.prepare(`
  SELECT id, lower(email) as email FROM customers
  WHERE city IS NULL OR state IS NULL OR dob IS NULL OR address IS NULL OR phone IS NULL
`).all();
const latestApplicationByEmail = db.prepare(`
  SELECT city, state, dob, address, phone FROM applications WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1
`);
const updateCustomerDetails = db.prepare(`
  UPDATE customers SET
    city = COALESCE(city, ?),
    state = COALESCE(state, ?),
    dob = COALESCE(dob, ?),
    address = COALESCE(address, ?),
    phone = COALESCE(phone, ?)
  WHERE id = ?
`);
for (const c of customersMissingDetails) {
  const app = latestApplicationByEmail.get(c.email);
  if (!app) continue;
  updateCustomerDetails.run(app.city || null, app.state || null, app.dob || null, app.address || null, app.phone || null, c.id);
}

function upsertCustomer({ email, first_name, last_name, phone, address, city, state, zip_code, dob }) {
  if (!email) return;
  const existing = db.prepare('SELECT id FROM customers WHERE lower(email) = lower(?)').get(email);
  if (existing) {
    db.prepare(`
      UPDATE customers SET
        city = COALESCE(city, ?),
        state = COALESCE(state, ?),
        zip_code = COALESCE(zip_code, ?),
        address = COALESCE(address, ?),
        dob = COALESCE(dob, ?),
        phone = COALESCE(phone, ?)
      WHERE id = ?
    `).run(city || null, state || null, zip_code || null, address || null, dob || null, phone || null, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO customers (email, first_name, last_name, phone, address, city, state, zip_code, dob)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(email, first_name || null, last_name || null, phone || null, address || null, city || null, state || null, zip_code || null, dob || null);
  return result.lastInsertRowid;
}

// Backfill: any vehicle with a legacy single photo_path but no rows yet in
// vehicle_photos gets that photo carried over so it isn't lost.
const vehiclesWithLegacyPhoto = db.prepare(`
  SELECT id, photo_path FROM vehicles
  WHERE photo_path IS NOT NULL
    AND id NOT IN (SELECT DISTINCT vehicle_id FROM vehicle_photos)
`).all();
for (const v of vehiclesWithLegacyPhoto) {
  db.prepare('INSERT INTO vehicle_photos (vehicle_id, photo_path) VALUES (?, ?)').run(v.id, v.photo_path);
}

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

module.exports = { db, logActivity, queueMessage, upsertCustomer };

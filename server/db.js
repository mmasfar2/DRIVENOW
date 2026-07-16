const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const { DATA_DIR } = require('./paths');
const { computeCharge, computeRevenueEligible, SALES_TAX_RATE, HIGHWAY_TAX_RATE } = require('./billing');

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

-- General business overhead that isn't tied to any one vehicle (card
-- processing fees absorbed rather than billed to the customer, software
-- subscriptions, insurance premiums, etc.) — kept separate from
-- vehicle_maintenance on purpose, since that table only ever means
-- "spent on this specific car." category is free text, not an enum, so
-- new expense types don't need a code change to start using.
CREATE TABLE IF NOT EXISTS business_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
  method TEXT NOT NULL DEFAULT 'cash', -- cash | card | swipe
  processing_fee REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash', -- cash | card
  processing_fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'held', -- held | resolved
  collected_at TEXT NOT NULL,
  refunded_amount REAL NOT NULL DEFAULT 0,
  forfeited_amount REAL NOT NULL DEFAULT 0,
  resolved_at TEXT,
  notes TEXT,
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
if (!existingCols.includes('customer_id')) {
  // A direct link, set once at booking-creation time (see upsertCustomer's
  // call sites in applications.js) instead of re-guessing which customer a
  // booking belongs to by matching email/name/address every time it's
  // displayed. Guessing at read time meant a booking with neither an email
  // nor an address on file (common on a quick walk-in) could never be
  // found again even though a customer record for it definitely exists —
  // this is set once, right when we actually know the answer, and never
  // needs to be re-derived.
  db.exec('ALTER TABLE applications ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
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
if (!existingCols.includes('gas_level_out')) {
  db.exec('ALTER TABLE applications ADD COLUMN gas_level_out TEXT');
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
if (!existingCols.includes('zip_code')) {
  db.exec('ALTER TABLE applications ADD COLUMN zip_code TEXT');
}
if (!existingCols.includes('admin_fee_rate')) {
  db.exec('ALTER TABLE applications ADD COLUMN admin_fee_rate REAL'); // daily rate
}
if (!existingCols.includes('travel_fee')) {
  db.exec('ALTER TABLE applications ADD COLUMN travel_fee REAL'); // flat, one-time
}
if (!existingCols.includes('insurance_fee_rate')) {
  db.exec('ALTER TABLE applications ADD COLUMN insurance_fee_rate REAL'); // daily rate
}
if (!existingCols.includes('security_deposit')) {
  // Not a fee — an amount to collect and hold as a refundable liability at
  // pickup. If set when a booking is created, a `deposits` row is seeded
  // automatically (see POST /manual-booking) so it shows up in the
  // reservation's Security Deposit panel ready to resolve, without the front
  // desk having to separately click "Collect Deposit" after the fact.
  db.exec('ALTER TABLE applications ADD COLUMN security_deposit REAL');
}
if (!existingCols.includes('processing_fee')) {
  db.exec('ALTER TABLE applications ADD COLUMN processing_fee REAL'); // flat, one-time — 2.75% of the invoice when enabled
}
if (!existingCols.includes('discount')) {
  // Stored (not session-only) so the Financials tab's Discount checkbox
  // reflects what was actually saved instead of resetting to unchecked/0 on
  // every reload — a positive dollar amount, subtracted from the charge.
  db.exec('ALTER TABLE applications ADD COLUMN discount REAL');
}
if (!existingCols.includes('misc_fee')) {
  // Flat, one-time, same shape as travel_fee. Counts toward revenue like
  // Admin/Travel Fee — a generic catch-all charge, not a pass-through cost.
  db.exec('ALTER TABLE applications ADD COLUMN misc_fee REAL');
}
if (!existingCols.includes('toll_fee')) {
  // Flat, one-time — a toll billed to the customer on this specific
  // invoice (separate from the vehicle_maintenance toll log used for
  // fleet-wide toll tracking). Excluded from revenue, same "surplus, not
  // profit" treatment as every other toll and Insurance Fee.
  db.exec('ALTER TABLE applications ADD COLUMN toll_fee REAL');
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
if (!vehicleCols.includes('next_service_at')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN next_service_at TEXT');
}
if (!vehicleCols.includes('purchase_mileage')) {
  db.exec('ALTER TABLE vehicles ADD COLUMN purchase_mileage REAL');
}

const maintenanceCols = db.prepare("PRAGMA table_info(vehicle_maintenance)").all().map(c => c.name);
if (!maintenanceCols.includes('category')) {
  db.exec('ALTER TABLE vehicle_maintenance ADD COLUMN category TEXT');
}

const businessExpenseCols = db.prepare("PRAGMA table_info(business_expenses)").all().map(c => c.name);
if (!businessExpenseCols.includes('payment_id')) {
  // Set only on expense rows auto-generated from a "Payment through Swipe"
  // payment, so editing/deleting that payment can find and keep its
  // absorbed-fee expense entry in sync instead of leaving it orphaned.
  db.exec('ALTER TABLE business_expenses ADD COLUMN payment_id INTEGER');
}
if (!businessExpenseCols.includes('vehicle_id')) {
  // Set automatically for swipe-triggered expenses (traced through
  // payment -> application -> assigned_vehicle_id), so that specific cost
  // can show up against the vehicle it actually came from in Vehicle
  // Detail / Revenue by Vehicle, not just the fleet-wide total. Left null
  // for manually-logged expenses that aren't tied to one car (most of
  // them — subscriptions, misc overhead, etc.).
  db.exec('ALTER TABLE business_expenses ADD COLUMN vehicle_id INTEGER');
}
// Backfill vehicle_id on swipe-triggered expenses created before that column
// existed — traces the same payment -> application -> assigned_vehicle_id
// path syncSwipeExpense now sets automatically going forward. Only ever
// touches rows still missing it, so this is a no-op once caught up.
db.exec(`
  UPDATE business_expenses
  SET vehicle_id = (
    SELECT a.assigned_vehicle_id
    FROM payments p JOIN applications a ON a.id = p.application_id
    WHERE p.id = business_expenses.payment_id
  )
  WHERE vehicle_id IS NULL AND payment_id IS NOT NULL
`);
// Swipe-triggered expenses are dated to wherever the booking's cumulative
// payments actually reach in the same day-by-day FIFO walk getAccruedRevenueDays
// uses for revenue — not whenever the payment happened to be logged, and not
// a fixed field, so the fee lands on the same day its revenue does. Matters
// when backfilling old bookings entered well after the fact, and for partial
// payments on still-active bookings that shouldn't land on a future date.
// applications.js's syncSwipeExpense sets this correctly going forward; this
// re-derives it for every swipe-linked row on every startup (cheap, and safe
// to re-run since it recomputes the same answer) so edits to a booking's
// dates or payments stay in sync too.
{
  const frontierByApp = new Map();
  getAccruedRevenueDays().forEach(d => {
    if (d.amount > 0) frontierByApp.set(d.application_id, d.date);
  });
  const rows = db.prepare(`
    SELECT be.id, p.application_id, a.rental_end_at, a.pickup_scheduled_at
    FROM business_expenses be
    JOIN payments p ON p.id = be.payment_id
    JOIN applications a ON a.id = p.application_id
    WHERE be.payment_id IS NOT NULL
  `).all();
  const updExpenseDate = db.prepare('UPDATE business_expenses SET expense_date = ? WHERE id = ?');
  rows.forEach(r => {
    const date = frontierByApp.get(r.application_id)
      || (r.rental_end_at || r.pickup_scheduled_at || '').slice(0, 10);
    if (date) updExpenseDate.run(date, r.id);
  });
}

const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map(c => c.name);
if (!paymentCols.includes('method')) {
  db.exec("ALTER TABLE payments ADD COLUMN method TEXT NOT NULL DEFAULT 'cash'");
}
if (!paymentCols.includes('processing_fee')) {
  db.exec('ALTER TABLE payments ADD COLUMN processing_fee REAL NOT NULL DEFAULT 0');
}

db.exec(`
CREATE TABLE IF NOT EXISTS undo_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Sessions live on the same persistent disk as the rest of the data, so a
-- logged-in user stays logged in across a server restart/redeploy — the
-- default express-session MemoryStore is wiped on every restart, which is
-- what was producing stray "Not authenticated" errors mid-session.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

function logUndo(entityType, label, payload) {
  db.prepare('DELETE FROM undo_log').run();
  db.prepare('INSERT INTO undo_log (entity_type, label, payload) VALUES (?, ?, ?)').run(entityType, label, JSON.stringify(payload));
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
if (!customerCols.includes('license_number')) {
  db.exec('ALTER TABLE customers ADD COLUMN license_number TEXT');
}
if (!customerCols.includes('insurance_company')) {
  db.exec('ALTER TABLE customers ADD COLUMN insurance_company TEXT');
}
if (!customerCols.includes('insurance_policy_number')) {
  db.exec('ALTER TABLE customers ADD COLUMN insurance_policy_number TEXT');
}

// customers.email used to be NOT NULL, which forced a fake placeholder
// address (walkin-<phone>@no-email.drivenow) onto walk-in customers who
// never gave a real one — SQLite can't drop a NOT NULL constraint in place,
// so rebuild the table without it. UNIQUE still holds; SQLite allows
// multiple NULLs under a UNIQUE constraint, so any number of no-email
// customers can coexist. Column list built from PRAGMA (not hardcoded) so
// this can't silently shuffle data into the wrong columns if the schema
// has drifted from what's read here.
const emailColInfo = db.prepare("PRAGMA table_info(customers)").all().find(c => c.name === 'email');
if (emailColInfo && emailColInfo.notnull) {
  const cols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name).join(', ');
  db.exec(`
    CREATE TABLE customers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      license_number TEXT,
      insurance_company TEXT,
      insurance_policy_number TEXT
    );
    INSERT INTO customers_new (${cols}) SELECT ${cols} FROM customers;
    DROP TABLE customers;
    ALTER TABLE customers_new RENAME TO customers;
  `);
}
// Any placeholder emails written before real NULL was possible (see #86) —
// convert them back now that the column actually allows it.
db.prepare("UPDATE customers SET email = NULL WHERE email LIKE 'walkin-%@no-email.drivenow'").run();

// One-time backfill: strip punctuation/spacing from existing phone numbers.
// Phone is no longer used to match/dedupe customers (two different people —
// family, a shared business line — can share one phone number, which made
// phone-based matching merge them together), but it's still worth keeping
// clean for display and contact purposes. Cheap to re-run — already-clean
// digits-only values are a no-op.
db.exec(`
  UPDATE customers SET phone = replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '')
  WHERE phone IS NOT NULL AND phone GLOB '*[^0-9]*'
`);
db.exec(`
  UPDATE applications SET phone = replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '')
  WHERE phone IS NOT NULL AND phone GLOB '*[^0-9]*'
`);

// One-time cleanup: consolidate existing customer records that share the
// same identity into one — likely genuine duplicates from before
// upsertCustomer matched this way (e.g. the same walk-in registered twice
// under slightly different emails, or with none at all, on separate
// visits). Two passes: name+address (both non-blank), then — for records
// with no address on file at all — name+phone, which is just as safe a
// signal since two different people essentially never share both an exact
// full name and a phone number. Keeps whichever record already has an
// email (oldest, if more than one does), re-points customer_tags,
// insurance_records, AND any application already directly linked via
// customer_id to that survivor (skipping this would leave those bookings
// pointing at a row that's about to be deleted, silently dropping them off
// the customer's profile), fills in any fields the survivor is missing via
// COALESCE, then removes the redundant rows. Safe to leave running on every
// startup — once a group resolves to a single row, it has nothing left to
// merge, so this is a no-op after the first pass.
function mergeCustomerDuplicates(groups, findGroupRows) {
  const updateSurvivor = db.prepare(`
    UPDATE customers SET
      email = COALESCE(email, ?), phone = COALESCE(phone, ?),
      city = COALESCE(city, ?), state = COALESCE(state, ?),
      zip_code = COALESCE(zip_code, ?), dob = COALESCE(dob, ?), license_number = COALESCE(license_number, ?),
      insurance_company = COALESCE(insurance_company, ?), insurance_policy_number = COALESCE(insurance_policy_number, ?)
    WHERE id = ?
  `);
  for (const g of groups) {
    const rows = findGroupRows(g);
    const [survivor, ...duplicates] = rows;
    for (const dup of duplicates) {
      updateSurvivor.run(
        dup.email, dup.phone, dup.city, dup.state,
        dup.zip_code, dup.dob, dup.license_number, dup.insurance_company, dup.insurance_policy_number,
        survivor.id
      );
      db.prepare('UPDATE customer_tags SET customer_id = ? WHERE customer_id = ?').run(survivor.id, dup.id);
      db.prepare('UPDATE insurance_records SET customer_id = ? WHERE customer_id = ?').run(survivor.id, dup.id);
      db.prepare('UPDATE applications SET customer_id = ? WHERE customer_id = ?').run(survivor.id, dup.id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(dup.id);
    }
  }
}

mergeCustomerDuplicates(
  db.prepare(`
    SELECT lower(trim(first_name)) as fn, lower(trim(last_name)) as ln, lower(trim(address)) as addr
    FROM customers
    WHERE first_name IS NOT NULL AND first_name != '' AND last_name IS NOT NULL AND last_name != ''
      AND address IS NOT NULL AND address != ''
    GROUP BY fn, ln, addr
    HAVING COUNT(*) > 1
  `).all(),
  (g) => db.prepare(`
    SELECT * FROM customers
    WHERE lower(trim(first_name)) = ? AND lower(trim(last_name)) = ? AND lower(trim(address)) = ?
    ORDER BY (email IS NULL), created_at ASC
  `).all(g.fn, g.ln, g.addr)
);

mergeCustomerDuplicates(
  db.prepare(`
    SELECT lower(trim(first_name)) as fn, lower(trim(last_name)) as ln,
           replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') as ph
    FROM customers
    WHERE first_name IS NOT NULL AND first_name != '' AND last_name IS NOT NULL AND last_name != ''
      AND (address IS NULL OR trim(address) = '')
      AND phone IS NOT NULL AND phone != ''
    GROUP BY fn, ln, ph
    HAVING COUNT(*) > 1
  `).all(),
  (g) => db.prepare(`
    SELECT * FROM customers
    WHERE lower(trim(first_name)) = ? AND lower(trim(last_name)) = ?
      AND (address IS NULL OR trim(address) = '')
      AND replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') = ?
    ORDER BY (email IS NULL), created_at ASC
  `).all(g.fn, g.ln, g.ph)
);

db.exec(`
CREATE TABLE IF NOT EXISTS insurance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- 'private' | 'our_policy'
  carrier TEXT,
  protection_type TEXT,
  policy_number TEXT,
  document_path TEXT,
  last_verified_at TEXT,
  next_payment_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  application_id INTEGER, -- the booking during which the damage occurred, if known
  insurance_record_id INTEGER, -- which policy this claim is filed against
  assigned_to INTEGER, -- staff member (users.id) handling the claim
  status TEXT NOT NULL DEFAULT 'initial_claim', -- initial_claim | pending_payment | closed | collections
  detailed_status TEXT,
  incident_type TEXT,
  external_reference_id TEXT,
  event_source TEXT,
  damage_notes TEXT,
  damage_reported_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deductible_amount REAL,
  max_out_of_pocket REAL,
  vehicle_location TEXT,
  mark_vehicle_inactive INTEGER NOT NULL DEFAULT 0,
  next_task TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
  FOREIGN KEY (application_id) REFERENCES applications(id),
  FOREIGN KEY (insurance_record_id) REFERENCES insurance_records(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);
`);

const claimCols = db.prepare("PRAGMA table_info(claims)").all().map(c => c.name);
if (!claimCols.includes('deductible_amount')) {
  db.exec('ALTER TABLE claims ADD COLUMN deductible_amount REAL');
}
if (!claimCols.includes('max_out_of_pocket')) {
  db.exec('ALTER TABLE claims ADD COLUMN max_out_of_pocket REAL');
}
if (!claimCols.includes('vehicle_location')) {
  db.exec('ALTER TABLE claims ADD COLUMN vehicle_location TEXT');
}
if (!claimCols.includes('mark_vehicle_inactive')) {
  db.exec('ALTER TABLE claims ADD COLUMN mark_vehicle_inactive INTEGER NOT NULL DEFAULT 0');
}

const insuranceCols = db.prepare("PRAGMA table_info(insurance_records)").all().map(c => c.name);
if (!insuranceCols.includes('status')) {
  db.exec("ALTER TABLE insurance_records ADD COLUMN status TEXT NOT NULL DEFAULT 'Active'");
}

db.exec(`
CREATE TABLE IF NOT EXISTS downtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER NOT NULL,
  service_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | snoozed | closed
  date_reported TEXT NOT NULL,
  clearance_eta TEXT,
  vendor TEXT,
  est_cost REAL,
  notes TEXT,
  remove_from_availability INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);
`);

// Backfill: build a customers record for every distinct applicant that
// isn't linked to one yet (grouped by email, or name+address, or — when
// there's no address on file at all — name+phone, same identity rule as
// upsertCustomer), so legacy leads/bookings that predate the customer_id
// column get a profile retroactively. Scoped to customer_id IS NULL — every
// application created since customer_id shipped already got linked directly
// at creation time, so re-running upsertCustomer on those rows on every
// startup would just mint a fresh duplicate customer for anyone with no
// email and no address on file.
const distinctApplicants = db.prepare(`
  SELECT first_name, last_name, phone, email, address, dob, MIN(created_at) as first_seen
  FROM applications
  WHERE customer_id IS NULL
  GROUP BY COALESCE(
    NULLIF(lower(email), ''),
    CASE WHEN address IS NOT NULL AND trim(address) != ''
         THEN lower(trim(first_name)) || '|' || lower(trim(last_name)) || '|addr|' || lower(trim(address))
         ELSE lower(trim(first_name)) || '|' || lower(trim(last_name)) || '|ph|' ||
              replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '')
    END
  )
`).all();
for (const a of distinctApplicants) {
  upsertCustomer(a);
}

// Backfill: link every existing application directly to its customer via
// the same email, or name+address, or — when there's no address on file at
// all — name+phone matching rule, so the direct customer_id link (added
// above) isn't only populated for bookings created after this shipped.
// Only touches rows still missing it.
db.exec(`
  UPDATE applications SET customer_id = (
    SELECT c.id FROM customers c
    WHERE (applications.email != '' AND c.email IS NOT NULL AND lower(c.email) = lower(applications.email))
       OR (
         c.address IS NOT NULL AND c.address != '' AND applications.address IS NOT NULL AND applications.address != ''
         AND lower(trim(c.first_name)) = lower(trim(applications.first_name))
         AND lower(trim(c.last_name)) = lower(trim(applications.last_name))
         AND lower(trim(c.address)) = lower(trim(applications.address))
       )
       OR (
         (c.address IS NULL OR trim(c.address) = '') AND (applications.address IS NULL OR trim(applications.address) = '')
         AND lower(trim(c.first_name)) = lower(trim(applications.first_name))
         AND lower(trim(c.last_name)) = lower(trim(applications.last_name))
         AND c.phone IS NOT NULL AND c.phone != '' AND applications.phone IS NOT NULL AND applications.phone != ''
         AND replace(replace(replace(replace(replace(c.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') =
             replace(replace(replace(replace(replace(applications.phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '')
       )
    LIMIT 1
  )
  WHERE customer_id IS NULL
`);

// Backfill: fill in any missing contact details on existing customer records
// from their most recent application, now that the apply form sends city/state/dob.
const customersMissingDetails = db.prepare(`
  SELECT id, lower(email) as email FROM customers
  WHERE city IS NULL OR state IS NULL OR dob IS NULL OR address IS NULL OR phone IS NULL OR zip_code IS NULL
`).all();
const latestApplicationByEmail = db.prepare(`
  SELECT city, state, dob, address, phone, zip_code FROM applications WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1
`);
const updateCustomerDetails = db.prepare(`
  UPDATE customers SET
    city = COALESCE(city, ?),
    state = COALESCE(state, ?),
    dob = COALESCE(dob, ?),
    address = COALESCE(address, ?),
    phone = COALESCE(phone, ?),
    zip_code = COALESCE(zip_code, ?)
  WHERE id = ?
`);
for (const c of customersMissingDetails) {
  const app = latestApplicationByEmail.get(c.email);
  if (!app) continue;
  updateCustomerDetails.run(app.city || null, app.state || null, app.dob || null, app.address || null, app.phone || null, app.zip_code || null, c.id);
}

// Digits only — kept clean for display/contact purposes, but not used to
// match/dedupe customers (see upsertCustomer below): two different people
// can share one phone number (family, a shared business line), which would
// wrongly merge them.
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function normalizeText(s) {
  return (s || '').trim().toLowerCase();
}

// Matches by email when given (customers.email is nullable — a walk-in with
// no email at all just gets a NULL one instead of silently never being
// registered as a client), otherwise by name + address together. Phone
// alone is deliberately NOT used to match — two different people (family, a
// shared business line) can share one phone number, and matching on it
// would merge their bookings/billing together. But when there's no address
// on file at all (a common bare-minimum walk-in entry), name + phone
// together is the fallback: two different people sharing both an exact full
// name AND a phone number essentially never happens, so this is as safe as
// name + address while still covering the case address can't.
function upsertCustomer({ email, first_name, last_name, phone, address, city, state, zip_code, dob, license_number }) {
  const realEmail = (email || '').trim();
  const firstKey = normalizeText(first_name);
  const lastKey = normalizeText(last_name);
  const addressKey = normalizeText(address);
  const phoneKey = normalizePhone(phone);
  const hasNameAddress = !!(firstKey && lastKey && addressKey);
  const hasNamePhone = !!(firstKey && lastKey && phoneKey);
  if (!first_name && !last_name) return; // no name at all — nothing to register

  let existing = realEmail
    ? db.prepare('SELECT id, email FROM customers WHERE lower(email) = lower(?)').get(realEmail)
    : null;
  if (!existing && hasNameAddress) {
    existing = db.prepare(`
      SELECT id, email FROM customers
      WHERE lower(trim(first_name)) = ? AND lower(trim(last_name)) = ? AND lower(trim(address)) = ?
    `).get(firstKey, lastKey, addressKey);
  }
  if (!existing && hasNamePhone) {
    existing = db.prepare(`
      SELECT id, email FROM customers
      WHERE lower(trim(first_name)) = ? AND lower(trim(last_name)) = ?
        AND (address IS NULL OR trim(address) = '')
        AND replace(replace(replace(replace(replace(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '.', '') = ?
    `).get(firstKey, lastKey, phoneKey);
  }
  const finalEmail = realEmail || (existing ? existing.email : null);

  if (existing) {
    db.prepare(`
      UPDATE customers SET
        email = COALESCE(?, email),
        city = COALESCE(city, ?),
        state = COALESCE(state, ?),
        zip_code = COALESCE(zip_code, ?),
        address = COALESCE(address, ?),
        dob = COALESCE(dob, ?),
        phone = COALESCE(phone, ?),
        license_number = COALESCE(license_number, ?)
      WHERE id = ?
    `).run(finalEmail, city || null, state || null, zip_code || null, address || null, dob || null, phone || null, license_number || null, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO customers (email, first_name, last_name, phone, address, city, state, zip_code, dob, license_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(finalEmail, first_name || null, last_name || null, phone || null, address || null, city || null, state || null, zip_code || null, dob || null, license_number || null);
  return result.lastInsertRowid;
}

// Keeps the Insurance panel in sync with intake — called whenever a public
// application, manual booking, or insurance-quote submission includes an
// insurance document/detail, so it shows up there without a separate manual
// entry step. One record per (customer, type); re-submitting only fills in
// gaps (via COALESCE) rather than overwriting anything an admin already
// edited from the Insurance panel itself.
function upsertInsuranceRecord(customerId, type, { document_path, notes, carrier, protection_type, policy_number } = {}) {
  if (!customerId || !type) return;
  const existing = db.prepare('SELECT id FROM insurance_records WHERE customer_id = ? AND type = ?').get(customerId, type);
  if (existing) {
    db.prepare(`
      UPDATE insurance_records SET
        document_path = COALESCE(?, document_path),
        notes = COALESCE(notes, ?),
        carrier = COALESCE(carrier, ?),
        protection_type = COALESCE(protection_type, ?),
        policy_number = COALESCE(policy_number, ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(document_path || null, notes || null, carrier || null, protection_type || null, policy_number || null, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO insurance_records (customer_id, type, document_path, notes, carrier, protection_type, policy_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(customerId, type, document_path || null, notes || null, carrier || null, protection_type || null, policy_number || null);
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

// Forfeited deposit amounts count as revenue once resolved — a held deposit
// stays a refundable liability, but the moment some (or all) of it is
// forfeited, that portion is real revenue and needs to show up everywhere
// revenue does (dashboard totals, Revenue reports, Vehicle Detail profit).
// Attributed to the booking's own return date (rental_end_at) — not
// resolved_at (whenever the resolve-deposit action actually happened, which
// could be days after the return if it wasn't processed right away) and not
// any check-in button click timestamp either. A booking's forfeiture always
// belongs to when the rental itself ended, regardless of when staff got
// around to marking it resolved in the system. Every revenue figure reads
// from this single query so a forfeiture can't show up in one place and not
// another.
function getForfeitedDeposits() {
  return db.prepare(`
    SELECT d.id, d.application_id, a.assigned_vehicle_id as vehicle_id, d.forfeited_amount, a.rental_end_at
    FROM deposits d JOIN applications a ON a.id = d.application_id
    WHERE d.status = 'resolved' AND d.forfeited_amount > 0
  `).all().map(d => ({
    id: d.id, application_id: d.application_id, vehicle_id: d.vehicle_id,
    forfeited_amount: d.forfeited_amount,
    date: d.rental_end_at ? d.rental_end_at.slice(0, 10) : null,
  }));
}

// Revenue as it's actually earned AND paid for — one row per calendar day
// of every active/completed booking, at that booking's own daily rate plus
// that day's admin fee, with the one-time travel/misc fees (minus any
// discount) folded into the pickup day — rather than whenever a payment
// happened to be logged. A booking paid in full up front shows its revenue
// spread across the exact days it covers: $43 on May 12, $43 on May 13,
// and so on. Sales tax, highway tax, insurance fee, processing fee, and
// tolls are excluded — pass-through/ancillary, not earnings.
//
// A booking that's only partly paid has only earned the days its payments
// actually cover — allocated FIFO, oldest day first, like a running tab:
// walk the booking chronologically and keep "spending" what's been paid
// against each day's full invoice cost (rate + its share of tax + admin +
// insurance fee, plus travel/processing/misc/toll fee and minus discount on
// the pickup day) until it runs out. Earlier days are marked fully earned
// before later ones get anything, and the one day payment runs out mid-way
// through gets its own partial share. This (rather than spreading the same
// paid % evenly across every day) means a day already fully paid for stays
// that way — an old, closed month's revenue doesn't retroactively shift
// just because a later payment came in on the same booking.
//
// Each day's invoice cost is its own real, independently cent-rounded
// charge — the same number it'd be if this booking had actually been
// billed and paid day by day, rather than one lump total — so the running
// ledger only ever spends whole cents. That means the sum of every day's
// invoice can land a few cents away from the booking's actual stored total
// (rounding 18 separate days up/down independently doesn't perfectly
// cancel out the way rounding one number once does); that's an accepted
// tradeoff of treating each day as its own real charge.
//
// Each row also carries taxAmount — that same day's share of highway +
// sales tax (only ever levied on the lease subtotal, never on admin/
// travel/insurance/processing fees), collected using the identical FIFO
// fraction as the day's revenue. This is what the Taxes Collected report
// reads from, so "how much tax was collected" always uses the same
// payment-allocation logic as "how much revenue was collected" instead of
// a separate cash-basis estimate.
//
// A booking paid MORE than its full invoice (an overpayment — the same
// thing computeOwed shows as a negative balance) still has that excess
// classified the same way as everything else: split by the booking's own
// revenue-vs-tax ratio and added to the last day's totals, rather than
// left uncounted. It doesn't change what's owed back to the customer if
// they ask for a refund — that's still tracked separately by computeOwed
// — this only affects how the money is classified for revenue reporting
// in the meantime.
function getAccruedRevenueDays() {
  const rows = db.prepare(`
    SELECT id as application_id, assigned_vehicle_id as vehicle_id, status,
           pickup_scheduled_at, rental_end_at, weekly_rate, admin_fee_rate, travel_fee, discount,
           invoice_amount, total_due_at_pickup, insurance_fee_rate, processing_fee, misc_fee, toll_fee
    FROM applications
    WHERE status IN ('active', 'completed')
      AND pickup_scheduled_at IS NOT NULL AND rental_end_at IS NOT NULL AND weekly_rate IS NOT NULL
  `).all();
  const paidByApp = new Map(db.prepare(`
    SELECT application_id, COALESCE(SUM(amount), 0) as total FROM payments GROUP BY application_id
  `).all().map(r => [r.application_id, r.total]));
  const days = [];
  rows.forEach(a => {
    const start = new Date(a.pickup_scheduled_at.slice(0, 10));
    // Revenue is capped to the booking's own scheduled dates, full stop —
    // whether or not it's been checked in yet does not extend earnings.
    // (Whether a car still shows as "on rent" past a missed return date is a
    // separate, utilization-only concern handled in reports.js.)
    const end = new Date(a.rental_end_at.slice(0, 10));
    if (!(end > start)) return;
    const totalCharge = computeCharge(a);
    let remainingPaid = Math.max(0, paidByApp.get(a.application_id) || 0);
    const revenueShare = totalCharge > 0 ? computeRevenueEligible(a) / totalCharge : 0;
    const dailyRate = a.weekly_rate / 7;
    const dailyTaxedRate = dailyRate * (1 + HIGHWAY_TAX_RATE + SALES_TAX_RATE);
    const dailyTaxPortion = Math.round((dailyRate * (HIGHWAY_TAX_RATE + SALES_TAX_RATE)) * 100) / 100;
    const adminFeeRate = Number(a.admin_fee_rate) || 0;
    const insuranceFeeRate = Number(a.insurance_fee_rate) || 0;
    const travelFee = Math.round((Number(a.travel_fee) || 0) * 100) / 100;
    const processingFee = Math.round((Number(a.processing_fee) || 0) * 100) / 100;
    const miscFee = Math.round((Number(a.misc_fee) || 0) * 100) / 100;
    const tollFee = Math.round((Number(a.toll_fee) || 0) * 100) / 100;
    const discount = Math.round((Number(a.discount) || 0) * 100) / 100;
    const cursor = new Date(start);
    let firstDay = true;
    let lastEntry = null;
    while (cursor < end) {
      const revenuePortion = Math.round((dailyRate + adminFeeRate + (firstDay ? travelFee + miscFee - discount : 0)) * 100) / 100;
      const fullDayInvoice = Math.round((dailyTaxedRate + adminFeeRate + insuranceFeeRate + (firstDay ? travelFee + processingFee + miscFee + tollFee - discount : 0)) * 100) / 100;
      let amount;
      let taxAmount;
      if (remainingPaid >= fullDayInvoice) {
        amount = revenuePortion;
        taxAmount = dailyTaxPortion;
        remainingPaid = Math.round((remainingPaid - fullDayInvoice) * 100) / 100;
      } else if (remainingPaid > 0) {
        const fraction = fullDayInvoice > 0 ? remainingPaid / fullDayInvoice : 0;
        amount = Math.round(revenuePortion * fraction * 100) / 100;
        taxAmount = Math.round(dailyTaxPortion * fraction * 100) / 100;
        remainingPaid = 0;
      } else {
        amount = 0;
        taxAmount = 0;
      }
      lastEntry = { application_id: a.application_id, vehicle_id: a.vehicle_id, date: cursor.toISOString().slice(0, 10), amount, taxAmount };
      days.push(lastEntry);
      firstDay = false;
      cursor.setDate(cursor.getDate() + 1);
    }
    // Every day's invoice is spent — anything still left in remainingPaid is
    // an overpayment. Split it the same way as everything else and fold it
    // into the last day rather than dropping it.
    if (remainingPaid > 0 && lastEntry) {
      const extraRevenue = Math.round(remainingPaid * revenueShare * 100) / 100;
      const extraTax = Math.round((remainingPaid - extraRevenue) * 100) / 100;
      lastEntry.amount = Math.round((lastEntry.amount + extraRevenue) * 100) / 100;
      lastEntry.taxAmount = Math.round((lastEntry.taxAmount + extraTax) * 100) / 100;
    }
  });
  return days;
}

function logActivity(applicationId, message) {
  db.prepare('INSERT INTO activity_log (application_id, message) VALUES (?, ?)').run(applicationId, message);
}

function queueMessage(applicationId, channel, to, body) {
  db.prepare('INSERT INTO messages_outbox (application_id, channel, to_value, body) VALUES (?, ?, ?, ?)')
    .run(applicationId, channel, to, body);
}

module.exports = { db, logActivity, queueMessage, upsertCustomer, upsertInsuranceRecord, logUndo, getForfeitedDeposits, getAccruedRevenueDays };

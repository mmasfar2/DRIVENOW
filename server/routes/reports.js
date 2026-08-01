const express = require('express');
const { db, getForfeitedDeposits, getAccruedRevenueDays, getAccruedCardFeeDays } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SALES_TAX_RATE, HIGHWAY_TAX_RATE, computeCharge, computeOwed } = require('../billing');
const { todayStr: businessTodayStr } = require('../timezone');

const router = express.Router();

// Every report reads from the same tables the rest of the app already treats
// as the source of truth (payments, deposits, vehicle_maintenance, claims,
// billing.js) instead of recomputing its own version of "revenue" or "owed".

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function dayDiff(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function clip(d, lo, hi) { return d < lo ? lo : d > hi ? hi : d; }

// Same method vocabulary payments are actually logged with (see PAYMENT_METHODS
// in routes/applications.js) — kept in display order for the Collections report.
const PAYMENT_METHOD_LABELS = { cash: 'Cash', card: 'Card', swipe: 'Swipe', cash_app: 'Cash App', apple_pay: 'Apple Pay', zelle: 'Zelle' };
const PAYMENT_METHOD_KEYS = Object.keys(PAYMENT_METHOD_LABELS);

// Collapses a payment's own date (YYYY-MM-DD) down to the key for whatever
// bucket it's being grouped into.
function periodKeyFor(dateStr, groupBy) {
  if (groupBy === 'month') return dateStr.slice(0, 7);
  if (groupBy === 'week') {
    // Monday-start ISO week, computed in UTC so it doesn't drift a day
    // depending on the server's local timezone.
    const d = new Date(`${dateStr}T00:00:00Z`);
    const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - (isoDay - 1));
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

function periodLabelFor(key, groupBy) {
  if (groupBy === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  if (groupBy === 'week') return `Week of ${key}`;
  return key;
}

// The actual [from, to] calendar-day span a period key covers — used to back
// the report's drilldown (which individual payments fall in this row) since
// the period key itself is a Monday (week) or YYYY-MM (month), not a range.
function periodRangeFor(key, groupBy) {
  if (groupBy === 'month') {
    const [y, m] = key.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: `${key}-01`, to: lastDay };
  }
  if (groupBy === 'week') {
    const d = new Date(`${key}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from: key, to: d.toISOString().slice(0, 10) };
  }
  return { from: key, to: key };
}

// Utilization only — whether a vehicle counts as "on rent" for a day. Unlike
// revenue (getAccruedRevenueDays in db.js, capped to a booking's own
// scheduled dates), a still-active booking that's never been checked in
// keeps counting as on rent through today: the car is physically still out
// even past a missed return date, even though that lateness earns no extra
// revenue until the booking is actually extended and paid for.
function computeVehicleDays(from, to) {
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const rangeDays = Math.max(1, dayDiff(rangeStart, rangeEnd) + 1);
  const todayStr = businessTodayStr();
  const vehicles = db.prepare('SELECT id, year, make, model, license_plate FROM vehicles ORDER BY year DESC').all();
  return vehicles.map(v => {
    const apps = db.prepare(`
      SELECT pickup_scheduled_at, rental_end_at, updated_at, status FROM applications
      WHERE assigned_vehicle_id = ? AND status IN ('active', 'completed') AND pickup_scheduled_at IS NOT NULL
    `).all(v.id);
    let rentedDays = 0;
    for (const a of apps) {
      const start = new Date(a.pickup_scheduled_at.slice(0, 10));
      let endRaw;
      if (a.status === 'completed') {
        endRaw = a.rental_end_at ? a.rental_end_at.slice(0, 10) : a.updated_at.slice(0, 10);
      } else {
        // Still active (never checked in)? Keep counting it as on rent
        // through today rather than stopping at a scheduled return date
        // that was never actually confirmed to have happened.
        const scheduled = a.rental_end_at ? a.rental_end_at.slice(0, 10) : todayStr;
        endRaw = scheduled > todayStr ? scheduled : todayStr;
      }
      const end = new Date(endRaw);
      const s = clip(start, rangeStart, rangeEnd);
      const e = clip(end, rangeStart, rangeEnd);
      if (e >= s) rentedDays += dayDiff(s, e) + 1;
    }
    rentedDays = Math.min(rentedDays, rangeDays);
    return { v, rentedDays, rangeDays };
  });
}

// Each report: category, label, description, whether it takes a date range,
// its display columns, and a run(from, to) that returns an array of row objects.
const REPORTS = {
  revenue_by_vehicle: {
    category: 'revenue', label: 'Revenue by Vehicle',
    description: 'The car\'s daily rate, travel fee, and admin fee, accrued on the actual calendar days of the rental that fall in the selected range (sales tax, highway tax, insurance fee, and processing fee excluded — not revenue), scaled by how much of the invoice has actually been paid. Plus any deposit amounts forfeited against that vehicle in range, counted as of the booking\'s return date, any insurance claim payout for that vehicle in range, counted as of its payout date, and any vehicle sale amount in range, counted as of its sale date. Expense is maintenance cost in range (tolls excluded — a pass-through cost recovered from the customer, not money actually lost) plus any claim deductible paid on that vehicle in range, counted as of the date the damage was reported; Business Expense is Swipe card-processing fees attributed to that vehicle\'s bookings, spread across the same nights as the revenue they\'re tied to — shown as its own column. Profit is Revenue less both.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'bookings', label: 'Bookings', type: 'number' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'expense', label: 'Expense', type: 'money' },
      { key: 'business_expense', label: 'Business Expense', type: 'money' },
      { key: 'profit', label: 'Profit', type: 'money' },
    ],
    run(from, to) {
      const vehicles = db.prepare('SELECT id, year, make, model, license_plate FROM vehicles').all();
      const byVehicle = new Map();
      getAccruedRevenueDays().forEach(d => {
        if (d.date < from || d.date > to) return;
        if (!byVehicle.has(d.vehicle_id)) byVehicle.set(d.vehicle_id, { revenue: 0, appIds: new Set() });
        const entry = byVehicle.get(d.vehicle_id);
        entry.revenue += d.amount;
        entry.appIds.add(d.application_id);
      });
      // Tolls are excluded — a pass-through cost recovered from the
      // customer, not money actually lost on the vehicle (same condition
      // the Toll Report below uses to find them). COALESCE both sides to
      // '' first — category is often NULL for ordinary maintenance rows,
      // and NULL = 'toll' evaluates to NULL rather than false in SQL, which
      // would make NOT(...) also NULL and silently drop every NULL-category
      // row from the WHERE clause, not just the toll ones.
      const expenseByVehicle = new Map(db.prepare(`
        SELECT vehicle_id, COALESCE(SUM(cost), 0) as expense
        FROM vehicle_maintenance
        WHERE substr(performed_at, 1, 10) BETWEEN ? AND ?
          AND NOT (COALESCE(category, '') = 'toll' OR lower(COALESCE(description, '')) LIKE '%toll%')
        GROUP BY vehicle_id
      `).all(from, to).map(r => [r.vehicle_id, r.expense]));
      // A claim's deductible is money actually paid out on that vehicle —
      // counted as of the date the damage was reported, same as maintenance
      // is dated to when it was performed.
      const deductibleByVehicle = new Map(db.prepare(`
        SELECT vehicle_id, COALESCE(SUM(deductible_amount), 0) as expense
        FROM claims
        WHERE deductible_amount IS NOT NULL AND substr(damage_reported_at, 1, 10) BETWEEN ? AND ?
        GROUP BY vehicle_id
      `).all(from, to).map(r => [r.vehicle_id, r.expense]));
      // An insurance payout is money the vehicle actually earned back —
      // counted as of its payout date (when the insurer paid out), not the
      // date the claim was originally filed.
      const payoutByVehicle = new Map(db.prepare(`
        SELECT vehicle_id, COALESCE(SUM(insurance_payout), 0) as payout
        FROM claims
        WHERE insurance_payout IS NOT NULL AND payout_date IS NOT NULL AND substr(payout_date, 1, 10) BETWEEN ? AND ?
        GROUP BY vehicle_id
      `).all(from, to).map(r => [r.vehicle_id, r.payout]));
      // A vehicle sale is its own revenue too — counted as of its sale date,
      // same treatment as an insurance payout.
      const saleByVehicle = new Map(db.prepare(`
        SELECT id as vehicle_id, sale_amount FROM vehicles
        WHERE sale_amount IS NOT NULL AND sale_date IS NOT NULL AND substr(sale_date, 1, 10) BETWEEN ? AND ?
      `).all(from, to).map(r => [r.vehicle_id, r.sale_amount]));
      // Business expenses attributed to a specific vehicle (currently just
      // Swipe card-processing fees, spread across the same nights as the
      // booking's revenue via getAccruedCardFeeDays — see db.js) — kept as
      // its own column rather than folded into Expense, so maintenance cost
      // and absorbed business cost stay distinguishable at a glance.
      const businessExpenseByVehicle = new Map();
      getAccruedCardFeeDays().forEach(d => {
        if (d.date < from || d.date > to) return;
        businessExpenseByVehicle.set(d.vehicle_id, (businessExpenseByVehicle.get(d.vehicle_id) || 0) + d.amount);
      });
      const forfeitedByVehicle = new Map();
      getForfeitedDeposits().forEach(d => {
        if (!d.date || d.date < from || d.date > to) return;
        forfeitedByVehicle.set(d.vehicle_id, (forfeitedByVehicle.get(d.vehicle_id) || 0) + Number(d.forfeited_amount));
      });
      return vehicles.map(v => {
        const entry = byVehicle.get(v.id);
        const revenue = round2((entry ? entry.revenue : 0) + (forfeitedByVehicle.get(v.id) || 0) + (payoutByVehicle.get(v.id) || 0) + (saleByVehicle.get(v.id) || 0));
        const expense = round2((expenseByVehicle.get(v.id) || 0) + (deductibleByVehicle.get(v.id) || 0));
        const businessExpense = round2(businessExpenseByVehicle.get(v.id) || 0);
        return {
          vehicle_id: v.id, vehicle: `${v.year} ${v.make} ${v.model}`, license_plate: v.license_plate || '—',
          bookings: entry ? entry.appIds.size : 0, revenue, expense, business_expense: businessExpense,
          profit: round2(revenue - expense - businessExpense),
        };
      }).sort((a, b) => b.revenue - a.revenue);
    },
  },

  revenue_by_time_period: {
    category: 'revenue', label: 'Revenue by Time Period',
    description: 'Total revenue across every vehicle for the selected range — the car\'s daily rate, travel fee, and admin fee, accrued on the actual calendar days of the rental that fall in the selected range (sales tax, highway tax, insurance fee, and processing fee excluded — not revenue), not the day a payment against it happened to be logged. Plus any security deposit amounts forfeited in range, any insurance claim payouts dated in range, and any vehicle sale amounts dated in range. Less maintenance expense logged in range (tolls excluded — a pass-through cost recovered from the customer), claim deductibles dated in range, general business expenses (subscriptions, absorbed fees entered by hand, etc.) logged in range, and Swipe card-processing fees spread across the same nights as the revenue they\'re tied to — the only report that also counts non-vehicle overhead against profit, since this one represents the whole business, not one car.',
    hasDateRange: true,
    columns: [
      { key: 'period', label: 'Period' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'expense', label: 'Expense', type: 'money' },
      { key: 'profit', label: 'Profit', type: 'money' },
      { key: 'card_fees', label: 'Card Processing Fees', type: 'money' },
    ],
    run(from, to) {
      const revenue = getAccruedRevenueDays()
        .filter(d => d.date >= from && d.date <= to)
        .reduce((sum, d) => sum + d.amount, 0);
      const forfeited = getForfeitedDeposits()
        .filter(d => d.date && d.date >= from && d.date <= to)
        .reduce((sum, d) => sum + Number(d.forfeited_amount), 0);
      const insurancePayout = db.prepare(`
        SELECT COALESCE(SUM(insurance_payout), 0) as total FROM claims
        WHERE insurance_payout IS NOT NULL AND payout_date IS NOT NULL AND substr(payout_date, 1, 10) BETWEEN ? AND ?
      `).get(from, to).total;
      const vehicleSales = db.prepare(`
        SELECT COALESCE(SUM(sale_amount), 0) as total FROM vehicles
        WHERE sale_amount IS NOT NULL AND sale_date IS NOT NULL AND substr(sale_date, 1, 10) BETWEEN ? AND ?
      `).get(from, to).total;
      // Tolls excluded — a pass-through cost recovered from the customer,
      // not money actually lost. COALESCE first (see expenseByVehicle above
      // for why) so a NULL category doesn't silently drop the whole row.
      const vehicleExpense = db.prepare(`
        SELECT COALESCE(SUM(cost), 0) as total FROM vehicle_maintenance
        WHERE substr(performed_at, 1, 10) BETWEEN ? AND ?
          AND NOT (COALESCE(category, '') = 'toll' OR lower(COALESCE(description, '')) LIKE '%toll%')
      `).get(from, to).total;
      const claimDeductible = db.prepare(`
        SELECT COALESCE(SUM(deductible_amount), 0) as total FROM claims
        WHERE deductible_amount IS NOT NULL AND substr(damage_reported_at, 1, 10) BETWEEN ? AND ?
      `).get(from, to).total;
      // General overhead (subscriptions, absorbed fees entered by hand, etc.)
      // is dated by its own expense_date as before; Swipe card-processing
      // fees (payment_id set) are excluded here and pulled in separately
      // below via getAccruedCardFeeDays, spread across the same nights as
      // the booking's revenue instead of a single logged date.
      const generalBusinessExpense = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM business_expenses
        WHERE payment_id IS NULL AND expense_date BETWEEN ? AND ?
      `).get(from, to).total;
      const cardFeeExpense = getAccruedCardFeeDays()
        .filter(d => d.date >= from && d.date <= to)
        .reduce((sum, d) => sum + d.amount, 0);
      const businessExpense = generalBusinessExpense + cardFeeExpense;
      // Card processing fees (a card payment's own surcharge) are a
      // separate, informational figure tied to when the payment actually
      // happened — not part of revenue-eligible amounts, just still shown
      // here for the range it landed in.
      const cardFees = db.prepare(`
        SELECT COALESCE(SUM(processing_fee), 0) as total FROM payments
        WHERE substr(paid_at, 1, 10) BETWEEN ? AND ?
      `).get(from, to).total;
      const totalRevenue = round2(revenue + forfeited + insurancePayout + vehicleSales);
      const totalExpense = round2(vehicleExpense + claimDeductible + businessExpense);
      return [{
        period: `${from} – ${to}`,
        revenue: totalRevenue, expense: totalExpense, profit: round2(totalRevenue - totalExpense),
        card_fees: round2(cardFees),
      }];
    },
  },

  taxes_collected: {
    category: 'revenue', label: 'Taxes Collected',
    description: `Highway tax (${(HIGHWAY_TAX_RATE * 100).toFixed(2)}%) and sales tax (${(SALES_TAX_RATE * 100).toFixed(2)}%) actually collected for the selected range — accrued day-by-day and allocated using the same FIFO payment logic as Revenue (see getAccruedRevenueDays in db.js), not estimated as a flat percentage of raw payment totals.`,
    hasDateRange: true,
    columns: [
      { key: 'period', label: 'Period' },
      { key: 'highway_tax', label: 'Highway Tax Collected', type: 'money' },
      { key: 'sales_tax', label: 'Sales Tax Collected', type: 'money' },
      { key: 'total_tax', label: 'Total Tax Collected', type: 'money' },
    ],
    run(from, to) {
      const totalTax = getAccruedRevenueDays()
        .filter(d => d.date >= from && d.date <= to)
        .reduce((sum, d) => sum + d.taxAmount, 0);
      // Both taxes are levied on the same lease subtotal at a fixed rate
      // each, so splitting the combined collected total by that fixed
      // rate ratio is exact, not an approximation.
      const highwayShare = HIGHWAY_TAX_RATE / (HIGHWAY_TAX_RATE + SALES_TAX_RATE);
      const highwayTax = round2(totalTax * highwayShare);
      const salesTax = round2(totalTax - highwayTax);
      return [{
        period: `${from} – ${to}`,
        highway_tax: highwayTax, sales_tax: salesTax, total_tax: round2(totalTax),
      }];
    },
  },

  collections_by_method: {
    category: 'revenue', label: 'Collections by Payment Method',
    description: 'Rental payments actually collected in the selected range — dated by when the payment was logged (paid_at), not the rental nights it applies to, so this is "cash that came in on a given day," not accrued revenue. Grouped by day, week, or month and split out by the method used (Cash, Card, Swipe, Cash App, Apple Pay, Zelle). Security deposits are not included — only the payments table. To see a single day, set From and To to the same date.',
    hasDateRange: true,
    extraParams: [
      { key: 'groupBy', label: 'Group By', type: 'select', default: 'day', options: [
        { value: 'day', label: 'Day' },
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
      ] },
    ],
    columns: [
      { key: 'period', label: 'Period' },
      ...PAYMENT_METHOD_KEYS.map(k => ({ key: k, label: PAYMENT_METHOD_LABELS[k], type: 'money' })),
      { key: 'total', label: 'Total Collected', type: 'money' },
    ],
    run(from, to, params) {
      const groupBy = (params && params.groupBy) || 'day';
      const rows = db.prepare(`
        SELECT amount, method, substr(paid_at, 1, 10) as date
        FROM payments WHERE substr(paid_at, 1, 10) BETWEEN ? AND ?
      `).all(from, to);
      const byPeriod = new Map();
      for (const r of rows) {
        const key = periodKeyFor(r.date, groupBy);
        if (!byPeriod.has(key)) {
          const entry = { period: key, total: 0 };
          PAYMENT_METHOD_KEYS.forEach(k => { entry[k] = 0; });
          byPeriod.set(key, entry);
        }
        const entry = byPeriod.get(key);
        const method = PAYMENT_METHOD_KEYS.includes(r.method) ? r.method : 'cash';
        entry[method] = round2(entry[method] + r.amount);
        entry.total = round2(entry.total + r.amount);
      }
      // period_from/period_to ride along on each row for the drilldown below
      // (which exact payments make up this row) — not in `columns`, so they
      // never render as a visible column, same as vehicle_id on Revenue by Vehicle.
      return [...byPeriod.keys()].sort().map(key => {
        const range = periodRangeFor(key, groupBy);
        return { ...byPeriod.get(key), period: periodLabelFor(key, groupBy), period_from: range.from, period_to: range.to };
      });
    },
  },

  security_deposits_collected: {
    category: 'revenue', label: 'Security Deposits Collected',
    description: 'Deposits collected in the selected range, and their current held/resolved status.',
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date Collected' },
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'method', label: 'Method' },
      { key: 'status', label: 'Status' },
      { key: 'forfeited', label: 'Forfeited', type: 'money' },
      { key: 'refunded', label: 'Refunded', type: 'money' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT d.collected_at, a.first_name, a.last_name, v.year, v.make, v.model,
               d.amount, d.method, d.status, d.forfeited_amount, d.refunded_amount
        FROM deposits d
        JOIN applications a ON a.id = d.application_id
        LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
        WHERE substr(d.collected_at, 1, 10) BETWEEN ? AND ?
        ORDER BY d.collected_at
      `).all(from, to).map(r => ({
        date: r.collected_at.slice(0, 10), customer: `${r.first_name} ${r.last_name}`,
        vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : '—',
        amount: round2(r.amount), method: r.method, status: r.status,
        forfeited: round2(r.forfeited_amount), refunded: round2(r.refunded_amount),
      }));
    },
  },

  toll_report: {
    category: 'revenue', label: 'Toll Report',
    description: "Toll charges logged against a vehicle's maintenance record (log a toll the same way as any other maintenance cost, tagged \"toll\").",
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'description', label: 'Description' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT vm.performed_at, v.year, v.make, v.model, v.license_plate, vm.description, vm.cost
        FROM vehicle_maintenance vm
        JOIN vehicles v ON v.id = vm.vehicle_id
        WHERE (vm.category = 'toll' OR lower(vm.description) LIKE '%toll%')
          AND substr(vm.performed_at, 1, 10) BETWEEN ? AND ?
        ORDER BY vm.performed_at
      `).all(from, to).map(r => ({
        date: r.performed_at ? r.performed_at.slice(0, 10) : '—',
        vehicle: `${r.year} ${r.make} ${r.model}`, license_plate: r.license_plate || '—',
        description: r.description, amount: round2(r.cost),
      }));
    },
  },

  fleet_utilization_rate: {
    category: 'utilization', label: 'Fleet Utilization Rate',
    description: 'Percent of days in range each vehicle spent on an active or completed booking.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'rented_days', label: 'Rented Days', type: 'number' },
      { key: 'range_days', label: 'Range Days', type: 'number' },
      { key: 'utilization', label: 'Utilization', type: 'percent' },
    ],
    run(from, to) {
      return computeVehicleDays(from, to).map(({ v, rentedDays, rangeDays }) => ({
        vehicle: `${v.year} ${v.make} ${v.model}`, license_plate: v.license_plate || '—',
        rented_days: rentedDays, range_days: rangeDays,
        utilization: round2((rentedDays / rangeDays) * 100),
      })).sort((a, b) => b.utilization - a.utilization);
    },
  },

  idle_time_per_vehicle: {
    category: 'utilization', label: 'Idle Time per Vehicle',
    description: 'Days each vehicle sat with no active or completed booking in range.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'idle_days', label: 'Idle Days', type: 'number' },
      { key: 'range_days', label: 'Range Days', type: 'number' },
      { key: 'idle_pct', label: 'Idle %', type: 'percent' },
    ],
    run(from, to) {
      return computeVehicleDays(from, to).map(({ v, rentedDays, rangeDays }) => ({
        vehicle: `${v.year} ${v.make} ${v.model}`, license_plate: v.license_plate || '—',
        idle_days: rangeDays - rentedDays, range_days: rangeDays,
        idle_pct: round2(((rangeDays - rentedDays) / rangeDays) * 100),
      })).sort((a, b) => b.idle_days - a.idle_days);
    },
  },

  revpav: {
    category: 'utilization', label: 'Revenue per Available Vehicle (RevPAV)',
    description: 'The car\'s daily rate, travel fee, and admin fee, accrued on the actual calendar days of the rental that fall in the selected range, plus deposit amounts forfeited in range — same Revenue definition as Revenue by Vehicle — divided by days in range.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'range_days', label: 'Range Days', type: 'number' },
      { key: 'revpav', label: 'RevPAV ($/day)', type: 'money' },
    ],
    run(from, to) {
      const rangeDays = Math.max(1, dayDiff(new Date(from), new Date(to)) + 1);
      const vehicles = db.prepare('SELECT id, year, make, model FROM vehicles ORDER BY year DESC').all();
      const revenueByVehicle = new Map();
      getAccruedRevenueDays().forEach(d => {
        if (d.date < from || d.date > to) return;
        revenueByVehicle.set(d.vehicle_id, (revenueByVehicle.get(d.vehicle_id) || 0) + d.amount);
      });
      getForfeitedDeposits().forEach(d => {
        if (!d.date || d.date < from || d.date > to) return;
        revenueByVehicle.set(d.vehicle_id, (revenueByVehicle.get(d.vehicle_id) || 0) + Number(d.forfeited_amount));
      });
      return vehicles.map(v => {
        const revenue = round2(revenueByVehicle.get(v.id) || 0);
        return {
          vehicle: `${v.year} ${v.make} ${v.model}`, revenue,
          range_days: rangeDays, revpav: round2(revenue / rangeDays),
        };
      }).sort((a, b) => b.revenue - a.revenue);
    },
  },

  booking_volume_over_time: {
    category: 'bookings', label: 'Booking Volume Over Time',
    description: 'New bookings created per day in the selected range.',
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'bookings', label: 'New Bookings', type: 'number' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT substr(created_at, 1, 10) as date, COUNT(*) as bookings
        FROM applications WHERE substr(created_at, 1, 10) BETWEEN ? AND ?
        GROUP BY date ORDER BY date
      `).all(from, to);
    },
  },

  upcoming_bookings: {
    category: 'bookings', label: 'Upcoming Bookings',
    description: 'Active bookings with a pickup date in the selected range.',
    hasDateRange: true,
    columns: [
      { key: 'pickup', label: 'Pickup Date' },
      { key: 'return', label: 'Return Date' },
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT a.pickup_scheduled_at, a.rental_end_at, a.first_name, a.last_name, v.year, v.make, v.model
        FROM applications a LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
        WHERE a.status = 'active' AND substr(a.pickup_scheduled_at, 1, 10) BETWEEN ? AND ?
        ORDER BY a.pickup_scheduled_at
      `).all(from, to).map(r => ({
        pickup: r.pickup_scheduled_at ? r.pickup_scheduled_at.slice(0, 10) : '—',
        return: r.rental_end_at ? r.rental_end_at.slice(0, 10) : '—',
        customer: `${r.first_name} ${r.last_name}`, vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : 'Unassigned',
      }));
    },
  },

  mileage_per_vehicle: {
    category: 'health', label: 'Mileage per Vehicle',
    description: 'Current recorded mileage and last checked-in odometer reading per vehicle.',
    hasDateRange: false,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'mileage', label: 'Recorded Mileage', type: 'number' },
      { key: 'last_odometer_in', label: 'Last Odometer In', type: 'number' },
      { key: 'next_service', label: 'Next Service Due' },
    ],
    run() {
      return db.prepare(`
        SELECT v.year, v.make, v.model, v.license_plate, v.mileage, v.next_service_at,
               (SELECT MAX(odometer_in) FROM applications WHERE assigned_vehicle_id = v.id) as last_odometer_in
        FROM vehicles v ORDER BY v.year DESC
      `).all().map(r => ({
        vehicle: `${r.year} ${r.make} ${r.model}`, license_plate: r.license_plate || '—',
        mileage: r.mileage ?? '—', last_odometer_in: r.last_odometer_in ?? '—',
        next_service: r.next_service_at ? r.next_service_at.slice(0, 10) : '—',
      }));
    },
  },

  damage_claims_history: {
    category: 'health', label: 'Damage Claims History',
    description: 'Every claim filed in the selected range, straight from the Claims module.',
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date Reported' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'incident_type', label: 'Incident Type' },
      { key: 'status', label: 'Status' },
      { key: 'detailed_status', label: 'Detailed Status' },
      { key: 'deductible', label: 'Deductible', type: 'money' },
    ],
    run(from, to) {
      const STATUS_LABELS = { initial_claim: 'Initial Claim', pending_payment: 'Pending Payment', closed: 'Closed', collections: 'Collections' };
      return db.prepare(`
        SELECT cl.damage_reported_at, v.year, v.make, v.model, cl.incident_type, cl.status, cl.detailed_status, cl.deductible_amount
        FROM claims cl JOIN vehicles v ON v.id = cl.vehicle_id
        WHERE substr(cl.damage_reported_at, 1, 10) BETWEEN ? AND ?
        ORDER BY cl.damage_reported_at DESC
      `).all(from, to).map(r => ({
        date: r.damage_reported_at.slice(0, 10), vehicle: `${r.year} ${r.make} ${r.model}`,
        incident_type: r.incident_type || '—', status: STATUS_LABELS[r.status] || r.status,
        detailed_status: r.detailed_status || '—', deductible: r.deductible_amount != null ? round2(r.deductible_amount) : '—',
      }));
    },
  },

  downtime_due_to_maintenance: {
    category: 'health', label: 'Downtime Due to Maintenance',
    description: 'Maintenance events and cost per vehicle in range — a proxy for how often each vehicle was down.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'events', label: 'Maintenance Events', type: 'number' },
      { key: 'total_cost', label: 'Total Cost', type: 'money' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT v.year, v.make, v.model, v.license_plate, COUNT(*) as events, COALESCE(SUM(vm.cost), 0) as total_cost
        FROM vehicle_maintenance vm JOIN vehicles v ON v.id = vm.vehicle_id
        WHERE substr(vm.performed_at, 1, 10) BETWEEN ? AND ?
        GROUP BY v.id ORDER BY events DESC
      `).all(from, to).map(r => ({
        vehicle: `${r.year} ${r.make} ${r.model}`, license_plate: r.license_plate || '—',
        events: r.events, total_cost: round2(r.total_cost),
      }));
    },
  },

  outstanding_balance: {
    category: 'past_due', label: 'Reservations with Outstanding Balance',
    description: 'Active bookings currently owing money, computed the same way as the balance shown on each reservation page.',
    hasDateRange: false,
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'charge', label: 'Charge', type: 'money' },
      { key: 'paid', label: 'Paid', type: 'money' },
      { key: 'balance', label: 'Balance Owed', type: 'money' },
    ],
    run() {
      const rows = db.prepare(`
        SELECT a.*, v.year, v.make, v.model FROM applications a
        LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
        WHERE a.status = 'active'
      `).all();
      const out = [];
      for (const r of rows) {
        const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM payments WHERE application_id = ?').get(r.id).t;
        const owed = computeOwed(r, paid);
        if (owed > 0) {
          out.push({
            customer: `${r.first_name} ${r.last_name}`, vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : 'Unassigned',
            charge: round2(computeCharge(r)), paid: round2(paid), balance: round2(owed),
          });
        }
      }
      return out.sort((a, b) => b.balance - a.balance);
    },
  },

  open_collections: {
    category: 'collections', label: 'Open Collections',
    description: 'Claims currently sitting in Collections status, straight from the Claims module.',
    hasDateRange: true,
    columns: [
      { key: 'claim', label: 'Claim #' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'reported', label: 'Date Reported' },
      { key: 'detailed_status', label: 'Detailed Status' },
      { key: 'assigned_to', label: 'Assigned To' },
      { key: 'max_oop', label: 'Max Out of Pocket', type: 'money' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT cl.id, cl.damage_reported_at, cl.detailed_status, cl.max_out_of_pocket,
               v.year, v.make, v.model, u.name as assigned_to_name
        FROM claims cl JOIN vehicles v ON v.id = cl.vehicle_id
        LEFT JOIN users u ON u.id = cl.assigned_to
        WHERE cl.status = 'collections' AND substr(cl.damage_reported_at, 1, 10) BETWEEN ? AND ?
        ORDER BY cl.damage_reported_at
      `).all(from, to).map(r => ({
        claim: `#${String(r.id).padStart(4, '0')}`, vehicle: `${r.year} ${r.make} ${r.model}`,
        reported: r.damage_reported_at.slice(0, 10), detailed_status: r.detailed_status || '—',
        assigned_to: r.assigned_to_name || 'Unassigned', max_oop: r.max_out_of_pocket != null ? round2(r.max_out_of_pocket) : '—',
      }));
    },
  },

  late_returns_overage: {
    category: 'operational', label: 'Late Returns & Overage Charges',
    description: 'Completed bookings checked back in after their scheduled return date, with an estimated overage charge (days late × daily rate).',
    hasDateRange: true,
    columns: [
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'scheduled_return', label: 'Scheduled Return' },
      { key: 'actual_return', label: 'Actual Return' },
      { key: 'days_late', label: 'Days Late', type: 'number' },
      { key: 'overage', label: 'Est. Overage Charge', type: 'money' },
    ],
    run(from, to) {
      const rows = db.prepare(`
        SELECT a.first_name, a.last_name, a.rental_end_at, a.updated_at, a.weekly_rate, v.year, v.make, v.model
        FROM applications a LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
        WHERE a.status = 'completed' AND a.rental_end_at IS NOT NULL
          AND substr(a.updated_at, 1, 10) BETWEEN ? AND ?
      `).all(from, to);
      const out = [];
      for (const r of rows) {
        const scheduled = r.rental_end_at.slice(0, 10);
        const actual = r.updated_at.slice(0, 10);
        const daysLate = dayDiff(new Date(scheduled), new Date(actual));
        if (daysLate > 0) {
          out.push({
            customer: `${r.first_name} ${r.last_name}`, vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : '—',
            scheduled_return: scheduled, actual_return: actual, days_late: daysLate,
            overage: round2(daysLate * ((r.weekly_rate || 0) / 7)),
          });
        }
      }
      return out.sort((a, b) => b.days_late - a.days_late);
    },
  },
};

const CATEGORIES = [
  { key: 'revenue', label: 'Revenue & Financial', icon: 'dollar' },
  { key: 'utilization', label: 'Utilization & Fleet Performance', icon: 'trending' },
  { key: 'bookings', label: 'Bookings & Demand', icon: 'calendar' },
  { key: 'health', label: 'Vehicle Health & Maintenance', icon: 'wrench' },
  { key: 'past_due', label: 'Past Due Balances', icon: 'alert' },
  { key: 'collections', label: 'Collections', icon: 'inbox' },
  { key: 'operational', label: 'Operational', icon: 'flag' },
];

function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(c => esc(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map(c => esc(row[c.key])).join(','));
  return lines.join('\n');
}

router.get('/', requireAuth, (req, res) => {
  res.json({
    categories: CATEGORIES,
    reports: Object.entries(REPORTS).map(([key, r]) => ({
      key, category: r.category, label: r.label, description: r.description, hasDateRange: r.hasDateRange, columns: r.columns,
      extraParams: r.extraParams || [],
    })),
  });
});

router.get('/:key/data', requireAuth, (req, res) => {
  const report = REPORTS[req.params.key];
  if (!report) return res.status(404).json({ error: 'Unknown report' });

  const today = businessTodayStr();
  const from = report.hasDateRange ? (req.query.from || today) : '0000-01-01';
  const to = report.hasDateRange ? (req.query.to || today) : '9999-12-31';
  if (from > to) return res.status(400).json({ error: '"From" date must be before "To" date' });

  const params = {};
  for (const p of (report.extraParams || [])) {
    const allowed = p.options.map(o => o.value);
    params[p.key] = allowed.includes(req.query[p.key]) ? req.query[p.key] : p.default;
  }
  const rows = report.run(from, to, params);

  if (req.query.format === 'csv') {
    const csv = toCsv(report.columns, rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}.csv"`);
    return res.send(csv);
  }
  res.json({ columns: report.columns, rows });
});

// Per-booking breakdown behind a Revenue by Vehicle row — same figures,
// same date range, just split out by the individual booking that earned
// them instead of summed across the whole vehicle. Expense (vehicle
// maintenance) has no natural per-booking split — a maintenance record is
// logged against the vehicle, not tied to whichever booking happened to be
// active at the time — so it's always 0 here; the vehicle-level Expense
// column is the only place that cost is meaningful.
router.get('/revenue_by_vehicle/:vehicleId/bookings', requireAuth, (req, res) => {
  const vehicleId = Number(req.params.vehicleId);
  const today = businessTodayStr();
  const from = req.query.from || today;
  const to = req.query.to || today;
  if (from > to) return res.status(400).json({ error: '"From" date must be before "To" date' });

  const revenueByApp = new Map();
  getAccruedRevenueDays().forEach(d => {
    if (d.vehicle_id !== vehicleId || d.date < from || d.date > to) return;
    revenueByApp.set(d.application_id, (revenueByApp.get(d.application_id) || 0) + d.amount);
  });
  const businessExpenseByApp = new Map();
  getAccruedCardFeeDays().forEach(d => {
    if (d.vehicle_id !== vehicleId || d.date < from || d.date > to) return;
    businessExpenseByApp.set(d.application_id, (businessExpenseByApp.get(d.application_id) || 0) + d.amount);
  });
  const forfeitedByApp = new Map();
  getForfeitedDeposits().forEach(d => {
    if (d.vehicle_id !== vehicleId || !d.date || d.date < from || d.date > to) return;
    forfeitedByApp.set(d.application_id, (forfeitedByApp.get(d.application_id) || 0) + Number(d.forfeited_amount));
  });

  const appIds = new Set([...revenueByApp.keys(), ...businessExpenseByApp.keys(), ...forfeitedByApp.keys()]);
  const idList = [...appIds];
  const apps = idList.length ? db.prepare(`
    SELECT id, first_name, last_name, pickup_scheduled_at, rental_end_at, status
    FROM applications WHERE id IN (${idList.map(() => '?').join(',')})
  `).all(...idList) : [];

  const rows = apps.map(a => {
    const revenue = round2((revenueByApp.get(a.id) || 0) + (forfeitedByApp.get(a.id) || 0));
    const businessExpense = round2(businessExpenseByApp.get(a.id) || 0);
    return {
      booking_id: a.id,
      customer: `${a.first_name} ${a.last_name}`,
      pickup_scheduled_at: a.pickup_scheduled_at, rental_end_at: a.rental_end_at, status: a.status,
      revenue, expense: 0, business_expense: businessExpense,
      profit: round2(revenue - businessExpense),
    };
  });

  // Insurance claim payouts aren't tied to a booking — they're their own
  // category, dated by payout_date (matching the top-level report), with the
  // claim's deductible as this row's expense (also matching deductibleByVehicle
  // there). Sits alongside booking rows rather than folded into one of them.
  const claimRows = db.prepare(`
    SELECT id, incident_type, payout_date, insurance_payout, deductible_amount
    FROM claims
    WHERE vehicle_id = ? AND insurance_payout IS NOT NULL AND payout_date IS NOT NULL
      AND substr(payout_date, 1, 10) BETWEEN ? AND ?
  `).all(vehicleId, from, to).map(c => {
    const revenue = round2(Number(c.insurance_payout));
    const expense = round2(Number(c.deductible_amount) || 0);
    return {
      booking_id: `Claim #${c.id}`,
      customer: `Insurance Payout — ${c.incident_type || 'Claim'}`,
      pickup_scheduled_at: null, rental_end_at: c.payout_date, status: 'claim',
      revenue, expense, business_expense: 0,
      profit: round2(revenue - expense),
    };
  });

  // A vehicle sale is its own category too, same reasoning as claim payouts
  // — not tied to a booking, dated by sale_date.
  const sale = db.prepare(`
    SELECT sale_amount, sale_date FROM vehicles
    WHERE id = ? AND sale_amount IS NOT NULL AND sale_date IS NOT NULL
      AND substr(sale_date, 1, 10) BETWEEN ? AND ?
  `).get(vehicleId, from, to);
  const saleRows = sale ? [{
    booking_id: 'Sale',
    customer: 'Vehicle Sale',
    pickup_scheduled_at: null, rental_end_at: sale.sale_date, status: 'sale',
    revenue: round2(Number(sale.sale_amount)), expense: 0, business_expense: 0,
    profit: round2(Number(sale.sale_amount)),
  }] : [];

  res.json([...rows, ...claimRows, ...saleRows].sort((a, b) => b.revenue - a.revenue));
});

// Per-payment breakdown behind a Collections by Payment Method row — every
// individual payment that rolled up into that row's totals, so a number
// that looks off can be traced back to the actual payment(s) behind it
// instead of just trusting the aggregate.
router.get('/collections_by_method/payments', requireAuth, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const rows = db.prepare(`
    SELECT p.id, p.amount, p.paid_at, p.method,
           a.first_name, a.last_name, v.year, v.make, v.model
    FROM payments p
    JOIN applications a ON a.id = p.application_id
    LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
    WHERE substr(p.paid_at, 1, 10) BETWEEN ? AND ?
    ORDER BY p.paid_at
  `).all(from, to);
  res.json(rows.map(r => ({
    paid_at: r.paid_at,
    customer: `${r.first_name} ${r.last_name}`,
    vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : 'Unassigned',
    method: PAYMENT_METHOD_LABELS[r.method] || r.method,
    amount: round2(r.amount),
  })));
});

module.exports = router;

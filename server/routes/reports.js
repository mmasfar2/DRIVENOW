const express = require('express');
const { db, getForfeitedDeposits, getAccruedRevenueDays } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SALES_TAX_RATE, computeCharge, computeOwed } = require('../billing');
const { todayStr: businessTodayStr } = require('../timezone');

const router = express.Router();

// Every report reads from the same tables the rest of the app already treats
// as the source of truth (payments, deposits, vehicle_maintenance, claims,
// billing.js) instead of recomputing its own version of "revenue" or "owed".
const TAX_FRACTION = SALES_TAX_RATE / (1 + SALES_TAX_RATE);

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function dayDiff(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function clip(d, lo, hi) { return d < lo ? lo : d > hi ? hi : d; }

// Utilization only — whether a vehicle counts as "on rent" for a day. Unlike
// revenue (getAccruedRevenueDays in db.js, always capped to a booking's own
// scheduled dates), a still-active booking that's never been checked in
// keeps counting as on rent through today: the car is physically still out
// even past a missed return date, even though that lateness earns no extra
// revenue until the booking is actually extended.
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
    description: 'The car\'s daily rate, travel fee, and admin fee, accrued day-by-day across the actual rental dates that fall in the selected range (sales tax, highway tax, insurance fee, and processing fee excluded — not revenue) — not when a payment happened to be logged. Plus any deposit amounts forfeited against that vehicle, counted as of the day they were forfeited. Less maintenance expense — same Revenue/Expense/Profit definition as the Vehicle Detail page.',
    hasDateRange: true,
    columns: [
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'license_plate', label: 'License Plate' },
      { key: 'bookings', label: 'Bookings', type: 'number' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'expense', label: 'Expense', type: 'money' },
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
      const expenseByVehicle = new Map(db.prepare(`
        SELECT vehicle_id, COALESCE(SUM(cost), 0) as expense
        FROM vehicle_maintenance WHERE substr(performed_at, 1, 10) BETWEEN ? AND ?
        GROUP BY vehicle_id
      `).all(from, to).map(r => [r.vehicle_id, r.expense]));
      const forfeitedByVehicle = new Map();
      getForfeitedDeposits().forEach(d => {
        if (!d.date || d.date < from || d.date > to) return;
        forfeitedByVehicle.set(d.vehicle_id, (forfeitedByVehicle.get(d.vehicle_id) || 0) + Number(d.forfeited_amount));
      });
      return vehicles.map(v => {
        const entry = byVehicle.get(v.id);
        const revenue = round2((entry ? entry.revenue : 0) + (forfeitedByVehicle.get(v.id) || 0));
        const expense = round2(expenseByVehicle.get(v.id) || 0);
        return {
          vehicle: `${v.year} ${v.make} ${v.model}`, license_plate: v.license_plate || '—',
          bookings: entry ? entry.appIds.size : 0, revenue, expense, profit: round2(revenue - expense),
        };
      }).sort((a, b) => b.revenue - a.revenue);
    },
  },

  revenue_by_time_period: {
    category: 'revenue', label: 'Revenue by Time Period',
    description: 'The car\'s daily rate, travel fee, and admin fee, accrued on the actual calendar day of the rental it applies to (sales tax, highway tax, insurance fee, and processing fee excluded — not revenue) — not the day a payment against it happened to be logged. Plus any security deposit amounts forfeited, counted as of the day they were forfeited. Less maintenance expense logged that day — same Revenue/Expense/Profit definition as the Vehicle Detail page.',
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'expense', label: 'Expense', type: 'money' },
      { key: 'profit', label: 'Profit', type: 'money' },
      { key: 'card_fees', label: 'Card Processing Fees', type: 'money' },
    ],
    run(from, to) {
      const revenueByDay = new Map();
      getAccruedRevenueDays().forEach(d => {
        if (d.date < from || d.date > to) return;
        revenueByDay.set(d.date, (revenueByDay.get(d.date) || 0) + d.amount);
      });
      // Card processing fees (a card payment's own surcharge) are a
      // separate, informational figure tied to when the payment actually
      // happened — not part of revenue-eligible amounts, just still shown
      // here for the day it landed.
      const cardFeesByDay = new Map(db.prepare(`
        SELECT substr(paid_at, 1, 10) as date, COALESCE(SUM(processing_fee), 0) as card_fees
        FROM payments WHERE substr(paid_at, 1, 10) BETWEEN ? AND ?
        GROUP BY date
      `).all(from, to).map(r => [r.date, r.card_fees]));
      const expenseByDay = new Map(db.prepare(`
        SELECT substr(performed_at, 1, 10) as date, COALESCE(SUM(cost), 0) as expense
        FROM vehicle_maintenance WHERE substr(performed_at, 1, 10) BETWEEN ? AND ?
        GROUP BY date
      `).all(from, to).map(r => [r.date, r.expense]));
      const forfeitedByDay = new Map();
      getForfeitedDeposits().forEach(d => {
        if (!d.date || d.date < from || d.date > to) return;
        forfeitedByDay.set(d.date, (forfeitedByDay.get(d.date) || 0) + Number(d.forfeited_amount));
      });
      const days = new Set([...revenueByDay.keys(), ...expenseByDay.keys(), ...forfeitedByDay.keys()]);
      return [...days].sort().map(date => {
        const revenue = round2((revenueByDay.get(date) || 0) + (forfeitedByDay.get(date) || 0));
        const expense = round2(expenseByDay.get(date) || 0);
        return {
          date, revenue, expense, profit: round2(revenue - expense),
          card_fees: round2(cardFeesByDay.get(date) || 0),
        };
      });
    },
  },

  taxes_collected: {
    category: 'revenue', label: 'Taxes Collected',
    description: `Estimated sales tax (${(SALES_TAX_RATE * 100).toFixed(2)}%) embedded in each payment collected, using the same rate billing.js uses to price every booking.`,
    hasDateRange: true,
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'customer', label: 'Customer' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'amount', label: 'Payment Amount', type: 'money' },
      { key: 'tax', label: 'Est. Tax Collected', type: 'money' },
    ],
    run(from, to) {
      return db.prepare(`
        SELECT p.paid_at, p.amount, a.first_name, a.last_name, v.year, v.make, v.model
        FROM payments p
        JOIN applications a ON a.id = p.application_id
        LEFT JOIN vehicles v ON v.id = a.assigned_vehicle_id
        WHERE substr(p.paid_at, 1, 10) BETWEEN ? AND ?
        ORDER BY p.paid_at
      `).all(from, to).map(r => ({
        date: r.paid_at.slice(0, 10), customer: `${r.first_name} ${r.last_name}`,
        vehicle: r.make ? `${r.year} ${r.make} ${r.model}` : '—',
        amount: round2(r.amount), tax: round2(r.amount * TAX_FRACTION),
      }));
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
    description: 'The car\'s daily rate, travel fee, and admin fee, accrued day-by-day across the actual rental dates that fall in the selected range, plus deposit amounts forfeited in range — same Revenue definition as Revenue by Vehicle, capped to each booking\'s actual scheduled dates regardless of check-in status — divided by days in range.',
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

  const rows = report.run(from, to);

  if (req.query.format === 'csv') {
    const csv = toCsv(report.columns, rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}.csv"`);
    return res.send(csv);
  }
  res.json({ columns: report.columns, rows });
});

module.exports = router;

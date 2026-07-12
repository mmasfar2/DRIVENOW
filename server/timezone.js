// DriveNow operates out of Charlotte, NC — every "today"/"this month"/"N
// days ago" boundary in the app (revenue resets, pending-check-in flags,
// report date ranges, default payment/deposit dates) should line up with
// the business's own calendar day, not the timezone the server process
// happens to be running in (Render defaults to UTC) or whatever device an
// admin happens to be logged in from.
const BUSINESS_TZ = 'America/New_York';

// 'en-CA' formats as YYYY-MM-DD — the only common locale that does, so this
// avoids a manual format step. Explicitly passing timeZone here (rather than
// relying on process.env.TZ) means it's correct regardless of how the host
// is configured.
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}

function daysAgoStr(days) {
  return new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}

function monthsAgoStr(months) {
  const [y, m, d] = todayStr().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

module.exports = { BUSINESS_TZ, todayStr, daysAgoStr, monthsAgoStr };

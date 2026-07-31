// Shared across every write path that accepts a calendar date from the
// client (transactions.js, balances.js, accounts.js's /update-value). A
// regex like /^\d{4}-\d{2}-\d{2}$/ matches "2026-02-31" or "2026-13-45" --
// well-formed but not real calendar dates. Round-trip through Date.UTC and
// confirm the year/month/day survive, so an impossible date is rejected
// instead of stored verbatim. UTC avoids the local timezone shifting the day.
function isValidCalendarDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = { isValidCalendarDate };

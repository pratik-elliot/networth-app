const { isValidCalendarDate } = require("./validation");

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(raw) {
  // Statements are historical documents, so a two-digit year is this century.
  return raw.length === 4 ? Number(raw) : 2000 + Number(raw);
}

/* Returns an ISO string only when it is a real calendar date, so 31 February
   is rejected rather than silently stored. */
function isoIfReal(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const s = iso(y, m, d);
  return isValidCalendarDate(s) ? s : null;
}

/* "DD/MM" when some first part exceeds 12, "MM/DD" when some second part does,
   null when every date in the batch could be read either way. */
function detectDateOrder(rawDates) {
  for (const raw of rawDates || []) {
    const m = String(raw == null ? "" : raw).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) return "DD/MM";
    if (b > 12 && a <= 12) return "MM/DD";
  }
  return null;
}

function normaliseDate(raw, opts = {}) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const out = isoIfReal(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return out ? { iso: out, ambiguous: false } : null;
  }

  const named = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/);
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!m) return null;
    const out = isoIfReal(fullYear(named[3]), m, Number(named[1]));
    return out ? { iso: out, ambiguous: false } : null;
  }

  const numeric = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const y = fullYear(numeric[3]);

    // A part above 12 settles the order by itself.
    if (a > 12 && b > 12) return null;
    if (a > 12) {
      const out = isoIfReal(y, b, a);
      return out ? { iso: out, ambiguous: false } : null;
    }
    if (b > 12) {
      const out = isoIfReal(y, a, b);
      return out ? { iso: out, ambiguous: false } : null;
    }

    // Genuinely ambiguous: use the batch order, defaulting to day-first.
    const dayFirst = opts.order !== "MM/DD";
    const out = isoIfReal(y, dayFirst ? b : a, dayFirst ? a : b);
    return out ? { iso: out, ambiguous: true } : null;
  }

  return null;
}

function normaliseAmount(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return { value: Math.abs(raw), negative: raw < 0 };
  }
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // Accounting notation puts negatives in brackets.
  const bracketed = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, "").replace(/(?:INR|USD|Rs\.?|₹|\$|,|\s)/gi, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return { value: Math.abs(n), negative: bracketed || n < 0 };
}

module.exports = { normaliseDate, normaliseAmount, detectDateOrder };

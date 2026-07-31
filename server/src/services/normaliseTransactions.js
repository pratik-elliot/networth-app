const { normaliseDate, normaliseAmount, detectDateOrder } = require("./normaliseFields");

const MAX_DESCRIPTION = 500;

function cleanDescription(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION);
}

/* Statements express direction in several different ways: an explicit type, a
   Dr/Cr marker, separate withdrawal/deposit columns, or a negative amount. */
function resolveType(row, amount) {
  const marker = String(row.type || row.drCr || "").trim().toLowerCase();
  if (marker.startsWith("cr") || marker === "deposit") return "credit";
  if (marker.startsWith("dr") || marker.startsWith("deb") || marker === "withdrawal") return "debit";

  const filled = (v) => v != null && String(v).trim() !== "";
  if (filled(row.deposit) || filled(row.credit)) return "credit";
  if (filled(row.withdrawal) || filled(row.debit)) return "debit";

  if (amount && amount.negative) return "debit";
  return null;
}

function pickAmount(row) {
  for (const c of [row.amount, row.withdrawal, row.deposit, row.debit, row.credit]) {
    if (c == null || String(c).trim() === "") continue;
    const parsed = normaliseAmount(c);
    if (parsed) return parsed;
  }
  return null;
}

function normalise(rawRows) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  const order = detectDateOrder(list.map(r => (r && r.date) || ""));

  const rows = [];
  const rejected = [];

  for (const raw of list) {
    const row = raw && typeof raw === "object" ? raw : {};

    const amount = pickAmount(row);
    if (!amount || amount.value === 0) {
      rejected.push({ raw, reason: "Could not read an amount for this row." });
      continue;
    }

    const date = normaliseDate(row.date, { order: order || "DD/MM" });
    if (!date) {
      rejected.push({ raw, reason: "Could not read a date for this row." });
      continue;
    }

    const type = resolveType(row, amount);
    if (!type) {
      rejected.push({ raw, reason: "Could not tell whether this row is a credit or a debit." });
      continue;
    }

    rows.push({
      date: date.iso,
      description: cleanDescription(row.description || row.narration || row.particulars),
      type,
      amount: amount.value,
    });
  }

  return { rows, rejected, dateOrderAssumed: order || (rows.length ? "DD/MM" : null) };
}

module.exports = { normalise };

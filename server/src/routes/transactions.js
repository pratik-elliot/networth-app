const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

// A regex like /^\d{4}-\d{2}-\d{2}$/ matches "2026-02-31" or "2026-13-45" --
// well-formed but not real calendar dates. Round-trip through Date.UTC and
// confirm the year/month/day survive, so an impossible date is rejected
// instead of stored verbatim. UTC avoids the local timezone shifting the day.
function isValidCalendarDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toApi(doc) {
  return {
    id: doc._id, accountId: doc.accountId, date: doc.date,
    description: doc.description, type: doc.type, amount: doc.amount,
  };
}

router.get("/account/:accountId", asyncHandler(async (req, res) => {
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const { transactions } = collections();
  const docs = await transactions.find({ accountId: req.params.accountId }).sort({ date: -1 }).toArray();
  res.json(docs.map(toApi));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accountId, date, description, type, amount } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  // Mirror /bulk's validation here: without it, a missing or non-numeric
  // amount coerces to NaN, JSON.stringify({amount: NaN}) serialises as
  // `null`, and the client sees 200 OK while a NaN is written to Mongo --
  // poisoning every future sum/sort over this ledger.
  if (!isValidCalendarDate(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
  if (type !== "credit" && type !== "debit") return res.status(400).json({ error: `Invalid type: ${type}` });
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) return res.status(400).json({ error: `Invalid amount: ${amount}` });

  const doc = {
    _id: uuid(), accountId, date, description: description || "",
    type, amount: numAmount,
  };
  const { transactions } = collections();
  await transactions.insertOne(doc);
  res.json(toApi(doc));
}));

/* Insert many transactions at once, for confirmed statement imports. */
router.post("/bulk", asyncHandler(async (req, res) => {
  const { accountId, rows } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No transactions to import." });
  if (rows.length > 2000) return res.status(400).json({ error: "Too many rows in one import (limit 2000)." });

  // The client preview is never trusted on the way back in.
  const docs = [];
  for (const r of rows) {
    const date = String((r && r.date) || "");
    const type = String((r && r.type) || "");
    const amount = Number(r && r.amount);
    if (!isValidCalendarDate(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
    if (type !== "credit" && type !== "debit") return res.status(400).json({ error: `Invalid type: ${type}` });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: `Invalid amount: ${r && r.amount}` });
    docs.push({
      _id: uuid(), accountId, date, type, amount,
      description: String((r && r.description) || "").slice(0, 500),
    });
  }

  const { transactions } = collections();
  try {
    await transactions.insertMany(docs, { ordered: true });
  } catch (err) {
    // `ordered: true` stops at the first failing document, but every
    // document before that point is already durably written to Mongo --
    // the insertMany call rejecting does NOT mean nothing was saved.
    // MongoBulkWriteError exposes how many actually landed via
    // `.insertedCount` (a getter over `.result.insertedCount`, verified
    // against the installed mongodb 6.21.0 driver). Surface that count
    // instead of letting the generic error handler return a bare 500 with
    // no count -- a client that blindly retries the whole batch on a
    // count-less 500 would duplicate every row that already landed.
    const insertedCount = typeof err.insertedCount === "number" ? err.insertedCount : 0;
    if (insertedCount > 0) {
      return res.status(207).json({
        inserted: insertedCount,
        error: `Import stopped partway through: ${insertedCount} of ${docs.length} rows were saved before a write error. Do not re-import this file as-is, or you will duplicate those ${insertedCount} rows.`,
      });
    }
    // Nothing was written -- safe to let asyncHandler forward this to the
    // generic error handler rather than fabricate a success response.
    throw err;
  }
  res.json({ inserted: docs.length });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { transactions } = collections();
  const doc = await transactions.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  await transactions.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;

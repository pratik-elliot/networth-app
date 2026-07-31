const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { isValidCalendarDate } = require("../services/validation");

const router = express.Router();
router.use(requireAuth);

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

router.get("/account/:accountId", asyncHandler(async (req, res) => {
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const { balanceLogs } = collections();
  const docs = await balanceLogs.find({ accountId: req.params.accountId }).sort({ date: -1 }).toArray();
  res.json(docs.map(d => ({ id: d._id, accountId: d.accountId, date: d.date, balance: d.balance })));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accountId, date, balance } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  // Without this, a missing or non-numeric balance coerces to NaN,
  // JSON.stringify({balance: NaN}) serialises as `null`, and the client
  // sees 200 OK while a NaN is written to Mongo -- poisoning every future
  // sum/sort over this ledger. Unlike transactions.amount (whose sign is
  // carried separately by `type`, so the magnitude must be positive), a
  // balance has no separate sign carrier and zero/negative are legitimate
  // readings (an emptied account, an overdrawn one) -- only non-finite
  // values (NaN, Infinity, missing) are rejected.
  if (!isValidCalendarDate(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
  const numBalance = Number(balance);
  if (!Number.isFinite(numBalance)) return res.status(400).json({ error: `Invalid balance: ${balance}` });

  const doc = { _id: uuid(), accountId, date, balance: numBalance };
  const { balanceLogs } = collections();
  await balanceLogs.insertOne(doc);
  res.json({ id: doc._id, accountId, date, balance: doc.balance });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { balanceLogs } = collections();
  const doc = await balanceLogs.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  await balanceLogs.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;

const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { toApiAccount, fromApiAccount } = require("../services/accountShape");
const { isValidCalendarDate } = require("../services/validation");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const docs = await accounts.find({ userId: req.userId }).sort({ createdDate: -1 }).toArray();
  res.json(docs.map(toApiAccount));
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const doc = await accounts.findOne({ _id: req.params.id, userId: req.userId });
  if (!doc) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(doc));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const id = uuid();
  const doc = {
    _id: id,
    userId: req.userId,
    ...fromApiAccount(req.body),
    createdDate: req.body.createdDate || new Date().toISOString().slice(0, 10),
    images: [],
  };
  await accounts.insertOne(doc);
  res.json(toApiAccount(doc));
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const update = fromApiAccount(req.body);
  const result = await accounts.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: update },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(result));
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { accounts, transactions, balanceLogs, attachments } = collections();
  const existing = await accounts.findOne({ _id: req.params.id, userId: req.userId });
  if (!existing) return res.status(404).json({ error: "Account not found." });

  // MongoDB has no ON DELETE CASCADE, so everything belonging to this account
  // must be removed explicitly or it is orphaned forever.
  await Promise.all([
    transactions.deleteMany({ accountId: req.params.id }),
    balanceLogs.deleteMany({ accountId: req.params.id }),
    attachments.deleteMany({ accountId: req.params.id }),
  ]);
  await accounts.deleteOne({ _id: req.params.id, userId: req.userId });
  res.json({ ok: true });
}));

/* Log a sourced value update for physically-valued assets (gold, auto, real estate, etc). */
router.post("/:id/update-value", asyncHandler(async (req, res) => {
  const { currentValue, valueDate, valueUrl } = req.body;
  // Without this, a missing or non-numeric currentValue (e.g. "12 lakh")
  // coerces to NaN, JSON.stringify({currentValue: NaN}) serialises as
  // `null`, and the client sees 200 OK while a NaN is written to Mongo.
  // toApiAccount then reads it back as null, and latestValue() in
  // client/src/theme.js coerces that to 0 -- the asset silently disappears
  // from net worth with no error anywhere. Note "" (an emptied number
  // input) legitimately coerces to 0, which must keep succeeding.
  const value = Number(currentValue);
  if (!Number.isFinite(value)) {
    return res.status(400).json({ error: `Invalid value: ${currentValue}` });
  }
  // valueDate is optional -- only validate it when one is actually
  // provided, and preserve the existing `|| null` handling for an absent one.
  if (valueDate && !isValidCalendarDate(valueDate)) {
    return res.status(400).json({ error: `Invalid date: ${valueDate}` });
  }

  const { accounts } = collections();
  const result = await accounts.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: { currentValue: value, valueDate: valueDate || null, valueUrl: valueUrl || null } },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(result));
}));

module.exports = router;

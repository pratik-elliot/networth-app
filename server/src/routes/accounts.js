const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { toApiAccount, fromApiAccount } = require("../services/accountShape");

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
  const { accounts } = collections();
  const { currentValue, valueDate, valueUrl } = req.body;
  const result = await accounts.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: { currentValue: Number(currentValue), valueDate: valueDate || null, valueUrl: valueUrl || null } },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(result));
}));

module.exports = router;

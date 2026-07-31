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
  const doc = { _id: uuid(), accountId, date, balance: Number(balance) };
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

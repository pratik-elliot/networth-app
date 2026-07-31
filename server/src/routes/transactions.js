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
  const doc = {
    _id: uuid(), accountId, date, description: description || "",
    type, amount: Number(amount),
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
    if (type !== "credit" && type !== "debit") return res.status(400).json({ error: `Invalid type: ${type}` });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: `Invalid amount: ${r && r.amount}` });
    docs.push({
      _id: uuid(), accountId, date, type, amount,
      description: String((r && r.description) || "").slice(0, 500),
    });
  }

  const { transactions } = collections();
  await transactions.insertMany(docs, { ordered: true });
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

const express = require("express");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

/* Full, unrestricted export of everything belonging to the logged-in user. */
router.get("/", asyncHandler(async (req, res) => {
  const { accounts, transactions, balanceLogs } = collections();

  const accountDocs = await accounts.find({ userId: req.userId }).toArray();
  const accountIds = accountDocs.map(a => a._id);

  const [txDocs, balDocs] = await Promise.all([
    accountIds.length ? transactions.find({ accountId: { $in: accountIds } }).sort({ date: -1 }).toArray() : [],
    accountIds.length ? balanceLogs.find({ accountId: { $in: accountIds } }).sort({ date: -1 }).toArray() : [],
  ]);

  // File bytes are excluded deliberately: the export stays a readable JSON
  // document rather than tens of megabytes of base64.
  res.json({
    exportedAt: new Date().toISOString(),
    accounts: accountDocs,
    nominees: accountDocs.flatMap(a => (a.nominees || []).map(n => ({ ...n, accountId: a._id }))),
    transactions: txDocs,
    balanceLogs: balDocs,
  });
}));

module.exports = router;

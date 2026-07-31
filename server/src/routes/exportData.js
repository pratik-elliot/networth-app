const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

/* Full, unrestricted export of everything belonging to the logged-in user. */
router.get("/", (req, res) => {
  const accounts = db.prepare("SELECT * FROM accounts WHERE user_id = ?").all(req.userId);
  const accountIds = accounts.map(a => a.id);
  const placeholders = accountIds.map(() => "?").join(",") || "''";

  const nominees = accountIds.length
    ? db.prepare(`SELECT * FROM nominees WHERE account_id IN (${placeholders})`).all(...accountIds) : [];
  const transactions = accountIds.length
    ? db.prepare(`SELECT * FROM transactions WHERE account_id IN (${placeholders}) ORDER BY date DESC`).all(...accountIds) : [];
  const balanceLogs = accountIds.length
    ? db.prepare(`SELECT * FROM balance_logs WHERE account_id IN (${placeholders}) ORDER BY date DESC`).all(...accountIds) : [];

  res.json({
    exportedAt: new Date().toISOString(),
    accounts, nominees, transactions, balanceLogs,
  });
});

module.exports = router;

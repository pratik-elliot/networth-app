const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function accountBelongsToUser(accountId, userId) {
  return !!db.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
}

router.get("/account/:accountId", (req, res) => {
  if (!accountBelongsToUser(req.params.accountId, req.userId)) return res.status(404).json({ error: "Account not found." });
  const rows = db.prepare("SELECT * FROM balance_logs WHERE account_id = ? ORDER BY date DESC").all(req.params.accountId);
  res.json(rows.map(r => ({ id: r.id, accountId: r.account_id, date: r.date, balance: r.balance })));
});

router.post("/", (req, res) => {
  const { accountId, date, balance } = req.body;
  if (!accountBelongsToUser(accountId, req.userId)) return res.status(404).json({ error: "Account not found." });
  const id = uuid();
  db.prepare("INSERT INTO balance_logs (id, account_id, date, balance) VALUES (?, ?, ?, ?)").run(id, accountId, date, balance);
  res.json({ id, accountId, date, balance });
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM balance_logs WHERE id = ?").get(req.params.id);
  if (!row || !accountBelongsToUser(row.account_id, req.userId)) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM balance_logs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

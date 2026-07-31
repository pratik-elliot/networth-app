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
  const rows = db.prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY date DESC").all(req.params.accountId);
  res.json(rows.map(r => ({ id: r.id, accountId: r.account_id, date: r.date, description: r.description, type: r.type, amount: r.amount })));
});

router.post("/", (req, res) => {
  const { accountId, date, description, type, amount } = req.body;
  if (!accountBelongsToUser(accountId, req.userId)) return res.status(404).json({ error: "Account not found." });
  const id = uuid();
  db.prepare("INSERT INTO transactions (id, account_id, date, description, type, amount) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, accountId, date, description || "", type, amount);
  res.json({ id, accountId, date, description, type, amount });
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(req.params.id);
  if (!row || !accountBelongsToUser(row.account_id, req.userId)) return res.status(404).json({ error: "Not found." });
  db.prepare("DELETE FROM transactions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

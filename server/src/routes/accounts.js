const express = require("express");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function ownedAccount(id, userId) {
  return db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?").get(id, userId);
}

function serializeAccount(row) {
  const nominees = db.prepare("SELECT * FROM nominees WHERE account_id = ?").all(row.id);
  const images = db.prepare("SELECT * FROM account_images WHERE account_id = ?").all(row.id);
  return {
    id: row.id, name: row.name, institution: row.institution, country: row.country,
    currency: row.currency, type: row.type, interestRate: row.interest_rate,
    interestFrequency: row.interest_frequency, lastKYCDate: row.last_kyc_date,
    isLiquid: row.is_liquid === null ? null : !!row.is_liquid, notes: row.notes,
    createdDate: row.created_date, currentValue: row.current_value, valueDate: row.value_date,
    valueUrl: row.value_url, purity: row.purity, form: row.form, quantity: row.quantity,
    city: row.city, vin: row.vin, make: row.make, model: row.model, year: row.year,
    address: row.address,
    nominees: nominees.map(n => ({ id: n.id, name: n.name, relation: n.relation, percent: n.percent })),
    images: images.map(i => ({
      id: i.id, filename: i.filename, url: i.url_path,
      mimeType: i.mime_type || null, sizeBytes: i.size_bytes || null,
    })),
  };
}

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY created_date DESC").all(req.userId);
  res.json(rows.map(serializeAccount));
});

router.get("/:id", (req, res) => {
  const row = ownedAccount(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: "Account not found." });
  res.json(serializeAccount(row));
});

router.post("/", (req, res) => {
  const b = req.body;
  const id = uuid();
  db.prepare(`
    INSERT INTO accounts (id, user_id, name, institution, country, currency, type, interest_rate,
      interest_frequency, last_kyc_date, is_liquid, notes, created_date, current_value, value_date,
      value_url, purity, form, quantity, city, vin, make, model, year, address)
    VALUES (@id, @user_id, @name, @institution, @country, @currency, @type, @interest_rate,
      @interest_frequency, @last_kyc_date, @is_liquid, @notes, @created_date, @current_value, @value_date,
      @value_url, @purity, @form, @quantity, @city, @vin, @make, @model, @year, @address)
  `).run({
    id, user_id: req.userId, name: b.name, institution: b.institution || null, country: b.country || null,
    currency: b.currency, type: b.type, interest_rate: b.interestRate || null,
    interest_frequency: b.interestFrequency || null, last_kyc_date: b.lastKYCDate || null,
    is_liquid: b.isLiquid === null || b.isLiquid === undefined ? null : (b.isLiquid ? 1 : 0),
    notes: b.notes || null, created_date: b.createdDate || new Date().toISOString().slice(0, 10),
    current_value: b.currentValue || null, value_date: b.valueDate || null, value_url: b.valueUrl || null,
    purity: b.purity || null, form: b.form || null, quantity: b.quantity || null, city: b.city || null,
    vin: b.vin || null, make: b.make || null, model: b.model || null, year: b.year || null,
    address: b.address || null,
  });

  (b.nominees || []).forEach(n => {
    db.prepare("INSERT INTO nominees (id, account_id, name, relation, percent) VALUES (?, ?, ?, ?, ?)")
      .run(uuid(), id, n.name, n.relation, n.percent || null);
  });

  res.json(serializeAccount(ownedAccount(id, req.userId)));
});

router.put("/:id", (req, res) => {
  const existing = ownedAccount(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Account not found." });
  const b = req.body;
  db.prepare(`
    UPDATE accounts SET name=@name, institution=@institution, country=@country, currency=@currency,
      type=@type, interest_rate=@interest_rate, interest_frequency=@interest_frequency,
      last_kyc_date=@last_kyc_date, is_liquid=@is_liquid, notes=@notes, current_value=@current_value,
      value_date=@value_date, value_url=@value_url, purity=@purity, form=@form, quantity=@quantity,
      city=@city, vin=@vin, make=@make, model=@model, year=@year, address=@address
    WHERE id=@id AND user_id=@user_id
  `).run({
    id: req.params.id, user_id: req.userId, name: b.name, institution: b.institution || null,
    country: b.country || null, currency: b.currency, type: b.type, interest_rate: b.interestRate || null,
    interest_frequency: b.interestFrequency || null, last_kyc_date: b.lastKYCDate || null,
    is_liquid: b.isLiquid === null || b.isLiquid === undefined ? null : (b.isLiquid ? 1 : 0),
    notes: b.notes || null, current_value: b.currentValue || null, value_date: b.valueDate || null,
    value_url: b.valueUrl || null, purity: b.purity || null, form: b.form || null,
    quantity: b.quantity || null, city: b.city || null, vin: b.vin || null, make: b.make || null,
    model: b.model || null, year: b.year || null, address: b.address || null,
  });

  db.prepare("DELETE FROM nominees WHERE account_id = ?").run(req.params.id);
  (b.nominees || []).forEach(n => {
    db.prepare("INSERT INTO nominees (id, account_id, name, relation, percent) VALUES (?, ?, ?, ?, ?)")
      .run(uuid(), req.params.id, n.name, n.relation, n.percent || null);
  });

  res.json(serializeAccount(ownedAccount(req.params.id, req.userId)));
});

router.delete("/:id", (req, res) => {
  const existing = ownedAccount(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Account not found." });
  db.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?").run(req.params.id, req.userId);
  res.json({ ok: true });
});

/* Log a sourced value update for physically-valued assets (gold, auto, real estate, etc). */
router.post("/:id/update-value", (req, res) => {
  const existing = ownedAccount(req.params.id, req.userId);
  if (!existing) return res.status(404).json({ error: "Account not found." });
  const { currentValue, valueDate, valueUrl } = req.body;
  db.prepare("UPDATE accounts SET current_value=?, value_date=?, value_url=? WHERE id=? AND user_id=?")
    .run(currentValue, valueDate, valueUrl || null, req.params.id, req.userId);
  res.json(serializeAccount(ownedAccount(req.params.id, req.userId)));
});

module.exports = router;

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const db = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authLimiter } = require("../middleware/rateLimit");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Login is a single step: email + password. The emailed one-time code is
// currently disabled, so IP rate limiting (see middleware/rateLimit.js) is what
// guards against password guessing. To restore two-step login, reinstate the
// OTP issue/verify routes — utils/mailer.js and the otp_codes table are both
// still in place for that.

/* Register a new user (email + password). */
router.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const { email, password, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "An account with this email already exists." });

  const id = uuid();
  const hash = await bcrypt.hash(password, 10);
  db.prepare(
    "INSERT INTO users (id, email, phone, password_hash, fx_rate, created_at) VALUES (?, ?, ?, ?, 83, ?)"
  ).run(id, email.toLowerCase(), phone || null, hash, new Date().toISOString());

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id, email: email.toLowerCase(), phone } });
}));

/* Log in with email + password, issuing a session token directly. */
router.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase());
  // Same message whether the address is unknown or the password is wrong, so
  // the response cannot be used to discover which emails have accounts.
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, phone: user.phone, fxRate: user.fx_rate } });
}));

/* Current user info + settings. */
router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, phone, fx_rate FROM users WHERE id = ?").get(req.userId);
  res.json({ id: user.id, email: user.email, phone: user.phone, fxRate: user.fx_rate });
});

router.put("/me", requireAuth, (req, res) => {
  const { phone, fxRate } = req.body;
  db.prepare("UPDATE users SET phone = ?, fx_rate = ? WHERE id = ?").run(phone || null, fxRate || 83, req.userId);
  res.json({ ok: true });
});

module.exports = router;

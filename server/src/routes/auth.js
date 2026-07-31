const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { sendOtpEmail } = require("../utils/mailer");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function makeOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

/* Register a new user (email + password). No OTP needed at signup. */
router.post("/register", async (req, res) => {
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
});

/* Step 1 of login: verify password, then email a one-time code. */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get((email || "").toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  const code = makeOtp();
  const ttlMin = Number(process.env.OTP_TTL_MINUTES || 10);
  const expiresAt = new Date(Date.now() + ttlMin * 60000).toISOString();
  db.prepare(
    "INSERT INTO otp_codes (id, user_id, code, purpose, expires_at, created_at) VALUES (?, ?, ?, 'login', ?, ?)"
  ).run(uuid(), user.id, code, expiresAt, new Date().toISOString());

  const result = await sendOtpEmail(user.email, code);
  res.json({
    message: result.devMode
      ? "Password verified. SMTP isn't configured, so the code was printed to the server console instead of emailed."
      : "Password verified. A verification code has been emailed to you.",
    userId: user.id,
    devMode: result.devMode,
  });
});

/* Step 2 of login: verify the OTP code, issue a session token. */
router.post("/verify-otp", (req, res) => {
  const { userId, code } = req.body;
  const row = db
    .prepare(
      "SELECT * FROM otp_codes WHERE user_id = ? AND purpose = 'login' AND consumed = 0 ORDER BY created_at DESC LIMIT 1"
    )
    .get(userId);
  if (!row) return res.status(400).json({ error: "No pending verification code. Please log in again." });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: "Code expired. Please log in again." });
  if (row.code !== String(code)) return res.status(400).json({ error: "Incorrect code." });

  db.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").run(row.id);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, phone: user.phone, fxRate: user.fx_rate } });
});

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

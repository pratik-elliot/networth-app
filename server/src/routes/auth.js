const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { authLimiter } = require("../middleware/rateLimit");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Login is a single step: email + password. The emailed one-time code is
// currently disabled, so IP rate limiting (see middleware/rateLimit.js) is what
// guards against password guessing. To restore two-step login, reinstate the
// OTP issue/verify routes — utils/mailer.js and the otpCodes collection are
// both still in place for that.

/* Register a new user (email + password). */
router.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const { email, password, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  const { users } = collections();
  const lower = email.toLowerCase();
  if (await users.findOne({ email: lower })) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const id = uuid();
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    await users.insertOne({
      _id: id,
      email: lower,
      phone: phone || null,
      passwordHash,
      fxRate: 83,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // The findOne check above handles the common case, but two concurrent
    // registrations for the same email can both pass it before either insert
    // runs. The unique index on users.email (see db.js) then rejects the
    // losing insert with a duplicate-key error (code 11000) -- surface that
    // as the same 409 the pre-check returns, instead of letting it fall
    // through to the generic 500 error handler. Anything else still propagates.
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    throw err;
  }

  const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id, email: lower, phone } });
}));

/* Log in with email + password, issuing a session token directly. */
router.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const { users } = collections();
  const user = await users.findOne({ email: String(email || "").toLowerCase() });
  // Same message whether the address is unknown or the password is wrong, so
  // the response cannot be used to discover which emails have accounts.
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid email or password." });

  const token = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user._id, email: user.email, phone: user.phone, fxRate: user.fxRate } });
}));

/* Current user info + settings. */
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const { users } = collections();
  const user = await users.findOne({ _id: req.userId });
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ id: user._id, email: user.email, phone: user.phone, fxRate: user.fxRate });
}));

router.put("/me", requireAuth, asyncHandler(async (req, res) => {
  const { phone, fxRate } = req.body;
  const { users } = collections();
  await users.updateOne(
    { _id: req.userId },
    { $set: { phone: phone || null, fxRate: Number(fxRate) || 83 } }
  );
  res.json({ ok: true });
}));

module.exports = router;

const express = require("express");
const multer = require("multer");
const { collections } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { importLimiter } = require("../middleware/rateLimit");
const statementText = require("../services/statementText");
const statementExtract = require("../services/statementExtract");
const { normalise } = require("../services/normaliseTransactions");

const router = express.Router();
router.use(requireAuth);

// Statements are parsed in memory and never written to disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

function duplicateKey(date, amount, description) {
  return `${date}|${Number(amount).toFixed(2)}|${String(description || "").trim().toLowerCase()}`;
}

router.get("/status", (req, res) => res.json({ configured: statementExtract.isConfigured() }));

async function handleParse(req, res, uploadErr) {
  if (uploadErr) {
    const msg = uploadErr.code === "LIMIT_FILE_SIZE"
      ? "That statement is larger than 15MB."
      : uploadErr.message || "Upload failed.";
    return res.status(400).json({ error: msg });
  }
  // Awaited deliberately: an un-awaited Promise is truthy and would let any
  // logged-in user read another user's account.
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (!req.file) return res.status(400).json({ error: "No statement file was received." });

  let text;
  try {
    // req.body.password comes from a text part in the same multipart request.
    // It is used once, here, and never logged, stored, or forwarded upstream.
    const password = typeof req.body?.password === "string" && req.body.password !== ""
      ? req.body.password
      : undefined;
    ({ text } = await statementText.extractText(req.file.buffer, req.file.originalname, { password }));
  } catch (e) {
    // e.code is PASSWORD_REQUIRED or PASSWORD_INCORRECT for the encrypted-PDF
    // cases, so the UI can prompt instead of showing a dead end.
    const body = { error: e.message };
    if (e.code) body.code = e.code;
    return res.status(400).json(body);
  }

  let rawRows;
  try {
    rawRows = await statementExtract.extractTransactions(text);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const { rows, rejected, dateOrderAssumed } = normalise(rawRows);

  const { transactions } = collections();
  const existing = new Set(
    (await transactions.find({ accountId: req.params.accountId }).toArray())
      .map(r => duplicateKey(r.date, r.amount, r.description))
  );

  res.json({
    rows: rows.map(r => ({ ...r, duplicate: existing.has(duplicateKey(r.date, r.amount, r.description)) })),
    rejected,
    dateOrderAssumed,
  });
}

router.post("/parse/:accountId", importLimiter, (req, res, next) => {
  // multer's callback receives only (err), so asyncHandler cannot wrap it
  // directly — forward rejections to Express ourselves instead.
  upload.single("statement")(req, res, (err) => {
    handleParse(req, res, err).catch(next);
  });
});

module.exports = router;

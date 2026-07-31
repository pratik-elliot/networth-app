const express = require("express");
const multer = require("multer");
const path = require("path");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Atlas' free tier allows 512MB in total, so attachments are deliberately
// smaller than the old 25MB disk limit.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 10;

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".pdf", ".csv", ".xls", ".xlsx", ".doc", ".docx", ".txt",
]);

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
  cb(new Error(`"${file.originalname}" isn't a supported file type. Allowed: images, PDF, CSV, Excel, Word, and text files.`));
}

// Held in memory only long enough to write into MongoDB.
const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: MAX_FILE_BYTES } });

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

async function handleUpload(req, res, uploadErr) {
  if (uploadErr) {
    const msg = uploadErr.code === "LIMIT_FILE_SIZE"
      ? `Each file must be under ${MAX_FILE_BYTES / (1024 * 1024)}MB.`
      : uploadErr.code === "LIMIT_FILE_COUNT"
        ? `You can upload at most ${MAX_FILES} files at a time.`
        : uploadErr.message || "Upload failed.";
    return res.status(400).json({ error: msg });
  }
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files were received." });
  }

  const { accounts, attachments } = collections();
  const meta = [];
  for (const f of req.files) {
    const id = uuid();
    await attachments.insertOne({
      _id: id,
      accountId: req.params.accountId,
      filename: f.originalname,
      mimeType: f.mimetype || "application/octet-stream",
      data: f.buffer,
    });
    meta.push({
      id,
      filename: f.originalname,
      mimeType: f.mimetype || null,
      sizeBytes: f.size || null,
      uploadedAt: new Date().toISOString(),
    });
  }

  // Metadata is embedded on the account so listing accounts needs no extra query.
  await accounts.updateOne({ _id: req.params.accountId }, { $push: { images: { $each: meta } } });

  res.json(meta.map(m => ({ ...m, url: `/api/attachments/${m.id}` })));
}

router.post("/account/:accountId", (req, res, next) => {
  // multer's callback receives only (err), so asyncHandler cannot wrap it
  // directly — forward rejections to Express ourselves instead.
  upload.array("images", MAX_FILES)(req, res, (err) => {
    handleUpload(req, res, err).catch(next);
  });
});

/* Serving through the API rather than a static mount means a file can only be
   read by the account's owner, not by anyone who happens to have the URL. */
router.get("/:id", asyncHandler(async (req, res) => {
  const { attachments } = collections();
  const doc = await attachments.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`);
  res.send(doc.data.buffer ? Buffer.from(doc.data.buffer) : doc.data);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { accounts, attachments } = collections();
  const doc = await attachments.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  await attachments.deleteOne({ _id: req.params.id });
  await accounts.updateOne({ _id: doc.accountId }, { $pull: { images: { id: req.params.id } } });
  res.json({ ok: true });
}));

module.exports = router;

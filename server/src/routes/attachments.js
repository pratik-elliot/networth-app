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

// Fallback for RFC 6266 §4.3's `filename` parameter: browsers that ignore
// `filename*` treat this as a literal quoted-string, never percent-decoding
// it, so percent-encoding here (as encodeURIComponent would) is the wrong
// tool -- it would save "my report.pdf" to disk as "my%20report.pdf". Strip
// non-ASCII and anything that would break out of the quotes instead.
function safeAsciiFilename(filename) {
  return filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

// encodeURIComponent leaves `!'()*` unescaped, but RFC 5987's attr-char
// (used by the `filename*` parameter) excludes them -- encode those few by
// hand so the value is unambiguous to a strict parser.
function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(/['()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A");
}

// Emits both parameters so every browser gets a correct filename: legacy
// UA's fall back to the sanitised ASCII `filename`, modern ones prefer the
// UTF-8, percent-encoded `filename*`. Both branches only ever emit
// printable-ASCII or percent-escaped bytes, so control characters (CR/LF)
// can't break out of the header.
function contentDisposition(filename) {
  return `inline; filename="${safeAsciiFilename(filename)}"; filename*=UTF-8''${encodeRFC5987ValueChars(filename)}`;
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
  // A real MongoDB read hands attachment bytes back wrapped in a BSON
  // Binary, whose `.buffer` is a Buffer already sized to exactly the stored
  // content (confirmed against a real BSON encode/decode round trip). But if
  // `data` is ever a plain Buffer instead -- a driver option such as
  // promoteBuffers, or a future caching layer -- that same `.buffer` access
  // returns the *entire* underlying, possibly pooled ArrayBuffer, which can
  // be up to 8KB and contain bytes left over from unrelated requests.
  // Buffer.isBuffer() lets a plain Buffer be sent as-is, sidestepping that
  // ArrayBuffer entirely instead of reaching for `.buffer` unconditionally.
  const bytes = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer);
  res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
  // mimeType is client-supplied and this is served inline, so tell browsers
  // not to sniff/execute the body as something else (e.g. HTML) no matter
  // what mimeType claims.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", contentDisposition(doc.filename));
  // Attachment bytes never change after upload (there is no update route)
  // and access is already gated by requireAuth + the ownership check above,
  // so a private, long-lived cache is safe. Without this, every thumbnail
  // and every remounted <Attachment> re-fetches full bytes through
  // /api/attachments, which now competes with everything else for the
  // shared apiLimiter budget that the old public /uploads mount never
  // touched.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  // A browser HTTP cache keys on URL + method, NOT on request headers,
  // unless Vary says otherwise. Without this, logging out (this app never
  // reloads the page on logout -- see client/src/App.jsx) would not evict a
  // cached response, so a later request for the same URL from a different
  // logged-in user on a shared device could be served straight out of the
  // cache, bypassing the ownership check above entirely. Keying the cache on
  // Authorization makes a credential change a cache-miss, the same way the
  // check itself works today.
  res.setHeader("Vary", "Authorization");
  res.send(bytes);
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

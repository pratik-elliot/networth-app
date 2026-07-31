const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { uploadDir } = require("../paths");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

fs.mkdirSync(uploadDir, { recursive: true });

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — statements and scanned PDFs run large
const MAX_FILES = 10;

// Documents (statements, valuations, certificates) are attached alongside
// photos, so the allowlist covers spreadsheets and PDFs as well as images.
const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".pdf", ".csv", ".xls", ".xlsx", ".doc", ".docx", ".txt",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
  cb(new Error(`"${file.originalname}" isn't a supported file type. Allowed: images, PDF, CSV, Excel, Word, and text files.`));
}

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES } });

function accountBelongsToUser(accountId, userId) {
  return !!db.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
}

// The wire field name is "images" for backwards compatibility; the feature now
// covers documents too.
const receiveFiles = upload.array("images", MAX_FILES);

router.post("/account/:accountId", (req, res) => {
  receiveFiles(req, res, (err) => {
    if (err) {
      // Without this, multer rejections fall through to the generic 500
      // handler and the user gets no idea what went wrong.
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? `Each file must be under ${MAX_FILE_BYTES / (1024 * 1024)}MB.`
        : err.code === "LIMIT_FILE_COUNT"
          ? `You can upload at most ${MAX_FILES} files at a time.`
          : err.message || "Upload failed.";
      return res.status(400).json({ error: msg });
    }

    if (!accountBelongsToUser(req.params.accountId, req.userId)) {
      return res.status(404).json({ error: "Account not found." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files were received." });
    }

    const saved = req.files.map(f => {
      const id = uuid();
      const urlPath = `/uploads/${f.filename}`;
      db.prepare(`
        INSERT INTO account_images (id, account_id, filename, url_path, mime_type, size_bytes, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.params.accountId, f.originalname, urlPath, f.mimetype || null, f.size || null, new Date().toISOString());
      return { id, filename: f.originalname, url: urlPath, mimeType: f.mimetype || null, sizeBytes: f.size || null };
    });
    res.json(saved);
  });
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM account_images WHERE id = ?").get(req.params.id);
  if (!row || !accountBelongsToUser(row.account_id, req.userId)) return res.status(404).json({ error: "Not found." });
  const filePath = path.join(uploadDir, path.basename(row.url_path));
  fs.unlink(filePath, () => {});
  db.prepare("DELETE FROM account_images WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

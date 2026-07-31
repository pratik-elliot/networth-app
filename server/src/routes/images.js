const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB per image

function accountBelongsToUser(accountId, userId) {
  return !!db.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
}

router.post("/account/:accountId", upload.array("images", 10), (req, res) => {
  if (!accountBelongsToUser(req.params.accountId, req.userId)) return res.status(404).json({ error: "Account not found." });
  const saved = (req.files || []).map(f => {
    const id = uuid();
    const urlPath = `/uploads/${f.filename}`;
    db.prepare("INSERT INTO account_images (id, account_id, filename, url_path, uploaded_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, req.params.accountId, f.originalname, urlPath, new Date().toISOString());
    return { id, filename: f.originalname, url: urlPath };
  });
  res.json(saved);
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

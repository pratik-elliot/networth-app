const path = require("path");
require("dotenv").config();

// Single source of truth for where uploaded files live. Both the static file
// server (index.js) and the upload handler (routes/images.js) must resolve to
// the same directory — if they disagree, uploads succeed but 404 when fetched.
// A relative UPLOAD_DIR is resolved against the process CWD, which on Render is
// the repo root, not the server/ directory.
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads"));

module.exports = { uploadDir };

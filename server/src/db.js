const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const dbPath = process.env.DB_PATH || "./data/networth.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  fx_rate REAL DEFAULT 83,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  institution TEXT,
  country TEXT,
  currency TEXT NOT NULL,
  type TEXT NOT NULL,
  interest_rate REAL,
  interest_frequency TEXT,
  last_kyc_date TEXT,
  is_liquid INTEGER,
  notes TEXT,
  created_date TEXT,
  current_value REAL,
  value_date TEXT,
  value_url TEXT,
  purity TEXT,
  form TEXT,
  quantity REAL,
  city TEXT,
  vin TEXT,
  make TEXT,
  model TEXT,
  year TEXT,
  address TEXT
);

CREATE TABLE IF NOT EXISTS nominees (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  relation TEXT,
  percent REAL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  balance REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS account_images (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename TEXT,
  url_path TEXT,
  uploaded_at TEXT
);
`);

// Added when attachments grew beyond images to PDFs/spreadsheets; databases
// created before that need the columns backfilled.
function addColumnIfMissing(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing("account_images", "mime_type", "TEXT");
addColumnIfMissing("account_images", "size_bytes", "INTEGER");

module.exports = db;

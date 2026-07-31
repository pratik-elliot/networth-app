# MongoDB Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every piece of persisted data from the ephemeral SQLite file on Render to MongoDB Atlas, so the ledger survives redeploys — and remove `better-sqlite3` so the server runs locally on Windows.

**Architecture:** One `mongodb` driver connection created at startup and shared. Existing UUID string ids stay as `_id`, so the JSON the client already consumes does not change at all. Nominees and attachment metadata are embedded inside their account document (always read together, bounded in size); transactions and balance logs stay in their own collections because they grow without bound. Attachment bytes move into MongoDB and are served through an authenticated route, replacing the public `/uploads` static mount.

**Tech Stack:** Node 20, Express 4, `mongodb` driver v6, MongoDB Atlas, Node's built-in `node:test`.

## Global Constraints

- **The API response shape must not change.** The client is not modified by this plan. Every endpoint returns exactly the fields it returns today (`id`, not `_id`).
- Ids remain UUID v4 **strings** stored as `_id`. Do not introduce `ObjectId`.
- `better-sqlite3` MUST be removed from `server/package.json`. It cannot compile on Windows and is what currently blocks local development.
- The Mongo driver is **async**. Every route handler that touches the database becomes `async` and MUST be wrapped in `asyncHandler` (`server/src/utils/asyncHandler.js`). An unhandled rejection kills the process on Node 20 — this already caused an outage.
- SQLite `ON DELETE CASCADE` does not exist in MongoDB. Deleting an account MUST explicitly delete its transactions and balance logs. Deleting a user MUST delete their accounts and everything under them.
- `MONGODB_URI` is read from the environment only. Never commit it. `server/.env` is gitignored.
- Atlas free tier allows 512 MB total storage. Attachments are capped at 8 MB each for this reason.
- Money is stored as a BSON double via plain JS numbers, matching current behaviour. Never store amounts as strings.

## Collections

| Collection | Shape |
| --- | --- |
| `users` | `{ _id, email, phone, passwordHash, fxRate, createdAt }` |
| `accounts` | `{ _id, userId, name, institution, country, currency, type, interestRate, interestFrequency, lastKYCDate, isLiquid, notes, createdDate, currentValue, valueDate, valueUrl, purity, form, quantity, city, vin, make, model, year, address, nominees: [{ id, name, relation, percent }], images: [{ id, filename, mimeType, sizeBytes, uploadedAt }] }` |
| `transactions` | `{ _id, accountId, date, description, type, amount }` |
| `balanceLogs` | `{ _id, accountId, date, balance }` |
| `attachments` | `{ _id, accountId, data: Binary, mimeType, filename }` |
| `otpCodes` | `{ _id, userId, code, purpose, expiresAt, consumed, createdAt }` — retained unused so two-step login can be restored |

Indexes: `users.email` unique; `accounts.userId`; `transactions.accountId`; `balanceLogs.accountId`; `attachments.accountId`.

---

### Task 1: Mongo connection module

**Files:**
- Modify: `server/package.json` (add `mongodb`, remove `better-sqlite3`)
- Create: `server/src/db.js` (replaces the SQLite version entirely)
- Modify: `server/src/index.js`
- Test: `server/test/db.test.js`

**Interfaces:**
- Produces:
  - `connect() -> Promise<void>` — connects and ensures indexes. Called once at startup.
  - `close() -> Promise<void>`
  - `collections() -> { users, accounts, transactions, balanceLogs, attachments, otpCodes }` — throws if called before `connect()`.

- [ ] **Step 1: Swap the dependency**

In `server/package.json`, delete the `"better-sqlite3"` line from `dependencies` and add:

```json
    "mongodb": "^6.10.0",
```

Then run: `cd server && rm -rf node_modules package-lock.json && npm install`

This must now succeed on Windows, because no dependency requires a native build.

- [ ] **Step 2: Write the failing test**

Create `server/test/db.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { collections } = require("../src/db");

test("collections() refuses to hand out handles before connect()", () => {
  assert.throws(() => collections(), /not connected/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `db.js` still exports the SQLite instance, so `collections` is not a function.

- [ ] **Step 4: Replace db.js**

Replace the entire contents of `server/src/db.js` with:

```js
const { MongoClient } = require("mongodb");
require("dotenv").config();

const DB_NAME = process.env.MONGODB_DB || "networth";

let client = null;
let db = null;

async function connect() {
  if (db) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. The server cannot start without a database.");

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);

  // Idempotent: createIndex is a no-op when the index already exists.
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("accounts").createIndex({ userId: 1 }),
    db.collection("transactions").createIndex({ accountId: 1 }),
    db.collection("balanceLogs").createIndex({ accountId: 1 }),
    db.collection("attachments").createIndex({ accountId: 1 }),
  ]);
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

function collections() {
  if (!db) throw new Error("Database is not connected yet.");
  return {
    users: db.collection("users"),
    accounts: db.collection("accounts"),
    transactions: db.collection("transactions"),
    balanceLogs: db.collection("balanceLogs"),
    attachments: db.collection("attachments"),
    otpCodes: db.collection("otpCodes"),
  };
}

module.exports = { connect, close, collections };
```

- [ ] **Step 5: Start the server only after the database is ready**

In `server/src/index.js`, replace the final listen block:

```js
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Net Worth Ledger API listening on port ${PORT}`));
```

with:

```js
const PORT = process.env.PORT || 4000;

// Serving requests before the database is connected would return confusing
// errors, so connect first and fail loudly if it is unreachable.
db.connect()
  .then(() => {
    app.listen(PORT, () => console.log(`Net Worth Ledger API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Could not connect to MongoDB:", err.message);
    process.exit(1);
  });
```

and add near the other requires at the top:

```js
const db = require("./db");
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/db.js server/src/index.js server/test/db.test.js
git commit -m "Replace SQLite with a MongoDB connection module"
```

---

### Task 2: Auth routes on MongoDB

**Files:**
- Modify: `server/src/routes/auth.js`

**Interfaces:**
- Consumes: `collections()` from Task 1.
- Produces: unchanged HTTP contract — `POST /register`, `POST /login`, `GET /me`, `PUT /me`.

- [ ] **Step 1: Rewrite the route file**

Replace the contents of `server/src/routes/auth.js` with:

```js
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
  await users.insertOne({
    _id: id,
    email: lower,
    phone: phone || null,
    passwordHash,
    fxRate: 83,
    createdAt: new Date().toISOString(),
  });

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
```

- [ ] **Step 2: Verify it parses**

Run: `cd server && node --check src/routes/auth.js`
Expected: no output

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/auth.js
git commit -m "Move auth routes to MongoDB"
```

---

### Task 3: Accounts routes on MongoDB

**Files:**
- Modify: `server/src/routes/accounts.js`
- Create: `server/src/services/accountShape.js`
- Test: `server/test/accountShape.test.js`

**Interfaces:**
- Consumes: `collections()` from Task 1.
- Produces:
  - `toApiAccount(doc) -> object` — maps a stored account document to the exact JSON the client expects.
  - `fromApiAccount(body) -> object` — maps request body fields onto storage fields.
  - Unchanged HTTP contract for `/api/accounts`.

- [ ] **Step 1: Write the failing test**

Create `server/test/accountShape.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { toApiAccount, fromApiAccount } = require("../src/services/accountShape");

test("toApiAccount exposes _id as id and never leaks _id or userId", () => {
  const out = toApiAccount({
    _id: "abc", userId: "u1", name: "HDFC", currency: "INR", type: "bank",
    nominees: [], images: [],
  });
  assert.strictEqual(out.id, "abc");
  assert.strictEqual(out._id, undefined);
  assert.strictEqual(out.userId, undefined);
});

test("toApiAccount defaults missing nominees and images to empty arrays", () => {
  const out = toApiAccount({ _id: "a", name: "X", currency: "USD", type: "bank" });
  assert.deepStrictEqual(out.nominees, []);
  assert.deepStrictEqual(out.images, []);
});

test("toApiAccount preserves isLiquid null rather than coercing it to false", () => {
  assert.strictEqual(toApiAccount({ _id: "a", isLiquid: null }).isLiquid, null);
  assert.strictEqual(toApiAccount({ _id: "a", isLiquid: true }).isLiquid, true);
  assert.strictEqual(toApiAccount({ _id: "a", isLiquid: false }).isLiquid, false);
});

test("fromApiAccount turns blank optional fields into null", () => {
  const out = fromApiAccount({ name: "X", currency: "INR", type: "bank", institution: "" });
  assert.strictEqual(out.institution, null);
});

test("fromApiAccount keeps numeric fields numeric", () => {
  const out = fromApiAccount({ name: "X", currency: "INR", type: "gold", quantity: "2.5", currentValue: "1000" });
  assert.strictEqual(out.quantity, 2.5);
  assert.strictEqual(out.currentValue, 1000);
});

test("fromApiAccount normalises nominees and gives each an id", () => {
  const out = fromApiAccount({ name: "X", currency: "INR", type: "bank",
    nominees: [{ name: "A", relation: "son", percent: "50" }] });
  assert.strictEqual(out.nominees.length, 1);
  assert.strictEqual(out.nominees[0].percent, 50);
  assert.ok(out.nominees[0].id);
});

test("fromApiAccount never lets a client set id or userId", () => {
  const out = fromApiAccount({ id: "evil", _id: "evil", userId: "evil", name: "X", currency: "INR", type: "bank" });
  assert.strictEqual(out._id, undefined);
  assert.strictEqual(out.userId, undefined);
  assert.strictEqual(out.id, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/accountShape'`

- [ ] **Step 3: Implement the mapper**

Create `server/src/services/accountShape.js`:

```js
const { v4: uuid } = require("uuid");

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  if (v === "" || v === null || v === undefined) return null;
  return String(v);
}

/* Storage document -> the exact JSON the client already consumes. */
function toApiAccount(doc) {
  const d = doc || {};
  return {
    id: d._id,
    name: d.name,
    institution: d.institution ?? null,
    country: d.country ?? null,
    currency: d.currency,
    type: d.type,
    interestRate: d.interestRate ?? null,
    interestFrequency: d.interestFrequency ?? null,
    lastKYCDate: d.lastKYCDate ?? null,
    isLiquid: d.isLiquid === undefined ? null : d.isLiquid,
    notes: d.notes ?? null,
    createdDate: d.createdDate ?? null,
    currentValue: d.currentValue ?? null,
    valueDate: d.valueDate ?? null,
    valueUrl: d.valueUrl ?? null,
    purity: d.purity ?? null,
    form: d.form ?? null,
    quantity: d.quantity ?? null,
    city: d.city ?? null,
    vin: d.vin ?? null,
    make: d.make ?? null,
    model: d.model ?? null,
    year: d.year ?? null,
    address: d.address ?? null,
    nominees: (d.nominees || []).map(n => ({ id: n.id, name: n.name, relation: n.relation, percent: n.percent ?? null })),
    images: (d.images || []).map(i => ({
      id: i.id,
      filename: i.filename,
      url: `/api/attachments/${i.id}`,
      mimeType: i.mimeType ?? null,
      sizeBytes: i.sizeBytes ?? null,
    })),
  };
}

/* Request body -> storage fields. Deliberately ignores id/_id/userId so a
   client cannot reassign ownership of a record. */
function fromApiAccount(b) {
  const body = b || {};
  return {
    name: body.name,
    institution: str(body.institution),
    country: str(body.country),
    currency: body.currency,
    type: body.type,
    interestRate: num(body.interestRate),
    interestFrequency: str(body.interestFrequency),
    lastKYCDate: str(body.lastKYCDate),
    isLiquid: body.isLiquid === null || body.isLiquid === undefined ? null : !!body.isLiquid,
    notes: str(body.notes),
    currentValue: num(body.currentValue),
    valueDate: str(body.valueDate),
    valueUrl: str(body.valueUrl),
    purity: str(body.purity),
    form: str(body.form),
    quantity: num(body.quantity),
    city: str(body.city),
    vin: str(body.vin),
    make: str(body.make),
    model: str(body.model),
    year: str(body.year),
    address: str(body.address),
    nominees: (body.nominees || []).map(n => ({
      id: n.id || uuid(),
      name: n.name,
      relation: n.relation,
      percent: num(n.percent),
    })),
  };
}

module.exports = { toApiAccount, fromApiAccount };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Rewrite the accounts routes**

Replace the contents of `server/src/routes/accounts.js` with:

```js
const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { toApiAccount, fromApiAccount } = require("../services/accountShape");

const router = express.Router();
router.use(requireAuth);

router.get("/", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const docs = await accounts.find({ userId: req.userId }).sort({ createdDate: -1 }).toArray();
  res.json(docs.map(toApiAccount));
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const doc = await accounts.findOne({ _id: req.params.id, userId: req.userId });
  if (!doc) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(doc));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const id = uuid();
  const doc = {
    _id: id,
    userId: req.userId,
    ...fromApiAccount(req.body),
    createdDate: req.body.createdDate || new Date().toISOString().slice(0, 10),
    images: [],
  };
  await accounts.insertOne(doc);
  res.json(toApiAccount(doc));
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const update = fromApiAccount(req.body);
  const result = await accounts.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: update },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(result));
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { accounts, transactions, balanceLogs, attachments } = collections();
  const existing = await accounts.findOne({ _id: req.params.id, userId: req.userId });
  if (!existing) return res.status(404).json({ error: "Account not found." });

  // MongoDB has no ON DELETE CASCADE, so everything belonging to this account
  // must be removed explicitly or it is orphaned forever.
  await Promise.all([
    transactions.deleteMany({ accountId: req.params.id }),
    balanceLogs.deleteMany({ accountId: req.params.id }),
    attachments.deleteMany({ accountId: req.params.id }),
  ]);
  await accounts.deleteOne({ _id: req.params.id, userId: req.userId });
  res.json({ ok: true });
}));

/* Log a sourced value update for physically-valued assets (gold, auto, real estate, etc). */
router.post("/:id/update-value", asyncHandler(async (req, res) => {
  const { accounts } = collections();
  const { currentValue, valueDate, valueUrl } = req.body;
  const result = await accounts.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    { $set: { currentValue: Number(currentValue), valueDate: valueDate || null, valueUrl: valueUrl || null } },
    { returnDocument: "after" }
  );
  if (!result) return res.status(404).json({ error: "Account not found." });
  res.json(toApiAccount(result));
}));

module.exports = router;
```

- [ ] **Step 6: Verify it parses and tests still pass**

Run: `cd server && node --check src/routes/accounts.js && npm test`
Expected: no parse output, tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/accounts.js server/src/services/accountShape.js server/test/accountShape.test.js
git commit -m "Move accounts routes to MongoDB"
```

---

### Task 4: Transactions and balances on MongoDB

**Files:**
- Modify: `server/src/routes/transactions.js`
- Modify: `server/src/routes/balances.js`

**Interfaces:**
- Consumes: `collections()` from Task 1.
- Produces: unchanged contracts, plus `POST /api/transactions/bulk` accepting `{ accountId, rows }` and returning `{ inserted: number }` (used later by statement import).

- [ ] **Step 1: Rewrite transactions.js**

Replace the contents of `server/src/routes/transactions.js` with:

```js
const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

function toApi(doc) {
  return {
    id: doc._id, accountId: doc.accountId, date: doc.date,
    description: doc.description, type: doc.type, amount: doc.amount,
  };
}

router.get("/account/:accountId", asyncHandler(async (req, res) => {
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const { transactions } = collections();
  const docs = await transactions.find({ accountId: req.params.accountId }).sort({ date: -1 }).toArray();
  res.json(docs.map(toApi));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accountId, date, description, type, amount } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const doc = {
    _id: uuid(), accountId, date, description: description || "",
    type, amount: Number(amount),
  };
  const { transactions } = collections();
  await transactions.insertOne(doc);
  res.json(toApi(doc));
}));

/* Insert many transactions at once, for confirmed statement imports. */
router.post("/bulk", asyncHandler(async (req, res) => {
  const { accountId, rows } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No transactions to import." });
  if (rows.length > 2000) return res.status(400).json({ error: "Too many rows in one import (limit 2000)." });

  // The client preview is never trusted on the way back in.
  const docs = [];
  for (const r of rows) {
    const date = String((r && r.date) || "");
    const type = String((r && r.type) || "");
    const amount = Number(r && r.amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
    if (type !== "credit" && type !== "debit") return res.status(400).json({ error: `Invalid type: ${type}` });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: `Invalid amount: ${r && r.amount}` });
    docs.push({
      _id: uuid(), accountId, date, type, amount,
      description: String((r && r.description) || "").slice(0, 500),
    });
  }

  const { transactions } = collections();
  await transactions.insertMany(docs, { ordered: true });
  res.json({ inserted: docs.length });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { transactions } = collections();
  const doc = await transactions.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  await transactions.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 2: Rewrite balances.js**

Replace the contents of `server/src/routes/balances.js` with:

```js
const express = require("express");
const { v4: uuid } = require("uuid");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

router.get("/account/:accountId", asyncHandler(async (req, res) => {
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const { balanceLogs } = collections();
  const docs = await balanceLogs.find({ accountId: req.params.accountId }).sort({ date: -1 }).toArray();
  res.json(docs.map(d => ({ id: d._id, accountId: d.accountId, date: d.date, balance: d.balance })));
}));

router.post("/", asyncHandler(async (req, res) => {
  const { accountId, date, balance } = req.body;
  if (!(await accountBelongsToUser(accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  const doc = { _id: uuid(), accountId, date, balance: Number(balance) };
  const { balanceLogs } = collections();
  await balanceLogs.insertOne(doc);
  res.json({ id: doc._id, accountId, date, balance: doc.balance });
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const { balanceLogs } = collections();
  const doc = await balanceLogs.findOne({ _id: req.params.id });
  if (!doc || !(await accountBelongsToUser(doc.accountId, req.userId))) {
    return res.status(404).json({ error: "Not found." });
  }
  await balanceLogs.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 3: Verify both parse**

Run: `cd server && node --check src/routes/transactions.js && node --check src/routes/balances.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/transactions.js server/src/routes/balances.js
git commit -m "Move transactions and balances to MongoDB, add bulk insert"
```

---

### Task 5: Attachments stored in MongoDB and served with auth

**Files:**
- Create: `server/src/routes/attachments.js`
- Delete: `server/src/routes/images.js`
- Delete: `server/src/paths.js`
- Modify: `server/src/index.js`
- Modify: `client/src/api.js`

**Interfaces:**
- Consumes: `collections()` from Task 1.
- Produces:
  - `POST /api/attachments/account/:accountId` (multipart, field `images`) -> `[{ id, filename, url, mimeType, sizeBytes }]`
  - `GET /api/attachments/:id` -> the file bytes, requires auth
  - `DELETE /api/attachments/:id` -> `{ ok: true }`

Files now live in MongoDB rather than on disk, so they survive redeploys and are no longer readable by anyone holding the URL.

- [ ] **Step 1: Create the attachments route**

Create `server/src/routes/attachments.js`:

```js
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
```

- [ ] **Step 2: Remove the disk-based route and path helper**

```bash
git rm server/src/routes/images.js server/src/paths.js
```

- [ ] **Step 3: Update index.js**

In `server/src/index.js`:

- Delete the line `const { uploadDir } = require("./paths");`
- Delete the line `const imageRoutes = require("./routes/images");`
- Delete the line `app.use("/uploads", express.static(uploadDir));`
- Delete the line `app.use("/api/images", imageRoutes);`
- Delete the now-unused `const fs = require("fs");` only if nothing else uses it (the client-dist check still does — keep it).
- Add alongside the other route requires: `const attachmentRoutes = require("./routes/attachments");`
- Add alongside the other route mounts: `app.use("/api/attachments", attachmentRoutes);`
- In the SPA fallback regex, change `/^\/(?!api|uploads).*/` to `/^\/(?!api).*/` since `/uploads` no longer exists.

- [ ] **Step 4: Point the client at the new endpoints**

In `client/src/api.js`, replace the `uploadFiles` and `deleteFile` methods with:

```js
  uploadFiles: (accountId, files) => {
    const fd = new FormData();
    Array.from(files).forEach(f => fd.append("images", f));
    return fetch(`${BASE}/api/attachments/account/${accountId}`, { method: "POST", headers: authHeaders(), body: fd }).then(handle);
  },
  deleteFile: (id) => fetch(`${BASE}/api/attachments/${id}`, { method: "DELETE", headers: authHeaders() }).then(handle),
```

Attachment URLs now require the auth header, so a plain `<a href>` or `<img src>` will 404. Add a helper for components to fetch bytes as a blob URL:

```js
  fetchAttachment: async (id) => {
    const res = await fetch(`${BASE}/api/attachments/${id}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Could not load that file.");
    return URL.createObjectURL(await res.blob());
  },
```

- [ ] **Step 5: Render attachments through the authenticated fetch**

Because attachment URLs now require an `Authorization` header, a bare `<img src>`
or `<a href>` will 404. Create `client/src/components/Attachment.jsx`:

```jsx
import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { C, MONO } from "../theme";
import { api } from "../api";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"];

function extensionOf(att) {
  const source = att.filename || "";
  const ext = source.split(".").pop();
  return ext && ext !== source ? ext.toLowerCase() : "";
}

function isImage(att) {
  if (att.mimeType) return att.mimeType.startsWith("image/");
  return IMAGE_EXTENSIONS.includes(extensionOf(att));
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Attachment({ att, onRemove }) {
  const [blobUrl, setBlobUrl] = useState(null);

  // Images need their bytes up front to show a thumbnail; documents only need
  // them when the user actually clicks, so they are fetched on demand.
  useEffect(() => {
    if (!isImage(att)) return;
    let revoked = false;
    let created = null;
    api.fetchAttachment(att.id)
      .then(url => { if (revoked) { URL.revokeObjectURL(url); return; } created = url; setBlobUrl(url); })
      .catch(() => {});
    return () => { revoked = true; if (created) URL.revokeObjectURL(created); };
  }, [att.id]);

  const open = async (e) => {
    e.preventDefault();
    try {
      const url = blobUrl || await api.fetchAttachment(att.id);
      window.open(url, "_blank", "noopener");
    } catch (err) { /* the parent surfaces upload/list errors */ }
  };

  const tileStyle = {
    width: 64, height: 64, borderRadius: 6,
    border: `1px solid ${C.hair}`, background: C.panelHi, padding: 4,
  };

  return (
    <div style={{ position: "relative" }}>
      <a href="#" onClick={open}
         title={`${att.filename}${formatSize(att.sizeBytes) ? ` · ${formatSize(att.sizeBytes)}` : ""}`}>
        {isImage(att) && blobUrl ? (
          <img src={blobUrl} alt={att.filename}
               style={{ ...tileStyle, objectFit: "cover", padding: 0 }} />
        ) : (
          <div className="flex flex-col items-center justify-center" style={tileStyle}>
            <FileText size={20} style={{ color: C.teal }} />
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.gold, marginTop: 2, textTransform: "uppercase" }}>
              {extensionOf(att) || "file"}
            </div>
            <div style={{ fontSize: 8, color: C.ivoryDim, maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {att.filename}
            </div>
          </div>
        )}
      </a>
      <button onClick={() => onRemove(att.id)}
              style={{ position: "absolute", top: -6, right: -6, background: C.crimson, borderRadius: "50%", width: 16, height: 16, color: "#fff", fontSize: 10, lineHeight: "16px" }}>×</button>
    </div>
  );
}
```

Then in `client/src/pages/AccountDetail.jsx`:

- Add `import Attachment from "../components/Attachment";`
- Delete the local `IMAGE_EXTENSIONS`, `fileExtension`, `isImage` and `formatSize` helpers, which now live in `Attachment.jsx`.
- Replace the whole `{(account.images || []).map(att => ( ... ))}` block with:

```jsx
            {(account.images || []).map(att => (
              <Attachment key={att.id} att={att} onRemove={removeFile} />
            ))}
```

- Remove `FileText` from the `lucide-react` import if it is no longer used in that file.

- [ ] **Step 6: Verify**

Run: `cd server && node --check src/routes/attachments.js && node --check src/index.js && npm test`
Then: `cd ../client && npm run build`
Expected: no parse errors, tests PASS, client builds

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Store attachments in MongoDB and serve them behind auth"
```

---

### Task 6: Export route, configuration, and a working local run

**Files:**
- Modify: `server/src/routes/exportData.js`
- Modify: `server/.env.example`
- Modify: `render.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `collections()` from Task 1.
- Produces: unchanged `GET /api/export` contract.

- [ ] **Step 1: Rewrite the export route**

Replace the contents of `server/src/routes/exportData.js` with:

```js
const express = require("express");
const { collections } = require("../db");
const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

/* Full, unrestricted export of everything belonging to the logged-in user. */
router.get("/", asyncHandler(async (req, res) => {
  const { accounts, transactions, balanceLogs } = collections();

  const accountDocs = await accounts.find({ userId: req.userId }).toArray();
  const accountIds = accountDocs.map(a => a._id);

  const [txDocs, balDocs] = await Promise.all([
    accountIds.length ? transactions.find({ accountId: { $in: accountIds } }).sort({ date: -1 }).toArray() : [],
    accountIds.length ? balanceLogs.find({ accountId: { $in: accountIds } }).sort({ date: -1 }).toArray() : [],
  ]);

  // File bytes are excluded deliberately: the export stays a readable JSON
  // document rather than tens of megabytes of base64.
  res.json({
    exportedAt: new Date().toISOString(),
    accounts: accountDocs,
    nominees: accountDocs.flatMap(a => (a.nominees || []).map(n => ({ ...n, accountId: a._id }))),
    transactions: txDocs,
    balanceLogs: balDocs,
  });
}));

module.exports = router;
```

- [ ] **Step 2: Document the environment variables**

In `server/.env.example`, replace the `DB_PATH` and `UPLOAD_DIR` block with:

```
# MongoDB connection string (MongoDB Atlas or a local mongod).
# Required — the server will not start without it.
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?appName=Cluster0
# Database name inside that cluster.
MONGODB_DB=networth
```

- [ ] **Step 3: Update render.yaml**

Replace the `DB_PATH` and `UPLOAD_DIR` entries with:

```yaml
      # All data lives in MongoDB Atlas, so nothing depends on Render's
      # ephemeral disk any more. Set the URI in the dashboard.
      - key: MONGODB_URI
        sync: false
      - key: MONGODB_DB
        value: networth
```

- [ ] **Step 4: Update the README**

In `README.md`, replace the "Backend" local-run section with:

```markdown
### Backend
```bash
cd server
cp .env.example .env      # set MONGODB_URI and JWT_SECRET
npm install
npm run dev
```
The API runs at `http://localhost:4000`. There is no native dependency to
compile, so this works on Windows, macOS and Linux alike.
```

And in the deployment section, replace the free-plan disk warning with:

```markdown
**Data persistence:** all data — accounts, transactions, balance logs and uploaded
files — lives in MongoDB Atlas, not on Render's disk, so it survives redeploys and
idle spin-down. Render's free plan needs no disk attached. Note Atlas' free tier
allows 512MB in total, which is why attachments are capped at 8MB each.
```

- [ ] **Step 5: Run the whole thing locally**

Create `server/.env` (not committed) containing a real `MONGODB_URI`, `MONGODB_DB=networth`, and any long random `JWT_SECRET`.

```bash
cd server && npm install && npm test && npm run dev
```

Expected: `Net Worth Ledger API listening on port 4000` with no native build errors.

In a second terminal:

```bash
cd client && npm install && npm run dev
```

Then at `http://localhost:5173`: register an account, create an account record, log a transaction, upload an attachment, and reload the page. Everything must still be there. Restart the server and confirm the data survives — that is the whole point of this migration.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Move export to MongoDB and document the new configuration"
```

---

## Verification

1. `cd server && npm test` — all tests pass.
2. `cd client && npm run build` — builds clean.
3. `cd server && npm install` completes on Windows with no `node-gyp` errors — proof `better-sqlite3` is gone.
4. Local run: register, add an account, add a transaction, upload a file. Restart the server. All data still present.
5. `grep -r "better-sqlite3\|db.prepare\|uploadDir" server/src` returns nothing.
6. Deploy to Render with `MONGODB_URI` set; redeploy a second time and confirm data survives.

## Follow-on work

- Statement import (PDF/CSV/XLSX) — replan against MongoDB; `POST /api/transactions/bulk` from Task 4 is already in place for it.
- Responsive UI overhaul.

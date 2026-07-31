const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const dbModule = require("../src/db");

// accounts.js reads `collections` off db.js via destructuring at require
// time, so the stand-in below must be installed before the route file is
// first required. Same pattern as server/test/balances.test.js.
//
// Only POST /:id/update-value is under test here (FINDING 1). It reaches
// `accounts` via findOneAndUpdate alone, so that is the only method the
// stub needs to be faithful about; findOneAndUpdateCalls lets tests assert
// that an invalid request never reaches Mongo at all.
const ACCOUNTS_STORE = new Map();
let findOneAndUpdateCalls = 0;

const fakeAccounts = {
  findOneAndUpdate: async (query, update) => {
    findOneAndUpdateCalls += 1;
    const existing = ACCOUNTS_STORE.get(query._id);
    if (!existing || existing.userId !== query.userId) return null;
    const updated = { ...existing, ...update.$set };
    ACCOUNTS_STORE.set(query._id, updated);
    return updated;
  },
};

dbModule.collections = () => ({ accounts: fakeAccounts });

const accountsRouter = require("../src/routes/accounts");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/accounts", accountsRouter);
  // Mirrors index.js's generic error handler.
  app.use((err, req, res, next) => {
    res.status(500).json({ error: "Something went wrong on the server." });
  });
  return app;
}

async function withServer(fn) {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function authHeader(userId = "user1") {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

function resetStore() {
  ACCOUNTS_STORE.clear();
  ACCOUNTS_STORE.set("acc1", {
    _id: "acc1", userId: "user1", name: "Gold bar", currency: "INR", type: "gold",
    currentValue: 5000, valueDate: "2026-01-01", valueUrl: null, nominees: [], images: [],
  });
  findOneAndUpdateCalls = 0;
}

test("POST /:id/update-value rejects a missing currentValue with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      // currentValue omitted -- Number(undefined) is NaN. Before the fix
      // this was written to Mongo and the client got 200 OK because
      // JSON.stringify({currentValue: NaN}) serialises the field as null.
      body: JSON.stringify({ valueDate: "2026-07-30" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /value/i);
    assert.strictEqual(findOneAndUpdateCalls, 0, "an invalid request must never reach the DB");
    assert.strictEqual(ACCOUNTS_STORE.get("acc1").currentValue, 5000, "the stored value must be untouched");
  });
});

test("POST /:id/update-value rejects a non-numeric currentValue with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    // A string like "12 lakh" is exactly the kind of input a user typing a
    // value in shorthand could produce, and Number() on it is NaN.
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: "12 lakh" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(findOneAndUpdateCalls, 0);
  });
});

test("POST /:id/update-value rejects a comma-formatted numeric string with 400", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    // Number("1,200") is NaN, even though it looks numeric to a human.
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: "1,200" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(findOneAndUpdateCalls, 0);
  });
});

test("POST /:id/update-value accepts currentValue: 0 and stores it as 0", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: 0 }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.currentValue, 0);
    assert.strictEqual(findOneAndUpdateCalls, 1);
  });
});

test("POST /:id/update-value accepts currentValue: \"\" (an emptied number input) and stores it as 0", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    // The UI submits type="number" inputs, so an emptied field arrives as
    // "". Number("") is 0, and 0 is a legitimate value that must keep
    // succeeding -- only genuinely non-finite input should be rejected.
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: "" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.currentValue, 0);
    assert.strictEqual(findOneAndUpdateCalls, 1);
  });
});

test("POST /:id/update-value accepts a valid update and returns the updated account", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: "6200.5", valueDate: "2026-07-30", valueUrl: "https://example.com/quote" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.id, "acc1");
    assert.strictEqual(body.currentValue, 6200.5);
    assert.strictEqual(body.valueDate, "2026-07-30");
    assert.strictEqual(body.valueUrl, "https://example.com/quote");
    assert.strictEqual(findOneAndUpdateCalls, 1);
  });
});

test("POST /:id/update-value rejects an impossible calendar date (2026-02-31) with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: 5000, valueDate: "2026-02-31" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid date/i);
    assert.strictEqual(findOneAndUpdateCalls, 0);
    assert.strictEqual(ACCOUNTS_STORE.get("acc1").valueDate, "2026-01-01", "the stored date must be untouched");
  });
});

test("POST /:id/update-value leaves valueDate as null when none is provided", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStore();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/accounts/acc1/update-value`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ currentValue: 5000 }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.valueDate, null);
    assert.strictEqual(findOneAndUpdateCalls, 1);
  });
});

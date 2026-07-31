const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const dbModule = require("../src/db");

// balances.js reads `collections` off db.js via destructuring at require
// time, so the stand-in below must be installed before the route file is
// first required. Same pattern as server/test/auth.test.js.
const fakeAccounts = {
  findOne: async () => ({ _id: "acc1" }),
};
let insertOneCalls = 0;
const fakeBalanceLogs = {
  insertOne: async (doc) => {
    insertOneCalls += 1;
    return { acknowledged: true, insertedId: doc._id };
  },
  find: () => ({ sort: () => ({ toArray: async () => [] }) }),
  findOne: async () => null,
  deleteOne: async () => ({ acknowledged: true }),
};
dbModule.collections = () => ({ accounts: fakeAccounts, balanceLogs: fakeBalanceLogs });

const balancesRouter = require("../src/routes/balances");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/balances", balancesRouter);
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

function authHeader() {
  const token = jwt.sign({ sub: "user1" }, process.env.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

test("POST /api/balances/ rejects a missing balance with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      // balance omitted -- Number(undefined) is NaN. Before the fix this was
      // written to Mongo and the client got 200 OK because
      // JSON.stringify({balance: NaN}) serialises the field as null.
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /balance/i);
    assert.strictEqual(insertOneCalls, 0);
  });
});

test("POST /api/balances/ rejects a non-numeric balance with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", balance: "abc" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(insertOneCalls, 0);
  });
});

test("POST /api/balances/ rejects Infinity with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    // JSON has no literal for Infinity, but a client could still send the
    // string form; Number("Infinity") is a real (non-finite) number, so
    // this must be caught by Number.isFinite rather than slipping through
    // now that the `<= 0` check (which would have rejected +Infinity as a
    // side effect) is gone.
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", balance: "Infinity" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(insertOneCalls, 0);
  });
});

test("POST /api/balances/ accepts a zero balance and stores it as 0", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      // Zero is a legitimate reading -- an emptied bank account, a spent
      // cash account, a closed account -- not an error. A `<= 0` rejection
      // (mirroring transactions.amount too literally) would wrongly block
      // this. Only non-finite values (NaN/Infinity/missing) are invalid.
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", balance: 0 }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.balance, 0);
    assert.strictEqual(insertOneCalls, 1);
  });
});

test("POST /api/balances/ accepts a negative balance and stores it as-is", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", balance: -250.5 }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.balance, -250.5);
    assert.strictEqual(insertOneCalls, 1);
  });
});

test("POST /api/balances/ rejects an impossible calendar date (2026-02-31) with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/balances/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ accountId: "acc1", date: "2026-02-31", balance: 100 }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid date/i);
    assert.strictEqual(insertOneCalls, 0);
  });
});

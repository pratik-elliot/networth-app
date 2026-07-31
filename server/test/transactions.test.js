const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const dbModule = require("../src/db");

// transactions.js reads `collections` off db.js via destructuring at require
// time (`const { collections } = require("../db")`), so the stand-in below
// must be installed on db.js's exports *before* the route file is first
// required -- patching it afterward would miss the reference the route
// module already captured. Same pattern as server/test/auth.test.js.
const fakeAccounts = {
  // The account-ownership check only needs a truthy/falsy result; every
  // test below owns the account unless a test overrides this.
  findOne: async () => ({ _id: "acc1" }),
};
let insertOneCalls = 0;
const fakeTransactions = {
  insertOne: async (doc) => {
    insertOneCalls += 1;
    return { acknowledged: true, insertedId: doc._id };
  },
  insertMany: async () => ({ acknowledged: true }),
  find: () => ({ sort: () => ({ toArray: async () => [] }) }),
  findOne: async () => null,
  deleteOne: async () => ({ acknowledged: true }),
};
dbModule.collections = () => ({ accounts: fakeAccounts, transactions: fakeTransactions });

const transactionsRouter = require("../src/routes/transactions");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/transactions", transactionsRouter);
  // Mirrors index.js's generic error handler: anything asyncHandler forwards
  // that the route itself didn't turn into a specific response ends up here.
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

test("POST /api/transactions/ rejects a missing amount with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/transactions/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      // amount omitted entirely -- Number(undefined) is NaN. Before the fix,
      // this coerced to NaN, was written to Mongo, and the client got 200 OK
      // because JSON.stringify({amount: NaN}) serialises the field as null.
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", type: "credit" }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /amount/i);
    // The defect this guards against is a silent 200 with a NaN already
    // durably written -- so the strongest assertion is that insertOne was
    // never even attempted.
    assert.strictEqual(insertOneCalls, 0);
  });
});

test("POST /api/transactions/ rejects a non-numeric amount with 400 and never writes to the DB", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });
  insertOneCalls = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/transactions/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ accountId: "acc1", date: "2026-07-30", type: "credit", amount: "abc" }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(insertOneCalls, 0);
  });
});

test("POST /api/transactions/bulk rejects an impossible calendar date (2026-02-31) with 400", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/transactions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        accountId: "acc1",
        // /^\d{4}-\d{2}-\d{2}$/ matches this string, so the old regex-only
        // check let it through. February never has 31 days.
        rows: [{ date: "2026-02-31", type: "debit", amount: 10, description: "rent" }],
      }),
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /invalid date/i);
  });
});

test("POST /api/transactions/bulk surfaces the partial insert count when insertMany fails partway through", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
    t.mock.reset();
  });

  // Simulate an ordered bulk write that stopped after 2 of 3 documents were
  // already durably persisted -- exactly the shape of mongodb's
  // MongoBulkWriteError, which exposes the count via `.insertedCount`.
  t.mock.method(fakeTransactions, "insertMany", async () => {
    const err = new Error("E11000 duplicate key error collection: networth.transactions");
    err.name = "MongoBulkWriteError";
    err.insertedCount = 2;
    throw err;
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/transactions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        accountId: "acc1",
        rows: [
          { date: "2026-07-01", type: "debit", amount: 10, description: "a" },
          { date: "2026-07-02", type: "debit", amount: 20, description: "b" },
          { date: "2026-07-03", type: "debit", amount: 30, description: "c" },
        ],
      }),
    });
    // Before the fix, this rejection reached the generic error handler and
    // came back as a bare 500 with no count at all -- indistinguishable
    // from "nothing was written," inviting a full-batch resubmit that would
    // duplicate the 2 rows that already landed.
    assert.notStrictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.inserted, 2);
    assert.match(body.error, /2 of 3/);
  });
});

test("POST /api/transactions/bulk still reports a plain failure (no inserted count) when nothing was written", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
    t.mock.reset();
  });

  // A connection drop before any document lands: no insertedCount at all.
  // This must NOT be reported as a fake partial success.
  t.mock.method(fakeTransactions, "insertMany", async () => {
    throw new Error("connection reset");
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/transactions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({
        accountId: "acc1",
        rows: [{ date: "2026-07-01", type: "debit", amount: 10, description: "a" }],
      }),
    });
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.inserted, undefined);
  });
});

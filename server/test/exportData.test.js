const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const dbModule = require("../src/db");

// exportData.js reads `collections` off db.js via destructuring at require
// time, so the stand-in below must be installed before the route file is
// first required. Same pattern as server/test/attachments.test.js.
//
// Deliberately omit an `attachments` collection from the stub entirely: the
// export route must never touch it (attachment bytes are excluded by
// design). If a future change tries to read attachment bytes into the
// export, `collections().attachments` would be `undefined` and calling
// `.find(...)` on it throws, turning a 200 into a 500 -- that's the
// regression guard for "no attachment bytes in the export".
let accountsStore = [];
let transactionsStore = [];
let balanceLogsStore = [];

function makeCollection(store, matches) {
  return {
    find(query) {
      let results = store.filter((doc) => matches(doc, query));
      const cursor = {
        sort(spec) {
          const [key, dir] = Object.entries(spec)[0];
          results = [...results].sort((a, b) => {
            if (a[key] === b[key]) return 0;
            return dir === -1 ? (a[key] < b[key] ? 1 : -1) : (a[key] < b[key] ? -1 : 1);
          });
          return cursor;
        },
        toArray: async () => results,
      };
      return cursor;
    },
  };
}

const fakeAccounts = makeCollection(accountsStore, (doc, query) => doc.userId === query.userId);
const fakeTransactions = makeCollection(transactionsStore, (doc, query) => query.accountId.$in.includes(doc.accountId));
const fakeBalanceLogs = makeCollection(balanceLogsStore, (doc, query) => query.accountId.$in.includes(doc.accountId));

dbModule.collections = () => ({
  accounts: fakeAccounts,
  transactions: fakeTransactions,
  balanceLogs: fakeBalanceLogs,
});

const exportRouter = require("../src/routes/exportData");

function buildApp() {
  const app = express();
  app.use("/api/export", exportRouter);
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

function authHeader(userId) {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

function resetStores() {
  accountsStore.length = 0;
  transactionsStore.length = 0;
  balanceLogsStore.length = 0;
}

test("GET /api/export returns exactly the five documented top-level keys, all populated", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStores();

  accountsStore.push({
    _id: "acc1", userId: "user1", name: "Checking",
    nominees: [{ id: "nom1", name: "Jane Doe", relation: "spouse", percent: 100 }],
  });
  transactionsStore.push({ _id: "tx1", accountId: "acc1", date: "2026-07-01", amount: 10 });
  balanceLogsStore.push({ _id: "bal1", accountId: "acc1", date: "2026-07-01", balance: 500 });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/export`, { headers: authHeader("user1") });
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ["accounts", "balanceLogs", "exportedAt", "nominees", "transactions"]
    );
    assert.strictEqual(typeof body.exportedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(body.exportedAt)), "exportedAt must be a parseable timestamp");
    assert.strictEqual(body.accounts.length, 1);
    assert.strictEqual(body.nominees.length, 1);
    assert.strictEqual(body.transactions.length, 1);
    assert.strictEqual(body.balanceLogs.length, 1);
  });
});

test("nominees are flattened out of accounts[].nominees with the correct accountId stamped on each", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStores();

  accountsStore.push({
    _id: "acc1", userId: "user1", name: "Checking",
    nominees: [
      { id: "nom1", name: "Jane Doe", relation: "spouse", percent: 60 },
      { id: "nom2", name: "Jo Doe", relation: "child", percent: 40 },
    ],
  });
  accountsStore.push({
    _id: "acc2", userId: "user1", name: "Savings",
    nominees: [{ id: "nom3", name: "Sam Doe", relation: "sibling", percent: 100 }],
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/export`, { headers: authHeader("user1") });
    const body = await res.json();

    assert.strictEqual(body.nominees.length, 3, "there is no nominees collection -- these come only from flattening accounts[].nominees");

    const byId = Object.fromEntries(body.nominees.map((n) => [n.id, n]));
    assert.strictEqual(byId.nom1.accountId, "acc1");
    assert.strictEqual(byId.nom1.name, "Jane Doe");
    assert.strictEqual(byId.nom2.accountId, "acc1");
    assert.strictEqual(byId.nom3.accountId, "acc2", "each nominee must be stamped with its OWN account's id, not the last account processed");
  });
});

test("an account with no nominees contributes nothing to the nominees array and does not throw", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStores();

  // No `nominees` key at all -- the shape a legacy or minimally-created
  // account document could have.
  accountsStore.push({ _id: "acc1", userId: "user1", name: "No nominees" });
  // Explicit empty array.
  accountsStore.push({ _id: "acc2", userId: "user1", name: "Also none", nominees: [] });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/export`, { headers: authHeader("user1") });
    assert.strictEqual(res.status, 200, "a missing/empty nominees field must not throw (e.g. `.map` on undefined)");
    const body = await res.json();
    assert.strictEqual(body.accounts.length, 2);
    assert.deepStrictEqual(body.nominees, []);
  });
});

test("a user with no accounts at all gets empty arrays, not an error", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStores();

  // Some other user's data exists, but user2 owns nothing.
  accountsStore.push({ _id: "acc1", userId: "user1", name: "Not user2's", nominees: [] });
  transactionsStore.push({ _id: "tx1", accountId: "acc1", date: "2026-07-01", amount: 10 });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/export`, { headers: authHeader("user2") });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.accounts, []);
    assert.deepStrictEqual(body.nominees, []);
    assert.deepStrictEqual(body.transactions, []);
    assert.deepStrictEqual(body.balanceLogs, []);
  });
});

test("the export contains no attachment bytes", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  resetStores();

  // `images` metadata (no bytes -- those live only in the attachments
  // collection, which this stub deliberately does not provide) is embedded
  // on the account the same way the real accounts collection stores it.
  accountsStore.push({
    _id: "acc1", userId: "user1", name: "Checking", nominees: [],
    images: [{ id: "img1", filename: "statement.pdf", mimeType: "application/pdf", sizeBytes: 12345 }],
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/export`, { headers: authHeader("user1") });
    // A 200 here already proves the route never dereferenced
    // collections().attachments (it is undefined in this stub, so
    // `.find(...)` on it would throw and this would be a 500).
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.ok(!("attachments" in body), "export must not gain an attachments key");
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("\"data\""), "export must never carry a raw attachment-bytes field");
    // The account's own image metadata should still be there (harmless,
    // already client-visible) -- just never the bytes.
    assert.strictEqual(body.accounts[0].images[0].filename, "statement.pdf");
  });
});

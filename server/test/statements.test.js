const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");

const dbModule = require("../src/db");

const USER_ID = "user-1";
const ACCOUNT_ID = "acct-1";

function tokenFor(id) {
  return jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

/* Stands up the real router over stubbed collections, so the route's own
   ownership and duplicate logic is exercised without a live MongoDB. */
async function withServer(t, { accounts = [], transactions = [], extract } = {}, run) {
  process.env.JWT_SECRET = "test-secret";
  process.env.OPENROUTER_API_KEY = "test-key";

  const originalCollections = dbModule.collections;
  dbModule.collections = () => ({
    accounts: {
      findOne: async (q) => accounts.find(a => a._id === q._id && a.userId === q.userId) || null,
    },
    transactions: {
      find: () => ({ toArray: async () => transactions }),
    },
  });

  const extractModule = require("../src/services/statementExtract");
  const originalExtract = extractModule.extractTransactions;
  if (extract) extractModule.extractTransactions = extract;

  delete require.cache[require.resolve("../src/routes/statements")];
  const router = require("../src/routes/statements");

  const app = express();
  app.use("/api/statements", router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    dbModule.collections = originalCollections;
    extractModule.extractTransactions = originalExtract;
    server.close();
    delete process.env.OPENROUTER_API_KEY;
  });

  await run(base);
}

function uploadForm(content, filename) {
  const boundary = "----testboundary123";
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="statement"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(head, "utf8"),
    Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test("GET /status reports whether import is configured", async (t) => {
  await withServer(t, {}, async (base) => {
    const res = await fetch(`${base}/api/statements/status`, {
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}` },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { configured: true });
  });
});

test("parse rejects a request with no token", async (t) => {
  await withServer(t, {}, async (base) => {
    const { body, contentType } = uploadForm("Date,Amount\n", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST", headers: { "Content-Type": contentType }, body,
    });
    assert.strictEqual(res.status, 401);
  });
});

test("parse refuses an account belonging to someone else", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: "someone-else" }];
  await withServer(t, { accounts }, async (base) => {
    const { body, contentType } = uploadForm("Date,Amount\n2026-02-13,5\n", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 404, "must not disclose that the account exists");
  });
});

test("parse returns normalised rows and writes nothing", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => [
    { date: "13/02/2026", description: "SALARY", type: "credit", amount: "50,000" },
  ];
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("Date,Desc,Amount\n", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(json.rows, [
      { date: "2026-02-13", description: "SALARY", type: "credit", amount: 50000, duplicate: false },
    ]);
    assert.strictEqual(json.dateOrderAssumed, "DD/MM");
  });
});

test("parse flags a row that already exists on the account", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const transactions = [{ date: "2026-02-13", amount: 50000, description: "SALARY" }];
  const extract = async () => [
    { date: "2026-02-13", description: "SALARY", type: "credit", amount: "50000" },
    { date: "2026-02-14", description: "RENT", type: "debit", amount: "1000" },
  ];
  await withServer(t, { accounts, transactions, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    const json = await res.json();
    assert.deepStrictEqual(json.rows.map(r => r.duplicate), [true, false]);
  });
});

test("parse surfaces rows the normaliser could not use", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => [{ date: "nonsense", description: "X", amount: "1", type: "credit" }];
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    const json = await res.json();
    assert.deepStrictEqual(json.rows, []);
    assert.strictEqual(json.rejected.length, 1);
  });
});

test("parse reports an unsupported file type as 400", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  await withServer(t, { accounts }, async (base) => {
    const { body, contentType } = uploadForm("hello", "notes.docx");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /PDF, CSV or Excel/i);
  });
});

test("parse reports an extraction failure as 502 with the reason", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => { throw new Error("No zero-data-retention provider is available"); };
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 502);
    assert.match((await res.json()).error, /zero-data-retention/i);
  });
});

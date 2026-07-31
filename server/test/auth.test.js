const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const dbModule = require("../src/db");

// auth.js reads `collections` off db.js via destructuring at require time
// (`const { collections } = require("../db")`), so the stand-in below must be
// installed on db.js's exports *before* the route file is first required --
// patching it afterward would miss the reference auth.js already captured.
const fakeUsers = {
  findOne: async () => null,
  insertOne: async () => ({ acknowledged: true }),
};
dbModule.collections = () => ({ users: fakeUsers });

const authRouter = require("../src/routes/auth");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
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

test("POST /register returns 409, not 500, when insertOne loses the duplicate-email race", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });

  // Simulate two concurrent registrations for the same email: the findOne
  // pre-check still reports no existing user (both requests raced past it),
  // but insertOne loses against the unique index on users.email and rejects
  // with a duplicate-key error -- exactly what the real MongoDB driver
  // reports as code 11000.
  t.mock.method(fakeUsers, "findOne", async () => null);
  const dupError = new Error("E11000 duplicate key error collection: networth.users index: email_1 dup key");
  dupError.code = 11000;
  t.mock.method(fakeUsers, "insertOne", async () => {
    throw dupError;
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "race@example.com", password: "hunter2" }),
    });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.deepStrictEqual(body, { error: "An account with this email already exists." });
  });
});

test("POST /register still surfaces a non-duplicate-key insert failure as a 500", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => {
    delete process.env.JWT_SECRET;
  });

  // Guard against over-broadly swallowing insert errors: only code 11000
  // should become a 409. Anything else -- a dropped connection here -- must
  // still reach the generic error handler.
  t.mock.method(fakeUsers, "findOne", async () => null);
  t.mock.method(fakeUsers, "insertOne", async () => {
    throw new Error("connection reset");
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "other@example.com", password: "hunter2" }),
    });
    assert.strictEqual(res.status, 500);
  });
});

const test = require("node:test");
const assert = require("node:assert");
const { MongoClient } = require("mongodb");
const { connect, close, collections } = require("../src/db");

test("collections() refuses to hand out handles before connect()", () => {
  assert.throws(() => collections(), /not connected/i);
});

test("close() resets connection state even when the underlying close() rejects", async (t) => {
  process.env.MONGODB_URI = "mongodb://localhost:27017";
  t.after(() => {
    delete process.env.MONGODB_URI;
  });

  const fakeCollection = { createIndex: async () => {} };
  const fakeDb = { collection: () => fakeCollection };

  // Stand in for the real driver so this stays a unit test: no network, no
  // MongoDB required. connect()/db() succeed; close() rejects, simulating a
  // dropped connection or a driver-level error during teardown.
  t.mock.method(MongoClient.prototype, "connect", async function () {
    return this;
  });
  t.mock.method(MongoClient.prototype, "db", () => fakeDb);
  t.mock.method(MongoClient.prototype, "close", async () => {
    throw new Error("simulated close failure");
  });

  await connect();
  assert.doesNotThrow(() => collections());

  await assert.rejects(() => close(), /simulated close failure/);

  // The whole point of the fix: even though the underlying close() blew up,
  // module state must still be reset. Otherwise collections() would keep
  // handing back handles bound to a dead client (failing on first use
  // instead of at acquisition), and a later connect() would short-circuit
  // on `if (db) return;` against that dead client.
  assert.throws(() => collections(), /not connected/i);
});

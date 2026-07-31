const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Binary } = require("mongodb");
const dbModule = require("../src/db");

// attachments.js reads `collections` off db.js via destructuring at require
// time, so the stand-in below must be installed before the route file is
// first required. Same pattern as server/test/auth.test.js.
//
// Two accounts owned by two different users let the ownership-check tests
// prove that one user's token cannot reach another user's account or files.
const ACCOUNTS = {
  acc1: "user1",
  acc2: "user2",
};

const fakeAccounts = {
  findOne: async (query) => {
    const owner = ACCOUNTS[query._id];
    if (owner && owner === query.userId) return { _id: query._id };
    return null;
  },
  updateOne: async () => ({ acknowledged: true }),
};

// A real MongoDB read hands back the stored bytes wrapped in a BSON `Binary`
// (see server/src/db.js's `collections()` / the mongodb driver), never a
// plain Buffer -- findOne here re-wraps on the way out to mirror that
// exactly, so the route's Binary-unwrapping code is exercised the same way
// it would be against Atlas.
const attachmentStore = new Map();
const fakeAttachments = {
  insertOne: async (doc) => {
    attachmentStore.set(doc._id, doc);
    return { acknowledged: true, insertedId: doc._id };
  },
  findOne: async (query) => {
    const doc = attachmentStore.get(query._id);
    if (!doc) return null;
    return { ...doc, data: new Binary(doc.data) };
  },
  deleteOne: async (query) => {
    attachmentStore.delete(query._id);
    return { acknowledged: true };
  },
};

dbModule.collections = () => ({ accounts: fakeAccounts, attachments: fakeAttachments });

const attachmentsRouter = require("../src/routes/attachments");

function buildApp() {
  const app = express();
  app.use("/api/attachments", attachmentsRouter);
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

function authHeader(userId) {
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET);
  return { Authorization: `Bearer ${token}` };
}

async function upload(baseUrl, accountId, userId, filename, bytes, mimeType) {
  const fd = new FormData();
  fd.append("images", new Blob([bytes], { type: mimeType }), filename);
  const res = await fetch(`${baseUrl}/api/attachments/account/${accountId}`, {
    method: "POST",
    headers: authHeader(userId),
    body: fd,
  });
  return res;
}

test("uploaded bytes come back byte-identical through the BSON Binary round trip", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  // Deliberately include 0x00 and 0xFF -- exactly the bytes a naive
  // JSON-serialised response, or an accidental "send the whole underlying
  // ArrayBuffer" bug, would mangle first.
  const original = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x00, 0xaa, ...Buffer.from("hello attachment world")]);

  await withServer(async (baseUrl) => {
    const upRes = await upload(baseUrl, "acc1", "user1", "statement.pdf", original, "application/pdf");
    assert.strictEqual(upRes.status, 200);
    const [meta] = await upRes.json();
    assert.strictEqual(meta.filename, "statement.pdf");
    assert.strictEqual(meta.url, `/api/attachments/${meta.id}`);

    const getRes = await fetch(`${baseUrl}${meta.url}`, { headers: authHeader("user1") });
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.headers.get("content-type"), "application/pdf");

    const roundTripped = Buffer.from(await getRes.arrayBuffer());
    assert.strictEqual(roundTripped.length, original.length);
    assert.strictEqual(Buffer.compare(roundTripped, original), 0);
  });
});

test("GET rejects another user's attachment with 404 and returns no bytes", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  const secret = Buffer.from("this is user1's private bank statement contents");

  await withServer(async (baseUrl) => {
    const upRes = await upload(baseUrl, "acc1", "user1", "secret.txt", secret, "text/plain");
    const [meta] = await upRes.json();

    // user2 owns a different account (acc2) and has never been granted
    // access to acc1 or its attachment.
    const getRes = await fetch(`${baseUrl}${meta.url}`, { headers: authHeader("user2") });
    assert.strictEqual(getRes.status, 404);

    const body = await getRes.text();
    // The strongest guarantee here isn't just the status code -- it's that
    // the secret bytes never left the server. A leaked-content bug could
    // still return 404 while embedding the file inside an error body.
    assert.ok(!body.includes("private bank statement"));
    const parsed = JSON.parse(body);
    assert.strictEqual(typeof parsed.error, "string");
  });
});

test("DELETE rejects another user's attachment with 404 and leaves it intact", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  await withServer(async (baseUrl) => {
    const upRes = await upload(baseUrl, "acc1", "user1", "keep.txt", Buffer.from("keep me"), "text/plain");
    const [meta] = await upRes.json();

    const delRes = await fetch(`${baseUrl}${meta.url}`, { method: "DELETE", headers: authHeader("user2") });
    assert.strictEqual(delRes.status, 404);
    assert.ok(attachmentStore.has(meta.id), "attachment must survive an unauthorized delete attempt");

    // The rightful owner can still fetch it afterwards, proving the failed
    // delete from user2 did not silently remove it.
    const getRes = await fetch(`${baseUrl}${meta.url}`, { headers: authHeader("user1") });
    assert.strictEqual(getRes.status, 200);
  });
});

test("POST rejects an upload to an account the caller does not own with 404", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  await withServer(async (baseUrl) => {
    // acc1 belongs to user1, not user2.
    const res = await upload(baseUrl, "acc1", "user2", "sneaky.txt", Buffer.from("hi"), "text/plain");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(attachmentStore.size, 0, "nothing should be written when ownership fails");
  });
});

test("GET returns 404 for an attachment id that does not exist", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/attachments/does-not-exist`, { headers: authHeader("user1") });
    assert.strictEqual(res.status, 404);
  });
});

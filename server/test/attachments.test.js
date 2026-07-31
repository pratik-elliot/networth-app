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

test("GET sends only the stored bytes, not the whole pooled buffer, when data is a plain Buffer", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; t.mock.reset(); });

  // Simulates a driver option (e.g. promoteBuffers: true) or a future
  // caching layer that hands back attachment bytes as a plain Buffer
  // instead of a BSON Binary -- the case the normal fakeAttachments.findOne
  // deliberately never produces. A short Buffer.from(string) is allocated
  // out of Node's shared 8KB buffer pool, so its own `.buffer` (the
  // underlying ArrayBuffer) is far larger than the 2 bytes actually stored --
  // exactly the shape that exposed adjacent heap before the
  // Buffer.isBuffer() guard was added.
  const plain = Buffer.from("hi");
  assert.ok(plain.buffer.byteLength > plain.length, "test buffer must be pool-allocated to be a meaningful regression check");
  t.mock.method(fakeAttachments, "findOne", async () => ({
    accountId: "acc1",
    filename: "plain.txt",
    mimeType: "text/plain",
    data: plain,
  }));

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/attachments/whatever-id`, { headers: authHeader("user1") });
    assert.strictEqual(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length, 2, `expected exactly 2 bytes, got ${body.length} (leaking the pooled buffer would return 8192)`);
    assert.strictEqual(body.toString(), "hi");
  });
});

test("Content-Disposition sanitises the ascii filename and percent-encodes filename* for a name with a space, a quote, and a non-ASCII character", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; t.mock.reset(); });

  // Space, literal double quotes, and a non-ASCII letter (e with acute
  // accent, U+00E9) written as an escape so the source file stays plain
  // ASCII regardless of editor/terminal encoding.
  const filename = "caf\u00e9 \"report\".pdf";

  // Stubbed at the findOne boundary rather than routed through a real
  // multipart upload: multer/busboy has its own, separate, pre-existing
  // filename-decoding behaviour for non-ASCII multipart filenames that has
  // nothing to do with this fix. Stubbing isolates the test to exactly the
  // Content-Disposition construction in the GET handler.
  t.mock.method(fakeAttachments, "findOne", async () => ({
    accountId: "acc1",
    filename,
    mimeType: "application/pdf",
    data: new Binary(Buffer.from("x")),
  }));

  await withServer(async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/api/attachments/whatever-id`, { headers: authHeader("user1") });
    const header = getRes.headers.get("content-disposition") || "";

    const asciiMatch = header.match(/filename="([^"]*)"/);
    const starMatch = header.match(/filename\*=UTF-8''([^;]+)/);
    assert.ok(asciiMatch, `missing filename= parameter in: ${header}`);
    assert.ok(starMatch, `missing filename*= parameter in: ${header}`);

    // The ascii fallback is what Firefox/Safari save the file as verbatim
    // (RFC 6266 section 4.3 -- it is never percent-decoded), so it must
    // contain no raw quote/backslash (would break out of the quoted-string)
    // and no non-ASCII byte.
    assert.ok(!/["\\]/.test(asciiMatch[1]), `ascii filename still has a quote/backslash: ${asciiMatch[1]}`);
    assert.ok(/^[\x20-\x7e]*$/.test(asciiMatch[1]), `ascii filename has a non-ASCII byte: ${asciiMatch[1]}`);

    // filename* must decode back to the exact original name for browsers
    // that do honour it.
    assert.strictEqual(decodeURIComponent(starMatch[1]), filename);
  });
});

test("Content-Disposition cannot be used to inject a CRLF-delimited header or split the response", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; t.mock.reset(); });

  // A classic header-injection payload: if this ever reached a raw header
  // string unescaped, it would inject a second Set-Cookie header (or split
  // the response entirely) into the reply to every future caller of this
  // endpoint. The ascii fallback strips anything outside \x20-\x7e (which
  // excludes CR 0x0D and LF 0x0A), and filename* runs the same string
  // through encodeURIComponent, which percent-encodes CR/LF -- but nothing
  // previously locked that in with a test.
  const filename = 'evil\r\nSet-Cookie: hijacked=true\r\n\r\n"><script>.pdf';

  t.mock.method(fakeAttachments, "findOne", async () => ({
    accountId: "acc1",
    filename,
    mimeType: "application/pdf",
    data: new Binary(Buffer.from("x")),
  }));

  await withServer(async (baseUrl) => {
    const getRes = await fetch(`${baseUrl}/api/attachments/whatever-id`, { headers: authHeader("user1") });

    // If injection had succeeded, this would already be a distinct header
    // rather than part of Content-Disposition's value.
    assert.strictEqual(getRes.headers.get("set-cookie"), null);

    const header = getRes.headers.get("content-disposition") || "";
    assert.ok(!/[\r\n]/.test(header), `Content-Disposition must contain no raw CR/LF: ${JSON.stringify(header)}`);

    const asciiMatch = header.match(/filename="([^"]*)"/);
    assert.ok(asciiMatch, `missing filename= parameter in: ${JSON.stringify(header)}`);
    assert.ok(!/[\r\n]/.test(asciiMatch[1]), "ascii filename fallback must have stripped CR/LF");

    const starMatch = header.match(/filename\*=UTF-8''([^;]+)/);
    assert.ok(starMatch, `missing filename*= parameter in: ${JSON.stringify(header)}`);
    // encodeURIComponent must have turned CR/LF into %0D/%0A, not passed
    // them through raw.
    assert.ok(/%0D%0A/i.test(starMatch[1]), "filename* must percent-encode the CR/LF, not carry it raw");
  });
});

test("GET sets a private, long-lived Cache-Control header, X-Content-Type-Options: nosniff, and Vary: Authorization", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.after(() => { delete process.env.JWT_SECRET; });
  attachmentStore.clear();

  await withServer(async (baseUrl) => {
    const upRes = await upload(baseUrl, "acc1", "user1", "cacheme.txt", Buffer.from("cache me"), "text/plain");
    const [meta] = await upRes.json();

    const getRes = await fetch(`${baseUrl}${meta.url}`, { headers: authHeader("user1") });
    const cacheControl = getRes.headers.get("cache-control") || "";
    // Attachments are immutable once uploaded and already gated behind auth
    // + ownership, so a long-lived private cache is safe and keeps repeated
    // thumbnail/document fetches off the shared apiLimiter budget that the
    // old public /uploads mount never touched.
    assert.match(cacheControl, /private/);
    assert.match(cacheControl, /max-age=\d+/);
    assert.strictEqual(getRes.headers.get("x-content-type-options"), "nosniff");

    // A browser HTTP cache keys on URL + method only unless Vary says
    // otherwise. This app's logout never reloads the page (see
    // client/src/App.jsx), so without Vary: Authorization, a cached
    // response for this URL could survive a session change on a shared
    // device and be served to a different, now-logged-in user without ever
    // reaching the ownership check above -- the exact hole moving off the
    // public /uploads mount was meant to close.
    assert.strictEqual(getRes.headers.get("vary"), "Authorization");
  });
});

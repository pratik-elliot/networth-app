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

test("toApiAccount projects uploadedAt on images so it survives the round trip instead of vanishing after upload", () => {
  // routes/attachments.js pushes { id, filename, mimeType, sizeBytes,
  // uploadedAt } into an account's embedded images[]. Without uploadedAt
  // listed here it would appear in the immediate upload response (which
  // attachments.js constructs by hand) but vanish on the next refresh,
  // since every other read of an account goes through toApiAccount.
  const out = toApiAccount({
    _id: "a", name: "X", currency: "INR", type: "bank",
    images: [{ id: "img1", filename: "statement.pdf", mimeType: "application/pdf", sizeBytes: 100, uploadedAt: "2026-07-30T12:00:00.000Z" }],
  });
  assert.strictEqual(out.images[0].uploadedAt, "2026-07-30T12:00:00.000Z");
});

test("toApiAccount defaults uploadedAt to null for images uploaded before the field existed", () => {
  const out = toApiAccount({
    _id: "a", name: "X", currency: "INR", type: "bank",
    images: [{ id: "img1", filename: "old.pdf" }],
  });
  assert.strictEqual(out.images[0].uploadedAt, null);
});

test("fromApiAccount never lets a client set id or userId", () => {
  const out = fromApiAccount({ id: "evil", _id: "evil", userId: "evil", name: "X", currency: "INR", type: "bank" });
  assert.strictEqual(out._id, undefined);
  assert.strictEqual(out.userId, undefined);
  assert.strictEqual(out.id, undefined);
});

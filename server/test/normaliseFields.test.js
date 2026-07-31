const test = require("node:test");
const assert = require("node:assert");
const { normaliseDate, normaliseAmount, detectDateOrder } = require("../src/services/normaliseFields");

test("normaliseDate reads ISO dates unchanged", () => {
  assert.deepStrictEqual(normaliseDate("2026-02-13", {}), { iso: "2026-02-13", ambiguous: false });
});

test("normaliseDate reads DD-Mon-YYYY", () => {
  assert.deepStrictEqual(normaliseDate("13-Feb-2026", {}), { iso: "2026-02-13", ambiguous: false });
  assert.deepStrictEqual(normaliseDate("13 Feb 2026", {}), { iso: "2026-02-13", ambiguous: false });
});

test("normaliseDate resolves an unambiguous day-first date", () => {
  assert.deepStrictEqual(normaliseDate("13/02/2026", {}), { iso: "2026-02-13", ambiguous: false });
});

test("normaliseDate resolves an unambiguous month-first date", () => {
  assert.deepStrictEqual(normaliseDate("02/13/2026", {}), { iso: "2026-02-13", ambiguous: false });
});

test("normaliseDate honours the supplied order when ambiguous", () => {
  assert.deepStrictEqual(normaliseDate("03/04/2026", { order: "DD/MM" }), { iso: "2026-04-03", ambiguous: true });
  assert.deepStrictEqual(normaliseDate("03/04/2026", { order: "MM/DD" }), { iso: "2026-03-04", ambiguous: true });
});

test("normaliseDate defaults ambiguous dates to DD/MM", () => {
  assert.deepStrictEqual(normaliseDate("03/04/2026", {}), { iso: "2026-04-03", ambiguous: true });
});

test("normaliseDate accepts two-digit years", () => {
  assert.deepStrictEqual(normaliseDate("13/02/26", {}), { iso: "2026-02-13", ambiguous: false });
});

test("normaliseDate rejects impossible and malformed dates", () => {
  assert.strictEqual(normaliseDate("31/02/2026", {}), null, "31 February is not a real date");
  assert.strictEqual(normaliseDate("not a date", {}), null);
  assert.strictEqual(normaliseDate("", {}), null);
  assert.strictEqual(normaliseDate(null, {}), null);
  assert.strictEqual(normaliseDate("45/45/2026", {}), null);
});

test("detectDateOrder finds day-first from a day above 12", () => {
  assert.strictEqual(detectDateOrder(["03/04/2026", "13/04/2026"]), "DD/MM");
});

test("detectDateOrder finds month-first from a second part above 12", () => {
  assert.strictEqual(detectDateOrder(["04/03/2026", "04/13/2026"]), "MM/DD");
});

test("detectDateOrder returns null when every date is ambiguous", () => {
  assert.strictEqual(detectDateOrder(["03/04/2026", "05/06/2026"]), null);
  assert.strictEqual(detectDateOrder([]), null);
});

test("normaliseAmount strips Indian grouping", () => {
  assert.deepStrictEqual(normaliseAmount("1,00,000.50"), { value: 100000.5, negative: false });
});

test("normaliseAmount strips currency symbols", () => {
  assert.deepStrictEqual(normaliseAmount("₹1,234.56"), { value: 1234.56, negative: false });
  assert.deepStrictEqual(normaliseAmount("$1,234.56"), { value: 1234.56, negative: false });
  assert.deepStrictEqual(normaliseAmount("Rs. 500"), { value: 500, negative: false });
  assert.deepStrictEqual(normaliseAmount("INR 500"), { value: 500, negative: false });
});

test("normaliseAmount reports negatives without losing the magnitude", () => {
  assert.deepStrictEqual(normaliseAmount("-250.00"), { value: 250, negative: true });
  assert.deepStrictEqual(normaliseAmount("(250.00)"), { value: 250, negative: true });
});

test("normaliseAmount accepts plain numbers", () => {
  assert.deepStrictEqual(normaliseAmount(1234.5), { value: 1234.5, negative: false });
  assert.deepStrictEqual(normaliseAmount(-99), { value: 99, negative: true });
});

test("normaliseAmount rejects unparseable and non-finite input", () => {
  assert.strictEqual(normaliseAmount("abc"), null);
  assert.strictEqual(normaliseAmount(""), null);
  assert.strictEqual(normaliseAmount(null), null);
  assert.strictEqual(normaliseAmount(undefined), null);
  assert.strictEqual(normaliseAmount(Infinity), null);
  assert.strictEqual(normaliseAmount(NaN), null);
  assert.strictEqual(normaliseAmount("1e400"), null, "overflows to Infinity");
});

const test = require("node:test");
const assert = require("node:assert");
const { normalise } = require("../src/services/normaliseTransactions");

test("normalise converts a clean row", () => {
  const out = normalise([{ date: "2026-02-13", description: "Salary", type: "credit", amount: "50000" }]);
  assert.deepStrictEqual(out.rows, [
    { date: "2026-02-13", description: "Salary", type: "credit", amount: 50000 },
  ]);
  assert.deepStrictEqual(out.rejected, []);
});

test("normalise infers debit from a negative amount", () => {
  const out = normalise([{ date: "2026-02-13", description: "ATM", amount: "-500" }]);
  assert.strictEqual(out.rows[0].type, "debit");
  assert.strictEqual(out.rows[0].amount, 500);
});

test("normalise reads Dr and Cr markers", () => {
  const out = normalise([
    { date: "2026-02-13", description: "A", amount: "100", type: "Dr" },
    { date: "2026-02-14", description: "B", amount: "200", type: "Cr" },
  ]);
  assert.strictEqual(out.rows[0].type, "debit");
  assert.strictEqual(out.rows[1].type, "credit");
});

test("normalise reads withdrawal and deposit columns", () => {
  const out = normalise([
    { date: "2026-02-13", description: "A", withdrawal: "1,500.00" },
    { date: "2026-02-14", description: "B", deposit: "2,000.00" },
  ]);
  assert.deepStrictEqual(out.rows.map(r => [r.type, r.amount]), [["debit", 1500], ["credit", 2000]]);
});

test("normalise applies one date order across the whole batch", () => {
  // 13/02 proves day-first, so 03/04 must be day-first too.
  const out = normalise([
    { date: "13/02/2026", description: "A", amount: "1", type: "credit" },
    { date: "03/04/2026", description: "B", amount: "2", type: "credit" },
  ]);
  assert.strictEqual(out.dateOrderAssumed, "DD/MM");
  assert.deepStrictEqual(out.rows.map(r => r.date), ["2026-02-13", "2026-04-03"]);
});

test("normalise applies a month-first batch order to ambiguous rows", () => {
  const out = normalise([
    { date: "04/13/2026", description: "A", amount: "1", type: "credit" },
    { date: "03/04/2026", description: "B", amount: "2", type: "credit" },
  ]);
  assert.strictEqual(out.dateOrderAssumed, "MM/DD");
  assert.deepStrictEqual(out.rows.map(r => r.date), ["2026-04-13", "2026-03-04"]);
});

test("normalise reports the assumed order when the batch is ambiguous", () => {
  const out = normalise([{ date: "03/04/2026", description: "A", amount: "1", type: "credit" }]);
  assert.strictEqual(out.dateOrderAssumed, "DD/MM");
  assert.strictEqual(out.rows[0].date, "2026-04-03");
});

test("normalise rejects rows it cannot use, with reasons", () => {
  const out = normalise([
    { date: "garbage", description: "A", amount: "1", type: "credit" },
    { date: "2026-02-13", description: "B", amount: "abc", type: "credit" },
    { date: "2026-02-13", description: "C" },
  ]);
  assert.deepStrictEqual(out.rows, []);
  assert.strictEqual(out.rejected.length, 3);
  assert.match(out.rejected[0].reason, /date/i);
  assert.match(out.rejected[1].reason, /amount/i);
  assert.match(out.rejected[2].reason, /amount/i);
});

test("normalise rejects a row it cannot classify as credit or debit", () => {
  const out = normalise([{ date: "2026-02-13", description: "A", amount: "100" }]);
  assert.deepStrictEqual(out.rows, []);
  assert.match(out.rejected[0].reason, /credit or a debit/i);
});

test("normalise tidies descriptions and caps their length", () => {
  const out = normalise([
    { date: "2026-02-13", description: "  UPI   PAYMENT\n  REF 123 ", amount: "1", type: "credit" },
    { date: "2026-02-13", description: "x".repeat(600), amount: "1", type: "credit" },
  ]);
  assert.strictEqual(out.rows[0].description, "UPI PAYMENT REF 123");
  assert.strictEqual(out.rows[1].description.length, 500);
});

test("normalise reads alternative description column names", () => {
  const out = normalise([{ date: "2026-02-13", narration: "NEFT IN", amount: "1", type: "credit" }]);
  assert.strictEqual(out.rows[0].description, "NEFT IN");
});

test("normalise treats a missing description as empty rather than rejecting", () => {
  const out = normalise([{ date: "2026-02-13", amount: "1", type: "credit" }]);
  assert.strictEqual(out.rows[0].description, "");
});

test("normalise rejects a zero amount", () => {
  const out = normalise([{ date: "2026-02-13", description: "A", amount: "0", type: "credit" }]);
  assert.strictEqual(out.rows.length, 0);
  assert.match(out.rejected[0].reason, /amount/i);
});

test("normalise ignores non-array input", () => {
  assert.deepStrictEqual(normalise(null).rows, []);
  assert.deepStrictEqual(normalise(undefined).rejected, []);
  assert.strictEqual(normalise([]).dateOrderAssumed, null);
});

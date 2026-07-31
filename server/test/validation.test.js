const test = require("node:test");
const assert = require("node:assert");
const { isValidCalendarDate } = require("../src/services/validation");

// This helper used to be duplicated verbatim inside transactions.js and
// balances.js. It was extracted to src/services/validation.js so
// accounts.js's /update-value route could reuse it too. These tests pin its
// behaviour so the extraction (and any future edit) cannot silently change
// it -- transactions.test.js and balances.test.js already exercise it
// indirectly through their routes, but this is the direct, from-first-
// principles check.
test("isValidCalendarDate accepts a real, well-formed date", () => {
  assert.strictEqual(isValidCalendarDate("2026-07-31"), true);
  assert.strictEqual(isValidCalendarDate("2024-02-29"), true); // leap day
});

test("isValidCalendarDate rejects a well-formed but impossible date", () => {
  assert.strictEqual(isValidCalendarDate("2026-02-31"), false);
  assert.strictEqual(isValidCalendarDate("2026-13-01"), false);
  assert.strictEqual(isValidCalendarDate("2023-02-29"), false); // not a leap year
});

test("isValidCalendarDate rejects malformed strings, non-strings, and missing values", () => {
  assert.strictEqual(isValidCalendarDate("2026-7-31"), false);
  assert.strictEqual(isValidCalendarDate("07/31/2026"), false);
  assert.strictEqual(isValidCalendarDate(""), false);
  assert.strictEqual(isValidCalendarDate(null), false);
  assert.strictEqual(isValidCalendarDate(undefined), false);
  assert.strictEqual(isValidCalendarDate(20260731), false);
});

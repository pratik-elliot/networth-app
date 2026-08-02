import test from "node:test";
import assert from "node:assert";
import { latestValue } from "../src/theme.js";

const bank = { id: "a1", type: "bank", currency: "INR" };
const gold = { id: "g1", type: "gold", currency: "INR", currentValue: 500000 };

test("returns null when a bank account has no balance anchor", () => {
  // Not zero. Zero would be a claim the account is empty; we do not know.
  assert.strictEqual(latestValue(bank, {}, {}), null);
  assert.strictEqual(latestValue(bank, { a1: [] }, { a1: [] }), null);
});

test("returns the anchor when there are no later transactions", () => {
  const bal = { a1: [{ id: "b1", date: "2026-07-31", balance: 123456 }] };
  assert.strictEqual(latestValue(bank, bal, {}), 123456);
});

test("ignores transactions dated on or before the anchor", () => {
  // A July closing balance already contains every July transaction.
  const bal = { a1: [{ id: "b1", date: "2026-07-31", balance: 100000 }] };
  const tx = { a1: [
    { id: "t1", date: "2026-07-15", type: "debit", amount: 500 },
    { id: "t2", date: "2026-07-31", type: "credit", amount: 900 },
  ] };
  assert.strictEqual(latestValue(bank, bal, tx), 100000);
});

test("adds credits and subtracts debits dated after the anchor", () => {
  const bal = { a1: [{ id: "b1", date: "2026-07-31", balance: 100000 }] };
  const tx = { a1: [
    { id: "t1", date: "2026-08-01", type: "credit", amount: 5000 },
    { id: "t2", date: "2026-08-02", type: "debit", amount: 1200 },
  ] };
  assert.strictEqual(latestValue(bank, bal, tx), 103800);
});

test("uses the most recent anchor when several exist", () => {
  const bal = { a1: [
    { id: "b1", date: "2026-06-30", balance: 50000 },
    { id: "b2", date: "2026-07-31", balance: 100000 },
  ] };
  const tx = { a1: [{ id: "t1", date: "2026-07-05", type: "credit", amount: 999 }] };
  // t1 precedes the July anchor, so it must not be added.
  assert.strictEqual(latestValue(bank, bal, tx), 100000);
});

test("physical assets use currentValue and are never null", () => {
  assert.strictEqual(latestValue(gold, {}, {}), 500000);
  assert.strictEqual(latestValue({ ...gold, currentValue: null }, {}, {}), 0);
});

test("never returns NaN from malformed data", () => {
  const bal = { a1: [{ id: "b1", date: "2026-07-31", balance: "not a number" }] };
  const tx = { a1: [{ id: "t1", date: "2026-08-01", type: "credit", amount: "oops" }] };
  const v = latestValue(bank, bal, tx);
  assert.ok(Number.isFinite(v), `expected a finite number, got ${v}`);
});

test("tolerates a missing txByAccount argument", () => {
  const bal = { a1: [{ id: "b1", date: "2026-07-31", balance: 100000 }] };
  assert.strictEqual(latestValue(bank, bal), 100000);
});

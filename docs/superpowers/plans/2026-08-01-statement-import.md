# Statement Import (PDF / CSV / XLSX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Supersedes** `docs/superpowers/plans/2026-07-31-statement-import.md`, which targeted SQLite and PDF/CSV only. That plan must not be executed.

**Goal:** Let a user upload a PDF, CSV or XLSX bank statement to an account, review the transactions extracted from it in an editable table, and save the ones they confirm.

**Architecture:** Text is extracted locally, sent to a model on OpenRouter with zero-data-retention routing enforced, then passed through a pure normaliser that fixes dates, amounts and credit/debit before anything reaches the user. Parsing writes nothing; the already-built `POST /api/transactions/bulk` inserts only the rows the user ticks.

**Tech Stack:** Node 20, Express 4, MongoDB Atlas (`mongodb` driver v6), `pdf-parse` v2, `exceljs`, OpenRouter HTTP API, React 18 + Vite, Node's built-in `node:test`.

## Global Constraints

- **MongoDB, not SQLite.** The migration is complete. Use `collections()` from `server/src/db.js`; `db.prepare` does not exist. `collections()` throws if called before `connect()`, so call it inside handlers, never at module top level.
- Every DB-touching handler MUST be `async` and wrapped in `asyncHandler` (`server/src/utils/asyncHandler.js`). An unhandled rejection kills the process on Node 20 and has already caused a real outage in this app.
- Ids are UUID v4 **strings** stored as `_id`. Never `ObjectId`.
- Responses expose `id`, never `_id` or `userId`.
- Ownership is checked with `accounts.findOne({ _id: accountId, userId })`, which is async. **Every call must be awaited** — a bare Promise is truthy and silently defeats the check.
- Money is a plain finite JS number, never a string, never `NaN`. Reject non-finite values with 400 before any write.
- **Never add a dependency with a native build step.** `better-sqlite3` was removed precisely because it could not compile on Windows.
- **Do NOT use the `xlsx` package from npm.** It is pinned at 0.18.5 with two high-severity advisories and no fix available — prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9). This code parses untrusted uploaded files, so that is disqualifying. Use `exceljs`.
- Every OpenRouter request MUST include `provider: { zdr: true, data_collection: "deny" }`. Both keys are schema-validated by the API (verified: an invalid value returns 400), and the free Ling model was confirmed to have a zero-retention endpoint.
- `OPENROUTER_API_KEY` is read from the environment only. Never commit it.
- Tests use Node's built-in `node:test` (`cd server && npm test`). Do NOT add Jest, Vitest, or any framework.
- New UI must be usable on a phone. Do not build a fixed-width desktop table.

## Verified API facts

These were checked against the installed packages. Do not substitute remembered APIs.

- **`pdf-parse` v2.4.5** is a class, NOT a callable default export. v1's `require("pdf-parse")(buffer)` does not work:
  ```js
  const { PDFParse, PasswordException } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();   // also returns { pages, total }
  await parser.destroy();
  ```
  Extracted text contains page markers of the form `-- 1 of 3 --`.
- **`exceljs` 4.4.0**: `row.values` is **1-indexed** (index 0 is always empty, so `.slice(1)`), date cells come back as `Date` objects, and trailing empty cells are dropped from the row array.
- **`server/src/services/validation.js`** already exports `isValidCalendarDate(str)`, which rejects well-formed but impossible dates like `2026-02-31`. Reuse it; do not write a second copy.
- **`POST /api/transactions/bulk` already exists** in `server/src/routes/transactions.js`. It takes `{ accountId, rows: [{ date, description, type, amount }] }` and returns `{ inserted }`. It re-validates every row server-side and caps at 2000. **Do not modify it.**

## File structure

| File | Responsibility |
| --- | --- |
| `server/src/services/normaliseFields.js` | Pure. Single date/amount string → normalised value. |
| `server/src/services/normaliseTransactions.js` | Pure. Model output rows → validated transaction rows + rejects. |
| `server/src/services/statementText.js` | Upload buffer → plain text. PDF/CSV/XLSX. |
| `server/src/services/statementExtract.js` | Text → raw rows via OpenRouter, ZDR enforced. |
| `server/src/routes/statements.js` | Auth, ownership, orchestration, duplicate flagging. Writes nothing. |
| `client/src/components/StatementImport.jsx` | Upload control + responsive review table. |

---

### Task 1: Date and amount primitives

**Files:**
- Create: `server/src/services/normaliseFields.js`
- Test: `server/test/normaliseFields.test.js`

**Interfaces:**
- Consumes: `isValidCalendarDate` from `../services/validation`.
- Produces:
  - `normaliseDate(raw, opts) -> { iso: string, ambiguous: boolean } | null` where `opts` is `{ order?: "DD/MM" | "MM/DD" }`
  - `normaliseAmount(raw) -> { value: number, negative: boolean } | null`
  - `detectDateOrder(rawDates: string[]) -> "DD/MM" | "MM/DD" | null`

- [ ] **Step 1: Write the failing test**

Create `server/test/normaliseFields.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/normaliseFields'`

- [ ] **Step 3: Implement**

Create `server/src/services/normaliseFields.js`:

```js
const { isValidCalendarDate } = require("./validation");

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fullYear(raw) {
  // Statements are historical documents, so a two-digit year is this century.
  return raw.length === 4 ? Number(raw) : 2000 + Number(raw);
}

/* Returns an ISO string only when it is a real calendar date, so 31 February
   is rejected rather than silently stored. */
function isoIfReal(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const s = iso(y, m, d);
  return isValidCalendarDate(s) ? s : null;
}

/* "DD/MM" when some first part exceeds 12, "MM/DD" when some second part does,
   null when every date in the batch could be read either way. */
function detectDateOrder(rawDates) {
  for (const raw of rawDates || []) {
    const m = String(raw == null ? "" : raw).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) return "DD/MM";
    if (b > 12 && a <= 12) return "MM/DD";
  }
  return null;
}

function normaliseDate(raw, opts = {}) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const out = isoIfReal(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
    return out ? { iso: out, ambiguous: false } : null;
  }

  const named = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/);
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!m) return null;
    const out = isoIfReal(fullYear(named[3]), m, Number(named[1]));
    return out ? { iso: out, ambiguous: false } : null;
  }

  const numeric = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const y = fullYear(numeric[3]);

    // A part above 12 settles the order by itself.
    if (a > 12 && b > 12) return null;
    if (a > 12) {
      const out = isoIfReal(y, b, a);
      return out ? { iso: out, ambiguous: false } : null;
    }
    if (b > 12) {
      const out = isoIfReal(y, a, b);
      return out ? { iso: out, ambiguous: false } : null;
    }

    // Genuinely ambiguous: use the batch order, defaulting to day-first.
    const dayFirst = opts.order !== "MM/DD";
    const out = isoIfReal(y, dayFirst ? b : a, dayFirst ? a : b);
    return out ? { iso: out, ambiguous: true } : null;
  }

  return null;
}

function normaliseAmount(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return { value: Math.abs(raw), negative: raw < 0 };
  }
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // Accounting notation puts negatives in brackets.
  const bracketed = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()]/g, "").replace(/(?:INR|USD|Rs\.?|₹|\$|,|\s)/gi, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return { value: Math.abs(n), negative: bracketed || n < 0 };
}

module.exports = { normaliseDate, normaliseAmount, detectDateOrder };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS (49 pre-existing tests plus the new ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/normaliseFields.js server/test/normaliseFields.test.js
git commit -m "Add date and amount normalisation for statement import"
```

---

### Task 2: Row normaliser

**Files:**
- Create: `server/src/services/normaliseTransactions.js`
- Test: `server/test/normaliseTransactions.test.js`

**Interfaces:**
- Consumes: `normaliseDate`, `normaliseAmount`, `detectDateOrder` from `./normaliseFields`.
- Produces: `normalise(rawRows) -> { rows: Array<{date, description, type, amount}>, rejected: Array<{raw, reason}>, dateOrderAssumed: "DD/MM" | "MM/DD" | null }`

- [ ] **Step 1: Write the failing test**

Create `server/test/normaliseTransactions.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/normaliseTransactions'`

- [ ] **Step 3: Implement**

Create `server/src/services/normaliseTransactions.js`:

```js
const { normaliseDate, normaliseAmount, detectDateOrder } = require("./normaliseFields");

const MAX_DESCRIPTION = 500;

function cleanDescription(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION);
}

/* Statements express direction in several different ways: an explicit type, a
   Dr/Cr marker, separate withdrawal/deposit columns, or a negative amount. */
function resolveType(row, amount) {
  const marker = String(row.type || row.drCr || "").trim().toLowerCase();
  if (marker.startsWith("cr") || marker === "deposit") return "credit";
  if (marker.startsWith("dr") || marker.startsWith("deb") || marker === "withdrawal") return "debit";

  const filled = (v) => v != null && String(v).trim() !== "";
  if (filled(row.deposit) || filled(row.credit)) return "credit";
  if (filled(row.withdrawal) || filled(row.debit)) return "debit";

  if (amount && amount.negative) return "debit";
  return null;
}

function pickAmount(row) {
  for (const c of [row.amount, row.withdrawal, row.deposit, row.debit, row.credit]) {
    if (c == null || String(c).trim() === "") continue;
    const parsed = normaliseAmount(c);
    if (parsed) return parsed;
  }
  return null;
}

function normalise(rawRows) {
  const list = Array.isArray(rawRows) ? rawRows : [];
  const order = detectDateOrder(list.map(r => (r && r.date) || ""));

  const rows = [];
  const rejected = [];

  for (const raw of list) {
    const row = raw && typeof raw === "object" ? raw : {};

    const amount = pickAmount(row);
    if (!amount || amount.value === 0) {
      rejected.push({ raw, reason: "Could not read an amount for this row." });
      continue;
    }

    const date = normaliseDate(row.date, { order: order || "DD/MM" });
    if (!date) {
      rejected.push({ raw, reason: "Could not read a date for this row." });
      continue;
    }

    const type = resolveType(row, amount);
    if (!type) {
      rejected.push({ raw, reason: "Could not tell whether this row is a credit or a debit." });
      continue;
    }

    rows.push({
      date: date.iso,
      description: cleanDescription(row.description || row.narration || row.particulars),
      type,
      amount: amount.value,
    });
  }

  return { rows, rejected, dateOrderAssumed: order || (rows.length ? "DD/MM" : null) };
}

module.exports = { normalise };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/normaliseTransactions.js server/test/normaliseTransactions.test.js
git commit -m "Add statement row normaliser"
```

---

### Task 3: Text extraction from PDF, CSV and XLSX

**Files:**
- Modify: `server/package.json`
- Create: `server/src/services/statementText.js`
- Test: `server/test/statementText.test.js`

**Interfaces:**
- Produces: `extractText(buffer: Buffer, filename: string) -> Promise<{ text: string, kind: "pdf"|"csv"|"xlsx" }>`. Throws `Error` with a user-facing message when the file cannot be read.

- [ ] **Step 1: Add the dependencies**

In `server/package.json` `dependencies`, add (keeping the list alphabetical):

```json
    "exceljs": "^4.4.0",
    "pdf-parse": "^2.4.5",
```

Run: `cd server && npm install`

Both are pure JavaScript — confirm the install completes with no `node-gyp` output.

- [ ] **Step 2: Write the failing test**

Create `server/test/statementText.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { extractText } = require("../src/services/statementText");

// A minimal one-page PDF whose content stream draws the text "Hello World".
const HELLO_PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8" +
  "PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdl" +
  "L1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0vQ29udGVudHMgNCAwIFIvUmVzb3VyY2Vz" +
  "PDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGggNDQ+PnN0cmVhbQpC" +
  "VCAvRjEgMjQgVGYgMjAgMTAwIFRkIChIZWxsbyBXb3JsZCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1" +
  "IDAgb2JqPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj5lbmRvYmoK" +
  "dHJhaWxlcjw8L1Jvb3QgMSAwIFI+Pg==",
  "base64"
);

async function makeXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Statement");
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("extractText reads a CSV as text", async () => {
  const csv = "Date,Description,Amount\n2026-02-13,Salary,50000\n";
  const out = await extractText(Buffer.from(csv, "utf8"), "statement.csv");
  assert.strictEqual(out.kind, "csv");
  assert.match(out.text, /Salary/);
});

test("extractText reads a PDF's text layer", async () => {
  const out = await extractText(HELLO_PDF, "statement.pdf");
  assert.strictEqual(out.kind, "pdf");
  assert.match(out.text, /Hello World/);
});

test("extractText flattens an XLSX into delimited rows", async () => {
  const buf = await makeXlsx([
    ["Date", "Description", "Debit", "Credit"],
    ["13/02/2026", "SALARY CREDIT", null, 50000],
  ]);
  const out = await extractText(buf, "statement.xlsx");
  assert.strictEqual(out.kind, "xlsx");
  assert.match(out.text, /SALARY CREDIT/);
  assert.match(out.text, /13\/02\/2026/);
  assert.match(out.text, /50000/);
});

test("extractText renders XLSX date cells as ISO dates, not JS Date noise", async () => {
  // exceljs hands back a Date object for a real date cell. Left as-is it would
  // stringify to "Thu Feb 12 2026 ..." and confuse the extraction.
  const buf = await makeXlsx([
    ["Date", "Description", "Amount"],
    [new Date(Date.UTC(2026, 1, 14)), "ATM", 1500],
  ]);
  const out = await extractText(buf, "statement.xlsx");
  assert.match(out.text, /2026-02-14/);
  assert.doesNotMatch(out.text, /GMT|\(.*Time\)/);
});

test("extractText keeps empty XLSX cells positional", async () => {
  // A blank Debit column must not shift Credit into its place, or every row's
  // direction flips.
  const buf = await makeXlsx([
    ["Date", "Desc", "Debit", "Credit"],
    ["2026-02-13", "A", null, 999],
  ]);
  const out = await extractText(buf, "statement.xlsx");
  const line = out.text.split("\n").find(l => l.includes("999"));
  assert.match(line, /A\s*\|\s*\|\s*999/, `expected an empty Debit cell, got: ${line}`);
});

test("extractText rejects an unsupported extension", async () => {
  await assert.rejects(() => extractText(Buffer.from("x"), "notes.docx"), /PDF, CSV or Excel/i);
});

test("extractText rejects an empty file", async () => {
  await assert.rejects(() => extractText(Buffer.alloc(0), "empty.csv"), /empty/i);
  await assert.rejects(() => extractText(Buffer.from("   \n  "), "blank.csv"), /empty/i);
});

test("extractText reports a PDF with no selectable text as scanned", async () => {
  const blank = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  );
  await assert.rejects(() => extractText(blank, "scan.pdf"), /scan|selectable text/i);
});

test("extractText reports a corrupt PDF clearly rather than throwing raw", async () => {
  await assert.rejects(
    () => extractText(Buffer.from("this is definitely not a pdf"), "broken.pdf"),
    /could not be read|scan|selectable text/i
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/statementText'`

- [ ] **Step 4: Implement**

Create `server/src/services/statementText.js`:

```js
const path = require("path");

// Below this, a PDF almost certainly holds scanned images rather than a text
// layer. pdf-parse still emits page markers like "-- 1 of 1 --" for an empty
// page, so the threshold is measured after those are stripped.
const MIN_PDF_TEXT_LENGTH = 20;
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/gm;

async function extractPdf(buffer) {
  // pdf-parse v2 exports a class; v1's callable default export is gone.
  const { PDFParse } = require("pdf-parse");

  let parser;
  let text;
  try {
    parser = new PDFParse({ data: buffer });
    ({ text } = await parser.getText());
  } catch (err) {
    const message = String((err && err.message) || "");
    if (/password|encrypt/i.test(message) || (err && err.name === "PasswordException")) {
      throw new Error("This PDF is password-protected. Remove the password and upload it again.");
    }
    throw new Error("This PDF could not be read. It may be corrupted or in an unsupported format.");
  } finally {
    // Releases the worker; skipping this leaks a handle per upload.
    if (parser) await parser.destroy().catch(() => {});
  }

  const cleaned = String(text || "").replace(PAGE_MARKER, "").trim();
  if (cleaned.length < MIN_PDF_TEXT_LENGTH) {
    throw new Error(
      "This PDF has no selectable text, so it is probably a scan or a photo. " +
      "Please upload a statement downloaded directly from your bank."
    );
  }
  return cleaned;
}

function cellToText(v) {
  if (v == null) return "";
  // exceljs returns a Date for date-formatted cells; its default stringification
  // ("Thu Feb 12 2026 ... GMT+0000") is noise the extractor would have to undo.
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Formula cells arrive as { formula, result }; the computed value is what matters.
  if (typeof v === "object") {
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    return "";
  }
  return String(v);
}

async function extractXlsx(buffer) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new Error("This spreadsheet could not be read. It may be corrupted or password-protected.");
  }

  const lines = [];
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // row.values is 1-indexed with an empty slot at 0, and exceljs drops
      // trailing empties — so pad to the sheet width to keep columns aligned.
      const values = row.values || [];
      const cells = [];
      for (let i = 1; i <= sheet.columnCount; i++) cells.push(cellToText(values[i]));
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.some(c => c !== "")) lines.push(cells.join(" | "));
    });
  });

  const text = lines.join("\n").trim();
  if (!text) throw new Error("That spreadsheet has no readable rows.");
  return text;
}

async function extractText(buffer, filename) {
  if (!buffer || buffer.length === 0) throw new Error("That file is empty.");

  const ext = path.extname(filename || "").toLowerCase();

  if (ext === ".csv" || ext === ".txt") {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("That file is empty.");
    return { text, kind: "csv" };
  }
  if (ext === ".pdf") return { text: await extractPdf(buffer), kind: "pdf" };
  if (ext === ".xlsx" || ext === ".xls") return { text: await extractXlsx(buffer), kind: "xlsx" };

  throw new Error("Only PDF, CSV or Excel statements can be imported.");
}

module.exports = { extractText };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/services/statementText.js server/test/statementText.test.js
git commit -m "Add PDF, CSV and XLSX text extraction for statement import"
```

---

### Task 4: OpenRouter extraction with zero data retention enforced

**Files:**
- Create: `server/src/services/statementExtract.js`
- Test: `server/test/statementExtract.test.js`

**Interfaces:**
- Produces:
  - `extractTransactions(text, opts) -> Promise<object[]>` where `opts` may carry `{ fetchImpl }` for tests
  - `isConfigured() -> boolean`

- [ ] **Step 1: Write the failing test**

Create `server/test/statementExtract.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");

function loadFresh() {
  delete require.cache[require.resolve("../src/services/statementExtract")];
  return require("../src/services/statementExtract");
}

function stubFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  fn.calls = calls;
  return fn;
}

const modelSaid = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

test.afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});

test("isConfigured reflects the API key", () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.strictEqual(loadFresh().isConfigured(), false);
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.strictEqual(loadFresh().isConfigured(), true);
});

test("extractTransactions always enforces zero data retention", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("statement text", { fetchImpl });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepStrictEqual(body.provider, { zdr: true, data_collection: "deny" },
    "statement text must never be sent to a provider that may retain it");
});

test("extractTransactions defaults to the free Ling model", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "inclusionai/ling-3.0-flash:free");
});

test("extractTransactions honours OPENROUTER_MODEL", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "some/other-model";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "some/other-model");
});

test("extractTransactions sends the API key as a bearer token", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, "Bearer test-key");
});

test("extractTransactions returns the rows the model reported", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const rows = [{ date: "2026-02-13", description: "Salary", type: "credit", amount: "50000" }];
  const fetchImpl = stubFetch(modelSaid({ transactions: rows }));
  assert.deepStrictEqual(await loadFresh().extractTransactions("text", { fetchImpl }), rows);
});

test("extractTransactions returns an empty array when the model finds nothing", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  assert.deepStrictEqual(await loadFresh().extractTransactions("text", { fetchImpl }), []);
});

test("extractTransactions explains a missing ZDR provider", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ error: { message: "No endpoints found matching your data policy" } }, { status: 404 });
  await assert.rejects(
    () => loadFresh().extractTransactions("text", { fetchImpl }),
    /zero.data.retention|data policy/i
  );
});

test("extractTransactions reports rate limiting plainly", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ error: { message: "rate limited" } }, { status: 429 });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /too many|limit/i);
});

test("extractTransactions reports a rejected key", async () => {
  process.env.OPENROUTER_API_KEY = "bad-key";
  const fetchImpl = stubFetch({ error: { message: "invalid" } }, { status: 401 });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /API key/i);
});

test("extractTransactions rejects unparseable model output", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ choices: [{ message: { content: "I am not JSON" } }] });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /could not read/i);
});

test("extractTransactions tolerates a model that wraps JSON in code fences", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fenced = "```json\n{\"transactions\":[{\"date\":\"2026-02-13\",\"amount\":\"5\"}]}\n```";
  const fetchImpl = stubFetch({ choices: [{ message: { content: fenced } }] });
  const out = await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(out.length, 1);
});

test("extractTransactions refuses to run without an API key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => loadFresh().extractTransactions("text", {}), /not configured/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/statementExtract'`

- [ ] **Step 3: Implement**

Create `server/src/services/statementExtract.js`:

```js
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "inclusionai/ling-3.0-flash:free";
const REQUEST_TIMEOUT_MS = 120000;
// Keeps a very long statement inside the model's context window.
const MAX_TEXT_CHARS = 120000;

const SYSTEM_PROMPT = [
  "You extract bank transactions from statement text.",
  'Return ONLY a JSON object of the form {"transactions":[{"date":"...","description":"...","type":"credit|debit","amount":"..."}]}.',
  "Copy dates and amounts EXACTLY as they appear in the statement; never reformat, convert or recalculate them.",
  "Use 'credit' for money coming in and 'debit' for money going out.",
  "Ignore opening and closing balance lines, running balance columns, page headers and footers, and summary totals.",
  "Ignore page markers of the form '-- 1 of 3 --'.",
  "If there are no transactions, return an empty array.",
].join(" ");

function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

function describeFailure(status, bodyText) {
  if (status === 401 || status === 403) {
    return "OpenRouter rejected the API key. Check that OPENROUTER_API_KEY is set correctly.";
  }
  if (status === 429) {
    return "Too many requests to OpenRouter. The free tier allows a limited number per day — please try again later.";
  }
  if (/data polic|no endpoints|no allowed providers/i.test(bodyText || "")) {
    return (
      "No zero-data-retention provider is available for this model, so your statement was NOT sent. " +
      "Set OPENROUTER_MODEL to a model that has a ZDR provider."
    );
  }
  return `OpenRouter returned ${status}.`;
}

/* Some models wrap JSON in a markdown code fence despite being asked not to. */
function parseModelJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : raw);
}

async function extractTransactions(text, opts = {}) {
  if (!isConfigured()) {
    throw new Error("Statement import is not configured. Set OPENROUTER_API_KEY to enable it.");
  }

  const doFetch = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
        // Never send statement contents to a provider that may retain or train
        // on them. Both keys are schema-validated by OpenRouter, and the
        // request fails rather than silently downgrading if no ZDR endpoint
        // exists — failing closed is the intended behaviour here.
        provider: { zdr: true, data_collection: "deny" },
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: String(text || "").slice(0, MAX_TEXT_CHARS) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Reading the statement timed out. Try a shorter statement.");
    }
    throw new Error(`Could not reach OpenRouter: ${(err && err.message) || "unknown error"}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(describeFailure(res.status, bodyText));
  }

  const payload = await res.json();
  const content =
    payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : "";

  let parsed;
  try {
    parsed = parseModelJson(content);
  } catch (err) {
    throw new Error("Could not read this statement — the extraction service returned an unexpected response.");
  }

  return Array.isArray(parsed && parsed.transactions) ? parsed.transactions : [];
}

module.exports = { extractTransactions, isConfigured };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/statementExtract.js server/test/statementExtract.test.js
git commit -m "Add OpenRouter statement extraction with zero-retention routing"
```

---

### Task 5: Parse route with duplicate flagging

**Files:**
- Create: `server/src/routes/statements.js`
- Modify: `server/src/middleware/rateLimit.js`
- Modify: `server/src/index.js`
- Test: `server/test/statements.test.js`

**Interfaces:**
- Consumes: `extractText` (Task 3), `extractTransactions`/`isConfigured` (Task 4), `normalise` (Task 2), `collections()` from `../db`.
- Produces:
  - `GET /api/statements/status` → `{ configured: boolean }`
  - `POST /api/statements/parse/:accountId` (multipart, field `statement`) → `{ rows: [{date, description, type, amount, duplicate}], rejected, dateOrderAssumed }`

This route writes NOTHING to the database.

- [ ] **Step 1: Add the import limiter**

In `server/src/middleware/rateLimit.js`, add before `module.exports`:

```js
// Each parse spends one of a limited number of daily upstream requests, so this
// is far tighter than the general API ceiling.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many statement imports. Please wait an hour and try again." },
});
```

and change the export line to:

```js
module.exports = { authLimiter, apiLimiter, importLimiter };
```

- [ ] **Step 2: Write the failing test**

Create `server/test/statements.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/routes/statements'`

- [ ] **Step 4: Implement the route**

Create `server/src/routes/statements.js`:

```js
const express = require("express");
const multer = require("multer");
const { collections } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { importLimiter } = require("../middleware/rateLimit");
const { extractText } = require("../services/statementText");
const { extractTransactions, isConfigured } = require("../services/statementExtract");
const { normalise } = require("../services/normaliseTransactions");

const router = express.Router();
router.use(requireAuth);

// Statements are parsed in memory and never written to disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

async function accountBelongsToUser(accountId, userId) {
  const { accounts } = collections();
  return !!(await accounts.findOne({ _id: accountId, userId }, { projection: { _id: 1 } }));
}

function duplicateKey(date, amount, description) {
  return `${date}|${Number(amount).toFixed(2)}|${String(description || "").trim().toLowerCase()}`;
}

router.get("/status", (req, res) => res.json({ configured: isConfigured() }));

async function handleParse(req, res, uploadErr) {
  if (uploadErr) {
    const msg = uploadErr.code === "LIMIT_FILE_SIZE"
      ? "That statement is larger than 15MB."
      : uploadErr.message || "Upload failed.";
    return res.status(400).json({ error: msg });
  }
  // Awaited deliberately: an un-awaited Promise is truthy and would let any
  // logged-in user read another user's account.
  if (!(await accountBelongsToUser(req.params.accountId, req.userId))) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (!req.file) return res.status(400).json({ error: "No statement file was received." });

  let text;
  try {
    ({ text } = await extractText(req.file.buffer, req.file.originalname));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let rawRows;
  try {
    rawRows = await extractTransactions(text);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const { rows, rejected, dateOrderAssumed } = normalise(rawRows);

  const { transactions } = collections();
  const existing = new Set(
    (await transactions.find({ accountId: req.params.accountId }).toArray())
      .map(r => duplicateKey(r.date, r.amount, r.description))
  );

  res.json({
    rows: rows.map(r => ({ ...r, duplicate: existing.has(duplicateKey(r.date, r.amount, r.description)) })),
    rejected,
    dateOrderAssumed,
  });
}

router.post("/parse/:accountId", importLimiter, (req, res, next) => {
  // multer's callback receives only (err), so asyncHandler cannot wrap it
  // directly — forward rejections to Express ourselves instead.
  upload.single("statement")(req, res, (err) => {
    handleParse(req, res, err).catch(next);
  });
});

module.exports = router;
```

- [ ] **Step 5: Mount the route**

In `server/src/index.js`, add alongside the other route requires:

```js
const statementRoutes = require("./routes/statements");
```

and alongside the other route mounts:

```js
app.use("/api/statements", statementRoutes);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npm test && node --check src/index.js`
Expected: PASS, and no output from `node --check`

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/statements.js server/src/middleware/rateLimit.js server/src/index.js server/test/statements.test.js
git commit -m "Add statement parse endpoint with duplicate flagging"
```

---

### Task 6: Review table UI

**Files:**
- Modify: `client/src/api.js`
- Create: `client/src/components/StatementImport.jsx`
- Modify: `client/src/pages/AccountDetail.jsx`

**Interfaces:**
- Consumes: `GET /api/statements/status`, `POST /api/statements/parse/:accountId`, `POST /api/transactions/bulk`.
- Produces: `<StatementImport accountId={string} onImported={() => Promise<void>} />`

The review table must work on a phone. Each row is a stacked card on narrow screens, not a horizontally scrolling table.

- [ ] **Step 1: Add the API methods**

In `client/src/api.js`, add immediately before the `exportAll` line:

```js
  statementStatus: () => fetch(`${BASE}/api/statements/status`, { headers: authHeaders() }).then(handle),
  parseStatement: (accountId, file) => {
    const fd = new FormData();
    fd.append("statement", file);
    return fetch(`${BASE}/api/statements/parse/${accountId}`, { method: "POST", headers: authHeaders(), body: fd }).then(handle);
  },
  bulkCreateTransactions: (accountId, rows) =>
    fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ accountId, rows }),
    }).then(handle),
```

- [ ] **Step 2: Create the component**

Create `client/src/components/StatementImport.jsx`:

```jsx
import React, { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { C, MONO } from "../theme";
import { Btn } from "./ui";
import { api } from "../api";

const FIELD = {
  background: "transparent",
  color: C.ivory,
  border: `1px solid ${C.hair}`,
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 12.5,
  minWidth: 0,
  width: "100%",
};

export default function StatementImport({ accountId, onImported }) {
  const fileRef = useRef(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    let live = true;
    api.statementStatus()
      .then(s => { if (live) setAvailable(!!s.configured); })
      .catch(() => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

  const choose = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true); setError(""); setNotice(""); setResult(null);
    try {
      const res = await api.parseStatement(accountId, file);
      if (!res.rows.length) {
        // Distinguish "nothing there" from "everything failed to parse" —
        // otherwise a statement whose every row was rejected looks empty.
        setNotice(res.rejected.length
          ? `No usable transactions. ${res.rejected.length} row${res.rejected.length === 1 ? "" : "s"} could not be read: ${res.rejected[0].reason}`
          : "No transactions were found in that statement.");
      }
      // Duplicates start unticked so re-importing an overlapping statement
      // cannot silently double-count.
      setResult({ ...res, rows: res.rows.map(r => ({ ...r, include: !r.duplicate })) });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const update = (i, patch) =>
    setResult(r => ({ ...r, rows: r.rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) }));

  const setAll = (include) =>
    setResult(r => ({ ...r, rows: r.rows.map(row => ({ ...row, include })) }));

  const confirm = async () => {
    const chosen = result.rows
      .filter(r => r.include)
      .map(({ date, description, type, amount }) => ({ date, description, type, amount: Number(amount) }));
    if (!chosen.length) { setError("No rows are selected."); return; }

    setBusy(true); setError("");
    try {
      const res = await api.bulkCreateTransactions(accountId, chosen);
      setResult(null);
      setNotice(`Imported ${res.inserted} transaction${res.inserted === 1 ? "" : "s"}.`);
      await onImported();
    } catch (err) {
      // A partial-import failure reports how many rows actually landed, which
      // the user needs before deciding whether to retry.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!available) return null;

  const selected = result ? result.rows.filter(r => r.include).length : 0;

  return (
    <div className="mt-4" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div style={{ color: C.ivoryDim, fontSize: 12 }}>Import statement (PDF, CSV or Excel)</div>
        <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
          <FileUp size={13} />{busy ? "Reading…" : "Choose file"}
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.csv,.xls,.xlsx"
            onChange={choose}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {error && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {notice && !error && <div style={{ color: C.teal, fontSize: 12, marginBottom: 8 }}>{notice}</div>}

      {result && result.rows.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap" style={{ marginBottom: 6 }}>
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>
              {result.rows.length} found · {selected} selected
              {result.dateOrderAssumed ? ` · dates read as ${result.dateOrderAssumed}` : ""}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAll(true)} style={{ color: C.gold, fontSize: 12 }}>Select all</button>
              <button type="button" onClick={() => setAll(false)} style={{ color: C.ivoryDim, fontSize: 12 }}>Clear</button>
            </div>
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto", border: `1px solid ${C.hair}`, borderRadius: 6 }}>
            {result.rows.map((r, i) => (
              <div
                key={i}
                className="grid gap-2 items-center p-2"
                style={{
                  // One column per field on a phone; a single row on wider screens.
                  gridTemplateColumns: "auto 1fr",
                  borderBottom: `1px solid ${C.hair}`,
                  opacity: r.include ? 1 : 0.45,
                }}
              >
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={e => update(i, { include: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                  aria-label={`Include ${r.description || "transaction"}`}
                />
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                  <input
                    value={r.date}
                    onChange={e => update(i, { date: e.target.value })}
                    style={{ ...FIELD, fontFamily: MONO }}
                    aria-label="Date"
                  />
                  <input
                    value={r.description}
                    onChange={e => update(i, { description: e.target.value })}
                    style={{ ...FIELD, gridColumn: "span 2" }}
                    aria-label="Description"
                  />
                  <select
                    value={r.type}
                    onChange={e => update(i, { type: e.target.value })}
                    style={{ ...FIELD, background: C.panel }}
                    aria-label="Type"
                  >
                    <option value="credit">credit</option>
                    <option value="debit">debit</option>
                  </select>
                  <input
                    value={r.amount}
                    inputMode="decimal"
                    onChange={e => update(i, { amount: e.target.value })}
                    style={{ ...FIELD, fontFamily: MONO, textAlign: "right" }}
                    aria-label="Amount"
                  />
                </div>
                {r.duplicate && (
                  <div style={{ gridColumn: "2", color: C.gold, fontSize: 10.5 }}>
                    Already recorded on this account — unticked to avoid double-counting.
                  </div>
                )}
              </div>
            ))}
          </div>

          {result.rejected.length > 0 && (
            <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 6 }}>
              {result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} could not be read: {result.rejected[0].reason}
            </div>
          )}

          <div className="flex gap-2 mt-3 flex-wrap">
            <Btn onClick={confirm} disabled={busy || selected === 0}>
              {busy ? "Importing…" : `Import ${selected} transaction${selected === 1 ? "" : "s"}`}
            </Btn>
            <Btn variant="ghost" onClick={() => { setResult(null); setError(""); }}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount it on the account page**

In `client/src/pages/AccountDetail.jsx`, add to the imports:

```jsx
import StatementImport from "../components/StatementImport";
```

Then find the Files block — the `<div>` that starts with the heading `Files (statements, valuations, certificates, photos)` — and immediately after its closing `</div>`, before the `<div className="flex gap-2 mt-4">` action row, insert:

```jsx
        {!isPhysical && (
          <StatementImport accountId={account.id} onImported={onImagesChanged} />
        )}
```

`onImagesChanged` reloads the account together with its transactions and balances, so imported rows appear without a manual refresh.

- [ ] **Step 4: Build to verify it compiles**

Run: `cd client && npm run build`
Expected: `✓ built in …` with no errors

- [ ] **Step 5: Commit**

```bash
git add client/src/api.js client/src/components/StatementImport.jsx client/src/pages/AccountDetail.jsx
git commit -m "Add statement import review table"
```

---

### Task 7: Configuration and documentation

**Files:**
- Modify: `server/.env.example`
- Modify: `render.yaml`
- Modify: `README.md`

- [ ] **Step 1: Document the variables**

Append to `server/.env.example`:

```
# --- Statement import (PDF/CSV/XLSX -> transactions) --------------------
# Get a key at openrouter.ai. Without it, statement import hides itself in
# the UI and the parse endpoint reports that it is not configured.
OPENROUTER_API_KEY=
# Model used to read statements. Every request demands a zero-data-retention
# provider and fails rather than sending your statement to one that retains it.
OPENROUTER_MODEL=inclusionai/ling-3.0-flash:free
```

- [ ] **Step 2: Declare them on Render**

In `render.yaml`, add to `envVars` immediately after the `MONGODB_DB` entry:

```yaml
      # Statement import. Set the key in the dashboard; every request demands a
      # zero-data-retention provider and fails closed if none is available.
      - key: OPENROUTER_API_KEY
        sync: false
      - key: OPENROUTER_MODEL
        value: inclusionai/ling-3.0-flash:free
```

- [ ] **Step 3: Document the feature**

In `README.md`, under "What's simulated vs. real here", REPLACE the existing sentence "Note these are *stored as attachments* — uploading a CSV/XLSX statement does not yet parse it into transactions." with a new bullet placed directly after the File attachments bullet:

```markdown
- **Statement import**: real — upload a PDF, CSV or Excel bank statement to an account and its
  rows are extracted into transactions. Text-layer PDFs only; a scanned statement is detected and
  reported rather than guessed at. Extraction uses a model on OpenRouter, and every request demands
  a zero-data-retention provider, failing rather than sending your statement to one that would
  retain it. Nothing is saved until you review an editable table and confirm; rows matching
  existing transactions are flagged and unticked so re-importing an overlapping statement cannot
  double-count. Requires `OPENROUTER_API_KEY` — the feature hides itself when it is unset.
```

- [ ] **Step 4: Verify the whole suite**

Run: `cd server && npm test`
Expected: PASS

Run: `cd client && npm run build`
Expected: builds clean

- [ ] **Step 5: Commit**

```bash
git add server/.env.example render.yaml README.md
git commit -m "Document statement import configuration"
```

---

## Verification

After Task 7:

1. `cd server && npm test` — all tests pass (49 pre-existing plus roughly 45 new).
2. `cd client && npm run build` — clean.
3. `grep -rn "require(\"xlsx\")\|require('xlsx')" server/` — returns nothing (the vulnerable package must never appear).
4. Set `OPENROUTER_API_KEY` locally in `server/.env`, start both servers, and confirm `GET /api/statements/status` returns `{"configured":true}`.
5. Upload a real CSV statement to a non-physical account. Confirm the review table appears, that nothing is written until you press Import, and that the transactions appear afterwards.
6. Upload the same file again. Confirm every row is flagged as already recorded and arrives unticked.
7. Open the review table on a narrow viewport (or a phone) and confirm the fields wrap rather than overflowing horizontally.

## Known limitations

- Scanned/image PDFs are rejected, not OCR'd.
- The free OpenRouter tier allows roughly 50 requests/day, so bulk backfilling is slow.
- Extraction is probabilistic. The review table is the correctness guarantee, which is why nothing auto-commits.
- Duplicate detection matches on date + amount + description. Two genuinely identical transactions on the same day will be flagged as duplicates; the user can still tick them deliberately.

# Statement Import (PDF + CSV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a PDF or CSV bank statement to an account, have its rows extracted into transactions, review them in an editable table, and save the ones they confirm.

**Architecture:** Text is extracted locally (`pdf-parse` for PDF, direct decode for CSV), sent to a model on OpenRouter with zero-data-retention routing enforced, then passed through a pure normaliser that fixes dates, amounts and credit/debit before anything reaches the user. Parsing writes nothing to the database; a separate bulk endpoint inserts only the rows the user ticks, inside one SQLite transaction.

**Tech Stack:** Node 20, Express 4, better-sqlite3, `pdf-parse`, OpenRouter HTTP API, React 18 + Vite. Tests use Node's built-in `node:test` runner — no test framework is added.

## Global Constraints

- Node >= 18 (`server/package.json` engines); Render builds on Node 20 via `.node-version`.
- Never add a dependency with a native build step. `better-sqlite3` already fails to compile on Windows dev machines; pure-JS deps only.
- All new async Express routes MUST be wrapped in `asyncHandler` (`server/src/utils/asyncHandler.js`). An unhandled rejection kills the process on Node 20.
- Every outbound OpenRouter request MUST include `provider: { zdr: true, data_collection: "deny" }`. Never send statement text without it.
- Secrets (`OPENROUTER_API_KEY`) are set in the Render dashboard only, never committed. `server/.env` is gitignored.
- Transaction `type` column accepts exactly `"credit"` or `"debit"`.
- Dates are stored as `YYYY-MM-DD` strings, matching the existing `transactions.date` column.
- Pure-function tests (Tasks 1, 2, 4) run on any machine. Tests touching `db.js` need a working `better-sqlite3` build, so run those on Linux/macOS or in the Render shell.

---

### Task 1: Test runner and date/amount primitives

**Files:**
- Modify: `server/package.json` (add `test` script)
- Create: `server/src/services/normaliseFields.js`
- Test: `server/test/normaliseFields.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normaliseDate(raw: string, opts: { order?: "DD/MM" | "MM/DD" }) -> { iso: string, ambiguous: boolean } | null`
  - `normaliseAmount(raw: string | number) -> { value: number, negative: boolean } | null`
  - `detectDateOrder(rawDates: string[]) -> "DD/MM" | "MM/DD" | null`

- [ ] **Step 1: Add the test script**

In `server/package.json`, add to `"scripts"`:

```json
    "test": "node --test test/"
```

- [ ] **Step 2: Write the failing test**

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
});

test("normaliseDate resolves an unambiguous day-first date", () => {
  // 13 cannot be a month, so this is unambiguously DD/MM.
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

test("normaliseDate rejects nonsense", () => {
  assert.strictEqual(normaliseDate("not a date", {}), null);
  assert.strictEqual(normaliseDate("", {}), null);
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

test("normaliseAmount accepts numbers", () => {
  assert.deepStrictEqual(normaliseAmount(1234.5), { value: 1234.5, negative: false });
});

test("normaliseAmount rejects unparseable input", () => {
  assert.strictEqual(normaliseAmount("abc"), null);
  assert.strictEqual(normaliseAmount(""), null);
  assert.strictEqual(normaliseAmount(null), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/normaliseFields'`

- [ ] **Step 4: Implement the primitives**

Create `server/src/services/normaliseFields.js`:

```js
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function fullYear(y) {
  const n = Number(y);
  if (y.length === 4) return n;
  // Statements are historical, so a two-digit year is this century.
  return 2000 + n;
}

function valid(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/* "DD/MM" when some first part exceeds 12, "MM/DD" when some second part does,
   null when every date in the batch could be read either way. */
function detectDateOrder(rawDates) {
  for (const raw of rawDates || []) {
    const m = String(raw || "").match(/^\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s*$/);
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
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    return valid(y, m, d) ? { iso: iso(y, m, d), ambiguous: false } : null;
  }

  const monthMatch = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})$/);
  if (monthMatch) {
    const d = Number(monthMatch[1]);
    const m = MONTHS[monthMatch[2].slice(0, 3).toLowerCase()];
    const y = fullYear(monthMatch[3]);
    if (!m || !valid(y, m, d)) return null;
    return { iso: iso(y, m, d), ambiguous: false };
  }

  const numeric = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const y = fullYear(numeric[3]);

    // One of the parts above 12 settles the order by itself.
    if (a > 12 && b <= 12) return valid(y, b, a) ? { iso: iso(y, b, a), ambiguous: false } : null;
    if (b > 12 && a <= 12) return valid(y, a, b) ? { iso: iso(y, a, b), ambiguous: false } : null;
    if (a > 12 && b > 12) return null;

    // Genuinely ambiguous: fall back to the batch order, defaulting to day-first.
    const order = opts.order === "MM/DD" ? "MM/DD" : "DD/MM";
    const d = order === "DD/MM" ? a : b;
    const m = order === "DD/MM" ? b : a;
    return valid(y, m, d) ? { iso: iso(y, m, d), ambiguous: true } : null;
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
  const cleaned = s
    .replace(/[()]/g, "")
    .replace(/(?:INR|USD|Rs\.?|₹|\$|,|\s)/gi, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return { value: Math.abs(n), negative: bracketed || n < 0 };
}

module.exports = { normaliseDate, normaliseAmount, detectDateOrder };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS — all 17 tests

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/src/services/normaliseFields.js server/test/normaliseFields.test.js
git commit -m "Add date and amount normalisation for statement import"
```

---

### Task 2: Row normaliser

**Files:**
- Create: `server/src/services/normaliseTransactions.js`
- Test: `server/test/normaliseTransactions.test.js`

**Interfaces:**
- Consumes: `normaliseDate`, `normaliseAmount`, `detectDateOrder` from `./normaliseFields`.
- Produces: `normalise(rawRows: object[]) -> { rows: Array<{ date, description, type, amount }>, rejected: Array<{ raw, reason }>, dateOrderAssumed: "DD/MM" | "MM/DD" | null }`

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
  assert.deepStrictEqual(
    out.rows.map(r => [r.type, r.amount]),
    [["debit", 1500], ["credit", 2000]]
  );
});

test("normalise applies one date order across the whole batch", () => {
  // 13/02 proves day-first, so 03/04 must also be day-first.
  const out = normalise([
    { date: "13/02/2026", description: "A", amount: "1", type: "credit" },
    { date: "03/04/2026", description: "B", amount: "2", type: "credit" },
  ]);
  assert.strictEqual(out.dateOrderAssumed, "DD/MM");
  assert.deepStrictEqual(out.rows.map(r => r.date), ["2026-02-13", "2026-04-03"]);
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

test("normalise tidies descriptions and caps their length", () => {
  const out = normalise([
    { date: "2026-02-13", description: "  UPI   PAYMENT\n  REF 123 ", amount: "1", type: "credit" },
    { date: "2026-02-13", description: "x".repeat(600), amount: "1", type: "credit" },
  ]);
  assert.strictEqual(out.rows[0].description, "UPI PAYMENT REF 123");
  assert.strictEqual(out.rows[1].description.length, 500);
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

test("normalise ignores a non-array input", () => {
  assert.deepStrictEqual(normalise(null).rows, []);
  assert.deepStrictEqual(normalise(undefined).rejected, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/normaliseTransactions'`

- [ ] **Step 3: Implement the normaliser**

Create `server/src/services/normaliseTransactions.js`:

```js
const { normaliseDate, normaliseAmount, detectDateOrder } = require("./normaliseFields");

const MAX_DESCRIPTION = 500;

function cleanDescription(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION);
}

/* Works out credit vs debit from whichever convention the statement used:
   an explicit type, a Dr/Cr marker, separate columns, or a negative amount. */
function resolveType(row, amount) {
  const marker = String(row.type || row.drCr || "").trim().toLowerCase();
  if (marker.startsWith("cr")) return "credit";
  if (marker.startsWith("dr") || marker.startsWith("deb")) return "debit";
  if (marker === "credit" || marker === "deposit") return "credit";
  if (marker === "debit" || marker === "withdrawal") return "debit";

  if (row.deposit != null && String(row.deposit).trim() !== "") return "credit";
  if (row.withdrawal != null && String(row.withdrawal).trim() !== "") return "debit";
  if (row.credit != null && String(row.credit).trim() !== "") return "credit";
  if (row.debit != null && String(row.debit).trim() !== "") return "debit";

  if (amount && amount.negative) return "debit";
  return null;
}

function pickAmount(row) {
  const candidates = [row.amount, row.withdrawal, row.deposit, row.debit, row.credit];
  for (const c of candidates) {
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
Expected: PASS — all tests in both files

- [ ] **Step 5: Commit**

```bash
git add server/src/services/normaliseTransactions.js server/test/normaliseTransactions.test.js
git commit -m "Add statement row normaliser"
```

---

### Task 3: Text extraction from PDF and CSV

**Files:**
- Modify: `server/package.json` (add `pdf-parse`)
- Create: `server/src/services/statementText.js`
- Test: `server/test/statementText.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `extractText(buffer: Buffer, filename: string) -> Promise<{ text: string, kind: "pdf" | "csv" }>`. Throws `Error` with a user-facing message when the file cannot be read.

- [ ] **Step 1: Add the dependency**

In `server/package.json` `"dependencies"`, add:

```json
    "pdf-parse": "^1.1.1",
```

Then run: `cd server && npm install` (on a machine where `better-sqlite3` builds; otherwise `npm install --no-save pdf-parse` is enough to run the tests).

- [ ] **Step 2: Write the failing test**

Create `server/test/statementText.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { extractText } = require("../src/services/statementText");

test("extractText reads a CSV as text", async () => {
  const csv = "Date,Description,Amount\n2026-02-13,Salary,50000\n";
  const out = await extractText(Buffer.from(csv, "utf8"), "statement.csv");
  assert.strictEqual(out.kind, "csv");
  assert.match(out.text, /Salary/);
});

test("extractText rejects an unsupported extension", async () => {
  await assert.rejects(
    () => extractText(Buffer.from("x"), "notes.docx"),
    /PDF or CSV/i
  );
});

test("extractText rejects an empty file", async () => {
  await assert.rejects(
    () => extractText(Buffer.alloc(0), "empty.csv"),
    /empty/i
  );
});

test("extractText reports a PDF with no selectable text as scanned", async () => {
  // A structurally valid PDF containing no text objects.
  const blank = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
    "latin1"
  );
  await assert.rejects(() => extractText(blank, "scan.pdf"), /scanned|no selectable text/i);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/statementText'`

- [ ] **Step 4: Implement text extraction**

Create `server/src/services/statementText.js`:

```js
const path = require("path");

// Below this, a PDF almost certainly holds scanned images rather than text.
const MIN_PDF_TEXT_LENGTH = 20;

async function extractPdf(buffer) {
  // Required lazily so CSV imports work even if the PDF library is unavailable.
  const pdfParse = require("pdf-parse");

  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    if (/password|encrypt/i.test(err.message || "")) {
      throw new Error("This PDF is password-protected. Remove the password and upload it again.");
    }
    throw new Error("This PDF could not be read. It may be corrupted or in an unsupported format.");
  }

  const text = (parsed.text || "").trim();
  if (text.length < MIN_PDF_TEXT_LENGTH) {
    throw new Error(
      "This PDF has no selectable text, so it is probably a scan or photo. " +
      "Please upload a statement downloaded directly from your bank."
    );
  }
  return text;
}

async function extractText(buffer, filename) {
  if (!buffer || buffer.length === 0) throw new Error("That file is empty.");

  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".csv") {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("That file is empty.");
    return { text, kind: "csv" };
  }
  if (ext === ".pdf") {
    return { text: await extractPdf(buffer), kind: "pdf" };
  }

  throw new Error("Only PDF or CSV statements can be imported.");
}

module.exports = { extractText };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/services/statementText.js server/test/statementText.test.js
git commit -m "Add PDF and CSV text extraction for statement import"
```

---

### Task 4: OpenRouter extraction with ZDR enforced

**Files:**
- Create: `server/src/services/statementExtract.js`
- Test: `server/test/statementExtract.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `extractTransactions(text: string, opts?: { fetchImpl?: Function }) -> Promise<object[]>` — raw, unvalidated rows.
  - `isConfigured() -> boolean` — whether `OPENROUTER_API_KEY` is set.

`opts.fetchImpl` exists purely so tests can inject a stub; production passes nothing and the global `fetch` is used.

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

function modelResponse(obj) {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

test("isConfigured reflects the API key", () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.strictEqual(loadFresh().isConfigured(), false);
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.strictEqual(loadFresh().isConfigured(), true);
});

test("extractTransactions always enforces zero data retention", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelResponse({ transactions: [] }));
  await loadFresh().extractTransactions("some statement text", { fetchImpl });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepStrictEqual(body.provider, { zdr: true, data_collection: "deny" });
});

test("extractTransactions sends the configured model", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_MODEL = "some/other-model";
  const fetchImpl = stubFetch(modelResponse({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "some/other-model");
  delete process.env.OPENROUTER_MODEL;
});

test("extractTransactions defaults to the free Ling model", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.OPENROUTER_MODEL;
  const fetchImpl = stubFetch(modelResponse({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(JSON.parse(fetchImpl.calls[0].init.body).model, "inclusionai/ling-3.0-flash:free");
});

test("extractTransactions returns the rows the model reported", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const rows = [{ date: "2026-02-13", description: "Salary", type: "credit", amount: "50000" }];
  const fetchImpl = stubFetch(modelResponse({ transactions: rows }));
  const out = await loadFresh().extractTransactions("text", { fetchImpl });
  assert.deepStrictEqual(out, rows);
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
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /too many|rate/i);
});

test("extractTransactions rejects unparseable model output", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch({ choices: [{ message: { content: "I am not JSON" } }] });
  await assert.rejects(() => loadFresh().extractTransactions("text", { fetchImpl }), /could not read/i);
});

test("extractTransactions refuses to run without an API key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(() => loadFresh().extractTransactions("text", {}), /not configured/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `Cannot find module '../src/services/statementExtract'`

- [ ] **Step 3: Implement the extractor**

Create `server/src/services/statementExtract.js`:

```js
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "inclusionai/ling-3.0-flash:free";
const REQUEST_TIMEOUT_MS = 120000;
// Keeps a very long statement inside the model's context window.
const MAX_TEXT_CHARS = 120000;

const SYSTEM_PROMPT = [
  "You extract bank transactions from statement text.",
  "Return ONLY a JSON object of the form:",
  '{"transactions":[{"date":"...","description":"...","type":"credit|debit","amount":"..."}]}',
  "Copy dates and amounts exactly as they appear; do not reformat or convert them.",
  "Use 'credit' for money in and 'debit' for money out.",
  "Ignore opening/closing balance lines, page headers, footers and summary totals.",
  "If there are no transactions, return an empty array.",
].join(" ");

function isConfigured() {
  return !!process.env.OPENROUTER_API_KEY;
}

function describeFailure(status, bodyText) {
  if (status === 401 || status === 403) {
    return "OpenRouter rejected the API key. Check OPENROUTER_API_KEY.";
  }
  if (status === 429) {
    return "Too many requests to OpenRouter. The free tier allows a limited number per day — try again later.";
  }
  if (/data polic|no endpoints|no allowed providers/i.test(bodyText || "")) {
    return (
      "No zero-data-retention provider is available for this model, so the statement was not sent. " +
      "Set OPENROUTER_MODEL to a model with a ZDR provider."
    );
  }
  return `OpenRouter returned ${status}.`;
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
        // Never send statement text to a provider that may retain it. If none
        // is available the request fails, which is the intended behaviour.
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
    if (err.name === "AbortError") throw new Error("The import timed out. Try a shorter statement.");
    throw new Error(`Could not reach OpenRouter: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(describeFailure(res.status, bodyText));
  }

  const payload = await res.json();
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error("Could not read the statement — the extraction service returned an unexpected response.");
  }

  return Array.isArray(parsed.transactions) ? parsed.transactions : [];
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

### Task 5: Bulk insert endpoint

**Files:**
- Modify: `server/src/routes/transactions.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `POST /api/transactions/bulk`, accepting `{ accountId, rows: [{ date, description, type, amount }] }` and returning `{ inserted: number }`.

Requires a working `better-sqlite3` build to exercise manually.

- [ ] **Step 1: Add the route**

In `server/src/routes/transactions.js`, add after the existing `router.post("/", ...)` handler:

```js
/* Insert many transactions at once, for confirmed statement imports.
   Runs in a single SQLite transaction so a bad row cannot leave the
   ledger half-populated. */
router.post("/bulk", (req, res) => {
  const { accountId, rows } = req.body;
  if (!accountBelongsToUser(accountId, req.userId)) return res.status(404).json({ error: "Account not found." });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "No transactions to import." });
  if (rows.length > 2000) return res.status(400).json({ error: "Too many rows in one import (limit 2000)." });

  // The preview response is never trusted on the way back in.
  const clean = [];
  for (const r of rows) {
    const amount = Number(r && r.amount);
    const date = String((r && r.date) || "");
    const type = String((r && r.type) || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: `Invalid date: ${date}` });
    if (type !== "credit" && type !== "debit") return res.status(400).json({ error: `Invalid type: ${type}` });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: `Invalid amount: ${r && r.amount}` });
    clean.push({ date, type, amount, description: String((r && r.description) || "").slice(0, 500) });
  }

  const insert = db.prepare("INSERT INTO transactions (id, account_id, date, description, type, amount) VALUES (?, ?, ?, ?, ?, ?)");
  const insertAll = db.transaction((list) => {
    for (const r of list) insert.run(uuid(), accountId, r.date, r.description, r.type, r.amount);
  });
  insertAll(clean);

  res.json({ inserted: clean.length });
});
```

- [ ] **Step 2: Verify the file parses**

Run: `cd server && node --check src/routes/transactions.js`
Expected: no output (success)

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/transactions.js
git commit -m "Add bulk transaction insert endpoint"
```

---

### Task 6: Parse route with duplicate flagging

**Files:**
- Create: `server/src/routes/statements.js`
- Modify: `server/src/middleware/rateLimit.js` (add `importLimiter`)
- Modify: `server/src/index.js` (mount the route)

**Interfaces:**
- Consumes: `extractText` (Task 3), `extractTransactions` (Task 4), `normalise` (Task 2).
- Produces: `POST /api/statements/parse/:accountId` returning `{ rows, rejected, dateOrderAssumed }` where each row carries an added `duplicate: boolean`.

- [ ] **Step 1: Add the import limiter**

In `server/src/middleware/rateLimit.js`, add before `module.exports`:

```js
// Each import spends one of a limited number of daily upstream requests, so
// this is far tighter than the general API ceiling.
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many statement imports. Please wait an hour and try again." },
});
```

Change the export line to:

```js
module.exports = { authLimiter, apiLimiter, importLimiter };
```

- [ ] **Step 2: Create the route**

Create `server/src/routes/statements.js`:

```js
const express = require("express");
const multer = require("multer");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { importLimiter } = require("../middleware/rateLimit");
const { extractText } = require("../services/statementText");
const { extractTransactions, isConfigured } = require("../services/statementExtract");
const { normalise } = require("../services/normaliseTransactions");

const router = express.Router();
router.use(requireAuth);

// Statements are parsed in memory and never written to disk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function accountBelongsToUser(accountId, userId) {
  return !!db.prepare("SELECT id FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
}

function duplicateKey(date, amount, description) {
  return `${date}|${Number(amount).toFixed(2)}|${String(description || "").trim().toLowerCase()}`;
}

router.get("/status", (req, res) => res.json({ configured: isConfigured() }));

async function handleParse(req, res, uploadErr) {
  if (uploadErr) {
    const msg = uploadErr.code === "LIMIT_FILE_SIZE"
      ? "That statement is larger than 15MB."
      : uploadErr.message;
    return res.status(400).json({ error: msg });
  }
  if (!accountBelongsToUser(req.params.accountId, req.userId)) {
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

  const existing = new Set(
    db.prepare("SELECT date, amount, description FROM transactions WHERE account_id = ?")
      .all(req.params.accountId)
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

- [ ] **Step 3: Mount the route**

In `server/src/index.js`, add alongside the other route requires:

```js
const statementRoutes = require("./routes/statements");
```

and alongside the other `app.use` route mounts:

```js
app.use("/api/statements", statementRoutes);
```

- [ ] **Step 4: Verify the files parse**

Run: `cd server && node --check src/routes/statements.js && node --check src/index.js && node --check src/middleware/rateLimit.js`
Expected: no output (success)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/statements.js server/src/index.js server/src/middleware/rateLimit.js
git commit -m "Add statement parse endpoint with duplicate flagging"
```

---

### Task 7: Review table UI

**Files:**
- Modify: `client/src/api.js`
- Create: `client/src/components/StatementImport.jsx`
- Modify: `client/src/pages/AccountDetail.jsx`

**Interfaces:**
- Consumes: `POST /api/statements/parse/:accountId`, `GET /api/statements/status`, `POST /api/transactions/bulk`.
- Produces: `<StatementImport accountId onImported />` — renders the trigger, review table and confirm action.

- [ ] **Step 1: Add the API methods**

In `client/src/api.js`, add before `exportAll`:

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

export default function StatementImport({ accountId, onImported }) {
  const fileRef = useRef(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { rows, rejected, dateOrderAssumed }

  useEffect(() => {
    api.statementStatus().then(s => setAvailable(!!s.configured)).catch(() => setAvailable(false));
  }, []);

  const choose = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const res = await api.parseStatement(accountId, file);
      // Duplicates start unticked so re-importing cannot double-count.
      setResult({ ...res, rows: res.rows.map(r => ({ ...r, include: !r.duplicate })) });
    } catch (err) { setError(err.message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const update = (i, patch) =>
    setResult(r => ({ ...r, rows: r.rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) }));

  const confirm = async () => {
    const chosen = result.rows.filter(r => r.include).map(({ date, description, type, amount }) =>
      ({ date, description, type, amount: Number(amount) }));
    if (!chosen.length) { setError("No rows are selected."); return; }
    setBusy(true); setError("");
    try {
      await api.bulkCreateTransactions(accountId, chosen);
      setResult(null);
      await onImported();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (!available) return null;

  const selected = result ? result.rows.filter(r => r.include).length : 0;

  return (
    <div className="mt-4" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
      <div className="flex items-center justify-between mb-2">
        <div style={{ color: C.ivoryDim, fontSize: 12 }}>Import statement (PDF or CSV)</div>
        <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
          <FileUp size={13} />{busy ? "Reading…" : "Choose file"}
          <input ref={fileRef} type="file" accept=".pdf,.csv" onChange={choose} style={{ display: "none" }} />
        </label>
      </div>

      {error && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{error}</div>}

      {result && (
        <div>
          <div style={{ color: C.ivoryDim, fontSize: 12, marginBottom: 6 }}>
            Found {result.rows.length} transactions · {selected} selected
            {result.dateOrderAssumed ? ` · dates read as ${result.dateOrderAssumed}` : ""}
          </div>

          <div style={{ maxHeight: 320, overflowY: "auto", border: `1px solid ${C.hair}`, borderRadius: 6 }}>
            {result.rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1"
                   style={{ borderBottom: `1px solid ${C.hair}`, fontSize: 12.5, opacity: r.include ? 1 : 0.5 }}>
                <input type="checkbox" checked={r.include} onChange={e => update(i, { include: e.target.checked })} />
                <input value={r.date} onChange={e => update(i, { date: e.target.value })}
                       style={{ width: 96, background: "transparent", color: C.ivory, fontFamily: MONO }} />
                <input value={r.description} onChange={e => update(i, { description: e.target.value })}
                       style={{ flex: 1, background: "transparent", color: C.ivory }} />
                <select value={r.type} onChange={e => update(i, { type: e.target.value })}
                        style={{ background: C.panel, color: C.ivory }}>
                  <option value="credit">credit</option>
                  <option value="debit">debit</option>
                </select>
                <input value={r.amount} onChange={e => update(i, { amount: e.target.value })}
                       style={{ width: 96, textAlign: "right", background: "transparent", color: C.ivory, fontFamily: MONO }} />
                {r.duplicate && <span style={{ color: C.gold, fontSize: 10 }}>dup</span>}
              </div>
            ))}
          </div>

          {result.rejected.length > 0 && (
            <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 6 }}>
              {result.rejected.length} row(s) could not be read: {result.rejected[0].reason}
            </div>
          )}

          <div className="flex gap-2 mt-3">
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

In `client/src/pages/AccountDetail.jsx`, add the import at the top:

```jsx
import StatementImport from "../components/StatementImport";
```

Then, immediately after the closing `</div>` of the Files block (the one containing the attachment tiles) and before the `<div className="flex gap-2 mt-4">` action row, insert:

```jsx
        {!isPhysical && (
          <StatementImport accountId={account.id} onImported={onImagesChanged} />
        )}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd client && npm run build`
Expected: `✓ built in …` with no errors

- [ ] **Step 5: Commit**

```bash
git add client/src/api.js client/src/components/StatementImport.jsx client/src/pages/AccountDetail.jsx
git commit -m "Add statement import review table"
```

---

### Task 8: Configuration and documentation

**Files:**
- Modify: `server/.env.example`
- Modify: `render.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (Task 4).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Document the variables**

Append to `server/.env.example`:

```
# --- Statement import (PDF/CSV -> transactions) -------------------------
# Get a key at openrouter.ai. Without it, statement import is hidden in the UI.
OPENROUTER_API_KEY=
# Model used to read statements. Requests always demand a zero-data-retention
# provider, and fail rather than sending your statement to one that retains it.
OPENROUTER_MODEL=inclusionai/ling-3.0-flash:free
```

- [ ] **Step 2: Declare the variables on Render**

In `render.yaml`, add to `envVars` after `MAIL_FROM`:

```yaml
      # Statement import. Set the key in the dashboard; requests always demand
      # a zero-data-retention provider.
      - key: OPENROUTER_API_KEY
        sync: false
      - key: OPENROUTER_MODEL
        value: inclusionai/ling-3.0-flash:free
```

- [ ] **Step 3: Document the feature**

In `README.md`, under "What's simulated vs. real here", add after the file attachments bullet:

```markdown
- **Statement import**: real — upload a PDF or CSV bank statement to an account and its rows
  are extracted into transactions. Extraction uses a model on OpenRouter, and every request
  demands a zero-data-retention provider, failing rather than sending your statement to one
  that would retain it. Nothing is saved until you review an editable table and confirm;
  rows matching existing transactions are flagged and unticked so re-importing an overlapping
  statement cannot double-count. Requires `OPENROUTER_API_KEY`; the feature hides itself when
  it is unset. Text-based PDFs only — scanned statements are detected and reported, not guessed at.
```

- [ ] **Step 4: Verify the whole suite still passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/.env.example render.yaml README.md
git commit -m "Document statement import configuration"
```

---

## Verification

After Task 8, confirm end to end:

1. `cd server && npm test` — all tests pass.
2. `cd client && npm run build` — builds clean.
3. Set `OPENROUTER_API_KEY` in Render, redeploy, and check `GET /api/statements/status` returns `{"configured":true}`.
4. Upload a real CSV statement to a non-physical account. Confirm the review table appears, that nothing is written until confirming, and that the transactions appear afterwards.
5. Upload the same file again. Confirm every row is flagged `dup` and arrives unticked.

## Known limitations carried from the spec

- If the free Ling model has no zero-retention provider, parsing fails with a clear message and `OPENROUTER_MODEL` must be changed. This is intentional fail-closed behaviour.
- Scanned/image PDFs are rejected, not OCR'd.
- XLSX is not supported.
- On Render's free plan the database has no persistent disk, so imported transactions are lost on redeploy.

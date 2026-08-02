# Account Page Restructure + Balance Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an account's balance correct and honest — anchored to a logged balance plus later transactions, "not set" rather than a false zero — and restructure the account page so each card does one job with its actions beside it.

**Architecture:** `latestValue` moves from "last logged balance" to the standard anchor model: most recent balance log plus transactions dated after it, returning `null` when no anchor exists. Every call site is updated to handle `null` explicitly. Statement import gains a `closingBalance` field so one import produces both history and a correct balance. The account page splits from one five-job card into five single-job cards.

**Tech Stack:** React 18, Vite, Node 20, Express 4, MongoDB, OpenRouter, Node's built-in `node:test`.

## Global Constraints

- **`fmt(null)` renders `"₹0"`** because it does `Number(amount) || 0`. A `null` balance must therefore be checked by the caller *before* it reaches `fmt` — never rely on `fmt` to display "not set".
- **An account with no balance anchor is UNKNOWN, not zero.** It must never be summed into a net-worth total. Silently contributing zero to a financial total is the defect this plan exists to fix.
- `latestValue` has exactly **five call sites**: `pages/AccountDetail.jsx:17`, `pages/AccountsList.jsx:38`, `pages/Dashboard.jsx:13`, `pages/Dashboard.jsx:26`, `pages/Reports.jsx:10`. All five must be updated. All four pages already receive `txByAccount` as a prop — no prop plumbing is required.
- Physical asset types (`gold`, `silver`, `jewelry`, `automobile`, `real_estate` — exported as `PHYSICAL_TYPES`) keep using `currentValue` and are never `null`. They have no transactions and no anchor.
- Transactions dated **on or before** the anchor date are already reflected in it and MUST NOT be added again. Only strictly-later transactions adjust the balance.
- Money is a finite JS number. Never produce `NaN` — this app already shipped a Critical bug where `NaN` reached a money field and rendered as a silent zero.
- Statement passwords remain secret: never logged, persisted, or interpolated. Do not weaken anything in `statementText.js` or `statements.js` around that.
- Every OpenRouter request keeps `provider: { zdr: true, data_collection: "deny" }`.
- Tests use Node's built-in `node:test`. No Jest, Vitest, jsdom, or React test runner. No new dependencies.
- No horizontal scroll at 320px, 375px or 768px. The app was measured clean at all three and must stay that way.
- Status copy uses the existing `"Verb…"` convention already in the codebase (`"Uploading…"`, `"Reading…"`, `"Importing…"`, `"Unlocking…"`).

## File structure

| File | Responsibility |
| --- | --- |
| `client/src/theme.js` | `latestValue` anchor math; returns `null` when unknown. |
| `client/test/balance.test.js` | Framework-free tests for the anchor math. |
| `client/src/pages/Dashboard.jsx` | Exclude unknown accounts from totals; report how many. |
| `client/src/pages/AccountsList.jsx` | Render "Not set" instead of ₹0. |
| `client/src/pages/Reports.jsx` | Exclude unknown accounts from the summary. |
| `server/src/services/statementExtract.js` | Ask the model for `closingBalance`. |
| `server/src/routes/statements.js` | Return the normalised closing balance in the parse response. |
| `client/src/components/StatementImport.jsx` | Balance row in review; two-stage status; AI notice. |
| `client/src/pages/AccountDetail.jsx` | Five single-job cards. |

---

### Task 1: Anchor-model balance math

**Files:**
- Modify: `client/src/theme.js:41-46`
- Test: `client/test/balance.test.js` (create)

**Interfaces:**
- Consumes: `PHYSICAL_TYPES` from `theme.js`.
- Produces: `latestValue(account, balanceLogsByAccount, txByAccount) -> number | null`. Returns `null` only for non-physical accounts with no balance log. Physical accounts always return a number.

Note the **third parameter is new**. Callers are updated in Task 2.

- [ ] **Step 1: Write the failing test**

Create `client/test/balance.test.js`. Note the **ESM `import` syntax** — `client/package.json` sets `"type": "module"`, so `require` would throw. This matches the existing `client/test/attachmentBlobCache.test.js`. Importing `theme.js` under plain `node --test` works despite its `lucide-react` import; that was verified.

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npm test`
Expected: FAIL — the null and anchor-math cases fail because the current implementation returns `0` and ignores transactions.

- [ ] **Step 3: Implement**

In `client/src/theme.js`, replace lines 41-46 with:

```js
/* An account's value follows the standard anchor model: the most recently
   logged balance, plus any transactions dated strictly after it. Transactions
   on or before the anchor are already reflected in it -- a July closing balance
   already contains every July transaction -- so adding them would double-count.

   Returns null when a non-physical account has no anchor. That is deliberately
   not 0: zero asserts the account is empty, null says we do not know, and only
   one of those is true. Callers must handle null before formatting, because
   fmt() turns null into "0". */
export function latestValue(account, balanceLogsByAccount, txByAccount) {
  if (PHYSICAL_TYPES.includes(account.type)) return Number(account.currentValue) || 0;

  const logs = (balanceLogsByAccount || {})[account.id] || [];
  if (!logs.length) return null;

  const anchor = [...logs].sort((a, b) => b.date.localeCompare(a.date))[0];
  const base = Number(anchor.balance) || 0;

  const later = ((txByAccount || {})[account.id] || []).filter(t => t.date > anchor.date);
  const delta = later.reduce((sum, t) => {
    const amt = Number(t.amount) || 0;
    return sum + (t.type === "credit" ? amt : -amt);
  }, 0);

  return base + delta;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/theme.js client/test/balance.test.js
git commit -m "Compute account balance from an anchor plus later transactions"
```

---

### Task 2: Handle an unknown balance at every call site

**Files:**
- Modify: `client/src/pages/Dashboard.jsx:10-33`
- Modify: `client/src/pages/AccountsList.jsx:38`
- Modify: `client/src/pages/Reports.jsx:10`
- Modify: `client/src/pages/AccountDetail.jsx:17`

**Interfaces:**
- Consumes: `latestValue(account, balanceLogsByAccount, txByAccount) -> number | null` from Task 1.
- Produces: no new exports. Task 5 relies on `AccountDetail` having `val` possibly `null`.

- [ ] **Step 1: Exclude unknown accounts from Dashboard totals**

In `client/src/pages/Dashboard.jsx`, replace the `byCurrency` memo (starting `const byCurrency = useMemo(`) with:

```jsx
  const byCurrency = useMemo(() => {
    const res = { USD: { total: 0, liquid: 0, nonLiquid: 0 }, INR: { total: 0, liquid: 0, nonLiquid: 0 } };
    accounts.forEach(a => {
      const val = latestValue(a, balByAccount, txByAccount);
      // An account with no balance anchor is unknown, not empty. Adding 0 would
      // quietly understate net worth and look like a confident answer.
      if (val === null) return;
      const liquid = a.isLiquid === null || a.isLiquid === undefined ? typeInfo(a.type).liquid : a.isLiquid;
      res[a.currency].total += val;
      if (liquid) res[a.currency].liquid += val; else res[a.currency].nonLiquid += val;
    });
    return res;
  }, [accounts, balByAccount, txByAccount]);

  const unvaluedCount = useMemo(
    () => accounts.filter(a => latestValue(a, balByAccount, txByAccount) === null).length,
    [accounts, balByAccount, txByAccount]
  );
```

Then replace the `byType` memo with:

```jsx
  const byType = useMemo(() => {
    const map = {};
    accounts.forEach(a => {
      const val = latestValue(a, balByAccount, txByAccount);
      if (val === null) return;
      const valUSD = a.currency === "INR" ? val / (fxRate || 83) : val;
      map[a.type] = (map[a.type] || 0) + valUSD;
    });
    return Object.entries(map).map(([type, value]) => ({ name: typeInfo(type).label, value: Math.round(value) }));
```

- [ ] **Step 2: Tell the user what was excluded**

Still in `Dashboard.jsx`, find the line rendering the FX-rate caption:

```jsx
Using FX rate 1 USD = {fxRate || 83} INR (set in Settings)
```

and immediately after that element's closing tag, add:

```jsx
        {unvaluedCount > 0 && (
          <div style={{ color: C.amber, fontSize: 12, marginTop: 6 }}>
            {unvaluedCount} account{unvaluedCount === 1 ? "" : "s"} excluded — no balance logged yet.
          </div>
        )}
```

- [ ] **Step 3: Show "Not set" in the accounts list**

In `client/src/pages/AccountsList.jsx`, change line 38 from:

```jsx
          const val = latestValue(a, balByAccount);
```

to:

```jsx
          const val = latestValue(a, balByAccount, txByAccount);
```

Then find where that row renders the amount — the element containing `{fmt(val, a.currency)}` — and replace just that expression with:

```jsx
{val === null ? "Not set" : fmt(val, a.currency)}
```

- [ ] **Step 4: Exclude unknown accounts from Reports**

In `client/src/pages/Reports.jsx`, change line 10 from:

```jsx
    const val = latestValue(a, balByAccount);
```

to:

```jsx
    const val = latestValue(a, balByAccount, txByAccount);
    if (val === null) return;
```

Note: confirm the enclosing callback is a `forEach` (an early `return` skips the account). If it is a `map`, convert the surrounding chain to `forEach` with an accumulator so a skipped account contributes nothing rather than `undefined`.

- [ ] **Step 5: Pass transactions in AccountDetail**

In `client/src/pages/AccountDetail.jsx`, change line 17 from:

```jsx
  const val = latestValue(account, balByAccount);
```

to:

```jsx
  const val = latestValue(account, balByAccount, txByAccount);
```

Leave the rendering alone for now — Task 5 restructures that card.

- [ ] **Step 6: Verify**

Run: `cd client && npm test && npm run build`
Expected: tests PASS, build clean.

Then confirm no call site was missed:

Run: `grep -rn "latestValue(" client/src/pages client/src/components`
Expected: every result passes three arguments.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/pages/AccountsList.jsx client/src/pages/Reports.jsx client/src/pages/AccountDetail.jsx
git commit -m "Exclude accounts with no balance anchor from net-worth totals"
```

---

### Task 3: Extract the statement's closing balance

**Files:**
- Modify: `server/src/services/statementExtract.js`
- Modify: `server/src/routes/statements.js`
- Test: `server/test/statementExtract.test.js`
- Test: `server/test/statements.test.js`

**Interfaces:**
- Consumes: `normaliseDate`, `normaliseAmount` from `server/src/services/normaliseFields.js`.
- Produces:
  - `extractTransactions(text, opts)` now returns `{ transactions: object[], closingBalance: { date, amount } | null }` instead of a bare array. **This is a breaking change to that function's return type** — `routes/statements.js` is the only caller and is updated in this task.
  - `POST /api/statements/parse/:accountId` response gains `closingBalance: { date: "YYYY-MM-DD", amount: number } | null`.

- [ ] **Step 1: Write the failing extraction test**

Append to `server/test/statementExtract.test.js`:

```js
test("extractTransactions returns transactions and a closing balance", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const payload = modelSaid({
    transactions: [{ date: "2026-07-31", description: "SALARY", type: "credit", amount: "50000" }],
    closingBalance: { date: "2026-07-31", amount: "1,23,456.00" },
  });
  const fetchImpl = stubFetch(payload);
  const out = await loadFresh().extractTransactions("text", { fetchImpl });
  assert.strictEqual(out.transactions.length, 1);
  assert.deepStrictEqual(out.closingBalance, { date: "2026-07-31", amount: "1,23,456.00" });
});

test("extractTransactions returns a null closing balance when the model omits it", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  const out = await loadFresh().extractTransactions("text", { fetchImpl });
  assert.deepStrictEqual(out.transactions, []);
  assert.strictEqual(out.closingBalance, null);
});

test("extractTransactions still asks for the closing balance in the prompt", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const fetchImpl = stubFetch(modelSaid({ transactions: [] }));
  await loadFresh().extractTransactions("text", { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  const system = body.messages[0].content;
  assert.match(system, /closingBalance/);
  // Balance rows must still be kept OUT of the transaction list.
  assert.match(system, /Ignore .*balance/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `out.transactions` is undefined because the function currently returns a bare array.

- [ ] **Step 3: Update the prompt and return shape**

In `server/src/services/statementExtract.js`, replace the `SYSTEM_PROMPT` constant with:

```js
const SYSTEM_PROMPT = [
  "You extract bank transactions from statement text.",
  'Return ONLY a JSON object of the form {"transactions":[{"date":"...","description":"...","type":"credit|debit","amount":"..."}],"closingBalance":{"date":"...","amount":"..."}}.',
  "Copy dates and amounts EXACTLY as they appear in the statement; never reformat, convert or recalculate them.",
  "Use 'credit' for money coming in and 'debit' for money going out.",
  "Ignore opening and closing balance lines, running balance columns, page headers and footers, and summary totals when building the transactions array.",
  'Separately, if the statement states a closing or ending balance, report it as closingBalance with the date it applies to. If there is no clear closing balance, set closingBalance to null.',
  "Ignore page markers of the form '-- 1 of 3 --'.",
  "If there are no transactions, return an empty array.",
].join(" ");
```

Then replace the final `return` of `extractTransactions` with:

```js
  const transactions = Array.isArray(parsed && parsed.transactions) ? parsed.transactions : [];
  const cb = parsed && parsed.closingBalance;
  // Kept raw here; normalising happens in the route alongside the transactions
  // so both go through the same date/amount parsing.
  const closingBalance = cb && (cb.date || cb.amount) ? cb : null;
  return { transactions, closingBalance };
```

- [ ] **Step 4: Write the failing route test**

Append to `server/test/statements.test.js`:

```js
test("parse returns a normalised closing balance", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => ({
    transactions: [{ date: "31/07/2026", description: "SALARY", type: "credit", amount: "50000" }],
    closingBalance: { date: "31/07/2026", amount: "1,23,456.00" },
  });
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    const json = await res.json();
    assert.deepStrictEqual(json.closingBalance, { date: "2026-07-31", amount: 123456 });
  });
});

test("parse returns closingBalance null when the extractor found none", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => ({ transactions: [], closingBalance: null });
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual((await res.json()).closingBalance, null);
  });
});

test("parse drops an unparseable closing balance rather than guessing", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const extract = async () => ({
    transactions: [],
    closingBalance: { date: "not a date", amount: "abc" },
  });
  await withServer(t, { accounts, extract }, async (base) => {
    const { body, contentType } = uploadForm("x", "s.csv");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual((await res.json()).closingBalance, null);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — the route ignores `closingBalance` and, because the extractor now returns an object, `normalise` receives a non-array.

- [ ] **Step 6: Update the route**

In `server/src/routes/statements.js`, add to the requires at the top:

```js
const { normaliseDate, normaliseAmount } = require("../services/normaliseFields");
```

Replace the extraction and normalisation block with:

```js
  let extracted;
  try {
    extracted = await statementExtract.extractTransactions(text);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const { rows, rejected, dateOrderAssumed } = normalise(extracted.transactions);

  // The closing balance is the anchor the balance model needs. Parsed with the
  // same helpers as the transactions, and dropped entirely if either half is
  // unreadable -- a guessed balance is worse than no balance.
  let closingBalance = null;
  if (extracted.closingBalance) {
    const d = normaliseDate(extracted.closingBalance.date, { order: dateOrderAssumed || "DD/MM" });
    const a = normaliseAmount(extracted.closingBalance.amount);
    if (d && a) closingBalance = { date: d.iso, amount: a.negative ? -a.value : a.value };
  }
```

Then add `closingBalance` to the response object:

```js
  res.json({
    rows: rows.map(r => ({ ...r, duplicate: existing.has(duplicateKey(r.date, r.amount, r.description)) })),
    rejected,
    dateOrderAssumed,
    closingBalance,
  });
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd server && npm test && node --check src/routes/statements.js`
Expected: PASS, no parse output.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/statementExtract.js server/src/routes/statements.js server/test/statementExtract.test.js server/test/statements.test.js
git commit -m "Extract the statement closing balance as a separate field"
```

---

### Task 4: Import the balance, and show what the app is doing

**Files:**
- Modify: `client/src/components/StatementImport.jsx`

**Interfaces:**
- Consumes: `closingBalance: { date, amount } | null` from the parse response (Task 3); `api.createBalance({ accountId, date, balance })` which already exists in `client/src/api.js`.
- Produces: no new exports.

- [ ] **Step 1: Add the two-stage status and the balance row state**

In `client/src/components/StatementImport.jsx`, add after the existing `const [password, setPassword] = useState("");` line:

```jsx
  // Split so the user can tell local file reading (instant) from the AI call
  // (10-30s). One undifferentiated spinner for both looks like a hang.
  const [stage, setStage] = useState("");
  const [includeBalance, setIncludeBalance] = useState(true);
```

In `runParse`, replace the line `setBusy(true); setError(""); setNotice(""); setResult(null);` with:

```jsx
    setBusy(true); setError(""); setNotice(""); setResult(null);
    setStage("Reading file…");
    // The AI call dominates the wall time, so switch the label almost
    // immediately rather than after the request resolves.
    const stageTimer = setTimeout(() => setStage("Extracting with AI…"), 400);
```

and in that same function's `finally` block, add as its first line:

```jsx
      clearTimeout(stageTimer);
      setStage("");
```

In the success path of `runParse`, immediately after `setResult({ ... })`, add:

```jsx
      setIncludeBalance(!!res.closingBalance);
```

- [ ] **Step 2: Show the stage on the trigger**

Replace the file-picker label's text expression:

```jsx
          <FileUp size={13} />{busy ? "Reading…" : "Choose file"}
```

with:

```jsx
          <FileUp size={13} />{busy ? (stage || "Working…") : "Choose file"}
```

- [ ] **Step 3: Render the closing-balance row**

Immediately after the `<div className="flex items-center justify-between gap-2 flex-wrap" style={{ marginBottom: 6 }}>` block that shows the row count, and before the scrolling rows container, insert:

```jsx
          {result.closingBalance && (
            <div
              className="flex items-center gap-2 p-2 flex-wrap"
              style={{ border: `1px solid ${C.hair}`, borderRadius: 6, marginBottom: 6, background: C.panelHi }}
            >
              <input
                type="checkbox"
                checked={includeBalance}
                onChange={e => setIncludeBalance(e.target.checked)}
                style={{ width: 18, height: 18 }}
                aria-label="Also set the account balance"
              />
              <div style={{ fontSize: 12.5, color: C.ivory, flex: "1 1 180px", minWidth: 0 }}>
                Set balance to{" "}
                <b style={{ fontFamily: MONO, color: C.gold }}>{result.closingBalance.amount}</b>{" "}
                as of {result.closingBalance.date}
              </div>
              <div style={{ fontSize: 10.5, color: C.ivoryDim }}>closing balance from the statement</div>
            </div>
          )}
```

- [ ] **Step 4: Log the balance on confirm**

In `confirm`, replace the body of the `try` block with:

```jsx
      const res = await api.bulkCreateTransactions(accountId, chosen);
      let balanceNote = "";
      if (includeBalance && result.closingBalance) {
        // Logged after the transactions so the anchor reflects them.
        await api.createBalance({
          accountId,
          date: result.closingBalance.date,
          balance: result.closingBalance.amount,
        });
        balanceNote = ` · balance set to ${result.closingBalance.amount}`;
      }
      setResult(null);
      setNotice(`Imported ${res.inserted} transaction${res.inserted === 1 ? "" : "s"}${balanceNote}.`);
      await onImported();
```

and replace the `setBusy(true); setError("");` line at the start of `confirm` with:

```jsx
    setBusy(true); setError(""); setStage("Saving…");
```

adding `setStage("");` as the first line of that function's `finally` block.

- [ ] **Step 5: Update the confirm button label**

Replace the import button's label expression:

```jsx
              {busy ? "Importing…" : `Import ${selected} transaction${selected === 1 ? "" : "s"}`}
```

with:

```jsx
              {busy ? (stage || "Importing…") : `Import ${selected} transaction${selected === 1 ? "" : "s"}`}
```

- [ ] **Step 6: Add the AI disclosure**

Immediately after the file-picker row's closing `</div>` (the row containing the "Import statement" heading and the Choose file label), insert:

```jsx
      {/* Placed where the decision is made, not buried in settings. */}
      <div style={{ color: C.ivoryDim, fontSize: 10.5, marginBottom: 8, lineHeight: 1.4 }}>
        Read by AI (zero data retention). Always check the rows before importing.
      </div>
```

- [ ] **Step 7: Verify**

Run: `cd client && npm run build`
Expected: `✓ built in …` with no errors.

Run: `cd client && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/components/StatementImport.jsx
git commit -m "Import the statement closing balance and report progress"
```

---

### Task 5: Split the account page into single-job cards

**Files:**
- Modify: `client/src/pages/AccountDetail.jsx`

**Interfaces:**
- Consumes: `val` may be `null` (Task 2); `StatementImport` unchanged in signature (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Add a shared card style**

In `client/src/pages/AccountDetail.jsx`, directly below the imports, add:

```jsx
// One card, one job. Previously a single card carried identity, nominees,
// file storage, statement import and an action row whose every button operated
// on a different card's contents.
const CARD = {
  background: C.panel,
  border: `1px solid ${C.hair}`,
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
};

const CARD_TITLE = { color: C.ivory, fontFamily: SERIF, fontSize: 15, marginBottom: 8 };
const CARD_SUB = { color: C.ivoryDim, fontSize: 11.5, marginBottom: 10, lineHeight: 1.4 };
```

- [ ] **Step 2: Fix the blank-institution separator**

Find the header line rendering `{info.label} · {account.institution} · {account.country}` and replace that expression with:

```jsx
{[info.label, account.institution, account.country].filter(Boolean).join(" · ")}
```

- [ ] **Step 3: Restructure into five cards**

Replace everything from the opening `<div style={{ background: C.panel, ... marginBottom: 16 }}>` through the closing `</div>` of the old action row (the block containing Edit account / Log Transaction / Log Balance / Download History) with:

```jsx
      {/* 1. IDENTITY */}
      <div style={CARD}>
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>
              {[info.label, account.institution, account.country].filter(Boolean).join(" · ")}
            </div>
            <div style={{ fontFamily: SERIF, fontSize: 24, color: C.ivory }}>{account.name}</div>
          </div>
          <Btn variant="ghost" onClick={onEdit}><Pencil size={13} />Edit account</Btn>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4" style={{ fontSize: 12.5, color: C.ivoryDim }}>
          {account.lastKYCDate && <div>Last KYC: <b style={{ color: C.ivory }}>{account.lastKYCDate}</b></div>}
          {account.interestRate ? <div>Interest: <b style={{ color: C.ivory }}>{account.interestRate}% ({account.interestFrequency})</b></div> : null}
          {(account.type === "gold" || account.type === "silver") && (
            <>
              <div>Purity: <b style={{ color: C.ivory }}>{account.purity || "—"}</b></div>
              <div>Form / Qty: <b style={{ color: C.ivory }}>{account.form} × {account.quantity || 0}</b></div>
              <div>City: <b style={{ color: C.ivory }}>{account.city || "—"}</b></div>
            </>
          )}
          {account.type === "automobile" && (
            <>
              <div>VIN: <b style={{ color: C.ivory }}>{account.vin || "—"}</b></div>
              <div>Vehicle: <b style={{ color: C.ivory }}>{account.year} {account.make} {account.model}</b></div>
            </>
          )}
        </div>

        {account.nominees?.length > 0 && (
          <div className="mt-3">
            <div style={{ color: C.ivoryDim, fontSize: 12, marginBottom: 4 }}><Users size={12} className="inline mr-1" />Nominees</div>
            <div className="flex gap-2 flex-wrap">
              {account.nominees.map(n => (
                <span key={n.id} style={{ fontSize: 12.5, color: C.ivory, background: C.panelHi, padding: "4px 10px", borderRadius: 20 }}>
                  {n.name} ({n.relation}{n.percent ? `, ${n.percent}%` : ""})
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. BALANCE (or VALUATION for physical assets) */}
      <div style={CARD}>
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div style={CARD_TITLE}>{isPhysical ? "Valuation" : "Balance"}</div>
            <div style={{ fontFamily: MONO, fontSize: 28, color: val === null ? C.ivoryDim : C.gold }}>
              {val === null ? "Not set" : fmt(val, account.currency)}
            </div>
            {isPhysical ? (
              account.valueDate && (
                <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 2 }}>
                  priced {account.valueDate}
                  {account.valueUrl && <> · <a href={account.valueUrl} target="_blank" rel="noreferrer" style={{ color: C.teal }}>source</a></>}
                </div>
              )
            ) : val === null ? (
              <div style={{ color: C.amber, fontSize: 11.5, marginTop: 2 }}>
                No balance logged, so this account is left out of your net worth.
              </div>
            ) : (
              <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 2 }}>
                anchored {logs[0].date}
                {laterTxnCount > 0 && ` · ${laterTxnCount} later transaction${laterTxnCount === 1 ? "" : "s"} applied`}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {isPhysical
              ? <Btn onClick={onUpdateValue}><RefreshCw size={13} />Update Value</Btn>
              : <Btn onClick={onAddBalance}><Plus size={13} />Log Balance</Btn>}
          </div>
        </div>

        {!isPhysical && logs.length > 0 && (
          <div className="mt-3" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 8, maxHeight: 140, overflowY: "auto" }}>
            {logs.map(l => (
              <div key={l.id} className="flex justify-between py-1" style={{ fontSize: 12.5 }}>
                <span style={{ color: C.ivoryDim }}>{l.date}</span>
                <span style={{ color: C.ivory, fontFamily: MONO }}>{fmt(l.balance, account.currency)}</span>
              </div>
            ))}
          </div>
        )}
        {isStale(account, txByAccount, balByAccount) && <div className="mt-2"><StaleBadge /></div>}
      </div>

      {/* 3. TRANSACTIONS */}
      {!isPhysical && (
        <div style={CARD}>
          <div className="flex justify-between items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
            <div style={{ ...CARD_TITLE, marginBottom: 0 }}>Transactions ({txns.length})</div>
            <div className="flex gap-2 flex-wrap">
              <Btn onClick={onAddTxn}><Plus size={13} />Log Transaction</Btn>
              <Btn variant="ghost" onClick={exportCsv}><Download size={13} />CSV</Btn>
            </div>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {txns.map(t => (
              <div key={t.id} className="flex justify-between gap-2 py-1.5" style={{ borderBottom: `1px solid ${C.hair}`, fontSize: 13 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ color: C.ivoryDim }}>{t.date}</span>{" "}
                  <span style={{ color: C.ivory }}>{t.description}</span>
                </div>
                <div style={{ color: t.type === "credit" ? C.teal : C.crimson, fontFamily: MONO, whiteSpace: "nowrap" }}>
                  {t.type === "credit" ? "+" : "-"}{fmt(t.amount, account.currency)}
                </div>
              </div>
            ))}
            {txns.length === 0 && <EmptyNote text="No transactions logged yet." />}
          </div>
        </div>
      )}

      {/* 4. IMPORT STATEMENT */}
      {!isPhysical && (
        <div style={CARD}>
          <div style={CARD_TITLE}>Import statement</div>
          <div style={CARD_SUB}>Reads a PDF, CSV or Excel statement and creates transactions from it.</div>
          <StatementImport accountId={account.id} onImported={onImagesChanged} />
        </div>
      )}

      {/* 5. DOCUMENTS */}
      <div style={CARD}>
        <div style={CARD_TITLE}>Documents</div>
        <div style={CARD_SUB}>Stored for reference — never read. Valuations, KYC papers, locker photos.</div>
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div style={{ color: C.ivoryDim, fontSize: 12 }}>{(account.images || []).length} file(s)</div>
          <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
            <Upload size={13} />{uploading ? "Uploading…" : "Upload"}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf,.csv,.xls,.xlsx,.doc,.docx,.txt"
              multiple
              onChange={handleUpload}
              style={{ display: "none" }}
            />
          </label>
        </div>
        {uploadError && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{uploadError}</div>}
        <div className="flex gap-2 flex-wrap">
          {(account.images || []).map(att => (
            <Attachment key={att.id} att={att} onRemove={removeFile} />
          ))}
          {(!account.images || account.images.length === 0) && <div style={{ color: C.ivoryDim, fontSize: 12 }}>No files yet.</div>}
        </div>
      </div>
```

Then **delete** the old trailing block that rendered the side-by-side "Transaction History" and "Balance History" cards (the `{!isPhysical && (<div className="grid grid-cols-1 md:grid-cols-2 gap-4">…)}` section) — both are now inside their own cards above.

- [ ] **Step 4: Add the derived values the Balance card needs**

Near the top of the component, directly after the existing `const val = latestValue(account, balByAccount, txByAccount);` line, add:

```jsx
  // logs is already sorted newest-first, so logs[0] is the anchor.
  const laterTxnCount = logs.length ? txns.filter(t => t.date > logs[0].date).length : 0;
```

Confirm `logs` is defined above this line as the newest-first sorted balance array; if it is defined below, move this line after it.

- [ ] **Step 5: Remove the now-unused StaleBadge from the old header**

The `StaleBadge` moved into the Balance card. Confirm it is rendered exactly once — search the file for `StaleBadge` and delete any leftover occurrence in the identity block.

- [ ] **Step 6: Verify the build and imports**

Run: `cd client && npm run build`
Expected: `✓ built in …` with no errors. If the build reports an unused import, remove it.

- [ ] **Step 7: Verify no horizontal scroll**

Run `cd server && npm run dev` in one terminal and `cd client && npm run dev` in another, open `http://localhost:5173`, sign in, and open a bank account. In devtools, set the viewport to 320px, then 375px, then 768px. At each width run in the console:

```js
document.documentElement.scrollWidth > document.documentElement.clientWidth
```

Expected: `false` at all three widths.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/AccountDetail.jsx
git commit -m "Split the account page into single-job cards"
```

---

## Verification

After Task 5:

1. `cd server && npm test` — all pass.
2. `cd client && npm test` — all pass.
3. `cd client && npm run build` — clean.
4. `grep -rn "latestValue(" client/src` — every call passes three arguments.
5. Manual, against a live local server:
   - An account with no balance log shows **"Not set"**, not ₹0, and the dashboard reports it as excluded.
   - Log a balance; the account value becomes that balance and the dashboard total rises.
   - Add a transaction dated **after** the balance; the account value moves by that amount.
   - Add a transaction dated **before** the balance; the account value does **not** change.
   - Import a statement with a closing balance: the review table shows a tickable balance row above the transactions, and confirming sets the balance.
   - Untick the balance row and confirm: transactions import, balance is unchanged.
   - Watch the import status change from "Reading file…" to "Extracting with AI…" to "Saving…".
   - Confirm the AI notice is visible in the Import card.
6. Viewport check at 320px, 375px and 768px: no horizontal scroll on the account page.

## Known limitations

- A balance anchor cannot be edited or deleted from the review table; use Log Balance to re-anchor.
- If a statement's closing balance is misread, the user must notice it in the review row — the same trust model as the transactions themselves, which is why the AI notice sits in that card.
- Accounts with transactions but no anchor stay excluded from net worth. That is intended: a month's transactions cannot imply a total.

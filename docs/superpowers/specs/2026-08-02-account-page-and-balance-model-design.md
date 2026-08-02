# Account Page Restructure + Balance Model — Design

Date: 2026-08-02
Status: Approved, not yet implemented

## Why

Three problems, discovered from real use after importing a live bank statement.

1. **The account page is one card doing five unrelated jobs** — identity, nominees,
   file storage, statement import, and an action row whose every button operates on
   something in a *different* card. "Download History (CSV)" sits beside "Edit
   account" while the history it exports lives below.
2. **File storage and statement import look identical** — two file pickers separated
   by a hairline, doing opposite things. One stores a file and never reads it; the
   other reads a file and never stores it. Uploading a statement to the wrong one
   silently produces the opposite of what was wanted.
3. **An account with no logged balance reports ₹0, and that ₹0 is summed into net
   worth.** `Dashboard.jsx` does `res[a.currency].total += val` where `val` is `0`
   for any account without a balance log. That is not "unknown" — it is a false
   claim that the account is empty. A real account holding money contributed ₹0.

## The balance model

The current model is: an account's value is the most recently logged balance;
transactions are ignored entirely. That is why importing a statement full of
transactions left the account at ₹0.

Adopt the standard anchor model used by YNAB, Firefly III and most banking software:

- A **transaction** is an event — money moved on a date.
- A **balance** is a state — a point-in-time snapshot, an *anchor*.

```
current balance = most recent balance anchor
                + sum of transactions dated strictly AFTER that anchor's date
```

Transactions on or before the anchor date are already reflected in it — a July
closing balance already contains every July transaction — so they are not added
again. Only later movements adjust it. Logging a fresh balance re-anchors and
self-corrects any drift.

**When there is no anchor, the balance is unknown, not zero.** `latestValue` returns
`null`, the UI reads "Balance not set", the account is excluded from net-worth totals,
and the dashboard states how many accounts are excluded. Silently contributing zero to
a net-worth figure is the worst available option.

Physical assets (gold, silver, jewelry, automobile, real estate) are unchanged: they
use `currentValue` set via "Update Value", have no transactions, and no anchor.

## Statement import captures the closing balance

The extraction prompt currently says *"Ignore opening and closing balance lines,
running balance columns, page headers and footers, and summary totals."* That was
right for keeping balance rows out of the transaction list, and wrong overall — the
closing balance is exactly the anchor the model needs.

The prompt gains a separate field: the model returns `closingBalance` (value + date)
alongside `transactions`, still excluding balance rows from the transaction list. The
review table shows it as its own tickable row above the transactions, labelled as a
balance rather than a transaction. Confirming the import logs it via the existing
balance endpoint.

If the model reports no closing balance, that section simply does not appear.

## Page structure — one card, one job

Every card owns exactly one concern, and every action sits with the thing it acts on.

```
[← Back to accounts]

┌─ IDENTITY ────────────────────────────────┐
│ Bank Account · HDFC Bank · IN             │   (separator omitted when a field is blank)
│ HDFC Savings                              │
│ Last KYC · Interest · Nominees            │
│                          [Edit account]   │
└───────────────────────────────────────────┘

┌─ BALANCE ─────────────────────────────────┐
│ ₹1,23,456                                 │
│ anchored 31 Jul 2026, +2 later txns       │
│                          [Log Balance]    │
│ ── recent anchors ──                      │
└───────────────────────────────────────────┘

┌─ TRANSACTIONS (6) ────────────────────────┐
│              [Log Transaction] [⭳ CSV]    │
│ 30 Jul  POS ORACLE SINGAPORE     −₹103    │
└───────────────────────────────────────────┘

┌─ IMPORT STATEMENT ────────────────────────┐
│ Reads a PDF, CSV or Excel statement and   │
│ creates transactions from it.             │
│                          [Choose file]    │
│ Read by AI (zero data retention). Always  │
│ check the rows before importing.          │
└───────────────────────────────────────────┘

┌─ DOCUMENTS ───────────────────────────────┐
│ Stored for reference — never read.        │
│ Valuations, KYC papers, locker photos.    │
│                             [Upload]      │
└───────────────────────────────────────────┘
```

The two file pickers are now separate cards, each with a one-line subtitle stating
what it does. "creates transactions from it" versus "never read" is the entire
distinction, said plainly.

For physical assets the Balance card becomes a Valuation card with "Update Value",
and the Transactions and Import cards do not render.

## Status feedback

Every operation that can take more than a moment reports what it is doing. The app
already uses the `"Verb…"` convention (`"Uploading…"`, `"Reading…"`, `"Importing…"`,
`"Unlocking…"`); this extends it consistently rather than inventing a new pattern.

| Operation | States |
| --- | --- |
| Document upload | `Uploading 2 of 3…` → error or the new tile |
| Document open | `Opening…` on the tile being fetched |
| Statement parse | `Reading file…` → `Extracting with AI…` → review table |
| Encrypted PDF | `Unlocking…` |
| Confirm import | `Saving…` → `Imported 6 transactions · balance set to ₹1,23,456` |
| Any failure | the existing red inline message, unchanged |

The parse step is split into two states deliberately: local text extraction is fast,
the AI call is the slow part, and a single spinner for both leaves the user unsure
whether anything is happening during a 10–30 second model call.

## AI disclosure

Shown in small dim text inside the Import card, under the control:

> Read by AI (zero data retention). Always check the rows before importing.

Placed where the decision is made rather than buried in settings or a README. It is
short because it has to be read, and it states both the privacy posture and the user's
responsibility to verify.

## Error handling

Unchanged in mechanism — the existing inline red message per card. The specific new
cases:

- No closing balance found → no balance row in the review table, no error.
- Balance logged but transactions failed → report both outcomes separately rather than
  a single misleading "import failed".
- Account with no anchor → "Balance not set" plus a "Log Balance" prompt, never ₹0.

## Testing

- `latestValue` unit tests: no anchor returns `null`; anchor with no later transactions
  returns the anchor; anchor plus later credits and debits; transactions dated on or
  before the anchor are excluded; multiple anchors use the most recent.
- Dashboard totals: an account with no anchor is excluded and counted as excluded, not
  summed as zero.
- Extraction: `closingBalance` is parsed when present and absent-safe when not; balance
  rows still never appear in the transaction list.
- Import flow: confirming with the balance row ticked logs a balance; unticked does not.
- Existing statement-import, attachment, and password tests must continue to pass.

## Out of scope

- Deriving a balance purely by summing transactions with no anchor. Rejected: a single
  month's statement would report the month's net change as the account total.
- Editing or deleting a balance anchor from the review table.
- Multi-currency conversion changes.
- Any change to the Accounts list, Reports or Settings pages — each already does one
  job per card.

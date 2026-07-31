# Statement Import (PDF + CSV) — Design

Date: 2026-07-31
Status: Approved, not yet implemented

## Goal

Let a user upload a bank statement (PDF or CSV) to an account and turn its rows into
transactions in the ledger, without hand-typing them.

Statements come from both Indian and US/international banks, so layouts, date orders,
currency symbols and number groupings all vary. Extraction is therefore done by a language
model rather than per-bank rules.

## Scope

In scope:

- Text-based PDF statements (text can be selected; no OCR).
- CSV statements.
- Extraction into the existing `transactions` shape: date, description, type, amount.
- A mandatory review step before anything is written.
- Detection of rows that duplicate existing transactions.

Out of scope for this iteration:

- Scanned/image PDFs and OCR.
- XLSX (deliberately deferred; the normaliser and review flow are shared, so it is a small
  follow-up if wanted).
- Password-protected PDFs beyond detecting them and reporting clearly.
- Importing balances, or creating accounts from a statement.
- Categorising or tagging transactions.

## Flow

```
upload file
  -> extract text        (PDF via pdf-parse, CSV read directly)
  -> AI extracts rows    (OpenRouter, strict JSON schema, ZDR enforced)
  -> normalise+validate  (pure function: dates, amounts, credit/debit)
  -> flag duplicates     (against existing transactions on the account)
  -> USER REVIEWS TABLE  (edit, uncheck, cancel)
  -> confirm
  -> bulk insert         (single SQLite transaction)
```

Nothing reaches the database before the user confirms. Because extraction is probabilistic,
the review step is the correctness guarantee, not a convenience.

## Components

Each unit is separately testable and has one job.

### `server/src/services/statementText.js`

`extractText(buffer, filename) -> { text, kind }`

Turns an uploaded file into plain text. `kind` is `"pdf"` or `"csv"`. PDFs go through
`pdf-parse`; CSVs are decoded as UTF-8. Throws a descriptive error when a PDF is
password-protected or yields no selectable text (i.e. it is scanned), so the caller can tell
the user precisely why the file cannot be used.

Depends on: `pdf-parse`.

### `server/src/services/statementExtract.js`

`extractTransactions(text, { currency }) -> rawRows[]`

Sends the statement text to OpenRouter and returns whatever rows the model reports, still
unvalidated. Responsible only for the network call and JSON parsing.

Request specifics:

- Endpoint: `https://openrouter.ai/api/v1/chat/completions`
- Model: `process.env.OPENROUTER_MODEL`, defaulting to `inclusionai/ling-3.0-flash:free`
- Always sends `provider: { zdr: true, data_collection: "deny" }`
- Requests a strict JSON object: `{ transactions: [{ date, description, type, amount }] }`
- Bounded by an `AbortController` timeout so a slow provider cannot stall the request

If OpenRouter has no zero-retention endpoint for the chosen model the request fails. That is
the intended behaviour: the import fails loudly rather than sending statement contents to a
provider that may retain them.

Depends on: global `fetch` (Node 20), `OPENROUTER_API_KEY`.

### `server/src/services/normaliseTransactions.js`

`normalise(rawRows, { statementCurrency }) -> { rows, rejected }`

A pure function with no I/O — the piece most worth testing, and where correctness actually
lives. It converts model output into records safe to insert, and reports what it could not
use rather than silently discarding.

Rules:

- **Dates** -> `YYYY-MM-DD`. Accepts `DD/MM/YYYY`, `MM/DD/YYYY`, `DD-Mon-YYYY`, `YYYY-MM-DD`.
  Where a date is ambiguous (`03/04/2026`), the order is resolved by looking at the whole
  batch: if any date in the statement has a first component above 12, that fixes the order
  for every row. If the batch is genuinely ambiguous, the rows are still imported but the
  review table flags the assumed order so the user can correct it.
- **Amounts** -> positive number. Strips currency symbols (`₹`, `$`, `Rs.`, `INR`, `USD`),
  spaces and thousands separators, including Indian grouping (`1,00,000` -> `100000`).
  Rejects anything that does not parse to a finite number.
- **Type** -> `"credit"` or `"debit"`, matching the existing column constraint. Derived from
  an explicit type/`Dr`/`Cr` marker, a withdrawal/deposit column, or a negative sign.
- **Description** -> trimmed, collapsed whitespace, capped at 500 characters.
- Rows missing a date, an amount or a type are rejected with a reason.

### Routes

Two endpoints, both requiring auth and account ownership. The parse endpoint lives in a new
`server/src/routes/statements.js`; the bulk insert belongs with the existing transaction
routes in `server/src/routes/transactions.js`.

`POST /api/statements/parse/:accountId` (multipart, one file)
Runs extract -> AI -> normalise -> duplicate flagging, and returns a preview. Writes nothing.

```json
{
  "rows": [
    { "date": "2026-07-01", "description": "...", "type": "debit",
      "amount": 1200.5, "duplicate": false }
  ],
  "rejected": [{ "reason": "unparseable amount", "raw": "..." }],
  "dateOrderAssumed": "DD/MM"
}
```

`POST /api/transactions/bulk`
Accepts the confirmed rows and inserts them inside one SQLite transaction, so a partial
failure leaves the ledger untouched. Re-validates every row server-side; the preview response
is not trusted on the way back in.

Both sit under `/api` and so are already covered by `apiLimiter`. Parsing additionally gets
its own tighter limiter, since each call spends one of a limited number of daily upstream
requests.

### Duplicate detection

A row is flagged as a duplicate when the account already has a transaction with the same
date, the same amount to two decimal places, and the same normalised description. Duplicates
are returned flagged and arrive **pre-unchecked** in the review table, so re-importing an
overlapping statement does not double-count. The user can still tick them deliberately.

### Client

A new "Import statement" control on the account detail page, beside the existing file upload.
On selecting a file it calls the parse endpoint, then shows a review table: a checkbox, and
editable date, description, type and amount per row. Duplicates are visually marked and
unticked. Rejected rows appear beneath, with their reasons. Confirming posts the ticked rows
to the bulk endpoint and refreshes the account.

The existing attachment upload is unchanged — importing a statement does not also store it.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Enables import. Absent = feature reports itself unavailable. | none |
| `OPENROUTER_MODEL` | Model slug. | `inclusionai/ling-3.0-flash:free` |

Both are set in the Render dashboard, never committed.

## Error handling

Every failure is reported with its cause and a next step:

- No `OPENROUTER_API_KEY`: import is unavailable; the UI hides the control.
- No zero-retention endpoint: request refused, explaining that the model has no ZDR provider
  and suggesting `OPENROUTER_MODEL` be changed.
- Password-protected or scanned PDF: reported as such, rather than as a generic parse error.
- Model returns malformed or non-JSON output: caught, surfaced as "could not read this
  statement", with rejected rows listed.
- Upstream rate limit (HTTP 429): reported plainly, since the free tier allows roughly 50
  requests/day.
- No transactions found: reported as an empty result rather than an error.

As with the mailer, no failure path may crash the process: the routes are wrapped in
`asyncHandler` and the service functions return results rather than throwing past the route.

## Testing

- **Normaliser unit tests** (no network): Indian and US date orders, ambiguous dates,
  `1,00,000` grouping, `₹`/`$`/`Rs.` prefixes, `Dr`/`Cr` markers, negative amounts,
  withdrawal/deposit columns, and rows that must be rejected.
- **Extraction test** against a recorded OpenRouter response fixture, asserting the ZDR
  provider block is present in the outgoing request body.
- **Duplicate detection test** against a seeded account.
- **Route test** asserting that `parse` writes nothing to the database.

No test calls the live API.

## Risks

1. **ZDR may be unavailable on the free model.** OpenRouter does not document a retention
   policy on the Ling-3.0-flash page, and its docs state it does not filter by retention
   automatically. With `zdr: true` the request fails closed. If the free endpoint is not
   zero-retention, the user must either accept a paid ZDR model via `OPENROUTER_MODEL` or
   forgo the feature. This must be verified against the OpenRouter account's privacy settings
   before relying on it.
2. **Extraction accuracy.** A model can misread a column or merge a multi-line description.
   The review table is the mitigation, and is why the design refuses to auto-commit.
3. **Free-tier rate limits** (~50 requests/day without credit) make bulk backfilling slow.
4. **Data is ephemeral on Render's free plan.** Imported transactions are wiped on every
   redeploy, as is the whole database. Importing a year of history is wasted effort until a
   persistent disk is attached.

## Future work

- XLSX import.
- OCR for scanned statements.
- Storing the source file as an attachment alongside the imported rows.
- Auto-categorisation.

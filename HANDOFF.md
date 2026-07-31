# Overnight work report — 1 Aug 2026

Everything below is on GitHub. **Nothing is deployed.** Read "What I need from you" first.

---

## ⚠️ What I need from you (5 minutes, blocks everything)

**Set `MONGODB_URI` in the Render dashboard before merging.**

`render.yaml` marks it `sync: false`, which means a Blueprint deploy will *not*
populate it. `db.js` throws without it and `index.js` calls `process.exit(1)`, so
**merging to `main` right now would crash-loop your live service.** That is the only
reason I did not deploy while you slept — your current app is still up and serving.

1. Render dashboard → your service → Environment
2. Add `MONGODB_URI` = the `mongodb+srv://…` string from Atlas
   (not the long non-SRV one in my local `.env` — that is a workaround for this
   machine's DNS, which refuses SRV lookups)
3. Add `OPENROUTER_API_KEY` = a **freshly rotated** key
4. Manual Deploy → confirm it boots
5. Then merge `feat/mongodb-migration`, then `feat/statement-import`

**Rotate two credentials — both are in our chat in plaintext:**
- Atlas password for `pratikpawarnetworth_db_user`
- The OpenRouter key you pasted

---

## What shipped

Two branches, 24 commits ahead of `main`, **113 tests passing**, client builds clean.

| Branch | What it does |
| --- | --- |
| `feat/mongodb-migration` | Moves every record off Render's ephemeral disk into MongoDB Atlas |
| `feat/statement-import` | PDF / CSV / XLSX statements → transactions |

### Statement import
Upload a statement, review an editable table, tick the rows you want, save. Nothing
is written until you confirm. Rows that match existing transactions arrive
**unticked** so re-importing an overlapping statement cannot double-count.

Extraction runs on OpenRouter with `provider: { zdr: true, data_collection: "deny" }`
on every request — verified enforced, and it **fails closed** rather than sending
your statement to a provider that might retain it.

---

## Test results

### Import accuracy — 10/10 rows exactly correct

**Indian CSV** (DD/MM, `1,00,000` grouping, separate Withdrawal/Deposit columns, running-balance column):

| Statement row | Stored |
| --- | --- |
| 13/02/2026 SALARY CREDIT FEB, deposit ₹1,00,000.00 | `2026-02-13` credit **100000** |
| 14/02/2026 ATM WDL MUMBAI, withdrawal ₹2,500.00 | `2026-02-14` debit **2500** |
| 15/02/2026 UPI-SWIGGY-ORDER, withdrawal ₹450.50 | `2026-02-15` debit **450.5** |
| 16/02/2026 NEFT IN REFUND, deposit ₹1,200.00 | `2026-02-16` credit **1200** |
| 17/02/2026 RENT PAYMENT FEB, withdrawal ₹25,000.00 | `2026-02-17` debit **25000** |

**US XLSX** (MM/DD, negative amounts, title row, blank rows, closing-balance row):

| Statement row | Stored |
| --- | --- |
| 03/02/2026 DIRECT DEPOSIT PAYROLL 3500.00 | `2026-03-02` credit **3500** |
| 03/05/2026 AMAZON.COM PURCHASE −129.99 | `2026-03-05` debit **129.99** |
| 03/11/2026 WHOLE FOODS MKT −87.43 | `2026-03-11` debit **87.43** |
| 03/15/2026 INTEREST PAYMENT 12.55 | `2026-03-15` credit **12.55** |
| 03/20/2026 ELECTRIC BILL AUTOPAY −210.00 | `2026-03-20` debit **210** |

It read the Indian file as **DD/MM** and the US file as **MM/DD**, and ignored
balance columns, title rows and closing totals in both. Verified directly in MongoDB:
every amount a real `number`, **zero NaN**, ids proper UUID strings.

Re-uploading the same file flagged **5/5 rows as duplicates with 0 selected**.

### Security — 33 checks, 0 real failures
- **Auth:** all 7 API routes 401 without a token; garbage tokens, wrong-secret JWTs and an `alg=none` confusion attack all rejected
- **IDOR (10/10):** a second logged-in user could not read, modify, delete, or inject into another user's account, transactions, balances, attachments, or bulk import — every attempt 404, and their export contained none of the victim's data
- **NoSQL injection:** `{"$ne":null}` and `{"$gt":""}` login bypasses rejected
- **Account enumeration:** unknown email and wrong password return byte-identical responses
- **Attachments:** owner reads OK; attacker 404; unauthenticated 401; `nosniff` and `Vary: Authorization` present; the old public `/uploads` mount serves only the SPA shell, no file bytes
- **Uploads:** `.exe` rejected, 9 MB file rejected by the 8 MB cap
- **Stored XSS:** `<img src=x onerror=alert(1)><script>alert(2)</script>` in a description rendered as inert text — 0 elements injected
- **Rate limiting:** blocks after 15 failed sign-ins per IP, with correct `Retry-After`; the import limiter is separate

### Responsiveness
No horizontal scroll at **320px, 375px, or 768px**, on login, dashboard, account detail, and the import review table. Zero console errors.

---

## Two real bugs found and fixed during testing

**1. Statement import was completely broken against the live API.** The default model
rejects `response_format` — *"ling-3.0-flash does not support feature:
structured-outputs"* — so every import returned 400. My plan specified that parameter
without checking this model supports it. Removed; the prompt already asks for JSON and
the parser tolerates fenced replies.

**2. The app scrolled sideways on a phone.** 483px of content in a 367px viewport. The
nav bar, the account action row, and six fixed `grid-cols-N` never wrapped. All fixed.

Also improved: a failing import used to report a bare `"OpenRouter returned 400."`,
throwing away the diagnostic sitting in the response body. It now surfaces the
provider's actual message — that one cost me a debugging round, and would have cost you more.

---

## Your `statement.pdf` cannot be imported — and that is correct behaviour

It is a **scanned image**. It contains literally zero extractable text (16 raw
characters, all page-marker). The app detected this and said so plainly:

> *"This PDF has no selectable text, so it is probably a scan or a photo. Please
> upload a statement downloaded directly from your bank."*

That is the designed behaviour — the alternative is feeding an empty string to a
language model and letting it invent transactions for your ledger. For it to work you
need a PDF downloaded from net banking (where you can select the text with a cursor),
or OCR support, which is not built.

---

## Known limitations
- Scanned PDFs are rejected, not OCR'd
- Free OpenRouter tier ≈ 50 requests/day, so bulk backfilling is slow
- Extraction is probabilistic — the review table is the correctness guarantee
- Duplicate matching is date + amount + description, so two genuinely identical same-day transactions get flagged (you can still tick them)
- `nodemailer` carries 8 advisories, but `utils/mailer.js` is required by nothing, so it is unreachable dead code. Worth removing or upgrading eventually.
- The full visual UI overhaul is still outstanding — I fixed the layout breakage, not the aesthetics

## Test data
All test users, accounts, transactions and attachments were deleted from
`networth_local`. The production `networth` database was never written to and is empty.

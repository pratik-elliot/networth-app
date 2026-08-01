# Password-Protected PDF Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import an encrypted PDF bank statement by supplying its password, without ever logging, storing, or transmitting that password anywhere it does not belong.

**Architecture:** `pdf-parse` v2 already accepts a `password` in its constructor and raises a distinguishable `PasswordException` for "no password given" versus "incorrect password". The service layer surfaces those as machine-readable error codes, the route passes the password through from the multipart body, and the client only reveals a password field once the server says one is needed — keeping the chosen file in browser memory so the user never re-picks it.

**Tech Stack:** Node 20, Express 4, MongoDB, `pdf-parse` v2, multer (memory storage), React 18, Node's built-in `node:test`.

## Global Constraints

- **The password is a secret and must be treated as one.** Most Indian bank statements derive it from PAN, date of birth, or account number. It MUST NOT appear in any log line, any error message, any thrown stack, any database record, or any outbound request to OpenRouter. Only the *extracted text* is ever sent upstream.
- The password travels in the multipart **body**, never a URL query parameter or header — query strings land in proxy and access logs.
- Do not persist the password. It lives in one function scope and is discarded with the request.
- Every DB-touching handler stays `async` and wrapped in `asyncHandler` (`server/src/utils/asyncHandler.js`). An unhandled rejection kills the process on Node 20 and has already caused a real outage in this app.
- Ownership is checked with `accounts.findOne({ _id: accountId, userId })` and **must be awaited** — a bare Promise is truthy and silently defeats the check.
- Tests use Node's built-in `node:test` (`cd server && npm test`). Do NOT add Jest, Vitest, or any framework.
- Do not add dependencies. Everything needed is already installed.
- The client's shared `handle()` only reads the response body when `res.ok` is false, so error codes must ride on a non-2xx response.

## Verified behaviour

Checked directly against the installed `pdf-parse` 2.4.5 with a real encrypted PDF. Do not re-derive:

| Call | Result |
| --- | --- |
| `new PDFParse({ data })` on an encrypted PDF | throws `PasswordException`, message `"No password given"` |
| `new PDFParse({ data, password: "wrong" })` | throws `PasswordException`, message `"Incorrect Password"` |
| `new PDFParse({ data, password: "123456" })` (correct) | resolves, text extracted normally |

`PasswordException` is a named export: `const { PDFParse, PasswordException } = require("pdf-parse")`.

Also verified: multer's `.single("statement")` with `memoryStorage` populates `req.body.password` from a text part in the same multipart request.

## Out of scope

- **Encrypted XLSX.** `exceljs` cannot open password-protected workbooks. The existing catch already reports "may be corrupted or password-protected", which stays as-is.
- **Scanned + encrypted PDFs.** Unlocking a scan just reveals images with no text layer, so it still fails the existing scanned-PDF check. That is correct and needs no new handling.
- Remembering or storing passwords between uploads.

## File structure

| File | Responsibility |
| --- | --- |
| `server/src/services/statementText.js` | Accept an optional password; raise coded errors. |
| `server/src/routes/statements.js` | Read the password from the body, map coded errors onto the HTTP response. |
| `client/src/api.js` | Carry the server's error `code` onto the thrown Error; send the password. |
| `client/src/components/StatementImport.jsx` | Reveal a password field only when the server asks for one. |

---

### Task 1: Password support and coded errors in the extraction service

**Files:**
- Modify: `server/src/services/statementText.js`
- Test: `server/test/statementText.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `extractText(buffer, filename, opts) -> Promise<{ text, kind }>` where `opts` is `{ password?: string, pdfParseImpl?: class }`. The existing two-argument call sites keep working unchanged.
  - Errors thrown from `extractText` may carry a `.code` string. Codes used by later tasks: `"PASSWORD_REQUIRED"`, `"PASSWORD_INCORRECT"`.

`pdfParseImpl` is a test seam only, matching the existing `opts.fetchImpl` pattern in `statementExtract.js`. Production passes nothing and the real `PDFParse` is used.

- [ ] **Step 1: Write the failing test**

Append to `server/test/statementText.test.js`:

```js
/* A fake standing in for pdf-parse's PDFParse class. Records what it was
   constructed with, so the tests can assert the password is forwarded. */
function fakeParser({ behaviour, seen }) {
  return class {
    constructor(opts) { seen.push(opts); this.opts = opts; }
    async getText() {
      if (behaviour === "needsPassword" && !this.opts.password) {
        const e = new Error("No password given");
        e.name = "PasswordException";
        throw e;
      }
      if (behaviour === "needsPassword" && this.opts.password !== "correct-pw") {
        const e = new Error("Incorrect Password");
        e.name = "PasswordException";
        throw e;
      }
      return { text: "Date Description Amount\n13/02/2026 SALARY 50000\n" };
    }
    async destroy() {}
  };
}

test("extractText reports an encrypted PDF with no password as PASSWORD_REQUIRED", async () => {
  const seen = [];
  await assert.rejects(
    () => extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", { pdfParseImpl: fakeParser({ behaviour: "needsPassword", seen }) }),
    (err) => {
      assert.strictEqual(err.code, "PASSWORD_REQUIRED");
      assert.match(err.message, /password/i);
      return true;
    }
  );
});

test("extractText reports a wrong password as PASSWORD_INCORRECT", async () => {
  const seen = [];
  await assert.rejects(
    () => extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", {
      password: "wrong-pw",
      pdfParseImpl: fakeParser({ behaviour: "needsPassword", seen }),
    }),
    (err) => {
      assert.strictEqual(err.code, "PASSWORD_INCORRECT");
      return true;
    }
  );
});

test("extractText forwards the password to the parser", async () => {
  const seen = [];
  const out = await extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", {
    password: "correct-pw",
    pdfParseImpl: fakeParser({ behaviour: "needsPassword", seen }),
  });
  assert.strictEqual(seen[0].password, "correct-pw");
  assert.match(out.text, /SALARY/);
});

test("extractText omits the password key entirely when none is given", async () => {
  // Passing password: undefined makes pdf-parse treat it as a supplied empty
  // credential in some versions; the key should simply be absent.
  const seen = [];
  await extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", {
    pdfParseImpl: fakeParser({ behaviour: "ok", seen }),
  });
  assert.strictEqual("password" in seen[0], false);
});

test("extractText NEVER puts the password in an error message", async () => {
  const secret = "PAN-ABCDE1234F-DOB-01011990";
  const seen = [];
  await assert.rejects(
    () => extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", {
      password: secret,
      pdfParseImpl: fakeParser({ behaviour: "needsPassword", seen }),
    }),
    (err) => {
      assert.ok(!String(err.message).includes(secret), "password leaked into the error message");
      assert.ok(!String(err.stack).includes(secret), "password leaked into the stack");
      return true;
    }
  );
});

test("extractText still reports a corrupt PDF without a code", async () => {
  const Broken = class {
    constructor() {}
    async getText() { throw new Error("bad xref table"); }
    async destroy() {}
  };
  await assert.rejects(
    () => extractText(Buffer.from("%PDF-1.4 fake"), "s.pdf", { pdfParseImpl: Broken }),
    (err) => {
      assert.strictEqual(err.code, undefined);
      assert.match(err.message, /could not be read/i);
      return true;
    }
  );
});

test("extractText ignores a password for CSV and XLSX", async () => {
  const out = await extractText(Buffer.from("Date,Amount\n2026-02-13,5\n"), "s.csv", { password: "irrelevant" });
  assert.strictEqual(out.kind, "csv");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — the new tests error because `extractText` ignores the third argument and no `.code` is set.

- [ ] **Step 3: Implement**

In `server/src/services/statementText.js`, add this helper directly below the `PAGE_MARKER` constant:

```js
/* Errors carrying a code let the route answer with something the UI can act
   on, instead of a wall of prose it has to pattern-match. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
```

Replace the whole `extractPdf` function with:

```js
async function extractPdf(buffer, opts) {
  // pdf-parse v2 exports a class; v1's callable default export is gone.
  // pdfParseImpl is a test seam — production always uses the real class.
  const Parser = opts.pdfParseImpl || require("pdf-parse").PDFParse;

  // Only set the key when a password was actually supplied; passing
  // `password: undefined` is not the same as omitting it.
  const loadParams = { data: buffer };
  if (opts.password) loadParams.password = opts.password;

  let parser;
  let text;
  try {
    parser = new Parser(loadParams);
    ({ text } = await parser.getText());
  } catch (err) {
    // NOTE: never interpolate opts.password into any message below. The
    // password is often derived from the user's PAN or date of birth.
    const message = String((err && err.message) || "");
    const isPasswordError = (err && err.name === "PasswordException") || /password/i.test(message);

    if (isPasswordError) {
      // pdf-parse distinguishes "none supplied" from "wrong one supplied",
      // which is what lets the UI prompt once and then say "that was wrong".
      if (opts.password || /incorrect/i.test(message)) {
        throw codedError("PASSWORD_INCORRECT", "That password did not open this PDF. Please check it and try again.");
      }
      throw codedError("PASSWORD_REQUIRED", "This PDF is password-protected. Enter its password to import it.");
    }
    if (/encrypt/i.test(message)) {
      throw codedError("PASSWORD_REQUIRED", "This PDF is encrypted. Enter its password to import it.");
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
```

Change the `extractText` signature and its PDF branch:

```js
async function extractText(buffer, filename, opts = {}) {
```

and

```js
  if (ext === ".pdf") return { text: await extractPdf(buffer, opts), kind: "pdf" };
```

Leave the `.csv`, `.txt`, `.xls` and `.xlsx` branches exactly as they are — a password is meaningless for those.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test`
Expected: PASS — all existing tests plus the seven new ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/statementText.js server/test/statementText.test.js
git commit -m "Accept a password for encrypted PDFs and raise coded errors"
```

---

### Task 2: Pass the password through the parse route

**Files:**
- Modify: `server/src/routes/statements.js`
- Test: `server/test/statements.test.js`

**Interfaces:**
- Consumes: `extractText(buffer, filename, { password })` and the `PASSWORD_REQUIRED` / `PASSWORD_INCORRECT` codes from Task 1.
- Produces: `POST /api/statements/parse/:accountId` additionally accepts a `password` text field in the multipart body. On a password failure it responds `400 { error, code }` where `code` is one of those two values.

- [ ] **Step 1: Write the failing test**

Append to `server/test/statements.test.js`. Note the existing `uploadForm` helper only builds a file part, so this adds a second helper:

```js
/* Builds a multipart body with a password text part BEFORE the file part.
   Order matters: multer streams parts in order, so a field placed after the
   file is not reliably present when the handler runs. */
function uploadFormWithPassword(content, filename, password) {
  const boundary = "----testboundarypw";
  const parts = [];
  if (password !== undefined) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="statement"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`, "utf8"));
  parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("parse returns PASSWORD_REQUIRED for an encrypted PDF with no password", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  await withServer(t, { accounts }, async (base) => {
    const textModule = require("../src/services/statementText");
    const original = textModule.extractText;
    textModule.extractText = async () => {
      const e = new Error("This PDF is password-protected. Enter its password to import it.");
      e.code = "PASSWORD_REQUIRED";
      throw e;
    };
    t.after(() => { textModule.extractText = original; });

    const { body, contentType } = uploadForm("x", "s.pdf");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 400);
    const json = await res.json();
    assert.strictEqual(json.code, "PASSWORD_REQUIRED");
    assert.match(json.error, /password/i);
  });
});

test("parse returns PASSWORD_INCORRECT when the supplied password is wrong", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  await withServer(t, { accounts }, async (base) => {
    const textModule = require("../src/services/statementText");
    const original = textModule.extractText;
    textModule.extractText = async () => {
      const e = new Error("That password did not open this PDF. Please check it and try again.");
      e.code = "PASSWORD_INCORRECT";
      throw e;
    };
    t.after(() => { textModule.extractText = original; });

    const { body, contentType } = uploadFormWithPassword("x", "s.pdf", "nope");
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, "PASSWORD_INCORRECT");
  });
});

test("parse forwards the password from the multipart body to extractText", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  await withServer(t, { accounts, extract: async () => [] }, async (base) => {
    const textModule = require("../src/services/statementText");
    const original = textModule.extractText;
    let seenOpts = null;
    textModule.extractText = async (buf, name, opts) => {
      seenOpts = opts;
      return { text: "Date Amount\n2026-02-13 5\n", kind: "pdf" };
    };
    t.after(() => { textModule.extractText = original; });

    const { body, contentType } = uploadFormWithPassword("x", "s.pdf", "my-secret-pw");
    await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.ok(seenOpts, "extractText was not called");
    assert.strictEqual(seenOpts.password, "my-secret-pw");
  });
});

test("parse NEVER forwards the password to the extraction service", async (t) => {
  // Structurally the password cannot reach OpenRouter today — extractTransactions
  // is called with the extracted text only. This pins that so a later refactor
  // cannot quietly start passing the whole request through.
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const secret = "PAN-QQQQQ1111Q-DOB-15081947";
  const seenByExtractor = [];
  const extract = async (...args) => { seenByExtractor.push(JSON.stringify(args)); return []; };

  await withServer(t, { accounts, extract }, async (base) => {
    const textModule = require("../src/services/statementText");
    const original = textModule.extractText;
    textModule.extractText = async () => ({ text: "Date Amount\n2026-02-13 5\n", kind: "pdf" });
    t.after(() => { textModule.extractText = original; });

    const { body, contentType } = uploadFormWithPassword("x", "s.pdf", secret);
    await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    assert.ok(seenByExtractor.length > 0, "extractTransactions was never called");
    assert.ok(!seenByExtractor.join("").includes(secret), "password reached the extraction service");
  });
});

test("parse NEVER echoes the password back or logs it", async (t) => {
  const accounts = [{ _id: ACCOUNT_ID, userId: USER_ID }];
  const secret = "PAN-ZZZZZ9999Z-DOB-31121999";
  await withServer(t, { accounts }, async (base) => {
    const textModule = require("../src/services/statementText");
    const original = textModule.extractText;
    textModule.extractText = async () => {
      const e = new Error("That password did not open this PDF. Please check it and try again.");
      e.code = "PASSWORD_INCORRECT";
      throw e;
    };

    // Capture anything the route writes to the console during the request.
    const logged = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => logged.push(a.join(" "));
    console.error = (...a) => logged.push(a.join(" "));
    t.after(() => { textModule.extractText = original; console.log = origLog; console.error = origErr; });

    const { body, contentType } = uploadFormWithPassword("x", "s.pdf", secret);
    const res = await fetch(`${base}/api/statements/parse/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(USER_ID)}`, "Content-Type": contentType },
      body,
    });
    const raw = await res.text();
    assert.ok(!raw.includes(secret), "password came back in the response body");
    assert.ok(!logged.join("\n").includes(secret), "password was written to the console");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — the route ignores `req.body.password` and returns no `code` field.

- [ ] **Step 3: Implement**

In `server/src/routes/statements.js`, change the require so the module object is used (the tests replace `extractText` on it, which a destructured import would not see):

```js
const statementText = require("../services/statementText");
```

Delete the old `const { extractText } = require("../services/statementText");` line.

Then replace the extraction block inside `handleParse` with:

```js
  let text;
  try {
    // req.body.password comes from a text part in the same multipart request.
    // It is used once, here, and never logged, stored, or forwarded upstream.
    const password = typeof req.body?.password === "string" && req.body.password !== ""
      ? req.body.password
      : undefined;
    ({ text } = await statementText.extractText(req.file.buffer, req.file.originalname, { password }));
  } catch (e) {
    // e.code is PASSWORD_REQUIRED or PASSWORD_INCORRECT for the encrypted-PDF
    // cases, so the UI can prompt instead of showing a dead end.
    const body = { error: e.message };
    if (e.code) body.code = e.code;
    return res.status(400).json(body);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npm test && node --check src/routes/statements.js`
Expected: PASS, and no output from `node --check`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/statements.js server/test/statements.test.js
git commit -m "Accept a statement password in the parse request"
```

---

### Task 3: Prompt for the password in the UI

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/components/StatementImport.jsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `400 { error, code }` response from Task 2.
- Produces: `api.parseStatement(accountId, file, password)` — `password` optional. Errors thrown by `handle()` now carry `.code` and `.status`.

- [ ] **Step 1: Carry the server's error code onto the thrown Error**

In `client/src/api.js`, replace the whole `handle` function with:

```js
async function handle(res) {
  if (!res.ok) {
    let msg = "Request failed.";
    let code;
    try {
      const d = await res.json();
      msg = d.error || msg;
      code = d.code;
    } catch (e) {}
    const err = new Error(msg);
    // Callers branch on this — e.g. the statement importer prompts for a
    // password when the server reports PASSWORD_REQUIRED.
    if (code) err.code = code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}
```

- [ ] **Step 2: Send the password**

In `client/src/api.js`, replace the `parseStatement` method with:

```js
  parseStatement: (accountId, file, password) => {
    const fd = new FormData();
    // The password part is appended BEFORE the file so multer has it parsed
    // by the time the handler runs.
    if (password) fd.append("password", password);
    fd.append("statement", file);
    return fetch(`${BASE}/api/statements/parse/${accountId}`, { method: "POST", headers: authHeaders(), body: fd }).then(handle);
  },
```

- [ ] **Step 3: Prompt for the password in the component**

In `client/src/components/StatementImport.jsx`:

Add two pieces of state, directly after the `const [result, setResult] = useState(null);` line:

```jsx
  // Held so the user does not have to re-pick the file after being asked
  // for a password. Cleared as soon as the import succeeds or is cancelled.
  const [lockedFile, setLockedFile] = useState(null);
  const [password, setPassword] = useState("");
```

Replace the whole `choose` function with:

```jsx
  const runParse = async (file, pw) => {
    setBusy(true); setError(""); setNotice(""); setResult(null);
    try {
      const res = await api.parseStatement(accountId, file, pw);
      setLockedFile(null);
      setPassword("");
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
      if (err.code === "PASSWORD_REQUIRED" || err.code === "PASSWORD_INCORRECT") {
        setLockedFile(file);
        setPassword("");
      }
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const choose = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await runParse(file, undefined);
  };
```

Then insert this block immediately after the `{notice && !error && ...}` line and before `{result && result.rows.length > 0 && (`:

```jsx
      {lockedFile && (
        <form
          className="flex gap-2 items-center flex-wrap"
          style={{ marginBottom: 8 }}
          onSubmit={(e) => { e.preventDefault(); if (password) runParse(lockedFile, password); }}
        >
          <input
            type="password"
            value={password}
            autoComplete="off"
            placeholder={`Password for ${lockedFile.name}`}
            onChange={(e) => setPassword(e.target.value)}
            style={{ ...FIELD, width: "auto", flex: "1 1 200px" }}
            aria-label="Statement password"
          />
          <Btn type="submit" disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</Btn>
          <Btn variant="ghost" onClick={() => { setLockedFile(null); setPassword(""); setError(""); }}>Cancel</Btn>
        </form>
      )}
```

Finally, in the existing Cancel button of the results block, also clear the password state. Replace:

```jsx
            <Btn variant="ghost" onClick={() => { setResult(null); setError(""); }}>Cancel</Btn>
```

with:

```jsx
            <Btn variant="ghost" onClick={() => { setResult(null); setError(""); setLockedFile(null); setPassword(""); }}>Cancel</Btn>
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd client && npm run build`
Expected: `✓ built in …` with no errors.

- [ ] **Step 5: Document it**

In `README.md`, find the "Statement import" bullet and replace the sentence
`Text-layer PDFs only; a scanned statement is detected and reported rather than guessed at.`
with:

```markdown
  Text-layer PDFs only; a scanned statement is detected and reported rather than guessed at.
  Password-protected PDFs are supported — you are prompted for the password only when one is
  needed, and it is used once to open the file and then discarded. It is never logged, never
  stored, and never sent to the extraction service. Encrypted Excel files are not supported.
```

- [ ] **Step 6: Verify the whole suite**

Run: `cd server && npm test`
Expected: PASS

Run: `cd client && npm run build`
Expected: builds clean

- [ ] **Step 7: Commit**

```bash
git add client/src/api.js client/src/components/StatementImport.jsx README.md
git commit -m "Prompt for a password when a statement PDF is encrypted"
```

---

## Verification

After Task 3:

1. `cd server && npm test` — all tests pass (113 existing plus roughly 11 new).
2. `cd client && npm run build` — clean.
3. `grep -rn "password" server/src/routes/statements.js` — confirm no `console.log`/`console.error` anywhere near it.
4. Manual check with a real encrypted statement:
   - Upload it. The review table should not appear; a password field should, labelled with the file name.
   - Enter a deliberately wrong password. Expect *"That password did not open this PDF"* and the field still present.
   - Enter the correct password. Expect the normal review table.
   - Confirm the server log for that request contains no trace of the password.
5. Upload a normal, unencrypted PDF or CSV and confirm the password field never appears.

## Known limitations

- A PDF that is both scanned and encrypted still fails after unlocking, because there is no text layer to read. That is the existing scanned-PDF path and is correct.
- Encrypted XLSX is not supported; `exceljs` cannot open protected workbooks.
- The password is never remembered, so re-importing the same statement later means entering it again. That is deliberate — storing statement passwords would be storing PAN- and DOB-derived secrets.

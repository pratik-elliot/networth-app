const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { extractText } = require("../src/services/statementText");

// A one-page PDF whose text layer holds three statement-like lines. Kept
// realistic in length on purpose: a two-word fixture would sit under the
// scanned-PDF threshold and fail for the wrong reason.
const STATEMENT_PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv" +
  "Ymo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlw" +
  "ZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgNDAwIDIwMF0vQ29udGVudHMgNCAwIFIv" +
  "UmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+ZW5kb2JqCjQgMCBvYmo8PC9MZW5ndGgg" +
  "MTk4Pj5zdHJlYW0KQlQgL0YxIDEwIFRmCjEgMCAwIDEgMjAgMTYwIFRtIChEYXRlICAgICAgIERl" +
  "c2NyaXB0aW9uICAgICAgICBBbW91bnQpIFRqCjEgMCAwIDEgMjAgMTQwIFRtICgxMy8wMi8yMDI2" +
  "IFNBTEFSWSBDUkVESVQgICAgICA1MDAwMC4wMCkgVGoKMSAwIDAgMSAyMCAxMjAgVG0gKDE0LzAy" +
  "LzIwMjYgQVRNIFdJVEhEUkFXQUwgICAgIDE1MDAuMDApIFRqCkVUCmVuZHN0cmVhbSBlbmRvYmoK" +
  "NSAwIG9iajw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+ZW5k" +
  "b2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0YK",
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
  const out = await extractText(STATEMENT_PDF, "statement.pdf");
  assert.strictEqual(out.kind, "pdf");
  assert.match(out.text, /SALARY CREDIT/);
  assert.match(out.text, /13\/02\/2026/);
  assert.match(out.text, /50000\.00/);
});

test("extractText strips pdf-parse page markers", async () => {
  // pdf-parse v2 injects "-- 1 of 1 --" between pages; left in, the model has
  // to be told to ignore them and may mistake them for data.
  const out = await extractText(STATEMENT_PDF, "statement.pdf");
  assert.doesNotMatch(out.text, /--\s*\d+\s+of\s+\d+\s*--/);
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

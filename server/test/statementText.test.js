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

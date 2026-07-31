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

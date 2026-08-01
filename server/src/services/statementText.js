const path = require("path");

// Below this, a PDF almost certainly holds scanned images rather than a text
// layer. pdf-parse still emits page markers like "-- 1 of 1 --" for an empty
// page, so the threshold is measured after those are stripped.
const MIN_PDF_TEXT_LENGTH = 20;
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/gm;

/* Errors carrying a code let the route answer with something the UI can act
   on, instead of a wall of prose it has to pattern-match. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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

async function extractText(buffer, filename, opts = {}) {
  if (!buffer || buffer.length === 0) throw new Error("That file is empty.");

  const ext = path.extname(filename || "").toLowerCase();

  if (ext === ".csv" || ext === ".txt") {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("That file is empty.");
    return { text, kind: "csv" };
  }
  if (ext === ".pdf") return { text: await extractPdf(buffer, opts), kind: "pdf" };
  if (ext === ".xlsx" || ext === ".xls") return { text: await extractXlsx(buffer), kind: "xlsx" };

  throw new Error("Only PDF, CSV or Excel statements can be imported.");
}

module.exports = { extractText };

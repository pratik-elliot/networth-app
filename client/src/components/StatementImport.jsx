import React, { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { C, MONO } from "../theme";
import { Btn } from "./ui";
import { api } from "../api";

const FIELD = {
  background: "transparent",
  color: C.ivory,
  border: `1px solid ${C.hair}`,
  borderRadius: 4,
  padding: "4px 6px",
  fontSize: 12.5,
  minWidth: 0,
  width: "100%",
};

export default function StatementImport({ accountId, onImported }) {
  const fileRef = useRef(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(null);
  // Held so the user does not have to re-pick the file after being asked
  // for a password. Cleared as soon as the import succeeds or is cancelled.
  const [lockedFile, setLockedFile] = useState(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    let live = true;
    api.statementStatus()
      .then(s => { if (live) setAvailable(!!s.configured); })
      .catch(() => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

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

  const update = (i, patch) =>
    setResult(r => ({ ...r, rows: r.rows.map((row, j) => (j === i ? { ...row, ...patch } : row)) }));

  const setAll = (include) =>
    setResult(r => ({ ...r, rows: r.rows.map(row => ({ ...row, include })) }));

  const confirm = async () => {
    const chosen = result.rows
      .filter(r => r.include)
      .map(({ date, description, type, amount }) => ({ date, description, type, amount: Number(amount) }));
    if (!chosen.length) { setError("No rows are selected."); return; }

    setBusy(true); setError("");
    try {
      const res = await api.bulkCreateTransactions(accountId, chosen);
      setResult(null);
      setNotice(`Imported ${res.inserted} transaction${res.inserted === 1 ? "" : "s"}.`);
      await onImported();
    } catch (err) {
      // A partial-import failure reports how many rows actually landed, which
      // the user needs before deciding whether to retry.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!available) return null;

  const selected = result ? result.rows.filter(r => r.include).length : 0;

  return (
    <div className="mt-4" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div style={{ color: C.ivoryDim, fontSize: 12 }}>Import statement (PDF, CSV or Excel)</div>
        <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
          <FileUp size={13} />{busy ? "Reading…" : "Choose file"}
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.csv,.xls,.xlsx"
            onChange={choose}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {error && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {notice && !error && <div style={{ color: C.teal, fontSize: 12, marginBottom: 8 }}>{notice}</div>}

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

      {result && result.rows.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap" style={{ marginBottom: 6 }}>
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>
              {result.rows.length} found · {selected} selected
              {result.dateOrderAssumed ? ` · dates read as ${result.dateOrderAssumed}` : ""}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAll(true)} style={{ color: C.gold, fontSize: 12 }}>Select all</button>
              <button type="button" onClick={() => setAll(false)} style={{ color: C.ivoryDim, fontSize: 12 }}>Clear</button>
            </div>
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto", border: `1px solid ${C.hair}`, borderRadius: 6 }}>
            {result.rows.map((r, i) => (
              <div
                key={i}
                className="grid gap-2 items-center p-2"
                style={{
                  // Checkbox in its own column; the fields wrap beside it, so a
                  // narrow screen stacks them instead of scrolling sideways.
                  gridTemplateColumns: "auto 1fr",
                  borderBottom: `1px solid ${C.hair}`,
                  opacity: r.include ? 1 : 0.45,
                }}
              >
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={e => update(i, { include: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                  aria-label={`Include ${r.description || "transaction"}`}
                />
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
                  <input
                    value={r.date}
                    onChange={e => update(i, { date: e.target.value })}
                    style={{ ...FIELD, fontFamily: MONO }}
                    aria-label="Date"
                  />
                  <input
                    value={r.description}
                    onChange={e => update(i, { description: e.target.value })}
                    style={{ ...FIELD, gridColumn: "span 2" }}
                    aria-label="Description"
                  />
                  <select
                    value={r.type}
                    onChange={e => update(i, { type: e.target.value })}
                    style={{ ...FIELD, background: C.panel }}
                    aria-label="Type"
                  >
                    <option value="credit">credit</option>
                    <option value="debit">debit</option>
                  </select>
                  <input
                    value={r.amount}
                    inputMode="decimal"
                    onChange={e => update(i, { amount: e.target.value })}
                    style={{ ...FIELD, fontFamily: MONO, textAlign: "right" }}
                    aria-label="Amount"
                  />
                </div>
                {r.duplicate && (
                  <div style={{ gridColumn: "2", color: C.gold, fontSize: 10.5 }}>
                    Already recorded on this account — unticked to avoid double-counting.
                  </div>
                )}
              </div>
            ))}
          </div>

          {result.rejected.length > 0 && (
            <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 6 }}>
              {result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} could not be read: {result.rejected[0].reason}
            </div>
          )}

          <div className="flex gap-2 mt-3 flex-wrap">
            <Btn onClick={confirm} disabled={busy || selected === 0}>
              {busy ? "Importing…" : `Import ${selected} transaction${selected === 1 ? "" : "s"}`}
            </Btn>
            <Btn variant="ghost" onClick={() => { setResult(null); setError(""); setLockedFile(null); setPassword(""); }}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

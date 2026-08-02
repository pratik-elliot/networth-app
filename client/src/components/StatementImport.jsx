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
  // Split so the user can tell local file reading (instant) from the AI call
  // (10-30s). One undifferentiated spinner for both looks like a hang.
  const [stage, setStage] = useState("");
  const [includeBalance, setIncludeBalance] = useState(true);

  useEffect(() => {
    let live = true;
    api.statementStatus()
      .then(s => { if (live) setAvailable(!!s.configured); })
      .catch(() => { if (live) setAvailable(false); });
    return () => { live = false; };
  }, []);

  const runParse = async (file, pw) => {
    setBusy(true); setError(""); setNotice(""); setResult(null);
    setStage("Reading file…");
    // The AI call dominates the wall time, so switch the label almost
    // immediately rather than after the request resolves.
    const stageTimer = setTimeout(() => setStage("Extracting with AI…"), 400);
    try {
      const res = await api.parseStatement(accountId, file, pw);
      setLockedFile(null);
      setPassword("");
      setIncludeBalance(!!res.closingBalance);
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
      } else {
        // Otherwise this isn't a password problem -- e.g. the user swapped in
        // an unsupported file while a previous file was locked. Clear the
        // stale prompt so it doesn't keep naming a file that's no longer
        // relevant to the error being shown.
        setLockedFile(null);
        setPassword("");
      }
      setError(err.message);
    } finally {
      clearTimeout(stageTimer);
      setStage("");
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

    setBusy(true); setError(""); setStage("Saving…");
    try {
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
    } catch (err) {
      // A partial-import failure reports how many rows actually landed, which
      // the user needs before deciding whether to retry.
      setError(err.message);
    } finally {
      setStage("");
      setBusy(false);
    }
  };

  if (!available) return null;

  const selected = result ? result.rows.filter(r => r.include).length : 0;

  return (
    // The enclosing card supplies the heading and the explanation, so this
    // renders only the control -- a second "Import statement" title here would
    // just repeat it.
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
          <FileUp size={13} />{busy ? (stage || "Working…") : "Choose file"}
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

      {/* Placed where the decision is made, not buried in settings. */}
      <div style={{ color: C.ivoryDim, fontSize: 10.5, marginBottom: 8, lineHeight: 1.4 }}>
        Read by AI (zero data retention). Always check the rows before importing.
      </div>

      {error && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {notice && !error && <div style={{ color: C.teal, fontSize: 12, marginBottom: 8 }}>{notice}</div>}

      {lockedFile && (
        <div
          className="flex gap-2 items-center flex-wrap"
          style={{ marginBottom: 8 }}
        >
          <input
            type="password"
            value={password}
            autoComplete="off"
            placeholder={`Password for ${lockedFile.name}`}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && password && !busy) { e.preventDefault(); runParse(lockedFile, password); } }}
            style={{ ...FIELD, width: "auto", flex: "1 1 200px" }}
            aria-label="Statement password"
          />
          <Btn onClick={() => runParse(lockedFile, password)} disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</Btn>
          <Btn variant="ghost" onClick={() => { setLockedFile(null); setPassword(""); setError(""); }}>Cancel</Btn>
        </div>
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
              {busy ? (stage || "Importing…") : `Import ${selected} transaction${selected === 1 ? "" : "s"}`}
            </Btn>
            <Btn variant="ghost" onClick={() => { setResult(null); setError(""); setLockedFile(null); setPassword(""); }}>Cancel</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

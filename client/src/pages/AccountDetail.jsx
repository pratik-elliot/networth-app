import React, { useRef, useState } from "react";
import { ArrowLeft, Pencil, Plus, RefreshCw, Download, Users, Upload } from "lucide-react";
import { C, SERIF, MONO, typeInfo, fmt, latestValue, isStale, PHYSICAL_TYPES } from "../theme";
import { Btn, StaleBadge, EmptyNote } from "../components/ui";
import { api } from "../api";
import Attachment from "../components/Attachment";
import StatementImport from "../components/StatementImport";

// One card, one job. Previously a single card carried identity, nominees,
// file storage, statement import and an action row whose every button operated
// on a different card's contents.
const CARD = {
  background: C.panel,
  border: `1px solid ${C.hair}`,
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
};

const CARD_TITLE = { color: C.ivory, fontFamily: SERIF, fontSize: 15, marginBottom: 8 };
const CARD_SUB = { color: C.ivoryDim, fontSize: 11.5, marginBottom: 10, lineHeight: 1.4 };

export default function AccountDetail({
  account, txByAccount, balByAccount, onBack, onAddTxn, onAddBalance, onUpdateValue, onEdit,
  onImagesChanged,
}) {
  const info = typeInfo(account.type);
  const isPhysical = PHYSICAL_TYPES.includes(account.type);
  const txns = (txByAccount[account.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const logs = (balByAccount[account.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const val = latestValue(account, balByAccount, txByAccount);
  // logs is sorted newest-first, so logs[0] is the anchor.
  const laterTxnCount = logs.length ? txns.filter(t => t.date > logs[0].date).length : 0;
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const exportCsv = () => {
    let rows = [];
    if (isPhysical) {
      rows.push(["Type", "Date", "Value", "Source URL"]);
      rows.push(["Current Value", account.valueDate, account.currentValue, account.valueUrl]);
    } else {
      rows.push(["Kind", "Date", "Description", "Type", "Amount/Balance"]);
      txns.forEach(t => rows.push(["Transaction", t.date, t.description, t.type, t.amount]));
      logs.forEach(l => rows.push(["Balance", l.date, "", "", l.balance]));
    }
    const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${account.name.replace(/\s+/g, "_")}_history.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    setUploading(true);
    setUploadError("");
    try {
      await api.uploadFiles(account.id, files);
      await onImagesChanged();
    } catch (err) {
      // Previously this had no catch, so failed uploads vanished silently.
      setUploadError(err.message || "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeFile = async (id) => {
    setUploadError("");
    try { await api.deleteFile(id); await onImagesChanged(); }
    catch (err) { setUploadError(err.message || "Could not remove that file."); }
  };

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 mb-4" style={{ color: C.gold, fontSize: 13 }}><ArrowLeft size={14} />Back to accounts</button>

      {/* 1. IDENTITY */}
      <div style={CARD}>
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>
              {[info.label, account.institution, account.country].filter(Boolean).join(" · ")}
            </div>
            <div style={{ fontFamily: SERIF, fontSize: 24, color: C.ivory }}>{account.name}</div>
          </div>
          <Btn variant="ghost" onClick={onEdit}><Pencil size={13} />Edit account</Btn>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4" style={{ fontSize: 12.5, color: C.ivoryDim }}>
          {account.lastKYCDate && <div>Last KYC: <b style={{ color: C.ivory }}>{account.lastKYCDate}</b></div>}
          {account.interestRate ? <div>Interest: <b style={{ color: C.ivory }}>{account.interestRate}% ({account.interestFrequency})</b></div> : null}
          {(account.type === "gold" || account.type === "silver") && (
            <>
              <div>Purity: <b style={{ color: C.ivory }}>{account.purity || "—"}</b></div>
              <div>Form / Qty: <b style={{ color: C.ivory }}>{account.form} × {account.quantity || 0}</b></div>
              <div>City: <b style={{ color: C.ivory }}>{account.city || "—"}</b></div>
            </>
          )}
          {account.type === "automobile" && (
            <>
              <div>VIN: <b style={{ color: C.ivory }}>{account.vin || "—"}</b></div>
              <div>Vehicle: <b style={{ color: C.ivory }}>{account.year} {account.make} {account.model}</b></div>
            </>
          )}
        </div>

        {account.nominees?.length > 0 && (
          <div className="mt-3">
            <div style={{ color: C.ivoryDim, fontSize: 12, marginBottom: 4 }}><Users size={12} className="inline mr-1" />Nominees</div>
            <div className="flex gap-2 flex-wrap">
              {account.nominees.map(n => (
                <span key={n.id} style={{ fontSize: 12.5, color: C.ivory, background: C.panelHi, padding: "4px 10px", borderRadius: 20 }}>
                  {n.name} ({n.relation}{n.percent ? `, ${n.percent}%` : ""})
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2. BALANCE (or VALUATION for physical assets) */}
      <div style={CARD}>
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div style={CARD_TITLE}>{isPhysical ? "Valuation" : "Balance"}</div>
            <div style={{ fontFamily: MONO, fontSize: 28, color: val === null ? C.ivoryDim : C.gold }}>
              {val === null ? "Not set" : fmt(val, account.currency)}
            </div>
            {isPhysical ? (
              account.valueDate && (
                <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 2 }}>
                  priced {account.valueDate}
                  {account.valueUrl && <> · <a href={account.valueUrl} target="_blank" rel="noreferrer" style={{ color: C.teal }}>source</a></>}
                </div>
              )
            ) : val === null ? (
              <div style={{ color: C.amber, fontSize: 11.5, marginTop: 2 }}>
                No balance logged, so this account is left out of your net worth.
              </div>
            ) : (
              <div style={{ color: C.ivoryDim, fontSize: 11.5, marginTop: 2 }}>
                anchored {logs[0].date}
                {laterTxnCount > 0 && ` · ${laterTxnCount} later transaction${laterTxnCount === 1 ? "" : "s"} applied`}
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {isPhysical
              ? <Btn onClick={onUpdateValue}><RefreshCw size={13} />Update Value</Btn>
              : <Btn onClick={onAddBalance}><Plus size={13} />Log Balance</Btn>}
          </div>
        </div>

        {!isPhysical && logs.length > 0 && (
          <div className="mt-3" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 8, maxHeight: 140, overflowY: "auto" }}>
            {logs.map(l => (
              <div key={l.id} className="flex justify-between py-1" style={{ fontSize: 12.5 }}>
                <span style={{ color: C.ivoryDim }}>{l.date}</span>
                <span style={{ color: C.ivory, fontFamily: MONO }}>{fmt(l.balance, account.currency)}</span>
              </div>
            ))}
          </div>
        )}
        {isStale(account, txByAccount, balByAccount) && <div className="mt-2"><StaleBadge /></div>}
      </div>

      {/* 3. TRANSACTIONS */}
      {!isPhysical && (
        <div style={CARD}>
          <div className="flex justify-between items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
            <div style={{ ...CARD_TITLE, marginBottom: 0 }}>Transactions ({txns.length})</div>
            <div className="flex gap-2 flex-wrap">
              <Btn onClick={onAddTxn}><Plus size={13} />Log Transaction</Btn>
              <Btn variant="ghost" onClick={exportCsv}><Download size={13} />CSV</Btn>
            </div>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {txns.map(t => (
              <div key={t.id} className="flex justify-between gap-2 py-1.5" style={{ borderBottom: `1px solid ${C.hair}`, fontSize: 13 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ color: C.ivoryDim }}>{t.date}</span>{" "}
                  <span style={{ color: C.ivory }}>{t.description}</span>
                </div>
                <div style={{ color: t.type === "credit" ? C.teal : C.crimson, fontFamily: MONO, whiteSpace: "nowrap" }}>
                  {t.type === "credit" ? "+" : "-"}{fmt(t.amount, account.currency)}
                </div>
              </div>
            ))}
            {txns.length === 0 && <EmptyNote text="No transactions logged yet." />}
          </div>
        </div>
      )}

      {/* 4. IMPORT STATEMENT */}
      {!isPhysical && (
        <div style={CARD}>
          <div style={CARD_TITLE}>Import statement</div>
          <div style={CARD_SUB}>Reads a PDF, CSV or Excel statement and creates transactions from it.</div>
          <StatementImport accountId={account.id} onImported={onImagesChanged} />
        </div>
      )}

      {/* 5. DOCUMENTS */}
      <div style={CARD}>
        <div style={CARD_TITLE}>Documents</div>
        <div style={CARD_SUB}>Stored for reference — never read. Valuations, KYC papers, locker photos.</div>
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div style={{ color: C.ivoryDim, fontSize: 12 }}>{(account.images || []).length} file(s)</div>
          <label style={{ color: C.gold, fontSize: 12, cursor: "pointer" }} className="inline-flex items-center gap-1">
            <Upload size={13} />{uploading ? "Uploading…" : "Upload"}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf,.csv,.xls,.xlsx,.doc,.docx,.txt"
              multiple
              onChange={handleUpload}
              style={{ display: "none" }}
            />
          </label>
        </div>
        {uploadError && <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{uploadError}</div>}
        <div className="flex gap-2 flex-wrap">
          {(account.images || []).map(att => (
            <Attachment key={att.id} att={att} onRemove={removeFile} />
          ))}
          {(!account.images || account.images.length === 0) && <div style={{ color: C.ivoryDim, fontSize: 12 }}>No files yet.</div>}
        </div>
      </div>
    </div>
  );
}

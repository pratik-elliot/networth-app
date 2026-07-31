import React, { useRef, useState } from "react";
import { ArrowLeft, Pencil, Plus, RefreshCw, Download, Users, Upload, Trash2 } from "lucide-react";
import { C, SERIF, MONO, typeInfo, fmt, latestValue, isStale, lastActivityDate, PHYSICAL_TYPES } from "../theme";
import { Btn, StaleBadge, EmptyNote } from "../components/ui";
import { api } from "../api";
import Attachment from "../components/Attachment";
import StatementImport from "../components/StatementImport";

export default function AccountDetail({
  account, txByAccount, balByAccount, onBack, onAddTxn, onAddBalance, onUpdateValue, onEdit,
  onImagesChanged,
}) {
  const info = typeInfo(account.type);
  const isPhysical = PHYSICAL_TYPES.includes(account.type);
  const txns = (txByAccount[account.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const logs = (balByAccount[account.id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const val = latestValue(account, balByAccount);
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

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 20, marginBottom: 16 }}>
        <div className="flex justify-between items-start">
          <div>
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>{info.label} · {account.institution} · {account.country}</div>
            <div style={{ fontFamily: SERIF, fontSize: 24, color: C.ivory }}>{account.name}</div>
          </div>
          <div className="text-right">
            <div style={{ fontFamily: MONO, fontSize: 28, color: C.gold }}>{fmt(val, account.currency)}</div>
            {isStale(account, txByAccount, balByAccount) && <div className="mt-1"><StaleBadge /></div>}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 mt-4" style={{ fontSize: 12.5, color: C.ivoryDim }}>
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
          {isPhysical && account.valueDate && (
            <div>Priced as of <b style={{ color: C.ivory }}>{account.valueDate}</b>{account.valueUrl && <> · <a href={account.valueUrl} target="_blank" rel="noreferrer" style={{ color: C.teal }}>source</a></>}</div>
          )}
        </div>

        {account.nominees?.length > 0 && (
          <div className="mt-4" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
            <div style={{ color: C.ivoryDim, fontSize: 12, marginBottom: 4 }}><Users size={12} className="inline mr-1" />Nominees</div>
            <div className="flex gap-2 flex-wrap">
              {account.nominees.map(n => <span key={n.id} style={{ fontSize: 12.5, color: C.ivory, background: C.panelHi, padding: "4px 10px", borderRadius: 20 }}>{n.name} ({n.relation}{n.percent ? `, ${n.percent}%` : ""})</span>)}
            </div>
          </div>
        )}

        <div className="mt-4" style={{ borderTop: `1px solid ${C.hair}`, paddingTop: 10 }}>
          <div className="flex items-center justify-between mb-2">
            <div style={{ color: C.ivoryDim, fontSize: 12 }}>Files (statements, valuations, certificates, photos)</div>
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
          {uploadError && (
            <div style={{ color: C.crimson, fontSize: 12, marginBottom: 8 }}>{uploadError}</div>
          )}
          <div className="flex gap-2 flex-wrap">
            {(account.images || []).map(att => (
              <Attachment key={att.id} att={att} onRemove={removeFile} />
            ))}
            {(!account.images || account.images.length === 0) && <div style={{ color: C.ivoryDim, fontSize: 12 }}>No files yet.</div>}
          </div>
        </div>

        {!isPhysical && (
          <StatementImport accountId={account.id} onImported={onImagesChanged} />
        )}

        <div className="flex gap-2 mt-4">
          <Btn variant="ghost" onClick={onEdit}><Pencil size={13} />Edit account</Btn>
          {isPhysical ? <Btn onClick={onUpdateValue}><RefreshCw size={13} />Update Value</Btn> : (
            <>
              <Btn onClick={onAddTxn}><Plus size={13} />Log Transaction</Btn>
              <Btn onClick={onAddBalance}><Plus size={13} />Log Balance</Btn>
            </>
          )}
          <Btn variant="ghost" onClick={exportCsv}><Download size={13} />Download History (CSV)</Btn>
        </div>
      </div>

      {!isPhysical && (
        <div className="grid grid-cols-2 gap-4">
          <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16 }}>
            <div style={{ color: C.ivory, fontFamily: SERIF, fontSize: 15, marginBottom: 8 }}>Transaction History ({txns.length})</div>
            <div style={{ maxHeight: 380, overflowY: "auto" }}>
              {txns.map(t => (
                <div key={t.id} className="flex justify-between py-1.5" style={{ borderBottom: `1px solid ${C.hair}`, fontSize: 13 }}>
                  <div><span style={{ color: C.ivoryDim }}>{t.date}</span> <span style={{ color: C.ivory }}>{t.description}</span></div>
                  <div style={{ color: t.type === "credit" ? C.teal : C.crimson, fontFamily: MONO }}>{t.type === "credit" ? "+" : "-"}{fmt(t.amount, account.currency)}</div>
                </div>
              ))}
              {txns.length === 0 && <EmptyNote text="No transactions logged yet." />}
            </div>
          </div>
          <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16 }}>
            <div style={{ color: C.ivory, fontFamily: SERIF, fontSize: 15, marginBottom: 8 }}>Balance History ({logs.length})</div>
            <div style={{ maxHeight: 380, overflowY: "auto" }}>
              {logs.map(l => (
                <div key={l.id} className="flex justify-between py-1.5" style={{ borderBottom: `1px solid ${C.hair}`, fontSize: 13 }}>
                  <div style={{ color: C.ivoryDim }}>{l.date}</div>
                  <div style={{ color: C.ivory, fontFamily: MONO }}>{fmt(l.balance, account.currency)}</div>
                </div>
              ))}
              {logs.length === 0 && <EmptyNote text="No balances logged yet." />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React from "react";
import { Download } from "lucide-react";
import { C, SERIF, MONO, typeInfo, fmt, latestValue, isStale, lastActivityDate } from "../theme";
import { Btn, EmptyNote } from "../components/ui";
import { api } from "../api";

export default function Reports({ accounts, txByAccount, balByAccount }) {
  const byType = {};
  accounts.forEach(a => {
    const val = latestValue(a, balByAccount);
    if (!byType[a.type]) byType[a.type] = { USD: 0, INR: 0 };
    byType[a.type][a.currency] += val;
  });
  const stale = accounts.filter(a => isStale(a, txByAccount, balByAccount));

  const exportAll = async () => {
    const data = await api.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "networth-ledger-full-export.json"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div style={{ fontFamily: SERIF, fontSize: 20, color: C.ivory }}>Reports</div>
        <Btn onClick={exportAll}><Download size={14} />Download Full Data (JSON, no limits)</Btn>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ color: C.gold, fontFamily: SERIF, fontSize: 16, marginBottom: 10 }}>Summary by Account Type</div>
        <table className="w-full" style={{ fontSize: 13, color: C.ivory }}>
          <thead><tr style={{ color: C.ivoryDim, textAlign: "left" }}><th className="pb-2">Type</th><th className="pb-2">USD</th><th className="pb-2">INR</th></tr></thead>
          <tbody>
            {Object.entries(byType).map(([type, v]) => (
              <tr key={type} style={{ borderTop: `1px solid ${C.hair}` }}>
                <td className="py-1.5">{typeInfo(type).label}</td>
                <td className="py-1.5" style={{ fontFamily: MONO }}>{fmt(v.USD, "USD")}</td>
                <td className="py-1.5" style={{ fontFamily: MONO }}>{fmt(v.INR, "INR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16 }}>
        <div style={{ color: C.gold, fontFamily: SERIF, fontSize: 16, marginBottom: 10 }}>Accounts Needing Attention (90+ days stale)</div>
        {stale.length === 0 ? <EmptyNote text="All accounts are current." /> : (
          <div className="grid gap-2">
            {stale.map(a => (
              <div key={a.id} className="flex justify-between" style={{ fontSize: 13, color: C.ivory, borderBottom: `1px solid ${C.hair}`, paddingBottom: 6 }}>
                <span>{a.name} <span style={{ color: C.ivoryDim }}>({typeInfo(a.type).label})</span></span>
                <span style={{ color: C.crimson }}>Last activity: {lastActivityDate(a, txByAccount, balByAccount) || "never"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState } from "react";
import { Search, Pencil, Trash2 } from "lucide-react";
import { C, SERIF, MONO, ACCOUNT_TYPES, CURRENCIES, typeInfo, fmt, latestValue, isStale } from "../theme";
import { TInput, TSelect, StaleBadge, EmptyNote } from "../components/ui";

export default function AccountsList({ accounts, txByAccount, balByAccount, onEdit, onDelete, onOpen }) {
  const [q, setQ] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [filterCur, setFilterCur] = useState("all");

  const filtered = accounts.filter(a =>
    (filterType === "all" || a.type === filterType) &&
    (filterCur === "all" || a.currency === filterCur) &&
    (a.name.toLowerCase().includes(q.toLowerCase()) || (a.institution || "").toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div>
      <div className="flex gap-3 mb-4 items-center">
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: C.ivoryDim }} />
          <TInput placeholder="Search accounts or institutions…" value={q} onChange={e => setQ(e.target.value)} style={{ paddingLeft: 30 }} />
        </div>
        <TSelect value={filterType} onChange={e => setFilterType(e.target.value)} style={{ width: 200 }}>
          <option value="all">All types</option>
          {ACCOUNT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </TSelect>
        <TSelect value={filterCur} onChange={e => setFilterCur(e.target.value)} style={{ width: 120 }}>
          <option value="all">All currencies</option>
          {CURRENCIES.map(c => <option key={c}>{c}</option>)}
        </TSelect>
      </div>

      <div className="grid gap-3">
        {filtered.map(a => {
          const info = typeInfo(a.type);
          const Icon = info.icon;
          const val = latestValue(a, balByAccount);
          const stale = isStale(a, txByAccount, balByAccount);
          return (
            <div key={a.id} onClick={() => onOpen(a.id)} style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 14, cursor: "pointer" }} className="flex items-center justify-between hover:brightness-110">
              <div className="flex items-center gap-3">
                <div style={{ background: C.panelHi, borderRadius: 8, padding: 9 }}><Icon size={18} color={C.gold} /></div>
                <div>
                  <div style={{ color: C.ivory, fontFamily: SERIF, fontSize: 15.5 }}>{a.name}</div>
                  <div style={{ color: C.ivoryDim, fontSize: 12 }}>{a.institution || "—"} · {info.label} · {a.country}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {stale && <StaleBadge />}
                <div style={{ color: C.ivory, fontFamily: MONO, fontSize: 16, textAlign: "right" }}>{fmt(val, a.currency)}</div>
                <button onClick={e => { e.stopPropagation(); onEdit(a); }} style={{ color: C.ivoryDim }}><Pencil size={15} /></button>
                <button onClick={e => { e.stopPropagation(); if (confirm(`Delete ${a.name}?`)) onDelete(a.id); }} style={{ color: C.crimson }}><Trash2 size={15} /></button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <EmptyNote text="No accounts match. Add one to get started." />}
      </div>
    </div>
  );
}

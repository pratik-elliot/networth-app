import React, { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { C } from "../theme";
import { ACCOUNT_TYPES, CURRENCIES, INTEREST_FREQ, RELATIONS, typeInfo, todayStr, PHYSICAL_TYPES } from "../theme";
import { Field, TInput, TSelect, TArea, Btn, Modal } from "./ui";

function uid() { return Math.random().toString(36).slice(2, 10); }

export default function AccountForm({ initial, onSave, onClose }) {
  const [a, setA] = useState(initial || {
    name: "", institution: "", country: "US", currency: "USD", type: "bank",
    interestRate: "", interestFrequency: "None", nominees: [], lastKYCDate: "",
    isLiquid: null, notes: "", createdDate: todayStr(),
    currentValue: "", valueDate: "", valueUrl: "",
    purity: "", form: "Coin", quantity: "", city: "",
    vin: "", make: "", model: "", year: "", address: "",
  });
  const set = (k, v) => setA(prev => ({ ...prev, [k]: v }));
  const info = typeInfo(a.type);
  const isPhysical = PHYSICAL_TYPES.includes(a.type);

  const addNominee = () => setA(p => ({ ...p, nominees: [...(p.nominees || []), { id: uid(), name: "", relation: "Spouse", percent: "" }] }));
  const updateNominee = (id, k, v) => setA(p => ({ ...p, nominees: p.nominees.map(n => n.id === id ? { ...n, [k]: v } : n) }));
  const removeNominee = (id) => setA(p => ({ ...p, nominees: p.nominees.filter(n => n.id !== id) }));

  return (
    <Modal title={initial ? "Edit Account" : "Add Account"} onClose={onClose} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="Account Name"><TInput value={a.name} onChange={e => set("name", e.target.value)} placeholder="e.g. HDFC Savings, Vault Locker #204" /></Field>
        <Field label="Account Type">
          <TSelect value={a.type} onChange={e => set("type", e.target.value)}>
            {ACCOUNT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </TSelect>
        </Field>
        <Field label="Institution"><TInput value={a.institution} onChange={e => set("institution", e.target.value)} placeholder="e.g. HDFC Bank, Chase, self-held" /></Field>
        <Field label="Country">
          <TSelect value={a.country} onChange={e => set("country", e.target.value)}>
            <option value="US">United States</option><option value="IN">India</option><option value="Other">Other</option>
          </TSelect>
        </Field>
        <Field label="Currency">
          <TSelect value={a.currency} onChange={e => set("currency", e.target.value)}>{CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}</TSelect>
        </Field>
        <Field label="Liquidity">
          <TSelect value={a.isLiquid === null || a.isLiquid === undefined ? "default" : (a.isLiquid ? "yes" : "no")}
            onChange={e => set("isLiquid", e.target.value === "default" ? null : e.target.value === "yes")}>
            <option value="default">Default for type ({info.liquid ? "Liquid" : "Non-liquid"})</option>
            <option value="yes">Liquid</option><option value="no">Non-liquid</option>
          </TSelect>
        </Field>
        {!isPhysical && (
          <>
            <Field label="Interest Rate (%)"><TInput type="number" step="0.01" value={a.interestRate || ""} onChange={e => set("interestRate", e.target.value)} placeholder="e.g. 3.5" /></Field>
            <Field label="Interest Frequency">
              <TSelect value={a.interestFrequency || "None"} onChange={e => set("interestFrequency", e.target.value)}>{INTEREST_FREQ.map(f => <option key={f}>{f}</option>)}</TSelect>
            </Field>
          </>
        )}
        <Field label="Last KYC Date"><TInput type="date" value={a.lastKYCDate || ""} onChange={e => set("lastKYCDate", e.target.value)} /></Field>
      </div>

      {(a.type === "gold" || a.type === "silver") && (
        <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
          <div style={{ color: C.gold, fontSize: 13, marginBottom: 8 }}>Holding details</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            <Field label="Purity (e.g. 24K, 22K, 999)"><TInput value={a.purity || ""} onChange={e => set("purity", e.target.value)} /></Field>
            <Field label="Form">
              <TSelect value={a.form || "Coin"} onChange={e => set("form", e.target.value)}><option>Coin</option><option>Bar</option><option>Ornament</option></TSelect>
            </Field>
            <Field label="Number of Units / Quantity"><TInput type="number" value={a.quantity || ""} onChange={e => set("quantity", e.target.value)} /></Field>
            <Field label="City / Location"><TInput value={a.city || ""} onChange={e => set("city", e.target.value)} /></Field>
          </div>
        </div>
      )}

      {a.type === "automobile" && (
        <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
          <div style={{ color: C.gold, fontSize: 13, marginBottom: 8 }}>Vehicle details</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            <Field label="VIN"><TInput value={a.vin || ""} onChange={e => set("vin", e.target.value.toUpperCase())} /></Field>
            <Field label="Year"><TInput value={a.year || ""} onChange={e => set("year", e.target.value)} /></Field>
            <Field label="Make"><TInput value={a.make || ""} onChange={e => set("make", e.target.value)} /></Field>
            <Field label="Model"><TInput value={a.model || ""} onChange={e => set("model", e.target.value)} /></Field>
          </div>
        </div>
      )}

      {a.type === "real_estate" && (
        <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
          <Field label="Address"><TArea rows={2} value={a.address || ""} onChange={e => set("address", e.target.value)} /></Field>
        </div>
      )}

      {isPhysical && (
        <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
          <div style={{ color: C.gold, fontSize: 13, marginBottom: 8 }}>Current value (use "Update Value" on the account page later to log a sourced update)</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4">
            <Field label={`Current Value (${a.currency})`}><TInput type="number" value={a.currentValue || ""} onChange={e => set("currentValue", e.target.value)} /></Field>
            <Field label="Value As Of"><TInput type="date" value={a.valueDate || ""} onChange={e => set("valueDate", e.target.value)} /></Field>
            <Field label="Source URL"><TInput value={a.valueUrl || ""} onChange={e => set("valueUrl", e.target.value)} placeholder="https://…" /></Field>
          </div>
        </div>
      )}

      <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
        <div className="flex items-center justify-between mb-2">
          <div style={{ color: C.gold, fontSize: 13 }}>Nominees</div>
          <button onClick={addNominee} style={{ color: C.gold, fontSize: 12 }} className="inline-flex items-center gap-1"><Plus size={13} />Add nominee</button>
        </div>
        {(a.nominees || []).length === 0 && <div style={{ color: C.ivoryDim, fontSize: 12 }}>No nominees added.</div>}
        {(a.nominees || []).map(n => (
          <div key={n.id} className="grid gap-2 mb-2" style={{ gridTemplateColumns: "2fr 1.3fr 0.9fr auto" }}>
            <TInput placeholder="Name" value={n.name} onChange={e => updateNominee(n.id, "name", e.target.value)} />
            <TSelect value={n.relation} onChange={e => updateNominee(n.id, "relation", e.target.value)}>{RELATIONS.map(r => <option key={r}>{r}</option>)}</TSelect>
            <TInput placeholder="%" type="number" value={n.percent} onChange={e => updateNominee(n.id, "percent", e.target.value)} />
            <button onClick={() => removeNominee(n.id)} style={{ color: C.crimson }}><Trash2 size={16} /></button>
          </div>
        ))}
      </div>

      <div style={{ borderTop: `1px solid ${C.hair}`, marginTop: 8, paddingTop: 12 }}>
        <Field label="Notes"><TArea rows={2} value={a.notes || ""} onChange={e => set("notes", e.target.value)} /></Field>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => { if (!a.name.trim()) return; onSave(a); }}>Save Account</Btn>
      </div>
    </Modal>
  );
}

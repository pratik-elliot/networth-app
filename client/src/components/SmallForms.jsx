import React, { useState } from "react";
import { C, todayStr } from "../theme";
import { Field, TInput, TSelect, TArea, Btn, Modal } from "./ui";

export function TransactionForm({ account, onSave, onClose }) {
  const [t, setT] = useState({ date: todayStr(), description: "", type: "credit", amount: "" });
  return (
    <Modal title="Log Transaction" onClose={onClose}>
      <Field label="Date"><TInput type="date" value={t.date} onChange={e => setT({ ...t, date: e.target.value })} /></Field>
      <Field label="Description"><TInput value={t.description} onChange={e => setT({ ...t, description: e.target.value })} placeholder="e.g. Salary credit, wire transfer" /></Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="Type">
          <TSelect value={t.type} onChange={e => setT({ ...t, type: e.target.value })}>
            <option value="credit">Credit (+)</option><option value="debit">Debit (-)</option>
          </TSelect>
        </Field>
        <Field label={`Amount (${account.currency})`}><TInput type="number" value={t.amount} onChange={e => setT({ ...t, amount: e.target.value })} /></Field>
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => t.amount !== "" && onSave(t)}>Save Transaction</Btn>
      </div>
    </Modal>
  );
}

export function BalanceForm({ account, onSave, onClose }) {
  const [b, setB] = useState({ date: todayStr(), balance: "" });
  return (
    <Modal title="Log Balance" onClose={onClose}>
      <Field label="As Of Date"><TInput type="date" value={b.date} onChange={e => setB({ ...b, date: e.target.value })} /></Field>
      <Field label={`Balance (${account.currency})`}><TInput type="number" value={b.balance} onChange={e => setB({ ...b, balance: e.target.value })} /></Field>
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => b.balance !== "" && onSave(b)}>Save Balance</Btn>
      </div>
    </Modal>
  );
}

export function ValueUpdateForm({ account, onSave, onClose }) {
  const [v, setV] = useState({ currentValue: account.currentValue || "", valueDate: todayStr(), valueUrl: account.valueUrl || "" });
  return (
    <Modal title={`Update Value — ${account.name}`} onClose={onClose}>
      <p style={{ color: C.ivoryDim, fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
        This app can't reach external pricing sites automatically. Look up the current market value
        (gold/silver spot price, a valuation site for vehicles, comparable listings for property), then log
        the figure, date, and source link below. You can overwrite it any time.
      </p>
      <Field label={`Current Value (${account.currency})`}><TInput type="number" value={v.currentValue} onChange={e => setV({ ...v, currentValue: e.target.value })} /></Field>
      <Field label="Value As Of"><TInput type="date" value={v.valueDate} onChange={e => setV({ ...v, valueDate: e.target.value })} /></Field>
      <Field label="Source URL"><TInput value={v.valueUrl} onChange={e => setV({ ...v, valueUrl: e.target.value })} placeholder="https://…" /></Field>
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => onSave(v)}>Save Value</Btn>
      </div>
    </Modal>
  );
}

import React, { useState } from "react";
import { ShieldCheck, Check, LogOut } from "lucide-react";
import { C, SERIF } from "../theme";
import { Field, TInput, Btn } from "../components/ui";
import { api } from "../api";

export default function SettingsPanel({ me, onSaved, onLogout }) {
  const [phone, setPhone] = useState(me.phone || "");
  const [fxRate, setFxRate] = useState(me.fxRate || 83);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await api.updateMe({ phone, fxRate: Number(fxRate) });
    setSaved(true);
    onSaved({ ...me, phone, fxRate: Number(fxRate) });
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ maxWidth: 460 }}>
      <div style={{ fontFamily: SERIF, fontSize: 20, color: C.ivory, marginBottom: 4 }}>Settings</div>

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ color: C.gold, fontFamily: SERIF, fontSize: 15, marginBottom: 8 }}><ShieldCheck size={14} className="inline mr-1" />Account & Sign-in</div>
        <p style={{ color: C.ivoryDim, fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
          Signed in as <b style={{ color: C.ivory }}>{me.email}</b>. Every login requires your password plus a
          one-time code emailed to this address.
        </p>
        <Field label="Phone (optional, for reference)"><TInput value={phone} onChange={e => setPhone(e.target.value)} /></Field>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ color: C.gold, fontFamily: SERIF, fontSize: 15, marginBottom: 8 }}>Exchange Rate</div>
        <Field label="1 USD = ? INR (used only for the combined net-worth estimate)">
          <TInput type="number" value={fxRate} onChange={e => setFxRate(e.target.value)} />
        </Field>
      </div>

      <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
        <div style={{ color: C.gold, fontFamily: SERIF, fontSize: 15, marginBottom: 8 }}>Data Storage</div>
        <p style={{ color: C.ivoryDim, fontSize: 12, lineHeight: 1.5 }}>
          Your data lives in this app's own database on the server, not in your browser — so it's the same
          on every device you log in from. Use <b style={{ color: C.ivory }}>Reports → Download Full Data</b> any
          time for a complete backup you can store wherever you like (including Google Drive or Dropbox, uploaded manually).
        </p>
      </div>

      <div className="flex gap-2">
        <Btn onClick={save}><Check size={14} />{saved ? "Saved" : "Save Settings"}</Btn>
        <Btn variant="ghost" onClick={onLogout}><LogOut size={14} />Log out</Btn>
      </div>
    </div>
  );
}

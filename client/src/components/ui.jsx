import React from "react";
import { X, AlertTriangle } from "lucide-react";
import { C, SERIF, SANS } from "../theme";

export function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <div className="text-xs uppercase tracking-wide mb-1" style={{ color: C.ivoryDim, letterSpacing: "0.06em" }}>{label}</div>
      {children}
    </label>
  );
}
const inputStyle = { background: C.panelHi, border: `1px solid ${C.hair}`, color: C.ivory, borderRadius: 6, padding: "8px 10px", width: "100%", fontFamily: SANS, fontSize: 14 };
export function TInput(props) { return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} className={"outline-none " + (props.className || "")} />; }
export function TSelect({ children, ...props }) { return <select {...props} style={{ ...inputStyle, ...(props.style || {}) }} className="outline-none">{children}</select>; }
export function TArea(props) { return <textarea {...props} style={{ ...inputStyle, resize: "vertical", ...(props.style || {}) }} />; }

export function Btn({ children, variant = "solid", onClick, type = "button", className = "", style = {}, disabled }) {
  const base = "px-3 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5 transition-colors";
  const variants = {
    solid: { background: C.gold, color: C.ink },
    ghost: { background: "transparent", color: C.ivory, border: `1px solid ${C.hair}` },
    danger: { background: "transparent", color: C.crimson, border: `1px solid ${C.crimson}55` },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={base + " " + className}
      style={{ ...variants[variant], opacity: disabled ? 0.6 : 1, ...style }}>{children}</button>
  );
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000099", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", overflowY: "auto" }}>
      <div style={{ background: C.ledger, border: `1px solid ${C.hair}`, borderRadius: 10, width: "100%", maxWidth: wide ? 720 : 480, padding: 20 }}>
        <div className="flex items-center justify-between mb-4">
          <h3 style={{ fontFamily: SERIF, color: C.ivory, fontSize: 19 }}>{title}</h3>
          <button onClick={onClose} style={{ color: C.ivoryDim }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StaleBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: `${C.crimson}22`, color: C.crimson, border: `1px solid ${C.crimson}55` }}>
      <AlertTriangle size={11} /> Not updated in 90+ days
    </span>
  );
}

export function EmptyNote({ text }) {
  return <div style={{ color: C.ivoryDim, fontSize: 13, textAlign: "center", paddingTop: 40 }}>{text}</div>;
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return <div style={{ background: `${C.crimson}22`, border: `1px solid ${C.crimson}55`, color: C.crimson, padding: "8px 12px", borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{message}</div>;
}

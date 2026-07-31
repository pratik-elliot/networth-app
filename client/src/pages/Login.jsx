import React, { useState } from "react";
import { Coins } from "lucide-react";
import { C, SERIF, SANS } from "../theme";
import { TInput, Btn, ErrorBanner } from "../components/ui";
import { api, saveToken } from "../api";

export default function Login({ onLoggedIn }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = mode === "register"
        ? await api.register(email, password, phone)
        : await api.login(email, password);
      saveToken(res.token);
      onLoggedIn();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: SANS }}>
      <div style={{ width: 340 }}>
        <div className="flex items-center gap-2 justify-center mb-1">
          <Coins size={22} color={C.gold} />
          <span style={{ fontFamily: SERIF, fontSize: 22, color: C.ivory }}>Net Worth Ledger</span>
        </div>
        <p style={{ textAlign: "center", color: C.ivoryDim, fontSize: 12.5, marginBottom: 18 }}>
          {mode === "register" ? "Create your account" : "Sign in with your email and password"}
        </p>

        <ErrorBanner message={error} />

        <form onSubmit={submitCredentials}>
            <TInput type="email" required placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={{ marginBottom: 10 }} />
            <TInput type="password" required placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={{ marginBottom: 10 }} />
            {mode === "register" && (
              <TInput placeholder="Phone (optional)" value={phone} onChange={e => setPhone(e.target.value)} style={{ marginBottom: 10 }} />
            )}
            <Btn type="submit" disabled={busy} className="w-full justify-center" style={{ width: "100%", justifyContent: "center" }}>
              {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
            </Btn>
            <div style={{ textAlign: "center", marginTop: 14, fontSize: 12.5, color: C.ivoryDim }}>
              {mode === "login" ? (
                <>New here? <button type="button" onClick={() => setMode("register")} style={{ color: C.gold }}>Create an account</button></>
              ) : (
                <>Already have an account? <button type="button" onClick={() => setMode("login")} style={{ color: C.gold }}>Sign in</button></>
              )}
            </div>
          </form>
      </div>
    </div>
  );
}

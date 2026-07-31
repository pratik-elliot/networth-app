import React, { useEffect, useState, useCallback } from "react";
import { Coins, Plus } from "lucide-react";
import { C, SERIF, SANS } from "./theme";
import { api, getToken, clearToken } from "./api";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import AccountsList from "./pages/AccountsList";
import AccountDetail from "./pages/AccountDetail";
import Reports from "./pages/Reports";
import SettingsPanel from "./pages/Settings";
import AccountForm from "./components/AccountForm";
import { TransactionForm, BalanceForm, ValueUpdateForm } from "./components/SmallForms";
import { Btn } from "./components/ui";

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Accounts" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [me, setMe] = useState(null);

  const [accounts, setAccounts] = useState([]);
  const [txByAccount, setTxByAccount] = useState({});
  const [balByAccount, setBalByAccount] = useState({});
  const [loadingData, setLoadingData] = useState(true);

  const [tab, setTab] = useState("dashboard");
  const [selectedId, setSelectedId] = useState(null);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [showTxnForm, setShowTxnForm] = useState(false);
  const [showBalanceForm, setShowBalanceForm] = useState(false);
  const [showValueForm, setShowValueForm] = useState(false);

  const checkAuth = useCallback(async () => {
    if (!getToken()) { setAuthChecked(true); return; }
    try { const user = await api.me(); setMe(user); }
    catch (e) { clearToken(); }
    setAuthChecked(true);
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const loadAll = useCallback(async () => {
    setLoadingData(true);
    const list = await api.listAccounts();
    setAccounts(list);
    const txMap = {}, balMap = {};
    await Promise.all(list.map(async (a) => {
      const [tx, bal] = await Promise.all([api.listTransactions(a.id), api.listBalances(a.id)]);
      txMap[a.id] = tx; balMap[a.id] = bal;
    }));
    setTxByAccount(txMap); setBalByAccount(balMap);
    setLoadingData(false);
  }, []);

  useEffect(() => { if (me) loadAll(); }, [me, loadAll]);

  const refreshAccount = async (id) => {
    const [acc, tx, bal] = await Promise.all([api.listAccounts(), api.listTransactions(id), api.listBalances(id)]);
    setAccounts(acc);
    setTxByAccount(p => ({ ...p, [id]: tx }));
    setBalByAccount(p => ({ ...p, [id]: bal }));
  };

  const saveAccount = async (a) => {
    if (a.id) await api.updateAccount(a.id, a);
    else await api.createAccount(a);
    setShowAccountForm(false); setEditingAccount(null);
    await loadAll();
  };

  const deleteAccount = async (id) => {
    await api.deleteAccount(id);
    if (selectedId === id) setSelectedId(null);
    await loadAll();
  };

  if (!authChecked) return <ScreenMsg text="Loading…" />;
  if (!me) return <Login onLoggedIn={checkAuth} />;
  if (loadingData) return <ScreenMsg text="Loading your accounts…" />;

  const selectedAccount = accounts.find(a => a.id === selectedId);

  return (
    <div style={{ minHeight: "100vh", background: C.ink, fontFamily: SANS }}>
      <div style={{ borderBottom: `1px solid ${C.hair}`, padding: "16px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="flex items-center gap-2">
          <Coins size={20} color={C.gold} />
          <span style={{ fontFamily: SERIF, fontSize: 20, color: C.ivory, letterSpacing: "0.02em" }}>Net Worth Ledger</span>
        </div>
        <div className="flex gap-1">
          {NAV.map(n => (
            <button key={n.id} onClick={() => { setTab(n.id); setSelectedId(null); }}
              style={{ padding: "7px 14px", borderRadius: 6, fontSize: 13.5, color: tab === n.id ? C.ink : C.ivoryDim, background: tab === n.id ? C.gold : "transparent" }}>
              {n.label}
            </button>
          ))}
        </div>
        {tab === "accounts" && !selectedId && (
          <Btn onClick={() => { setEditingAccount(null); setShowAccountForm(true); }}><Plus size={14} />Add Account</Btn>
        )}
      </div>

      <div style={{ padding: "24px 28px" }}>
        {tab === "dashboard" && <Dashboard accounts={accounts} txByAccount={txByAccount} balByAccount={balByAccount} fxRate={me.fxRate} />}

        {tab === "accounts" && !selectedId && (
          <AccountsList
            accounts={accounts} txByAccount={txByAccount} balByAccount={balByAccount}
            onEdit={(a) => { setEditingAccount(a); setShowAccountForm(true); }}
            onDelete={deleteAccount}
            onOpen={setSelectedId}
          />
        )}

        {tab === "accounts" && selectedId && selectedAccount && (
          <AccountDetail
            account={selectedAccount} txByAccount={txByAccount} balByAccount={balByAccount}
            onBack={() => setSelectedId(null)}
            onAddTxn={() => setShowTxnForm(true)}
            onAddBalance={() => setShowBalanceForm(true)}
            onUpdateValue={() => setShowValueForm(true)}
            onEdit={() => { setEditingAccount(selectedAccount); setShowAccountForm(true); }}
            onImagesChanged={() => refreshAccount(selectedId)}
          />
        )}

        {tab === "reports" && <Reports accounts={accounts} txByAccount={txByAccount} balByAccount={balByAccount} />}
        {tab === "settings" && (
          <SettingsPanel me={me} onSaved={setMe} onLogout={() => { clearToken(); setMe(null); }} />
        )}
      </div>

      {showAccountForm && (
        <AccountForm initial={editingAccount} onSave={saveAccount} onClose={() => { setShowAccountForm(false); setEditingAccount(null); }} />
      )}
      {showTxnForm && selectedAccount && (
        <TransactionForm account={selectedAccount} onClose={() => setShowTxnForm(false)}
          onSave={async (t) => { await api.createTransaction({ accountId: selectedAccount.id, ...t }); setShowTxnForm(false); await refreshAccount(selectedAccount.id); }} />
      )}
      {showBalanceForm && selectedAccount && (
        <BalanceForm account={selectedAccount} onClose={() => setShowBalanceForm(false)}
          onSave={async (b) => { await api.createBalance({ accountId: selectedAccount.id, ...b }); setShowBalanceForm(false); await refreshAccount(selectedAccount.id); }} />
      )}
      {showValueForm && selectedAccount && (
        <ValueUpdateForm account={selectedAccount} onClose={() => setShowValueForm(false)}
          onSave={async (v) => { await api.updateValue(selectedAccount.id, v); setShowValueForm(false); await refreshAccount(selectedAccount.id); }} />
      )}
    </div>
  );
}

function ScreenMsg({ text }) {
  return <div style={{ minHeight: "100vh", background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", color: C.ivoryDim, fontFamily: SANS }}>{text}</div>;
}

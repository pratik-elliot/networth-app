import { Landmark, Wallet, TrendingUp, Package, Home, Car, Coins, Gem, PiggyBank } from "lucide-react";

export const C = {
  ink: "#10151F", ledger: "#141B29", panel: "#1B2434", panelHi: "#232E42",
  hair: "#2E3A52", ivory: "#F4EFE4", ivoryDim: "#B9BDC6",
  gold: "#C9A24B", goldDim: "#8A7239", teal: "#3E8E7E", crimson: "#C4574B", amber: "#D6A445",
};
export const SERIF = "'Iowan Old Style', 'Palatino Linotype', Georgia, serif";
export const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
export const MONO = "'SF Mono', 'Courier New', monospace";

export const ACCOUNT_TYPES = [
  { id: "bank", label: "Bank Account", icon: Landmark, liquid: true },
  { id: "cash", label: "Cash", icon: Wallet, liquid: true },
  { id: "investment", label: "Investment / Stock", icon: TrendingUp, liquid: true },
  { id: "locker", label: "Locker", icon: Package, liquid: false },
  { id: "real_estate", label: "Real Estate (Land/House/Apt)", icon: Home, liquid: false },
  { id: "automobile", label: "Automobile", icon: Car, liquid: false },
  { id: "gold", label: "Gold", icon: Coins, liquid: false },
  { id: "silver", label: "Silver", icon: Coins, liquid: false },
  { id: "jewelry", label: "Jewelry", icon: Gem, liquid: false },
  { id: "other", label: "Other", icon: PiggyBank, liquid: false },
];
export const typeInfo = (id) => ACCOUNT_TYPES.find(t => t.id === id) || ACCOUNT_TYPES[ACCOUNT_TYPES.length - 1];
export const CURRENCIES = ["USD", "INR"];
export const CURRENCY_SYMBOL = { USD: "$", INR: "\u20B9" };
export const INTEREST_FREQ = ["None", "Monthly", "Quarterly", "Annually"];
export const RELATIONS = ["Spouse", "Child", "Parent", "Sibling", "Other"];

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

export function fmt(amount, currency) {
  const n = Number(amount) || 0;
  const sym = CURRENCY_SYMBOL[currency] || "";
  return sym + n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 0 });
}

export const PHYSICAL_TYPES = ["gold", "silver", "jewelry", "automobile", "real_estate"];

/* An account's value follows the standard anchor model: the most recently
   logged balance, plus any transactions dated strictly after it. Transactions
   on or before the anchor are already reflected in it -- a July closing balance
   already contains every July transaction -- so adding them would double-count.

   Returns null when a non-physical account has no anchor. That is deliberately
   not 0: zero asserts the account is empty, null says we do not know, and only
   one of those is true. Callers must handle null before formatting, because
   fmt() turns null into "0". */
export function latestValue(account, balanceLogsByAccount, txByAccount) {
  if (PHYSICAL_TYPES.includes(account.type)) return Number(account.currentValue) || 0;

  const logs = (balanceLogsByAccount || {})[account.id] || [];
  if (!logs.length) return null;

  const anchor = [...logs].sort((a, b) => b.date.localeCompare(a.date))[0];
  const base = Number(anchor.balance) || 0;

  const later = ((txByAccount || {})[account.id] || []).filter(t => t.date > anchor.date);
  const delta = later.reduce((sum, t) => {
    const amt = Number(t.amount) || 0;
    return sum + (t.type === "credit" ? amt : -amt);
  }, 0);

  return base + delta;
}

export function lastActivityDate(account, txByAccount, balByAccount) {
  const dates = [];
  if (account.valueDate) dates.push(account.valueDate);
  (txByAccount[account.id] || []).forEach(t => dates.push(t.date));
  (balByAccount[account.id] || []).forEach(b => dates.push(b.date));
  if (!dates.length) return account.createdDate;
  return dates.sort().slice(-1)[0];
}

export function isStale(account, txByAccount, balByAccount) {
  const last = lastActivityDate(account, txByAccount, balByAccount);
  if (!last) return true;
  return daysBetween(last, todayStr()) > 90;
}

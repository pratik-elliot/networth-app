// Guarded because Vite always provides import.meta.env, but plain `node --test`
// (used for the framework-free unit tests) does not -- without the guard,
// merely importing this module outside Vite would throw before any test ran.
const BASE = (import.meta.env && import.meta.env.VITE_API_URL) || ""; // "" = same origin, proxied in dev

function authHeaders() {
  const token = localStorage.getItem("nwl_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function handle(res) {
  if (!res.ok) {
    let msg = "Request failed.";
    let code;
    try {
      const d = await res.json();
      msg = d.error || msg;
      code = d.code;
    } catch (e) {}
    const err = new Error(msg);
    // Callers branch on this — e.g. the statement importer prompts for a
    // password when the server reports PASSWORD_REQUIRED.
    if (code) err.code = code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  register: (email, password, phone) =>
    fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, phone }) }).then(handle),
  login: (email, password) =>
    fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }).then(handle),
  me: () => fetch(`${BASE}/api/auth/me`, { headers: authHeaders() }).then(handle),
  updateMe: (data) => fetch(`${BASE}/api/auth/me`, { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(data) }).then(handle),

  listAccounts: () => fetch(`${BASE}/api/accounts`, { headers: authHeaders() }).then(handle),
  createAccount: (a) => fetch(`${BASE}/api/accounts`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(a) }).then(handle),
  updateAccount: (id, a) => fetch(`${BASE}/api/accounts/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(a) }).then(handle),
  deleteAccount: (id) => fetch(`${BASE}/api/accounts/${id}`, { method: "DELETE", headers: authHeaders() }).then(handle),
  updateValue: (id, v) => fetch(`${BASE}/api/accounts/${id}/update-value`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(v) }).then(handle),

  listTransactions: (accountId) => fetch(`${BASE}/api/transactions/account/${accountId}`, { headers: authHeaders() }).then(handle),
  createTransaction: (t) => fetch(`${BASE}/api/transactions`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(t) }).then(handle),
  deleteTransaction: (id) => fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() }).then(handle),

  listBalances: (accountId) => fetch(`${BASE}/api/balances/account/${accountId}`, { headers: authHeaders() }).then(handle),
  createBalance: (b) => fetch(`${BASE}/api/balances`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(b) }).then(handle),
  deleteBalance: (id) => fetch(`${BASE}/api/balances/${id}`, { method: "DELETE", headers: authHeaders() }).then(handle),

  uploadFiles: (accountId, files) => {
    const fd = new FormData();
    Array.from(files).forEach(f => fd.append("images", f));
    return fetch(`${BASE}/api/attachments/account/${accountId}`, { method: "POST", headers: authHeaders(), body: fd }).then(handle);
  },
  deleteFile: (id) => fetch(`${BASE}/api/attachments/${id}`, { method: "DELETE", headers: authHeaders() }).then(handle),

  fetchAttachment: async (id) => {
    const res = await fetch(`${BASE}/api/attachments/${id}`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Could not load that file.");
    return URL.createObjectURL(await res.blob());
  },

  statementStatus: () => fetch(`${BASE}/api/statements/status`, { headers: authHeaders() }).then(handle),
  parseStatement: (accountId, file, password) => {
    const fd = new FormData();
    // Ordering of the parts doesn't matter: multer populates req.body from
    // each field part as busboy emits it and only resolves once the whole
    // stream finishes, so the password is present by the time the handler
    // runs regardless of whether it's appended before or after the file.
    if (password) fd.append("password", password);
    fd.append("statement", file);
    return fetch(`${BASE}/api/statements/parse/${accountId}`, { method: "POST", headers: authHeaders(), body: fd }).then(handle);
  },
  bulkCreateTransactions: (accountId, rows) =>
    fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ accountId, rows }),
    }).then(handle),

  exportAll: () => fetch(`${BASE}/api/export`, { headers: authHeaders() }).then(handle),
};

export function saveToken(token) { localStorage.setItem("nwl_token", token); }
export function clearToken() { localStorage.removeItem("nwl_token"); }
export function getToken() { return localStorage.getItem("nwl_token"); }

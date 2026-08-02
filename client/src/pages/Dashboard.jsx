import React, { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { C, SERIF, CURRENCIES, typeInfo, fmt, latestValue, isStale } from "../theme";
import { StaleBadge, EmptyNote } from "../components/ui";

export default function Dashboard({ accounts, txByAccount, balByAccount, fxRate }) {
  const byCurrency = useMemo(() => {
    const res = { USD: { total: 0, liquid: 0, nonLiquid: 0 }, INR: { total: 0, liquid: 0, nonLiquid: 0 } };
    accounts.forEach(a => {
      const val = latestValue(a, balByAccount, txByAccount);
      // An account with no balance anchor is unknown, not empty. Adding 0 would
      // quietly understate net worth and look like a confident answer.
      if (val === null) return;
      const liquid = a.isLiquid === null || a.isLiquid === undefined ? typeInfo(a.type).liquid : a.isLiquid;
      res[a.currency].total += val;
      if (liquid) res[a.currency].liquid += val; else res[a.currency].nonLiquid += val;
    });
    return res;
  }, [accounts, balByAccount, txByAccount]);

  const unvaluedCount = useMemo(
    () => accounts.filter(a => latestValue(a, balByAccount, txByAccount) === null).length,
    [accounts, balByAccount, txByAccount]
  );

  const combinedUSD = byCurrency.USD.total + byCurrency.INR.total / (fxRate || 83);

  const byType = useMemo(() => {
    const map = {};
    accounts.forEach(a => {
      const val = latestValue(a, balByAccount, txByAccount);
      if (val === null) return;
      const valUSD = a.currency === "INR" ? val / (fxRate || 83) : val;
      map[a.type] = (map[a.type] || 0) + valUSD;
    });
    return Object.entries(map).map(([type, value]) => ({ name: typeInfo(type).label, value: Math.round(value) }));
  }, [accounts, balByAccount, txByAccount, fxRate]);

  const barData = [
    { name: "USD accounts", Liquid: byCurrency.USD.liquid, "Non-liquid": byCurrency.USD.nonLiquid },
    { name: "INR accounts", Liquid: byCurrency.INR.liquid, "Non-liquid": byCurrency.INR.nonLiquid },
  ];

  const staleAccounts = accounts.filter(a => isStale(a, txByAccount, balByAccount));
  const PIE_COLORS = [C.gold, C.teal, C.amber, C.crimson, "#7C8CA6", "#9C7BB0", "#5B8DB8", "#B0895A"];

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 18 }}>
          <div style={{ color: C.ivoryDim, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Combined Net Worth (est., ~USD)</div>
          <div style={{ fontFamily: SERIF, fontSize: 32, color: C.gold, marginTop: 4 }}>{fmt(combinedUSD, "USD")}</div>
          <div style={{ color: C.ivoryDim, fontSize: 11, marginTop: 4 }}>Using FX rate 1 USD = {fxRate} INR (set in Settings)</div>
          {unvaluedCount > 0 && (
            <div style={{ color: C.amber, fontSize: 12, marginTop: 6 }}>
              {unvaluedCount} account{unvaluedCount === 1 ? "" : "s"} excluded — no balance logged yet.
            </div>
          )}
        </div>
        {CURRENCIES.map(cur => (
          <div key={cur} style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 18 }}>
            <div style={{ color: C.ivoryDim, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Net Worth — {cur}</div>
            <div style={{ fontFamily: SERIF, fontSize: 28, color: C.ivory, marginTop: 4 }}>{fmt(byCurrency[cur].total, cur)}</div>
            <div className="flex gap-4 mt-2" style={{ fontSize: 12.5 }}>
              <div><span style={{ color: C.teal }}>●</span> Liquid: <b style={{ color: C.ivory }}>{fmt(byCurrency[cur].liquid, cur)}</b></div>
              <div><span style={{ color: C.crimson }}>●</span> Non-liquid: <b style={{ color: C.ivory }}>{fmt(byCurrency[cur].nonLiquid, cur)}</b></div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 18, height: 300 }}>
          <div style={{ color: C.ivory, fontFamily: SERIF, fontSize: 16, marginBottom: 8 }}>Allocation by Account Type</div>
          {byType.length ? (
            <ResponsiveContainer width="100%" height="88%">
              <PieChart>
                <Pie data={byType} dataKey="value" nameKey="name" innerRadius={45} outerRadius={85} paddingAngle={2}>
                  {byType.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: C.panelHi, border: `1px solid ${C.hair}`, color: C.ivory }} formatter={(v) => fmt(v, "USD")} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.ivoryDim }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <EmptyNote text="Add accounts to see allocation." />}
        </div>
        <div style={{ background: C.panel, border: `1px solid ${C.hair}`, borderRadius: 10, padding: 18, height: 300 }}>
          <div style={{ color: C.ivory, fontFamily: SERIF, fontSize: 16, marginBottom: 8 }}>Liquid vs Non-liquid by Currency</div>
          {accounts.length ? (
            <ResponsiveContainer width="100%" height="88%">
              <BarChart data={barData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.hair} />
                <XAxis dataKey="name" stroke={C.ivoryDim} fontSize={12} />
                <YAxis stroke={C.ivoryDim} fontSize={12} />
                <Tooltip contentStyle={{ background: C.panelHi, border: `1px solid ${C.hair}`, color: C.ivory }} />
                <Legend wrapperStyle={{ fontSize: 11, color: C.ivoryDim }} />
                <Bar dataKey="Liquid" fill={C.teal} radius={[4, 4, 0, 0]} />
                <Bar dataKey="Non-liquid" fill={C.crimson} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyNote text="Add accounts to see the breakdown." />}
        </div>
      </div>

      {staleAccounts.length > 0 && (
        <div style={{ background: C.panel, border: `1px solid ${C.crimson}55`, borderRadius: 10, padding: 16 }}>
          <div className="flex items-center gap-2 mb-2" style={{ color: C.crimson, fontFamily: SERIF, fontSize: 15 }}>
            <AlertTriangle size={16} /> {staleAccounts.length} account(s) not updated in over 90 days
          </div>
          <div className="flex flex-wrap gap-2">
            {staleAccounts.map(a => <span key={a.id} style={{ fontSize: 12.5, color: C.ivory, background: C.panelHi, padding: "4px 10px", borderRadius: 20 }}>{a.name}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

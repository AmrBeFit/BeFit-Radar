/* =====================================================================
   LeaveReport - leave balances and the leave report.
   Everyone except the CEO has a yearly leave balance (default 3 days). It lives on the server in a collection the
   browser cannot read, and this screen gets the numbers through the getLeaveBalances function, which only answers
   System Admin / HR (everyone), Branch Managers (their branches) and Fitness Managers (the Coaches of their branches).
   The person asking for leave never sees their own balance.
   Only System Admin and HR can change a balance (setLeaveBalance).
   Days are counted per calendar day (weekends included) inside one calendar year.
   ===================================================================== */
import React, { useEffect, useMemo, useState } from 'react';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { roleLabel } from './permissions';

const field = 'w-full p-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-900';

export default function LeaveReport({ canEdit = false, hideUser = () => false }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState([]);
  const [defaultBalance, setDefaultBalance] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState({}); // userId -> text being typed
  const [savingId, setSavingId] = useState('');
  const [openId, setOpenId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [bulk, setBulk] = useState('');        // the number typed in the "for everyone" box
  const [resetCustom, setResetCustom] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    httpsCallable(functions, 'getLeaveBalances')({ year })
      .then((res) => {
        if (cancelled) return;
        setRows(res.data.rows || []);
        setDefaultBalance(res.data.defaultBalance ?? 3);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the leave report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [year, reloadKey]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !hideUser(r))
      .filter((r) => !q || r.username.toLowerCase().includes(q) || (r.branches || []).join(' ').toLowerCase().includes(q));
  }, [rows, search, hideUser]);

  const saveBalance = async (r) => {
    const text = (drafts[r.userId] ?? '').trim();
    const value = parseInt(text, 10);
    if (!/^[0-9]{1,3}$/.test(text) || value > 365) return alert('Enter a whole number of days (0 to 365).');
    setSavingId(r.userId);
    try {
      await httpsCallable(functions, 'setLeaveBalance')({ targetUserId: r.userId, balance: value });
      setDrafts((d) => { const n = { ...d }; delete n[r.userId]; return n; });
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.message || 'Could not save the balance.');
    } finally {
      setSavingId('');
    }
  };

  const applyToEveryone = async () => {
    const text = (bulk === '' ? String(defaultBalance) : bulk).trim();
    const value = parseInt(text, 10);
    if (!/^[0-9]{1,3}$/.test(text) || value > 365) return alert('Enter a whole number of days (0 to 365).');
    const customCount = rows.filter((r) => r.custom).length;
    const msg = resetCustom
      ? `Give EVERY employee ${value} days?\n\nThis also replaces the ${customCount} balance(s) you set one by one.`
      : `Give every employee ${value} days?\n\nThe ${customCount} balance(s) you set one by one stay as they are.`;
    if (!window.confirm(msg)) return;
    setApplying(true);
    try {
      await httpsCallable(functions, 'setDefaultLeaveBalance')({ balance: value, resetCustom });
      setBulk('');
      setReloadKey((k) => k + 1);
    } catch (err) {
      alert(err.message || 'Could not apply the balance.');
    } finally {
      setApplying(false);
    }
  };

  const exportCsv = () => {
    const head = ['Username', 'Role', 'Branches', 'Balance', 'Taken (approved)', 'Waiting', 'Remaining'];
    const lines = shown.map((r) => [r.username, roleLabel(r.role), (r.branches || []).join(' / '), r.balance, r.taken, r.waiting, r.remaining]);
    const csv = [head, ...lines].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `leave-report-${year}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="max-w-3xl mx-auto bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-lg font-black text-slate-900">📊 Leave balances &amp; report</h2>
        <div className="flex items-center gap-2">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="p-2 bg-white border border-slate-200 rounded-xl text-xs font-bold">
            {[thisYear, thisYear - 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={exportCsv} disabled={shown.length === 0} className="px-3 py-2 rounded-xl text-xs font-black bg-slate-100 hover:bg-slate-200 text-slate-700 border-0 cursor-pointer disabled:opacity-50">
            ⬇️ Excel (CSV)
          </button>
        </div>
      </div>
      <p className="text-[11px] text-slate-500">
        Every account (except the CEO) has a yearly leave balance - {defaultBalance} days unless changed. A request cannot take a person past it.
        {canEdit ? ' You can change a balance here.' : ' Only a System Admin or HR can change a balance.'} The employee never sees these numbers.
      </p>
      {canEdit && (
        <div className="border border-indigo-200 bg-indigo-50/50 rounded-2xl p-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Leave days for everyone</label>
            <input
              type="text" inputMode="numeric" value={bulk} placeholder={String(defaultBalance)}
              onChange={(e) => setBulk(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              className="w-24 p-2 border border-slate-200 rounded-xl text-sm font-mono font-black text-center bg-white text-slate-900"
            />
          </div>
          <button type="button" onClick={applyToEveryone} disabled={applying} className="px-4 py-2.5 rounded-xl text-xs font-black text-white border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#4f46e5' }}>
            {applying ? 'Applying...' : '✅ Apply to everyone'}
          </button>
          <label className="flex items-center gap-2 text-[11px] font-bold text-slate-600 pb-2 cursor-pointer">
            <input type="checkbox" checked={resetCustom} onChange={(e) => setResetCustom(e.target.checked)} />
            Also replace the balances I set one by one
          </label>
          <p className="basis-full text-[10px] text-slate-500">
            Today's default: <b>{defaultBalance}</b> days. Everyone without a personal number follows it (new accounts too). After that, change any person below and press Save - a person with their own number is marked <b>custom</b>.
          </p>
        </div>
      )}
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a name or branch..." className={field} />

      {loading && <p className="text-xs text-slate-400 italic">Loading...</p>}
      {error && <p className="text-xs text-rose-600 font-bold">{error}</p>}

      {!loading && !error && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 border-b">
                <th className="py-2 pr-2">Employee</th>
                <th className="py-2 pr-2">Balance</th>
                <th className="py-2 pr-2">Taken</th>
                <th className="py-2 pr-2">Waiting</th>
                <th className="py-2 pr-2">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-slate-400 italic">No employees to show.</td></tr>
              )}
              {shown.map((r) => {
                const typed = drafts[r.userId];
                const changed = typed !== undefined && typed !== String(r.balance);
                return (
                  <React.Fragment key={r.userId}>
                    <tr className="border-b border-slate-100 align-middle">
                      <td className="py-2 pr-2">
                        <button type="button" onClick={() => setOpenId(openId === r.userId ? '' : r.userId)} className="text-left bg-transparent border-0 cursor-pointer p-0">
                          <span className="font-black text-slate-800">{r.username}</span>
                          <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 text-[10px] font-extrabold">{roleLabel(r.role)}</span>
                          {r.custom && <span className="ml-1.5 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-extrabold">custom</span>}
                          <span className="block text-[10px] text-slate-400">{(r.branches || []).join(' / ') || '-'}</span>
                        </button>
                      </td>
                      <td className="py-2 pr-2">
                        {canEdit ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="text" inputMode="numeric" value={typed ?? String(r.balance)}
                              onChange={(e) => setDrafts((d) => ({ ...d, [r.userId]: e.target.value.replace(/[^0-9]/g, '').slice(0, 3) }))}
                              className="w-14 p-1.5 border border-slate-200 rounded-lg text-xs font-mono font-bold text-center"
                            />
                            {changed && (
                              <button type="button" disabled={savingId === r.userId} onClick={() => saveBalance(r)}
                                className="px-2 py-1 rounded-lg text-[10px] font-black bg-emerald-600 text-white border-0 cursor-pointer">
                                {savingId === r.userId ? '...' : 'Save'}
                              </button>
                            )}
                          </div>
                        ) : <span className="font-mono font-bold">{r.balance}</span>}
                      </td>
                      <td className="py-2 pr-2 font-mono font-bold">{r.taken}</td>
                      <td className="py-2 pr-2 font-mono font-bold text-amber-700">{r.waiting}</td>
                      <td className="py-2 pr-2 font-mono font-black" style={{ color: r.remaining <= 0 ? '#e11d48' : '#059669' }}>{r.remaining}</td>
                    </tr>
                    {openId === r.userId && (
                      <tr className="bg-slate-50">
                        <td colSpan={5} className="py-2 px-3 text-[11px] text-slate-600">
                          {(r.leaves || []).length === 0 ? 'No leave requests in this year.' : (
                            <ul className="space-y-0.5">
                              {r.leaves.map((l) => (
                                <li key={l.id}>{l.startDate} → {l.endDate} · {l.days} day{l.days > 1 ? 's' : ''} · <span className="font-bold">{l.status}</span>{l.branch ? ` · ${l.branch}` : ''}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

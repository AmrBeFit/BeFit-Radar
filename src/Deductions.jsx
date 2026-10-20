/* =====================================================================
   Deductions - salary deductions AND salary bonuses (same screen, same rules; a bonus is added to the salary).
   Everything goes through Cloud Functions (createDeduction / getDeductions / cancelDeduction); the browser never reads the
   collection itself. A deduction is an AMOUNT (EGP) or a number of DAYS of salary, chosen by whoever records it.
   It can be cancelled only within 24 hours of recording; after that nobody can undo it.
   Everybody sees their own deductions; whoever may record them sees those of their branches; "See all" sees everything.
   ===================================================================== */
import React, { useEffect, useMemo, useState } from 'react';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { roleLabel } from './permissions';

const field = 'w-full p-2.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-900';
const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sign = (r) => (r.type === 'bonus' ? '+' : '−');
const fmtValue = (r) => (r.kind === 'days' ? `${r.value} day${Number(r.value) === 1 ? '' : 's'}` : `${Number(r.value).toLocaleString()} EGP`);

export default function Deductions({ hideUser = () => false }) {
  const [month, setMonth] = useState(todayYmd().slice(0, 7));
  const [allTime, setAllTime] = useState(false);
  const [data, setData] = useState({ rows: [], employees: [], canGive: false, canViewAll: false, categories: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [mode, setMode] = useState('deduction'); // what the open form records
  const [typeFilter, setTypeFilter] = useState('all');
  const emptyForm = { targetUserId: '', kind: 'amount', value: '', category: 'Late', reason: '', date: todayYmd() };
  const [form, setForm] = useState(emptyForm);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    httpsCallable(functions, 'getDeductions')({ month: allTime ? '' : month })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load the deductions.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, allTime, reload]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data.rows || [])
      .filter((r) => !hideUser(r))
      .filter((r) => typeFilter === 'all' || r.type === typeFilter)
      .filter((r) => !q || (r.username || '').toLowerCase().includes(q) || (r.reason || '').toLowerCase().includes(q) || (r.branches || []).join(' ').toLowerCase().includes(q));
  }, [data.rows, search, hideUser, typeFilter]);

  const totals = useMemo(() => {
    const t = { amount: 0, days: 0, bonusAmount: 0, bonusDays: 0 };
    shown.filter((r) => r.status === 'Active').forEach((r) => {
      const v = Number(r.value) || 0;
      if (r.type === 'bonus') { if (r.kind === 'days') t.bonusDays += v; else t.bonusAmount += v; }
      else if (r.kind === 'days') t.days += v; else t.amount += v;
    });
    return t;
  }, [shown]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.targetUserId) return alert('Please choose the employee.');
    const v = Number(form.value);
    if (!(v > 0)) return alert(form.kind === 'days' ? 'Enter the number of days.' : 'Enter the amount.');
    if (form.reason.trim().length < 3) return alert('Please write the reason.');
    const who = (data.employees || []).find((x) => x.id === form.targetUserId);
    if (!window.confirm(`Record a ${mode === 'bonus' ? 'BONUS' : 'deduction'} of ${form.kind === 'days' ? `${v} day(s)` : `${v} EGP`} ${mode === 'bonus' ? 'for' : 'on'} ${who ? who.username : 'this employee'}?\n\nIt can only be cancelled within 24 hours. After that it is final.`)) return;
    setSaving(true);
    try {
      await httpsCallable(functions, 'createDeduction')({ ...form, value: v, type: mode });
      setForm(emptyForm); setOpen(false); setReload((k) => k + 1);
    } catch (err) {
      alert(err.message || 'Could not record the deduction.');
    } finally { setSaving(false); }
  };

  const cancel = async (r) => {
    if (!window.confirm(`Cancel this ${r.type === 'bonus' ? 'bonus' : 'deduction'} (${fmtValue(r)} ${r.type === 'bonus' ? 'for' : 'on'} ${r.username})? ${data.isAdmin ? '' : 'Cancelling is only possible within 24 hours of recording it.'}`)) return;
    setBusyId(r.id);
    try { await httpsCallable(functions, 'cancelDeduction')({ id: r.id }); setReload((k) => k + 1); }
    catch (err) { alert(err.message || 'Could not cancel.'); }
    finally { setBusyId(''); }
  };

  const removeOne = async (r) => {
    if (!window.confirm(`DELETE this record permanently?\n\n${r.username}: ${fmtValue(r)} (${r.status})\n\nThis erases it from the history and cannot be undone.`)) return;
    setBusyId(r.id);
    try { await httpsCallable(functions, 'deleteDeductions')({ id: r.id }); setReload((k) => k + 1); }
    catch (err) { alert(err.message || 'Could not delete.'); }
    finally { setBusyId(''); }
  };

  const clearCancelled = async () => {
    if (!window.confirm(`Delete ALL cancelled deductions ${allTime ? 'of all time' : `of ${month}`} permanently? This cannot be undone.`)) return;
    setSaving(true);
    try {
      const res = await httpsCallable(functions, 'deleteDeductions')({ cancelledOnly: true, month: allTime ? '' : month });
      alert(`${res.data.deleted} record(s) deleted.`);
      setReload((k) => k + 1);
    } catch (err) { alert(err.message || 'Could not delete.'); }
    finally { setSaving(false); }
  };

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date', 'Employee', 'Role', 'Branches', 'Type', 'Value', 'Unit', 'Category', 'Reason', 'Recorded by', 'Status', 'Kind'].map(esc).join(',')];
    shown.forEach((r) => lines.push([r.date, r.username, r.role, (r.branches || []).join(' / '), r.kind === 'days' ? 'Days' : 'Amount', r.value, r.kind === 'days' ? 'days' : 'EGP', r.category, r.reason, r.createdBy, r.status, r.type === 'bonus' ? 'Bonus' : 'Deduction'].map(esc).join(',')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Salary_Deductions_Bonuses_${allTime ? 'all' : month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const canRecord = data.canGive || data.canGiveBonus;
  const mineOnly = !canRecord && !data.canViewAll && (data.rows || []).every((r) => r.mine);
  if (!loading && !error && mineOnly && shown.length === 0 && !canRecord) return null; // a plain employee with nothing recorded sees nothing

  return (
    <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-4 mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-slate-900">💸 {mineOnly ? 'My salary deductions & bonuses' : 'Salary deductions & bonuses'}</h3>
          <p className="text-[11px] text-slate-500">An amount in EGP or a number of days; a bonus is added to the salary. Can be cancelled only within 24 hours; after that it is final (only the System Admin can still cancel it).</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input type="month" value={month} disabled={allTime} onChange={(e) => setMonth(e.target.value)} className="bg-white border p-1.5 rounded-lg font-semibold text-slate-700 disabled:opacity-40" />
          <label className="flex items-center gap-1 font-bold text-slate-600 cursor-pointer"><input type="checkbox" checked={allTime} onChange={(e) => setAllTime(e.target.checked)} /> All time</label>
          {!mineOnly && <button type="button" onClick={exportCsv} disabled={shown.length === 0} className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-emerald-600 text-white border-0 cursor-pointer disabled:opacity-40">📥 CSV</button>}
          {data.isAdmin && shown.some((r) => r.status === 'Cancelled') && <button type="button" onClick={clearCancelled} disabled={saving} className="px-3 py-1.5 rounded-lg text-[11px] font-black bg-slate-700 text-white border-0 cursor-pointer disabled:opacity-40">🗑 Clear cancelled</button>}
          {data.canGive && <button type="button" onClick={() => { if (open && mode === 'deduction') { setOpen(false); } else { setMode('deduction'); setForm({ ...emptyForm, category: 'Late' }); setOpen(true); } }} className="px-3 py-1.5 rounded-lg text-[11px] font-black text-white border-0 cursor-pointer" style={{ backgroundColor: '#e11d48' }}>{open && mode === 'deduction' ? 'Close' : '➕ New deduction'}</button>}
          {data.canGiveBonus && <button type="button" onClick={() => { if (open && mode === 'bonus') { setOpen(false); } else { setMode('bonus'); setForm({ ...emptyForm, category: 'Performance' }); setOpen(true); } }} className="px-3 py-1.5 rounded-lg text-[11px] font-black text-white border-0 cursor-pointer" style={{ backgroundColor: '#059669' }}>{open && mode === 'bonus' ? 'Close' : '🎁 New bonus'}</button>}
        </div>
      </div>

      {open && ((mode === 'bonus' && data.canGiveBonus) || (mode === 'deduction' && data.canGive)) && (
        <form onSubmit={submit} className={`border rounded-2xl p-4 space-y-3 ${mode === 'bonus' ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/40'}`}>
          <p className="text-xs font-black" style={{ color: mode === 'bonus' ? '#047857' : '#be123c' }}>{mode === 'bonus' ? '🎁 New salary bonus' : '💸 New salary deduction'}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Employee</label>
              <select value={form.targetUserId} onChange={(e) => set('targetUserId', e.target.value)} className={field} required>
                <option value="">— Choose —</option>
                {(data.employees || []).filter((u) => !hideUser(u)).map((u) => <option key={u.id} value={u.id}>{u.username} ({roleLabel(u.role)}{u.branches && u.branches.length ? ` · ${u.branches.join(', ')}` : ''})</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Date</label>
              <input type="date" value={form.date} max={todayYmd()} onChange={(e) => set('date', e.target.value)} className={field} required />
            </div>
          </div>
          <div>
            <label className={label}>{mode === 'bonus' ? 'Bonus' : 'Deduct'}</label>
            <div className="flex flex-wrap gap-2 items-center">
              {[['amount', '💵 An amount (EGP)'], ['days', '📅 Days of salary']].map(([k, t]) => (
                <label key={k} className={`px-3 py-2 rounded-xl border text-xs font-bold cursor-pointer select-none transition-all ${form.kind === k ? (mode === 'bonus' ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-rose-600 text-white border-rose-700') : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'}`}>
                  <input type="radio" name="dkind" className="hidden" checked={form.kind === k} onChange={() => set('kind', k)} /> {t}
                </label>
              ))}
              <input type="number" min="0" step={form.kind === 'days' ? '0.25' : '0.01'} max={form.kind === 'days' ? 31 : 100000} value={form.value} onChange={(e) => set('value', e.target.value)}
                placeholder={form.kind === 'days' ? 'Number of days (e.g. 1, 0.5)' : 'Amount in EGP'} className={`${field} flex-1 min-w-[160px]`} required />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={label}>Category</label>
              <select value={form.category} onChange={(e) => set('category', e.target.value)} className={field}>
                {((mode === 'bonus' ? data.bonusCategories : data.categories) || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={label}>Reason</label>
              <input type="text" value={form.reason} maxLength={500} onChange={(e) => set('reason', e.target.value)} placeholder={mode === 'bonus' ? 'Why is this bonus given?' : 'Why is this deducted?'} className={field} required />
            </div>
          </div>
          <button type="submit" disabled={saving} className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer text-white disabled:opacity-50" style={{ backgroundColor: mode === 'bonus' ? '#059669' : '#e11d48' }}>{saving ? 'Saving...' : mode === 'bonus' ? 'Record bonus' : 'Record deduction'}</button>
        </form>
      )}

      {!mineOnly && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Employee, branch or reason..." className={`${field} max-w-xs`} />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${field} max-w-[170px]`}>
            <option value="all">Deductions &amp; bonuses</option><option value="deduction">Deductions only</option><option value="bonus">Bonuses only</option>
          </select>
          <span className="font-black" style={{ color: '#be123c' }}>Deductions: {totals.amount.toLocaleString()} EGP{totals.days ? ` + ${totals.days} day(s)` : ''}</span>
          <span className="font-black" style={{ color: '#047857' }}>Bonuses: {totals.bonusAmount.toLocaleString()} EGP{totals.bonusDays ? ` + ${totals.bonusDays} day(s)` : ''}</span>
        </div>
      )}

      {error && <p className="text-xs font-bold text-rose-700">{error}</p>}
      {loading ? <p className="text-xs text-slate-400">Loading...</p> : shown.length === 0 ? (
        <p className="text-xs text-slate-400 italic">Nothing recorded {allTime ? '' : 'in this month'}.</p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            <div key={r.id} className={`p-3 border rounded-xl text-xs flex flex-wrap items-center justify-between gap-2 transition-colors ${r.status === 'Cancelled' ? 'bg-slate-50 border-slate-200 opacity-60' : r.type === 'bonus' ? 'bg-white border-emerald-200' : 'bg-white border-rose-200'}`}>
              <div className="min-w-0 space-y-0.5">
                <p className="font-black text-slate-900">
                  {mineOnly ? '' : `${r.username} · `}<span style={{ color: r.type === 'bonus' ? '#047857' : '#be123c' }}>{sign(r)} {fmtValue(r)}</span>{r.type === 'bonus' && <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">🎁 Bonus</span>}
                  <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-100 text-slate-700">{r.category}</span>
                  {r.status === 'Cancelled' && <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-800">Cancelled{r.cancelledBy ? ` by ${r.cancelledBy}` : ''}</span>}
                </p>
                <p className="text-slate-500">{r.reason}</p>
                <p className="text-[10px] text-slate-400">{r.date}{!mineOnly && r.branches && r.branches.length ? ` · ${r.branches.join(', ')}` : ''}{r.createdBy ? ` · by ${r.createdBy}` : ''}</p>
              </div>
              {data.isAdmin && (
                <button type="button" disabled={busyId === r.id} onClick={() => removeOne(r)} title="System Admin only: delete from the history"
                  className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-rose-600 text-white border-0 cursor-pointer disabled:opacity-50">🗑 Delete</button>
              )}
              {r.canCancel && (
                <button type="button" disabled={busyId === r.id} onClick={() => cancel(r)} className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-amber-100 text-amber-800 border border-amber-300 cursor-pointer disabled:opacity-50">
                  {busyId === r.id ? '...' : data.isAdmin ? 'Cancel' : 'Cancel (within 24h)'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

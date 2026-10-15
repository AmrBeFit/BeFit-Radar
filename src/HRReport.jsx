/* =====================================================================
   HR Report - one place for HR: attendance (plan vs actual), lateness, leaves, penalties, salaries, the deduction rules,
   the payroll sheet (Excel, ready for the bank) and the payslips.
   All numbers are calculated on the SERVER (computePayroll) from the real attendance, schedule, leave and deduction records, using the
   rules HR sets in the Rules screen. Salaries and bank details live in collections the browser cannot read; this screen only gets them
   through callables that check the permissions tab_hrReport (view) and managePayroll (edit / release).
   ===================================================================== */
import React, { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { roleLabel } from './permissions';
import { printPayslips } from './payslipPrint';

const call = (name, data) => httpsCallable(functions, name)(data || {}).then((r) => r.data);
const field = 'w-full p-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-900';
const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
const money = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthNow = () => new Date().toISOString().slice(0, 7);
const chip = (bg, fg) => ({ backgroundColor: bg, color: fg });

const EVENTS = [
  ['late', '⏰ Late arrival'], ['leftEarly', '🚪 Left early'], ['absent', '❌ Absent (no check-in)'],
  ['noCheckout', '🕳 No check-out'], ['wrongBranch', '📍 At the wrong branch']
];
const KINDS = [
  ['days', 'Days of salary'], ['amount', 'Fixed amount (EGP)'], ['perMinute', 'EGP per minute'], ['percentDay', '% of one day'], ['none', 'No deduction (warning only)']
];
const EXAMPLE_RULES = [
  { event: 'late', minFrom: 1, minTo: 15, occFrom: 1, occTo: 2, kind: 'none', value: 0, note: 'First 2 short lates are free' },
  { event: 'late', minFrom: 1, minTo: 15, occFrom: 3, occTo: null, kind: 'percentDay', value: 25, note: 'Short late, 3rd time or more' },
  { event: 'late', minFrom: 16, minTo: 30, occFrom: 1, occTo: null, kind: 'percentDay', value: 50, note: 'Late 16-30 minutes' },
  { event: 'late', minFrom: 31, minTo: 60, occFrom: 1, occTo: null, kind: 'days', value: 1, note: 'Late 31-60 minutes' },
  { event: 'late', minFrom: 61, minTo: null, occFrom: 1, occTo: null, kind: 'days', value: 1.5, note: 'Late more than an hour' },
  { event: 'leftEarly', minFrom: 1, minTo: null, occFrom: 1, occTo: null, kind: 'percentDay', value: 50, note: 'Left early' },
  { event: 'absent', minFrom: 0, minTo: null, occFrom: 1, occTo: null, kind: 'days', value: 2, note: 'Absent without permission' },
  { event: 'noCheckout', minFrom: 0, minTo: null, occFrom: 1, occTo: null, kind: 'percentDay', value: 25, note: 'Forgot to check out' },
  { event: 'wrongBranch', minFrom: 0, minTo: null, occFrom: 1, occTo: null, kind: 'days', value: 1, note: 'Not at the planned branch' }
].map((r, i) => ({ id: `r${i + 1}`, ...r }));

// the same matching the server does, for the "try a scenario" box
const matchRule = (rules, event, minutes, occurrence) => rules.find((r) => r.event === event
  && (event === 'late' || event === 'leftEarly' ? (minutes >= (Number(r.minFrom) || 0) && (r.minTo === null || r.minTo === '' || r.minTo === undefined || minutes <= Number(r.minTo)) ) : true)
  && occurrence >= (Number(r.occFrom) || 1) && (r.occTo === null || r.occTo === '' || r.occTo === undefined || occurrence <= Number(r.occTo)));

export default function HRReport({ hideUser = () => false }) {
  const [sub, setSub] = useState('report');
  const [month, setMonth] = useState(monthNow());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [openId, setOpenId] = useState('');

  const refresh = () => setReload((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    call('computePayroll', { month })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load the report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, reload]);

  useEffect(() => { call('getPayrollConfig').then((r) => setCanManage(!!r.canManage)).catch(() => {}); }, []);

  const rows = useMemo(() => (data?.rows || []).filter((r) => !hideUser(r)), [data, hideUser]);
  const branches = useMemo(() => [...new Set(rows.flatMap((r) => r.branches || []))].sort(), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (!q || r.username.toLowerCase().includes(q)) && (!branchFilter || (r.branches || []).includes(branchFilter)));
  }, [rows, search, branchFilter]);

  const totals = useMemo(() => shown.reduce((t, r) => ({
    net: t.net + r.net, gross: t.gross + r.gross, ded: t.ded + r.totalDeductions,
    late: t.late + r.lateCount, absent: t.absent + r.absentCount, leave: t.leave + r.leaveDays, pen: t.pen + r.manualTotal
  }), { net: 0, gross: 0, ded: 0, late: 0, absent: 0, leave: 0, pen: 0 }), [shown]);

  const subBtn = (k, t) => (
    <button key={k} type="button" onClick={() => setSub(k)}
      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border-0 cursor-pointer ${sub === k ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900 bg-transparent'}`}>{t}</button>
  );

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-slate-900 tracking-tight">🧾 HR Report</h2>
            <p className="text-xs text-slate-500">
              Attendance, lateness, leaves, penalties, salaries and payslips in one place.
              {data ? ` Pay period: ${data.period.start} → ${data.period.end}.` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="font-extrabold uppercase text-[10px] text-slate-500">Payroll month</label>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="bg-white border p-1.5 rounded-lg font-semibold text-slate-700" />
            <button type="button" onClick={refresh} className="px-3 py-1.5 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>↻ Refresh</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 w-fit">
          {subBtn('report', '📊 Report')}
          {subBtn('payroll', '💵 Payroll & payslips')}
          {subBtn('salaries', '👥 Salaries & bank')}
          {subBtn('rules', '⚖️ Deduction rules')}
        </div>
      </div>

      {error && <p className="text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{error}</p>}
      {loading && !data && <p className="text-xs text-slate-400">Calculating...</p>}

      {(sub === 'report' || sub === 'payroll') && data && (
        <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Employee..." className={`${field} max-w-[200px]`} />
            <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className={`${field} max-w-[220px]`}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            {loading && <span className="text-xs text-slate-400">Updating...</span>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
            {[
              ['Employees', shown.length, '#e0e7ff', '#3730a3'], ['Gross', money(totals.gross), '#dcfce7', '#166534'], ['Deductions', money(totals.ded), '#ffe4e6', '#9f1239'],
              ['Net to pay', money(totals.net), '#0f172a', '#ffffff'], ['Lates', totals.late, '#fef3c7', '#92400e'], ['Absences', totals.absent, '#ffe4e6', '#9f1239'], ['Leave days', totals.leave, '#e0f2fe', '#075985']
            ].map(([t, v, bg, fg]) => (
              <div key={t} className="rounded-2xl px-3 py-2" style={chip(bg, fg)}>
                <p className="text-[10px] font-extrabold uppercase opacity-70">{t}</p>
                <p className="text-sm font-black">{v}</p>
              </div>
            ))}
          </div>
          {shown.some((r) => !r.hasSalary) && (
            <p className="text-[11px] font-bold rounded-xl px-3 py-2" style={chip('#fef3c7', '#92400e')}>
              ⚠️ {shown.filter((r) => !r.hasSalary).length} employee(s) have no salary yet (open "Salaries & bank"). They are listed with 0.
            </p>
          )}
        </div>
      )}

      {sub === 'report' && data && <ReportTable rows={shown} month={month} canManage={canManage} openId={openId} setOpenId={setOpenId} onChanged={refresh} />}
      {sub === 'payroll' && data && <PayrollPanel data={data} rows={shown} month={month} canManage={canManage} onChanged={refresh} />}
      {sub === 'salaries' && <SalariesPanel hideUser={hideUser} canManage={canManage} onChanged={refresh} />}
      {sub === 'rules' && <RulesPanel canManage={canManage} onChanged={refresh} />}
    </div>
  );
}

/* ----------------------------------------------------------------- report table */
async function exportReportExcel(rows, month) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('HR Report');
  ws.columns = [
    { header: '#', key: 'n', width: 5 }, { header: 'Employee', key: 'u', width: 24 }, { header: 'Role', key: 'role', width: 18 }, { header: 'Branches', key: 'br', width: 28 },
    { header: 'Planned days', key: 'pl', width: 12 }, { header: 'On time', key: 'ot', width: 10 }, { header: 'Late (count)', key: 'lc', width: 12 }, { header: 'Late (minutes)', key: 'lm', width: 14 },
    { header: 'Left early', key: 'le', width: 11 }, { header: 'Absent', key: 'ab', width: 9 }, { header: 'Leave days', key: 'lv', width: 11 }, { header: 'Leave waiting', key: 'lw', width: 12 },
    { header: 'Penalties (count)', key: 'pc', width: 15 }, { header: 'Penalties (EGP)', key: 'pe', width: 15 }, { header: 'Attendance deduction', key: 'ad', width: 19 },
    { header: 'Gross', key: 'gr', width: 14 }, { header: 'Total deductions', key: 'td', width: 16 }, { header: 'Net', key: 'net', width: 14 }
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  rows.forEach((r, i) => ws.addRow({
    n: i + 1, u: r.username, role: roleLabel(r.role), br: (r.branches || []).join(' / '), pl: r.planned, ot: r.onTime, lc: r.lateCount, lm: r.lateMinutes, le: r.leftEarlyCount, ab: r.absentCount,
    lv: r.leaveDays, lw: r.pendingLeaveDays || 0, pc: r.manualDeductions.length, pe: r.manualTotal, ad: r.attendanceDeductionApplied,
    gr: r.hasSalary ? r.gross : '', td: r.hasSalary ? r.totalDeductions : '', net: r.hasSalary ? r.net : ''
  }));
  const sum = (k) => rows.reduce((x, r) => x + (Number(r[k]) || 0), 0);
  const t = ws.addRow({ u: 'TOTAL', pl: sum('planned'), ot: sum('onTime'), lc: sum('lateCount'), lm: sum('lateMinutes'), le: sum('leftEarlyCount'), ab: sum('absentCount'), lv: sum('leaveDays'), pe: sum('manualTotal'), ad: sum('attendanceDeductionApplied'),
    gr: rows.filter((r) => r.hasSalary).reduce((x, r) => x + r.gross, 0), td: rows.filter((r) => r.hasSalary).reduce((x, r) => x + r.totalDeductions, 0), net: rows.filter((r) => r.hasSalary).reduce((x, r) => x + r.net, 0) });
  t.font = { bold: true };
  ['N', 'O', 'P', 'Q', 'R'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00'; });

  const wd = wb.addWorksheet('Attendance details');
  wd.columns = [{ header: 'Employee', key: 'u', width: 24 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Branch', key: 'b', width: 22 }, { header: 'Planned', key: 'p', width: 14 }, { header: 'In', key: 'i', width: 8 }, { header: 'Out', key: 'o', width: 8 }, { header: 'Status', key: 's', width: 36 }, { header: 'Deduction', key: 'x', width: 12 }];
  wd.getRow(1).font = { bold: true };
  rows.forEach((r) => r.days.filter((d) => d.status !== 'Upcoming').forEach((d) => wd.addRow({ u: r.username, d: d.date, b: d.branch, p: d.planned, i: d.arrival, o: d.departure, s: d.status, x: d.deduction })));

  const wp = wb.addWorksheet('Penalties');
  wp.columns = [{ header: 'Employee', key: 'u', width: 24 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Category', key: 'c', width: 16 }, { header: 'Type', key: 't', width: 10 }, { header: 'Value', key: 'v', width: 10 }, { header: 'Amount (EGP)', key: 'a', width: 14 }, { header: 'Reason', key: 'r', width: 50 }];
  wp.getRow(1).font = { bold: true };
  rows.forEach((r) => r.manualDeductions.forEach((m) => wp.addRow({ u: r.username, d: m.date, c: m.category, t: m.kind === 'days' ? 'Days' : 'Amount', v: m.value, a: m.amount, r: m.reason })));

  const buf = await wb.xlsx.writeBuffer();
  saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `HR_Report_${month}.xlsx`);
}

function ReportTable({ rows, month, canManage, openId, setOpenId, onChanged }) {
  return (
    <div className="space-y-2">
    <div className="flex justify-end">
      <button type="button" onClick={() => exportReportExcel(rows, month).catch((e) => alert(e.message || 'Could not export.'))} disabled={rows.length === 0} className="px-4 py-2 rounded-xl text-xs font-extrabold text-white border-0 cursor-pointer disabled:opacity-50 shadow-sm" style={{ backgroundColor: '#059669' }}>⬇️ Download Excel</button>
    </div>
    <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-x-auto">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="bg-slate-100 text-slate-700 text-[10px] font-black uppercase tracking-wider">
            {['Employee', 'Planned', 'On time', 'Late', 'Left early', 'Absent', 'Leave', 'Penalties', 'Attendance deduction', 'Net'].map((h) => <th key={h} className="p-2.5 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-semibold text-slate-800">
          {rows.length === 0 && <tr><td className="p-4 text-slate-400 italic" colSpan={10}>No employees.</td></tr>}
          {rows.map((r) => (
            <React.Fragment key={r.userId}>
              <tr className="hover:bg-indigo-50/40 cursor-pointer transition-colors" onClick={() => setOpenId(openId === r.userId ? '' : r.userId)}>
                <td className="p-2.5 whitespace-nowrap"><span className="font-black text-slate-900">{r.username}</span> <span className="text-[10px] text-slate-400">{roleLabel(r.role)}</span></td>
                <td className="p-2.5">{r.planned}</td>
                <td className="p-2.5 text-emerald-700">{r.onTime}</td>
                <td className="p-2.5" style={{ color: r.lateCount ? '#b45309' : undefined }}>{r.lateCount}{r.lateCount ? ` (${r.lateMinutes}m)` : ''}</td>
                <td className="p-2.5">{r.leftEarlyCount}</td>
                <td className="p-2.5" style={{ color: r.absentCount ? '#e11d48' : undefined }}>{r.absentCount}</td>
                <td className="p-2.5">{r.leaveDays}{r.pendingLeaveDays ? ` (+${r.pendingLeaveDays} waiting)` : ''}</td>
                <td className="p-2.5">{r.manualDeductions.length ? `${r.manualDeductions.length} · ${money(r.manualTotal)}` : '-'}</td>
                <td className="p-2.5" style={{ color: r.attendanceDeductionApplied ? '#e11d48' : undefined }}>{money(r.attendanceDeductionApplied)}</td>
                <td className="p-2.5 font-black whitespace-nowrap">{r.hasSalary ? `${money(r.net)} EGP` : '—'}</td>
              </tr>
              {openId === r.userId && (
                <tr><td colSpan={10} className="p-0 bg-slate-50"><EmployeeDetail r={r} month={month} canManage={canManage} onChanged={onChanged} /></td></tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}

function EmployeeDetail({ r, month, canManage, onChanged }) {
  const [adj, setAdj] = useState({ bonus: r.bonus || '', bonusNote: r.bonusNote || '', otherDeduction: r.otherDeduction || '', otherNote: r.otherNote || '' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await call('setPayrollAdjustment', { month, userId: r.userId, ...adj }); onChanged(); }
    catch (e) { alert(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };
  const sh = r.days.filter((d) => d.status !== 'Upcoming');
  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-1 text-xs">
          <p className="font-black text-slate-900 uppercase text-[10px]">Salary of the period</p>
          <p>Base {money(r.base)} + allowances {money(r.allowancesTotal)} + bonus {money(r.bonus)} = <b>{money(r.gross)}</b></p>
          <p>One day of salary: <b>{money(r.daily)}</b></p>
          <p>Deductions: attendance {money(r.attendanceDeductionApplied)}{r.capped ? ' (capped)' : ''} · penalties {money(r.manualTotal)} · other {money(r.otherDeduction)} · insurance {money(r.insurance)} · tax {money(r.tax)} = <b>{money(r.totalDeductions)}</b></p>
          <p className="text-sm font-black">Net: {money(r.net)} EGP</p>
        </div>
        <div className="space-y-2">
          <p className="font-black text-slate-900 uppercase text-[10px]">Bonus / other deduction for this month</p>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min="0" step="0.01" disabled={!canManage} value={adj.bonus} onChange={(e) => setAdj({ ...adj, bonus: e.target.value })} placeholder="Bonus (EGP)" className={field} />
            <input type="text" disabled={!canManage} value={adj.bonusNote} onChange={(e) => setAdj({ ...adj, bonusNote: e.target.value })} placeholder="Bonus note" className={field} />
            <input type="number" min="0" step="0.01" disabled={!canManage} value={adj.otherDeduction} onChange={(e) => setAdj({ ...adj, otherDeduction: e.target.value })} placeholder="Other deduction (EGP)" className={field} />
            <input type="text" disabled={!canManage} value={adj.otherNote} onChange={(e) => setAdj({ ...adj, otherNote: e.target.value })} placeholder="Deduction note" className={field} />
          </div>
          {canManage && <button type="button" onClick={save} disabled={saving} className="px-4 py-1.5 rounded-xl text-[11px] font-black text-white border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#4f46e5' }}>{saving ? 'Saving...' : 'Save'}</button>}
        </div>
      </div>

      <div>
        <p className="font-black text-slate-900 uppercase text-[10px] mb-1">Plan vs actual ({sh.length} shifts)</p>
        {sh.length === 0 ? <p className="text-xs text-slate-400 italic">No planned shifts in this period.</p> : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-[11px]">
              <thead><tr className="bg-slate-100 text-[10px] font-black uppercase text-slate-600">{['Date', 'Branch', 'Planned', 'In', 'Out', 'Status', 'Deduction'].map((h) => <th key={h} className="p-2">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {sh.map((d, i) => (
                  <tr key={i}>
                    <td className="p-2 whitespace-nowrap">{d.date}</td><td className="p-2">{d.branch}</td><td className="p-2 whitespace-nowrap">{d.planned}</td>
                    <td className="p-2">{d.arrival || '-'}</td><td className="p-2">{d.departure || '-'}</td>
                    <td className="p-2 font-bold" style={{ color: /Absent|Wrong/.test(d.status) ? '#e11d48' : /Late|early|No check/.test(d.status) ? '#b45309' : /leave/.test(d.status) ? '#0369a1' : '#047857' }}>{d.status}</td>
                    <td className="p-2 font-black">{d.deduction ? `- ${money(d.deduction)}` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div>
          <p className="font-black text-slate-900 uppercase text-[10px] mb-1">Penalties (recorded deductions)</p>
          {r.manualDeductions.length === 0 ? <p className="text-slate-400 italic">None.</p> : r.manualDeductions.map((m) => (
            <p key={m.id} className="border-b border-slate-100 py-1">{m.date} · <b>{m.kind === 'days' ? `${m.value} day(s)` : `${money(m.value)} EGP`}</b> = {money(m.amount)} · {m.category} · {m.reason}</p>
          ))}
        </div>
        <div>
          <p className="font-black text-slate-900 uppercase text-[10px] mb-1">Leaves in this period</p>
          {r.leaves.length === 0 ? <p className="text-slate-400 italic">None.</p> : r.leaves.map((l, i) => (
            <p key={i} className="border-b border-slate-100 py-1">{l.startDate} → {l.endDate} · <b style={{ color: l.status === 'Approved' ? '#047857' : '#b45309' }}>{l.status}</b></p>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- payroll sheet + payslips */
function PayrollPanel({ data, rows, month, canManage, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState([]);
  const released = new Set(data.released || []);
  const payable = rows.filter((r) => r.hasSalary);
  const pickedIds = picked.filter((id) => payable.some((r) => r.userId === id));
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const exportSheet = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payroll');
    ws.columns = [
      { header: '#', key: 'n', width: 5 }, { header: 'Employee', key: 'u', width: 24 }, { header: 'Role', key: 'role', width: 18 }, { header: 'Branches', key: 'br', width: 28 },
      { header: 'Bank', key: 'bank', width: 22 }, { header: 'Account holder', key: 'holder', width: 24 }, { header: 'Account number', key: 'acc', width: 24 }, { header: 'IBAN', key: 'iban', width: 30 },
      { header: 'Base salary', key: 'base', width: 14 }, { header: 'Allowances', key: 'al', width: 14 }, { header: 'Bonus', key: 'bonus', width: 12 }, { header: 'Gross', key: 'gross', width: 14 },
      { header: 'Attendance deductions', key: 'att', width: 20 }, { header: 'Penalties', key: 'pen', width: 14 }, { header: 'Other deductions', key: 'oth', width: 16 },
      { header: 'Insurance', key: 'ins', width: 12 }, { header: 'Tax', key: 'tax', width: 12 }, { header: 'Total deductions', key: 'ded', width: 16 }, { header: 'NET TO PAY', key: 'net', width: 16 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    payable.forEach((r, i) => ws.addRow({
      n: i + 1, u: r.username, role: roleLabel(r.role), br: (r.branches || []).join(' / '), bank: r.bank.bankName, holder: r.bank.accountHolder, acc: r.bank.accountNumber, iban: r.bank.iban,
      base: r.base, al: r.allowancesTotal, bonus: r.bonus, gross: r.gross, att: r.attendanceDeductionApplied, pen: r.manualTotal, oth: r.otherDeduction, ins: r.insurance, tax: r.tax, ded: r.totalDeductions, net: r.net
    }));
    const t = ws.addRow({ u: 'TOTAL', base: payable.reduce((s, r) => s + r.base, 0), al: payable.reduce((s, r) => s + r.allowancesTotal, 0), bonus: payable.reduce((s, r) => s + r.bonus, 0), gross: payable.reduce((s, r) => s + r.gross, 0),
      att: payable.reduce((s, r) => s + r.attendanceDeductionApplied, 0), pen: payable.reduce((s, r) => s + r.manualTotal, 0), oth: payable.reduce((s, r) => s + r.otherDeduction, 0), ins: payable.reduce((s, r) => s + r.insurance, 0),
      tax: payable.reduce((s, r) => s + r.tax, 0), ded: payable.reduce((s, r) => s + r.totalDeductions, 0), net: payable.reduce((s, r) => s + r.net, 0) });
    t.font = { bold: true };
    ['I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00'; });
    ['acc', 'iban'].forEach((k) => { ws.getColumn(k).numFmt = '@'; });

    const wd = wb.addWorksheet('Attendance details');
    wd.columns = [{ header: 'Employee', key: 'u', width: 24 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Branch', key: 'b', width: 22 }, { header: 'Planned', key: 'p', width: 14 }, { header: 'In', key: 'i', width: 8 }, { header: 'Out', key: 'o', width: 8 }, { header: 'Status', key: 's', width: 36 }, { header: 'Deduction', key: 'x', width: 12 }];
    wd.getRow(1).font = { bold: true };
    payable.forEach((r) => r.days.filter((d) => d.status !== 'Upcoming').forEach((d) => wd.addRow({ u: r.username, d: d.date, b: d.branch, p: d.planned, i: d.arrival, o: d.departure, s: d.status, x: d.deduction })));

    const wp = wb.addWorksheet('Penalties');
    wp.columns = [{ header: 'Employee', key: 'u', width: 24 }, { header: 'Date', key: 'd', width: 12 }, { header: 'Category', key: 'c', width: 16 }, { header: 'Type', key: 't', width: 10 }, { header: 'Value', key: 'v', width: 10 }, { header: 'Amount (EGP)', key: 'a', width: 14 }, { header: 'Reason', key: 'r', width: 50 }];
    wp.getRow(1).font = { bold: true };
    payable.forEach((r) => r.manualDeductions.forEach((m) => wp.addRow({ u: r.username, d: m.date, c: m.category, t: m.kind === 'days' ? 'Days' : 'Amount', v: m.value, a: m.amount, r: m.reason })));

    const buf = await wb.xlsx.writeBuffer();
    saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Payroll_${month}.xlsx`);
  };

  const slipItems = (list) => list.map((r) => ({ slip: r, period: data.period, month }));

  // ids = who; unrelease = hide
  const release = async (ids, unrelease) => {
    const names = payable.filter((r) => ids.includes(r.userId)).map((r) => r.username);
    const msg = unrelease
      ? `Hide the ${month} payslip from ${names.length} employee(s)?\n\nThey will no longer see it. You can release it again any time.`
      : `Release the ${month} payslip to ${names.length} employee(s)?\n\n${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''}\n\nEach employee sees ONLY their own payslip - a frozen copy of today's numbers. Releasing again later refreshes it with the latest numbers.`;
    if (ids.length === 0 || !window.confirm(msg)) return;
    setBusy(true);
    try { const res = await call('releasePayslips', { month, unrelease, userIds: ids }); alert(`${res.changed} payslip(s) ${unrelease ? 'hidden' : 'released'}.`); setPicked([]); onChanged(); }
    catch (e) { alert(e.message || 'Could not do that.'); }
    finally { setBusy(false); }
  };

  const missingBank = payable.filter((r) => !r.bank.accountNumber && !r.bank.iban);

  return (
    <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-slate-900">💵 Payroll sheet & payslips - {month}</h3>
          <p className="text-[11px] text-slate-500">Net to pay: <b>{money(payable.reduce((s, r) => s + r.net, 0))} EGP</b> for {payable.length} employee(s).</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={exportSheet} disabled={payable.length === 0} className="px-4 py-2 rounded-xl text-xs font-black text-white border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#059669' }}>📥 Payroll sheet (Excel)</button>
          <button type="button" onClick={() => printPayslips(slipItems(payable))} disabled={payable.length === 0} className="px-4 py-2 rounded-xl text-xs font-black text-white border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#4f46e5' }}>🖨 All payslips (print / PDF)</button>
        </div>
      </div>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border border-rose-200 bg-rose-50/40 rounded-2xl p-3">
          <span className="text-[11px] font-black text-rose-900 uppercase">Release to employees:</span>
          <button type="button" onClick={() => release(payable.map((r) => r.userId), false)} disabled={busy || payable.length === 0} className="px-3 py-1.5 rounded-xl text-[11px] font-black text-white border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#e11d48' }}>📤 Everyone ({payable.length})</button>
          <button type="button" onClick={() => release(pickedIds, false)} disabled={busy || pickedIds.length === 0} className="px-3 py-1.5 rounded-xl text-[11px] font-black text-white border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#be123c' }}>📤 Selected ({pickedIds.length})</button>
          <button type="button" onClick={() => release(pickedIds, true)} disabled={busy || pickedIds.length === 0} className="px-3 py-1.5 rounded-xl text-[11px] font-black border-0 cursor-pointer disabled:opacity-40" style={chip('#e2e8f0', '#334155')}>🙈 Hide selected</button>
          <button type="button" onClick={() => release([...released].filter((id) => payable.some((r) => r.userId === id)), true)} disabled={busy || released.size === 0} className="px-3 py-1.5 rounded-xl text-[11px] font-black border-0 cursor-pointer disabled:opacity-40" style={chip('#e2e8f0', '#334155')}>🙈 Hide from everyone</button>
          <span className="text-[10px] text-slate-500">Tick people in the table first to release or hide only them.</span>
        </div>
      )}
      {missingBank.length > 0 && <p className="text-[11px] font-bold rounded-xl px-3 py-2" style={chip('#fef3c7', '#92400e')}>⚠️ No bank account for: {missingBank.map((r) => r.username).join(', ')}</p>}
      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full text-left text-xs">
          <thead><tr className="bg-slate-100 text-[10px] font-black uppercase text-slate-600">{[canManage ? <input key="all" type="checkbox" checked={payable.length > 0 && pickedIds.length === payable.length} onChange={(e) => setPicked(e.target.checked ? payable.map((r) => r.userId) : [])} /> : '', 'Employee', 'Bank / account', 'Gross', 'Deductions', 'Net', 'Employee sees it', ''].map((h, i) => <th key={i} className="p-2.5 whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100 font-semibold text-slate-800">
            {payable.length === 0 && <tr><td className="p-4 italic text-slate-400" colSpan={8}>No employee has a salary yet. Add salaries in "Salaries & bank".</td></tr>}
            {payable.map((r) => (
              <tr key={r.userId}>
                <td className="p-2.5">{canManage && <input type="checkbox" checked={picked.includes(r.userId)} onChange={() => toggle(r.userId)} />}</td>
                <td className="p-2.5 whitespace-nowrap font-black">{r.username}</td>
                <td className="p-2.5">{r.bank.bankName || '-'} · {r.bank.accountNumber || r.bank.iban || '—'}</td>
                <td className="p-2.5">{money(r.gross)}</td>
                <td className="p-2.5" style={{ color: '#e11d48' }}>{money(r.totalDeductions)}</td>
                <td className="p-2.5 font-black">{money(r.net)}</td>
                <td className="p-2.5">{released.has(r.userId) ? <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={chip('#dcfce7', '#166534')}>Released</span> : <span className="text-slate-400">No</span>}</td>
                <td className="p-2.5 whitespace-nowrap space-x-1">
                  <button type="button" onClick={() => printPayslips(slipItems([r]))} className="px-3 py-1 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e0e7ff', '#3730a3')}>Payslip</button>
                  {canManage && (released.has(r.userId)
                    ? <>
                        <button type="button" disabled={busy} onClick={() => release([r.userId], false)} className="px-3 py-1 rounded-lg text-[11px] font-black border-0 cursor-pointer disabled:opacity-40" style={chip('#fef3c7', '#92400e')}>Re-release</button>
                        <button type="button" disabled={busy} onClick={() => release([r.userId], true)} className="px-3 py-1 rounded-lg text-[11px] font-black border-0 cursor-pointer disabled:opacity-40" style={chip('#e2e8f0', '#334155')}>Hide</button>
                      </>
                    : <button type="button" disabled={busy} onClick={() => release([r.userId], false)} className="px-3 py-1 rounded-lg text-[11px] font-black text-white border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#e11d48' }}>Release</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- salaries & bank */
function SalariesPanel({ hideUser, canManage, onChanged }) {
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState('');
  const [savingId, setSavingId] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call('getPayrollEmployees').then((r) => { if (!cancelled) setRows(r.rows || []); }).catch((e) => { if (!cancelled) setError(e.message || 'Could not load.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);

  const shown = useMemo(() => rows.filter((r) => !hideUser(r) && (!search.trim() || r.username.toLowerCase().includes(search.trim().toLowerCase()))), [rows, search, hideUser]);
  const val = (r) => drafts[r.userId] || r;
  const setDraft = (r, patch) => setDrafts((d) => ({ ...d, [r.userId]: { ...(d[r.userId] || r), ...patch } }));

  const save = async (r) => {
    const d = val(r);
    setSavingId(r.userId);
    try {
      await call('setPayrollProfile', { userId: r.userId, baseSalary: d.baseSalary, allowances: (d.allowances || []).filter((a) => a.name && a.amount !== ''), bankName: d.bankName, accountHolder: d.accountHolder, accountNumber: d.accountNumber, iban: d.iban, active: d.active });
      setDrafts((x) => { const n = { ...x }; delete n[r.userId]; return n; });
      setReload((k) => k + 1); onChanged();
    } catch (e) { alert(e.message || 'Could not save.'); }
    finally { setSavingId(''); }
  };

  return (
    <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-4">
      <div>
        <h3 className="text-base font-black text-slate-900">👥 Salaries & bank accounts</h3>
        <p className="text-[11px] text-slate-500">Private: kept on the server and shown only to people with the HR Report permission. Untick "Active" for someone who must not appear in the payroll.</p>
      </div>
      <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Employee..." className={`${field} max-w-xs`} />
      {error && <p className="text-xs font-bold text-rose-700">{error}</p>}
      {loading ? <p className="text-xs text-slate-400">Loading...</p> : (
        <div className="space-y-2">
          {shown.map((r) => {
            const d = val(r);
            const dirty = !!drafts[r.userId];
            return (
              <div key={r.userId} className={`border rounded-2xl p-3 space-y-2 ${!r.baseSalary && !dirty ? 'border-amber-200 bg-amber-50/40' : 'border-slate-200'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-black text-slate-900 text-xs min-w-[140px]">{r.username} <span className="text-[10px] text-slate-400">{roleLabel(r.role)}</span></span>
                  <input type="number" min="0" step="0.01" disabled={!canManage} value={d.baseSalary} onChange={(e) => setDraft(r, { baseSalary: e.target.value })} placeholder="Base salary" className={`${field} max-w-[130px]`} />
                  <input type="text" disabled={!canManage} value={d.bankName} onChange={(e) => setDraft(r, { bankName: e.target.value })} placeholder="Bank" className={`${field} max-w-[150px]`} />
                  <input type="text" disabled={!canManage} value={d.accountNumber} onChange={(e) => setDraft(r, { accountNumber: e.target.value })} placeholder="Account number" className={`${field} max-w-[190px]`} />
                  <button type="button" onClick={() => setOpenId(openId === r.userId ? '' : r.userId)} className="px-3 py-1.5 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>{openId === r.userId ? 'Less' : 'More'}</button>
                  {canManage && dirty && <button type="button" disabled={savingId === r.userId} onClick={() => save(r)} className="px-4 py-1.5 rounded-lg text-[11px] font-black text-white border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#4f46e5' }}>{savingId === r.userId ? '...' : 'Save'}</button>}
                </div>
                {openId === r.userId && (
                  <div className="space-y-2 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div><label className={label}>Account holder</label><input type="text" disabled={!canManage} value={d.accountHolder} onChange={(e) => setDraft(r, { accountHolder: e.target.value })} className={field} /></div>
                      <div><label className={label}>IBAN</label><input type="text" disabled={!canManage} value={d.iban} onChange={(e) => setDraft(r, { iban: e.target.value })} className={field} /></div>
                      <label className="flex items-end gap-2 text-xs font-bold text-slate-700 pb-2"><input type="checkbox" disabled={!canManage} checked={d.active !== false} onChange={(e) => setDraft(r, { active: e.target.checked })} /> Active in the payroll</label>
                    </div>
                    <div>
                      <label className={label}>Allowances (transport, housing, ...)</label>
                      {(d.allowances || []).map((a, i) => (
                        <div key={i} className="flex gap-2 mb-1">
                          <input type="text" disabled={!canManage} value={a.name} onChange={(e) => setDraft(r, { allowances: d.allowances.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Name" className={`${field} max-w-[200px]`} />
                          <input type="number" min="0" step="0.01" disabled={!canManage} value={a.amount} onChange={(e) => setDraft(r, { allowances: d.allowances.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} placeholder="Amount" className={`${field} max-w-[130px]`} />
                          {canManage && <button type="button" onClick={() => setDraft(r, { allowances: d.allowances.filter((_, j) => j !== i) })} className="px-2 rounded-lg text-xs font-black border-0 cursor-pointer" style={chip('#fee2e2', '#991b1b')}>✕</button>}
                        </div>
                      ))}
                      {canManage && <button type="button" onClick={() => setDraft(r, { allowances: [...(d.allowances || []), { name: '', amount: '' }] })} className="px-3 py-1 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e0e7ff', '#3730a3')}>➕ Add allowance</button>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- the deduction rules */
const RULE_TYPES = [
  'User', 'Supervisor', 'Branch Manager', 'Branch Manager+', 'Fitness Manager', 'Coach', 'HR', 'CEO',
  'Facility Manager', 'Facility Member', 'QA Manager', 'QA', 'Finance and Administration', 'Staff'
];

function RulesPanel({ canManage, onChanged }) {
  const [cfg, setCfg] = useState(null);
  const [scope, setScope] = useState(''); // '' = the default rules, otherwise an account type
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [sim, setSim] = useState({ salary: '6000', event: 'late', minutes: '20', occurrence: '1' });

  useEffect(() => { call('getPayrollConfig').then((r) => setCfg({ ...r.config, roleRules: r.config.roleRules || {} })).catch((e) => setError(e.message || 'Could not load.')); }, []);
  if (error) return <p className="text-xs font-bold text-rose-700">{error}</p>;
  if (!cfg) return <p className="text-xs text-slate-400">Loading...</p>;

  const own = scope ? cfg.roleRules[scope] : null;       // the type's own set (null = follows the default)
  const cur = scope ? (own || cfg) : cfg;                // the set shown / used for the scenario
  const editable = canManage && (!scope || !!own);

  const setGeneral = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const patchSet = (patch) => setCfg((c) => (scope
    ? { ...c, roleRules: { ...c.roleRules, [scope]: { ...c.roleRules[scope], ...patch } } }
    : { ...c, ...patch }));
  const setRule = (i, patch) => patchSet({ rules: cur.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i, dir) => { const a = cur.rules.slice(); const j = i + dir; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; patchSet({ rules: a }); };
  const addRule = () => patchSet({ rules: [...cur.rules, { id: `r${Date.now() % 100000}`, event: 'late', minFrom: 1, minTo: null, occFrom: 1, occTo: null, kind: 'days', value: 0.5, note: '' }] });

  const enableOwn = (on) => {
    if (on) {
      setCfg((c) => ({ ...c, roleRules: { ...c.roleRules, [scope]: { lateGraceMinutes: c.lateGraceMinutes, leftEarlyGraceMinutes: c.leftEarlyGraceMinutes, rules: c.rules.map((r) => ({ ...r })) } } }));
    } else {
      if (!window.confirm(`Remove the separate rules of ${roleLabel(scope)}? This type will follow the default rules again.`)) return;
      setCfg((c) => { const rr = { ...c.roleRules }; delete rr[scope]; return { ...c, roleRules: rr }; });
    }
  };

  const save = async () => {
    setSaving(true);
    try { await call('setPayrollConfig', { config: cfg }); alert('Rules saved. The report uses them right away.'); onChanged(); }
    catch (e) { alert(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const num = (v) => (v === null || v === undefined ? '' : v);
  const daily = (Number(sim.salary) || 0) / (cfg.daysPerMonth || 30);
  const r = matchRule(cur.rules, sim.event, Number(sim.minutes) || 0, Number(sim.occurrence) || 1);
  let simAmount = 0;
  if (r) { const v = Number(r.value) || 0; simAmount = r.kind === 'days' ? v * daily : r.kind === 'amount' ? v : r.kind === 'perMinute' ? v * (Number(sim.minutes) || 0) : r.kind === 'percentDay' ? (v / 100) * daily : 0; }
  const graceFree = sim.event === 'late' && (Number(sim.minutes) || 0) <= (Number(cur.lateGraceMinutes) || 0);
  const ownTypes = Object.keys(cfg.roleRules);

  return (
    <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-5">
      <div>
        <h3 className="text-base font-black text-slate-900">⚖️ Deduction rules</h3>
        <p className="text-[11px] text-slate-500 max-w-3xl">
          Set once; the report and the payslips use them automatically. For every late arrival, early leave, absence... the FIRST rule (from the top) that matches is applied.
          A situation with no matching rule costs nothing. "Time #" counts how many times it happened to the same employee in the pay period (1st, 2nd, 3rd ...).
          The default rules apply to everyone; an account type can have its own separate rules.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 border border-indigo-200 bg-indigo-50/40 rounded-2xl p-3">
        <div className="min-w-[240px]">
          <label className={label}>Rules for</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} className={field}>
            <option value="">⚖️ Default rules (everyone without their own set)</option>
            {RULE_TYPES.map((t) => <option key={t} value={t}>{roleLabel(t)}{cfg.roleRules[t] ? '  ✓ own rules' : ''}</option>)}
          </select>
        </div>
        {scope && canManage && (
          <label className="flex items-center gap-2 text-xs font-black text-indigo-900 pb-2 cursor-pointer">
            <input type="checkbox" checked={!!own} onChange={(e) => enableOwn(e.target.checked)} />
            Separate rules for {roleLabel(scope)} (starts as a copy of the default)
          </label>
        )}
        <p className="text-[11px] text-slate-500 pb-2">
          {ownTypes.length ? `Types with their own rules: ${ownTypes.map((t) => roleLabel(t)).join(', ')}.` : 'No type has its own rules yet.'}
        </p>
      </div>

      {scope && !own && (
        <p className="text-xs font-bold rounded-xl px-3 py-2" style={chip('#e0f2fe', '#075985')}>
          {roleLabel(scope)} follows the default rules{canManage ? ' - tick "Separate rules" above to give this type its own.' : '.'}
          {' '}The default rules are shown below (read only).
        </p>
      )}

      {!scope && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label className={label}>Pay period starts on day</label><input type="number" min="1" max="28" disabled={!canManage} value={cfg.periodStartDay} onChange={(e) => setGeneral('periodStartDay', e.target.value)} className={field} /><p className="text-[10px] text-slate-400 mt-0.5">1 = calendar month. 21 = from the 21st of last month to the 20th.</p></div>
          <div><label className={label}>Days in a salary month</label><input type="number" min="20" max="31" disabled={!canManage} value={cfg.daysPerMonth} onChange={(e) => setGeneral('daysPerMonth', e.target.value)} className={field} /><p className="text-[10px] text-slate-400 mt-0.5">One day of salary = salary ÷ this.</p></div>
          <div><label className={label}>A day of salary is based on</label>
            <select disabled={!canManage} value={cfg.dailyRateBasis} onChange={(e) => setGeneral('dailyRateBasis', e.target.value)} className={field}><option value="gross">Base + allowances</option><option value="base">Base salary only</option></select></div>
          <div><label className={label}>Cap on attendance deductions (% of base)</label><input type="number" min="0" max="100" disabled={!canManage} value={cfg.maxAttendanceDeductionPercent} onChange={(e) => setGeneral('maxAttendanceDeductionPercent', e.target.value)} className={field} /></div>
          <div><label className={label}>Insurance (% of base)</label><input type="number" min="0" max="100" step="0.01" disabled={!canManage} value={cfg.insurancePercent} onChange={(e) => setGeneral('insurancePercent', e.target.value)} className={field} /></div>
          <div><label className={label}>Tax (% of gross)</label><input type="number" min="0" max="100" step="0.01" disabled={!canManage} value={cfg.taxPercent} onChange={(e) => setGeneral('taxPercent', e.target.value)} className={field} /></div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div><label className={label}>Late grace (minutes)</label><input type="number" min="0" max="600" disabled={!editable} value={cur.lateGraceMinutes} onChange={(e) => patchSet({ lateGraceMinutes: e.target.value })} className={field} /><p className="text-[10px] text-slate-400 mt-0.5">Arriving within this many minutes is NOT late at all.</p></div>
        <div><label className={label}>Left-early grace (minutes)</label><input type="number" min="0" max="600" disabled={!editable} value={cur.leftEarlyGraceMinutes} onChange={(e) => patchSet({ leftEarlyGraceMinutes: e.target.value })} className={field} /></div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-black text-slate-900 text-xs uppercase">Rules{scope ? ` of ${roleLabel(scope)}` : ' (default)'} - top to bottom</p>
          {editable && (
            <div className="flex gap-2">
              <button type="button" onClick={() => { if (cur.rules.length === 0 || window.confirm('Replace the current rules with the example rules?')) patchSet({ rules: EXAMPLE_RULES.map((x) => ({ ...x })) }); }} className="px-3 py-1.5 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#fef3c7', '#92400e')}>Load example rules</button>
              {scope && <button type="button" onClick={() => { if (window.confirm('Replace this type\'s rules with a copy of the default rules?')) patchSet({ rules: cfg.rules.map((x) => ({ ...x })), lateGraceMinutes: cfg.lateGraceMinutes, leftEarlyGraceMinutes: cfg.leftEarlyGraceMinutes }); }} className="px-3 py-1.5 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>Copy from default</button>}
              <button type="button" onClick={addRule} className="px-3 py-1.5 rounded-lg text-[11px] font-black border-0 cursor-pointer" style={chip('#e0e7ff', '#3730a3')}>➕ Add rule</button>
            </div>
          )}
        </div>
        {cur.rules.length === 0 && <p className="text-xs text-slate-400 italic">No rules: nothing is deducted automatically for this. {editable ? 'Press "Load example rules" to start from a typical set, then change it.' : ''}</p>}
        {cur.rules.map((rule, i) => {
          const timed = rule.event === 'late' || rule.event === 'leftEarly';
          return (
            <div key={rule.id || i} className="border border-slate-200 rounded-2xl p-3 grid grid-cols-2 md:grid-cols-12 gap-2 items-end">
              <div className="col-span-2 md:col-span-3"><label className={label}>Situation</label>
                <select disabled={!editable} value={rule.event} onChange={(e) => setRule(i, { event: e.target.value })} className={field}>{EVENTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
              <div className="md:col-span-1"><label className={label}>From min</label><input type="number" min="0" disabled={!editable || !timed} value={timed ? num(rule.minFrom) : ''} onChange={(e) => setRule(i, { minFrom: e.target.value })} className={field} /></div>
              <div className="md:col-span-1"><label className={label}>To min</label><input type="number" min="0" disabled={!editable || !timed} placeholder={timed ? '∞' : ''} value={timed ? num(rule.minTo) : ''} onChange={(e) => setRule(i, { minTo: e.target.value === '' ? null : e.target.value })} className={field} /></div>
              <div className="md:col-span-1"><label className={label}>Time # from</label><input type="number" min="1" disabled={!editable} value={num(rule.occFrom)} onChange={(e) => setRule(i, { occFrom: e.target.value })} className={field} /></div>
              <div className="md:col-span-1"><label className={label}>Time # to</label><input type="number" min="1" disabled={!editable} placeholder="∞" value={num(rule.occTo)} onChange={(e) => setRule(i, { occTo: e.target.value === '' ? null : e.target.value })} className={field} /></div>
              <div className="col-span-2 md:col-span-2"><label className={label}>Deduct</label>
                <select disabled={!editable} value={rule.kind} onChange={(e) => setRule(i, { kind: e.target.value })} className={field}>{KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
              <div className="md:col-span-1"><label className={label}>Value</label><input type="number" min="0" step="0.01" disabled={!editable || rule.kind === 'none'} value={rule.kind === 'none' ? '' : num(rule.value)} onChange={(e) => setRule(i, { value: e.target.value })} className={field} /></div>
              <div className="col-span-2 md:col-span-12 flex flex-wrap items-center gap-2">
                <input type="text" disabled={!editable} value={rule.note || ''} onChange={(e) => setRule(i, { note: e.target.value })} placeholder="Note (optional)" className={`${field} flex-1 min-w-[200px]`} />
                {editable && (<>
                  <button type="button" onClick={() => move(i, -1)} className="px-2 py-1 rounded-lg text-xs font-black border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>↑</button>
                  <button type="button" onClick={() => move(i, 1)} className="px-2 py-1 rounded-lg text-xs font-black border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>↓</button>
                  <button type="button" onClick={() => patchSet({ rules: cur.rules.filter((_, j) => j !== i) })} className="px-2 py-1 rounded-lg text-xs font-black border-0 cursor-pointer" style={chip('#fee2e2', '#991b1b')}>Delete</button>
                </>)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border border-indigo-200 bg-indigo-50/40 rounded-2xl p-4 space-y-2">
        <p className="font-black text-indigo-900 text-xs uppercase">Try a scenario {scope ? `(${roleLabel(scope)}${own ? '' : ' - default rules'})` : '(default rules)'}</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
          <div><label className={label}>Salary</label><input type="number" value={sim.salary} onChange={(e) => setSim({ ...sim, salary: e.target.value })} className={field} /></div>
          <div><label className={label}>Situation</label><select value={sim.event} onChange={(e) => setSim({ ...sim, event: e.target.value })} className={field}>{EVENTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
          <div><label className={label}>Minutes</label><input type="number" value={sim.minutes} onChange={(e) => setSim({ ...sim, minutes: e.target.value })} className={field} /></div>
          <div><label className={label}>Which time this month</label><input type="number" min="1" value={sim.occurrence} onChange={(e) => setSim({ ...sim, occurrence: e.target.value })} className={field} /></div>
          <div className="text-xs font-black text-indigo-900">
            {graceFree ? 'Within the grace: not counted as late.' : r ? `→ ${money(simAmount)} EGP (${r.note || 'matched rule'})` : '→ No rule matches: 0 EGP'}
          </div>
        </div>
        <p className="text-[10px] text-slate-500">One day of salary = {money(daily)} EGP.</p>
      </div>

      {canManage && <button type="button" onClick={save} disabled={saving} className="px-6 py-2.5 rounded-xl text-xs font-extrabold text-white border-0 cursor-pointer disabled:opacity-50 shadow-sm" style={{ backgroundColor: '#4f46e5' }}>{saving ? 'Saving...' : 'Save rules'}</button>}
      {!canManage && <p className="text-[11px] text-slate-400 italic">You can read the rules but not change them.</p>}
    </div>
  );
}

/* =====================================================================
   MyPayslip - the "💵 My Payslip" tab, open to every employee.
   An employee reads ONLY their own payslips, and only the ones HR / the System Admin released (they can hide or re-release them any time).
   The data comes from the getMyPayslips function, which answers for the signed-in account only; a payslip is a frozen copy made at release
   time, the bank account is masked, and nothing about salaries is readable by the browser any other way.
   ===================================================================== */
import React, { useEffect, useState } from 'react';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { buildPayslipsHtml, printPayslips } from './payslipPrint';

export default function MyPayslip() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    httpsCallable(functions, 'getMyPayslips')({})
      .then((res) => { if (!cancelled) { const r = res.data.rows || []; setRows(r); if (r[0]) setOpen(r[0].month); } })
      .catch((e) => { if (!cancelled) { setRows([]); setError(e.message || 'Could not load your payslips.'); } });
    return () => { cancelled = true; };
  }, []);

  const current = rows ? rows.find((r) => r.month === open) : null;
  const item = (r) => ({ slip: r.payslip, period: r.period, month: r.month });

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div>
        <h2 className="text-lg font-black text-slate-900 tracking-tight">💵 My Payslip</h2>
        <p className="text-xs text-slate-500">Your payslip appears here after HR releases it. Only you can see it.</p>
      </div>
      {rows === null && <p className="text-xs text-slate-400">Loading...</p>}
      {error && <p className="text-xs font-bold text-rose-700">{error}</p>}
      {rows && rows.length === 0 && !error && <p className="text-xs text-slate-400 italic">No payslip has been released to you yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {rows.map((r) => (
              <button key={r.month} type="button" onClick={() => setOpen(r.month)}
                className={`px-3 py-1.5 rounded-xl text-xs font-black border cursor-pointer transition-all ${open === r.month ? 'bg-indigo-600 text-white border-indigo-700' : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-400'}`}>
                {r.month}
              </button>
            ))}
          </div>
          {current && (
            <>
              <iframe title="payslip" sandbox="" srcDoc={buildPayslipsHtml([item(current)])} className="w-full border border-slate-200 rounded-2xl bg-white" style={{ height: 780 }} />
              <button type="button" onClick={() => printPayslips([item(current)])} className="px-4 py-2 rounded-xl text-xs font-black text-white border-0 cursor-pointer" style={{ backgroundColor: '#4f46e5' }}>🖨 Print / Save as PDF</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

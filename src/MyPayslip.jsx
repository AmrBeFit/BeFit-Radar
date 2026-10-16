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
    <>
      {/* "coming soon" red ink stamp - fixed in the middle of the screen, never blocks clicks */}
      <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none select-none print:hidden">
        <svg viewBox="0 0 400 400" style={{ width: 'min(78vw, 420px)', opacity: 0.62, transform: 'rotate(-6deg)', overflow: 'visible', mixBlendMode: 'multiply' }} aria-hidden="true">
          <defs>
            <filter id="stampWorn" x="-10%" y="-10%" width="120%" height="120%">
              {/* ragged, ink-bled edges */}
              <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="4" result="warp" />
              <feDisplacementMap in="SourceGraphic" in2="warp" scale="5" xChannelSelector="R" yChannelSelector="G" result="wobbly" />
              <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="11" result="grain" />
              <feDisplacementMap in="wobbly" in2="grain" scale="2.6" xChannelSelector="G" yChannelSelector="B" result="rough" />
              {/* uneven pressure: blotchy patches where the ink did not take */}
              <feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="3" seed="23" result="press" />
              <feColorMatrix in="press" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -4 3.35" result="pressMask" />
              {/* fine speckle / scratches */}
              <feTurbulence type="fractalNoise" baseFrequency="0.55 0.9" numOctaves="3" seed="5" result="spk" />
              <feColorMatrix in="spk" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -7 5.0" result="spkMask" />
              <feComposite in="rough" in2="pressMask" operator="in" result="a" />
              <feComposite in="a" in2="spkMask" operator="in" />
            </filter>
          </defs>
          <g filter="url(#stampWorn)" fill="none" stroke="#c8102e">
            <circle cx="200" cy="200" r="178" strokeWidth="11" />
            <circle cx="200" cy="200" r="160" strokeWidth="3" />
            <circle cx="200" cy="200" r="128" strokeWidth="5" strokeDasharray="780 24 60 24" transform="rotate(-100 200 200)" />
          <polygon points="147.9,82.2 151.8,87.9 158.7,87.0 154.5,92.5 157.4,98.7 150.9,96.4 145.9,101.1 146.1,94.2 140.1,91.0 146.7,89.0" fill="#c8102e" stroke="none" />
          <polygon points="200.0,70.0 204.2,80.2 215.2,81.1 206.8,88.2 209.4,98.9 200.0,93.2 190.6,98.9 193.2,88.2 184.8,81.1 195.8,80.2" fill="#c8102e" stroke="none" />
          <polygon points="254.1,84.2 255.3,91.0 261.9,93.0 255.9,96.2 256.1,103.1 251.1,98.4 244.6,100.7 247.5,94.5 243.3,89.0 250.2,89.9" fill="#c8102e" stroke="none" />
          <polygon points="247.9,298.2 251.8,303.9 258.7,303.0 254.5,308.5 257.4,314.7 250.9,312.4 245.9,317.1 246.1,310.2 240.1,307.0 246.7,305.0" fill="#c8102e" stroke="none" />
          <polygon points="200.0,298.0 204.2,308.2 215.2,309.1 206.8,316.2 209.4,326.9 200.0,321.2 190.6,326.9 193.2,316.2 184.8,309.1 195.8,308.2" fill="#c8102e" stroke="none" />
          <polygon points="152.1,296.2 153.3,303.0 159.9,305.0 153.9,308.2 154.1,315.1 149.1,310.4 142.6,312.7 145.5,306.5 141.3,301.0 148.2,301.9" fill="#c8102e" stroke="none" />
            <g transform="rotate(-16 200 200)">
              <rect x="-10" y="148" width="420" height="104" fill="#ffffff" strokeWidth="5" />
              <rect x="-2" y="156" width="404" height="88" fill="none" strokeWidth="1.5" />
              <text x="200" y="203" textAnchor="middle" fill="#c8102e" stroke="none" fontFamily="Arial Black, Impact, sans-serif" fontWeight="900" fontSize="44" letterSpacing="3">COMING SOON</text>
              <text x="200" y="232" textAnchor="middle" fill="#c8102e" stroke="none" fontFamily="Arial, sans-serif" fontWeight="900" fontSize="20" letterSpacing="9">AMR SHATA</text>
            </g>
          </g>
        </svg>
      </div>
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
    </>
  );
}

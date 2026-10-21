/* =====================================================================
   LostFound - "🧳 Lost & Found".
   The branch Admin receives an item (photo, who handed it in and their job) and keeps it for 21 days while a
   counter shows the days left. It is then either given back to its owner, or sent to the main warehouse, where the Facility Manager must
   confirm receiving it in the app (it then sits "In storage"). Everything goes through the Cloud Functions
   (createLostItem, getLostItems, returnLostItem, handoverLostItem, confirmLostItemReceived, deleteLostItem).
   ===================================================================== */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { saveAs } from 'file-saver';
const loadExcelJS = async () => (await import('exceljs')).default; // loaded only when someone exports

const DAY = 24 * 3600 * 1000;
const CLOUD_NAME = 'gwgnpo4v';       // same Cloudinary account the maintenance requests use
const UPLOAD_PRESET = 'ggwrpeyx';

const CAT_ICON = {
  'Cash': '💵', 'Wallet': '👛', 'Bank card': '💳', 'ID / documents': '🪪', 'Mobile phone': '📱', 'Headphones / earbuds': '🎧',
  'Jewelry / watch': '💍', 'Keys': '🔑', 'Glasses': '👓', 'Bag': '🎒', 'Clothing': '👕', 'Water bottle / gym gear': '🧴',
  'Other electronics': '🔌', 'Other': '📦'
};
const STATUS = {
  InBranch: { label: 'In the branch', bg: '#dbeafe', fg: '#1d4ed8' },
  PendingFM: { label: 'Sent to the main warehouse - waiting for Facility Manager to confirm', bg: '#fef3c7', fg: '#b45309' },
  InStorage: { label: 'In the main warehouse', bg: '#ede9fe', fg: '#6d28d9' },
  Returned: { label: 'Given back to its owner', bg: '#dcfce7', fg: '#15803d' }
};

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// Shrink the photo before uploading (phone cameras make huge files).
const shrinkImage = (file, maxSide = 1280) => new Promise((resolve) => {
  try {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  } catch (e) { resolve(file); }
});
const uploadPhoto = async (file) => {
  const body = new FormData();
  body.append('file', await shrinkImage(file));
  body.append('upload_preset', UPLOAD_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: 'POST', body });
  const data = await res.json();
  if (!res.ok || !data.secure_url) throw new Error('Could not upload the photo. Check the internet and try again.');
  return data.secure_url;
};

const call = (name, data) => httpsCallable(functions, name)(data || {}).then((r) => r.data);

export default function LostFound() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [skew, setSkew] = useState(0);
  const [statusPick, setStatusPick] = useState('Active'); // Active = everything not yet returned
  const [branchPick, setBranchPick] = useState('');
  const [catPick, setCatPick] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [zoom, setZoom] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    call('getLostItems')
      .then((d) => { setData(d); setSkew((d.nowMs || Date.now()) - Date.now()); setError(''); })
      .catch((e) => { setError(e.message || 'Could not load.'); setData((d) => d || { items: [], categories: [], branches: [], dueDays: 21 }); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  const dueDays = data?.dueDays || 21;
  const now = Date.now() + skew;
  const daysLeft = (it) => Math.ceil(dueDays - (now - Number(it.receivedAtMs || now)) / DAY);

  const counts = useMemo(() => {
    const c = { InBranch: 0, PendingFM: 0, InStorage: 0, Returned: 0, overdue: 0 };
    items.forEach((it) => { c[it.status] = (c[it.status] || 0) + 1; if (it.status === 'InBranch' && Math.ceil(dueDays - (now - Number(it.receivedAtMs || now)) / DAY) <= 0) c.overdue += 1; });
    return c;
  }, [items, now, dueDays]);

  const branchNames = useMemo(() => Array.from(new Set(items.map((i) => i.branch).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [items]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (statusPick === 'Active' ? it.status === 'Returned' : statusPick !== 'All' && it.status !== statusPick) return false;
      if (branchPick && it.branch !== branchPick) return false;
      if (catPick && it.category !== catPick) return false;
      if (fromDate && Number(it.receivedAtMs) < new Date(`${fromDate}T00:00:00`).getTime()) return false;
      if (toDate && Number(it.receivedAtMs) > new Date(`${toDate}T23:59:59`).getTime()) return false;
      if (q && !`${it.description} ${it.fromName} ${it.receivedBy} ${it.place} ${it.returnedTo || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, statusPick, branchPick, catPick, search, fromDate, toDate]);

  const run = async (id, fn) => {
    setBusyId(id);
    try { await fn(); await load(); } catch (e) { alert(e.message || 'Something went wrong.'); } finally { setBusyId(''); }
  };

  const exportExcel = async () => {
    if (shown.length === 0) return alert('Nothing to export with the current filters.');
    setExporting(true);
    try {
      const wb = new (await loadExcelJS()).Workbook();
      const ws = wb.addWorksheet('Lost items');
      ws.columns = [
        { header: '#', key: 'n', width: 5 }, { header: 'Branch', key: 'br', width: 20 }, { header: 'Category', key: 'cat', width: 20 }, { header: 'Description', key: 'desc', width: 40 },
        { header: 'Cash amount (EGP)', key: 'amt', width: 16 }, { header: 'Where it was left', key: 'pl', width: 22 }, { header: 'Status', key: 'st', width: 30 },
        { header: 'Received by', key: 'rb', width: 18 }, { header: 'Received at', key: 'ra', width: 20 }, { header: 'Handed in by (name)', key: 'fn', width: 22 }, { header: 'Handed in by (job)', key: 'fj', width: 18 },
        { header: 'Days in the branch', key: 'days', width: 14 }, { header: 'Days left (21)', key: 'left', width: 13 },
        { header: 'Given to (customer)', key: 'rt', width: 22 }, { header: 'Customer phone', key: 'rp', width: 16 }, { header: 'Given by', key: 'rby', width: 16 }, { header: 'Given at', key: 'rat', width: 20 }, { header: 'Return note', key: 'rn', width: 30 },
        { header: 'Sent to warehouse by', key: 'hb', width: 16 }, { header: 'Sent to warehouse at', key: 'ha', width: 20 }, { header: 'FM received by', key: 'fb', width: 16 }, { header: 'FM received at', key: 'fa', width: 20 }, { header: 'Storage note', key: 'sn', width: 24 },
        { header: 'Photo', key: 'ph', width: 18 }
      ];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      shown.forEach((it, i) => {
        const end = it.status === 'Returned' ? Number(it.returnedAtMs) : now;
        const days = Math.max(0, Math.floor((end - Number(it.receivedAtMs || now)) / DAY));
        const row = ws.addRow({
          n: i + 1, br: it.branch, cat: it.category, desc: it.description, amt: it.category === 'Cash' ? it.amount : '', pl: it.place || '', st: (STATUS[it.status] || {}).label || it.status,
          rb: it.receivedBy, ra: fmtDate(it.receivedAtMs), fn: it.foundByReceiver ? 'Found by the receiver' : it.fromName, fj: it.foundByReceiver ? '' : it.fromJob,
          days, left: it.status === 'InBranch' ? daysLeft(it) : '',
          rt: it.returnedTo || '', rp: it.returnedPhone || '', rby: it.returnedBy || '', rat: fmtDate(it.returnedAtMs), rn: it.returnedNote || '',
          hb: it.handedOverBy || '', ha: fmtDate(it.handedOverAtMs), fb: it.fmReceivedBy || '', fa: fmtDate(it.fmReceivedAtMs), sn: it.storageNote || '',
          ph: (it.photoUrls || [])[0] ? { text: 'Open photo', hyperlink: it.photoUrls[0] } : ''
        });
        if (it.status === 'InBranch' && daysLeft(it) <= 0) row.getCell('left').font = { bold: true, color: { argb: 'FFB91C1C' } };
      });
      ws.getColumn('amt').numFmt = '#,##0.00';

      const sm = wb.addWorksheet('Summary');
      sm.columns = [{ header: 'Group', key: 'g', width: 26 }, { header: 'Item', key: 'i', width: 36 }, { header: 'Count', key: 'c', width: 10 }, { header: 'Cash (EGP)', key: 'm', width: 14 }];
      sm.getRow(1).font = { bold: true };
      const addGroup = (title, keyOf) => {
        const map = {};
        shown.forEach((it) => { const k = keyOf(it); map[k] = map[k] || { c: 0, m: 0 }; map[k].c += 1; if (it.category === 'Cash') map[k].m += Number(it.amount) || 0; });
        Object.entries(map).sort((a, b) => b[1].c - a[1].c).forEach(([k, v]) => sm.addRow({ g: title, i: k, c: v.c, m: v.m || '' }));
        sm.addRow({});
      };
      sm.addRow({ g: 'Items in this report', c: shown.length, m: shown.filter((i) => i.category === 'Cash').reduce((x, i) => x + (Number(i.amount) || 0), 0) });
      sm.addRow({ g: 'Overdue (in the branch more than 21 days)', c: shown.filter((i) => i.status === 'InBranch' && daysLeft(i) <= 0).length });
      sm.addRow({});
      addGroup('By status', (i) => (STATUS[i.status] || {}).label || i.status);
      addGroup('By branch', (i) => i.branch);
      addGroup('By category', (i) => i.category);
      sm.getColumn('m').numFmt = '#,##0.00';

      const buf = await wb.xlsx.writeBuffer();
      const d = new Date();
      saveAs(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Lost_and_Found_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.xlsx`);
    } catch (e) { alert(e.message || 'Could not create the Excel file.'); } finally { setExporting(false); }
  };

  const chip = (active) => ({ backgroundColor: active ? '#4f46e5' : '#e0e7ff', color: active ? '#fff' : '#3730a3' });

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-slate-900 tracking-tight">🧳 Lost & Found</h2>
            <p className="text-xs text-slate-500">Items left in the branches. Each one stays {dueDays} days in the branch, then goes to the main warehouse.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} disabled={loading} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>{loading ? '...' : '↻ Refresh'}</button>
            <button type="button" onClick={exportExcel} disabled={exporting || !data} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#16a34a', color: '#fff' }}>{exporting ? '...' : '📥 Excel'}</button>
            {data?.canManage && (
              <button type="button" onClick={() => setShowForm(true)} className="px-4 py-2 rounded-xl text-xs font-black border-0 cursor-pointer" style={{ backgroundColor: '#4f46e5', color: '#fff' }}>➕ Receive an item</button>
            )}
          </div>
        </div>

        {error && <p className="text-xs font-bold" style={{ color: '#b91c1c' }}>{error}</p>}

        <div className="flex flex-wrap gap-2">
          {[['Active', `Not returned yet · ${counts.InBranch + counts.PendingFM + counts.InStorage}`],
            ['InBranch', `In the branch · ${counts.InBranch}`],
            ['PendingFM', `Sent to warehouse · ${counts.PendingFM}`],
            ['InStorage', `In the warehouse · ${counts.InStorage}`],
            ['Returned', `Given back · ${counts.Returned}`],
            ['All', `All · ${items.length}`]].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setStatusPick(k)} className="px-3 py-1.5 rounded-xl text-xs font-black border-0 cursor-pointer" style={chip(statusPick === k)}>{label}</button>
          ))}
        </div>
        {counts.overdue > 0 && (
          <p className="text-xs font-black p-2.5 rounded-xl" style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}>⚠️ {counts.overdue} item(s) passed {dueDays} days in the branch and must go to the main warehouse.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Description, name..." className="p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold w-56" />
          <select value={branchPick} onChange={(e) => setBranchPick(e.target.value)} className="p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold">
            <option value="">All branches</option>
            {branchNames.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={catPick} onChange={(e) => setCatPick(e.target.value)} className="p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold">
            <option value="">All categories</option>
            {(data?.categories || []).map((c) => <option key={c} value={c}>{CAT_ICON[c] || '📦'} {c}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[11px] font-black text-slate-500">From
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" />
          </label>
          <label className="flex items-center gap-1 text-[11px] font-black text-slate-500">To
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" />
          </label>
          {(fromDate || toDate) && <button type="button" onClick={() => { setFromDate(''); setToDate(''); }} className="px-3 py-1.5 rounded-xl text-xs font-black border-0 cursor-pointer" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>Clear dates</button>}
        </div>
        <p className="text-[11px] text-slate-500">The Excel file contains exactly what is listed below (the filters and dates apply).</p>
      </div>

      {!data && <p className="text-xs font-bold text-slate-400 p-4">Loading...</p>}
      {data && shown.length === 0 && <p className="text-xs font-bold text-slate-400 p-6 text-center">Nothing here.</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((it) => (
          <ItemCard key={it.id} it={it} data={data} left={daysLeft(it)} dueDays={dueDays} busy={busyId === it.id}
            onZoom={setZoom} run={run} />
        ))}
      </div>

      {showForm && <ReceiveForm data={data} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}
      {zoom && (
        <div onClick={() => setZoom('')} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}>
          <img src={zoom} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}

function ItemCard({ it, data, left, dueDays, busy, onZoom, run }) {
  const [panel, setPanel] = useState('');   // '' | 'return' | 'confirm' | 'history'
  const [f, setF] = useState({ name: '', phone: '', note: '' });
  const st = STATUS[it.status] || STATUS.InBranch;
  const due = left <= 0;
  const canReturn = (it.status === 'InBranch' && data.canManage) || (it.status === 'InStorage' && data.canConfirm);
  const canHand = it.status === 'InBranch' && data.canManage;
  const canHandNow = canHand && (due || data.isSysAdmin);

  const counterColor = due ? '#b91c1c' : left <= 3 ? '#b45309' : '#1d4ed8';
  const pct = Math.max(0, Math.min(100, Math.round(((dueDays - Math.max(left, 0)) / dueDays) * 100)));

  return (
    <div className="bg-white border border-slate-200 rounded-3xl shadow-sm p-4 space-y-3">
      <div className="flex gap-3">
        <div className="flex gap-1.5 flex-shrink-0">
          {(it.photoUrls || []).slice(0, 3).map((u, i) => (
            <img key={i} src={u} alt="" onClick={() => onZoom(u)} className="cursor-pointer" style={{ width: i === 0 ? 92 : 44, height: i === 0 ? 92 : 44, objectFit: 'cover', borderRadius: 12, border: '1px solid #e2e8f0' }} />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-black text-sm text-slate-900">{CAT_ICON[it.category] || '📦'} {it.category}</span>
            {it.category === 'Cash' && it.amount != null && <span className="text-xs font-black" style={{ color: '#15803d' }}>{it.amount} EGP</span>}
          </div>
          <p className="font-black text-slate-900 text-sm">{it.branch}</p>
          <p className="text-xs text-slate-700 break-words">{it.description}</p>
          {it.place && <p className="text-[11px] text-slate-500">📍 {it.place}</p>}
          <span className="inline-block mt-1 px-2.5 py-1 rounded-lg text-[11px] font-black" style={{ backgroundColor: st.bg, color: st.fg }}>{st.label}</span>
        </div>
      </div>

      <div className="text-xs text-slate-700 space-y-0.5 p-3 rounded-2xl" style={{ backgroundColor: '#f8fafc' }}>
        <p>📥 Received by <b>{it.receivedBy}</b> · {fmtDate(it.receivedAtMs)}</p>
        <p>{it.foundByReceiver ? '🔎 Found in the branch by the receiver.' : <>🤝 Handed in by <b>{it.fromName}</b> — {it.fromJob}</>}</p>
        {it.status === 'Returned' && <p>✅ Given to <b>{it.returnedTo}</b>{it.returnedPhone ? ` (${it.returnedPhone})` : ''} by <b>{it.returnedBy}</b> · {fmtDate(it.returnedAtMs)}{it.returnedNote ? ` — ${it.returnedNote}` : ''}</p>}
        {(it.status === 'PendingFM' || it.status === 'InStorage') && <p>📦 Sent to the main warehouse by <b>{it.handedOverBy}</b> · {fmtDate(it.handedOverAtMs)}</p>}
        {it.status === 'InStorage' && <p>✔ Received by <b>{it.fmReceivedBy}</b> · {fmtDate(it.fmReceivedAtMs)}{it.storageNote ? ` — ${it.storageNote}` : ''}</p>}
      </div>

      {it.status === 'InBranch' && (
        <div>
          <div className="flex items-center justify-between text-xs font-black" style={{ color: counterColor }}>
            <span>{due ? `⏰ ${Math.abs(left)} day(s) overdue — send it to the main warehouse` : `⏳ ${left} day(s) left before it goes to the main warehouse`}</span>
            <span>{Math.min(dueDays, dueDays - Math.max(left, 0))}/{dueDays}</span>
          </div>
          <div style={{ height: 8, borderRadius: 8, backgroundColor: '#e2e8f0', overflow: 'hidden', marginTop: 4 }}>
            <div style={{ width: `${due ? 100 : pct}%`, height: '100%', backgroundColor: counterColor }} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canReturn && (
          <button type="button" disabled={busy} onClick={() => setPanel(panel === 'return' ? '' : 'return')} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#16a34a', color: '#fff' }}>✅ Given back to its owner</button>
        )}
        {canHand && (
          <button type="button" disabled={busy || !canHandNow}
            onClick={() => { if (window.confirm('Send this item to the main warehouse? The Facility Manager must confirm receiving it in the app.')) run(it.id, () => call('handoverLostItem', { id: it.id })); }}
            title={canHandNow ? '' : `Available after ${dueDays} days`}
            className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#f59e0b', color: '#fff' }}>📦 Send to the main warehouse</button>
        )}
        {it.status === 'PendingFM' && data.canConfirm && (
          <button type="button" disabled={busy} onClick={() => setPanel(panel === 'confirm' ? '' : 'confirm')} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#7c3aed', color: '#fff' }}>✔ Confirm I received it</button>
        )}
        <button type="button" onClick={() => setPanel(panel === 'history' ? '' : 'history')} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>🕘 History</button>
        {data.isSysAdmin && (
          <button type="button" disabled={busy} onClick={() => { if (window.confirm('Delete this item for good? Use this only for a wrong entry.')) run(it.id, () => call('deleteLostItem', { id: it.id })); }} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#fee2e2', color: '#b91c1c' }}>🗑 Delete</button>
        )}
      </div>
      {it.status === 'InBranch' && data.canManage && !canHandNow && <p className="text-[11px] text-slate-500">The "send to the main warehouse" button opens after {dueDays} days in the branch.</p>}

      {panel === 'return' && (
        <div className="p-3 rounded-2xl space-y-2" style={{ backgroundColor: '#f0fdf4' }}>
          <input className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" placeholder="Name of the person who took it *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" placeholder="Phone (optional)" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <input className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" placeholder="Note, e.g. showed his ID (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button type="button" disabled={busy || f.name.trim().length < 2} onClick={() => run(it.id, () => call('returnLostItem', { id: it.id, customerName: f.name, customerPhone: f.phone, note: f.note }))} className="px-4 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#16a34a', color: '#fff' }}>{busy ? '...' : 'Save: given back'}</button>
        </div>
      )}
      {panel === 'confirm' && (
        <div className="p-3 rounded-2xl space-y-2" style={{ backgroundColor: '#f5f3ff' }}>
          <input className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold" placeholder="Where is it stored in the warehouse? (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button type="button" disabled={busy} onClick={() => run(it.id, () => call('confirmLostItemReceived', { id: it.id, note: f.note }))} className="px-4 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#7c3aed', color: '#fff' }}>{busy ? '...' : 'Yes, I received it'}</button>
        </div>
      )}
      {panel === 'history' && (
        <ul className="text-[11px] text-slate-600 space-y-1 p-3 rounded-2xl" style={{ backgroundColor: '#f8fafc' }}>
          {(it.history || []).map((h, i) => <li key={i}>• {fmtDate(h.at)} — <b>{h.by}</b>: {h.action}{h.note ? ` (${h.note})` : ''}</li>)}
        </ul>
      )}
    </div>
  );
}

// Live camera (no gallery / file upload): the photo must be taken right now, in front of the item.
function CameraCapture({ onShot, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open the camera.');
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (dead) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
        setReady(true);
      } catch (e) {
        setErr(e && e.name === 'NotAllowedError' ? 'Camera access was denied. Allow the camera for this site in the browser settings, then try again.' : (e.message || 'Could not open the camera.'));
      }
    })();
    return () => { dead = true; if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop()); };
  }, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => { if (b) onShot(b); }, 'image/jpeg', 0.82);
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-3 gap-3" style={{ backgroundColor: 'rgba(0,0,0,0.92)' }}>
      {err ? (
        <p className="text-sm font-black text-center max-w-sm" style={{ color: '#fecaca' }}>{err}</p>
      ) : (
        <video ref={videoRef} playsInline muted style={{ maxWidth: '100%', maxHeight: '75vh', borderRadius: 16, backgroundColor: '#000' }} />
      )}
      <div className="flex gap-3">
        {!err && <button type="button" disabled={!ready} onClick={snap} className="px-6 py-3 rounded-2xl text-sm font-black border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#fff', color: '#0f172a' }}>📸 Take photo</button>}
        <button type="button" onClick={onClose} className="px-6 py-3 rounded-2xl text-sm font-black border-0 cursor-pointer" style={{ backgroundColor: '#334155', color: '#fff' }}>Cancel</button>
      </div>
    </div>
  );
}

function ReceiveForm({ data, onClose, onSaved }) {
  const branches = data?.branches || [];
  const [f, setF] = useState({ branch: '', category: '', description: '', place: '', amount: '', source: 'handed', fromName: '', fromJob: '' });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const addShot = (blob) => { setFiles((old) => [...old, blob].slice(0, 3)); setCameraOpen(false); };
  const previews = useMemo(() => files.map((x) => URL.createObjectURL(x)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const ready = f.branch && f.category && f.description.trim().length >= 3 && files.length > 0
    && (f.category !== 'Cash' || Number(f.amount) > 0)
    && (f.source === 'found' || (f.fromName.trim().length >= 2 && f.fromJob.trim().length >= 2));

  const save = async () => {
    setBusy(true);
    try {
      const photoUrls = [];
      for (const file of files) photoUrls.push(await uploadPhoto(file));
      await call('createLostItem', { ...f, photoUrls });
      onSaved();
    } catch (e) { alert(e.message || 'Could not save.'); setBusy(false); }
  };

  const inp = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 overflow-y-auto" style={{ backgroundColor: 'rgba(15,23,42,0.6)' }}>
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-lg p-5 space-y-3 my-6">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-black text-slate-900">🧳 Receive a lost item</h3>
          <button type="button" onClick={onClose} className="border-0 cursor-pointer text-lg font-black" style={{ background: 'transparent', color: '#64748b' }}>✕</button>
        </div>

        <label className="block text-[11px] font-black text-slate-500">Branch *
          <select className={inp} value={f.branch} onChange={set('branch')}>
            <option value="">{branches.length === 0 ? 'No branch assigned to you' : 'Choose the branch...'}</option>
            {branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="block text-[11px] font-black text-slate-500">Category *
          <select className={inp} value={f.category} onChange={set('category')}>
            <option value="">Choose...</option>
            {(data?.categories || []).map((c) => <option key={c} value={c}>{CAT_ICON[c] || '📦'} {c}</option>)}
          </select>
        </label>
        {f.category === 'Cash' && (
          <label className="block text-[11px] font-black text-slate-500">Amount counted in front of the person (EGP) *
            <input className={inp} type="number" min="0" value={f.amount} onChange={set('amount')} />
          </label>
        )}
        <label className="block text-[11px] font-black text-slate-500">Description * (colour, brand, anything that identifies it)
          <textarea className={inp} rows={2} value={f.description} onChange={set('description')} />
        </label>
        <label className="block text-[11px] font-black text-slate-500">Where was it left? (optional)
          <input className={inp} value={f.place} onChange={set('place')} placeholder="e.g. men's locker room" />
        </label>

        <div>
          <p className="text-[11px] font-black text-slate-500 mb-1">Photos * (1 to 3) — taken with the camera, not uploaded</p>
          <div className="flex flex-wrap gap-2 items-center">
            {previews.map((u, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={u} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12 }} />
                <button type="button" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="border-0 cursor-pointer" style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: '#b91c1c', color: '#fff', fontSize: 11 }}>✕</button>
              </div>
            ))}
            {files.length < 3 && (
              <button type="button" onClick={() => setCameraOpen(true)} className="border-0 cursor-pointer text-xs font-black" style={{ width: 72, height: 72, borderRadius: 12, backgroundColor: '#e0e7ff', color: '#3730a3' }}>📷 Take photo</button>
            )}
          </div>
        </div>

        <div className="p-3 rounded-2xl space-y-2" style={{ backgroundColor: '#f8fafc' }}>
          <p className="text-[11px] font-black text-slate-500">Who gave it to you? *</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setF((p) => ({ ...p, source: 'handed' }))} className="px-3 py-1.5 rounded-xl text-xs font-black border-0 cursor-pointer" style={{ backgroundColor: f.source === 'handed' ? '#4f46e5' : '#e0e7ff', color: f.source === 'handed' ? '#fff' : '#3730a3' }}>Someone handed it in</button>
            <button type="button" onClick={() => setF((p) => ({ ...p, source: 'found' }))} className="px-3 py-1.5 rounded-xl text-xs font-black border-0 cursor-pointer" style={{ backgroundColor: f.source === 'found' ? '#4f46e5' : '#e0e7ff', color: f.source === 'found' ? '#fff' : '#3730a3' }}>I found it myself</button>
          </div>
          {f.source === 'handed' && (
            <>
              <input className={inp} placeholder="Name of the person who handed it in *" value={f.fromName} onChange={set('fromName')} />
              <input className={inp} placeholder="His / her job *  (e.g. cleaner, coach, member)" value={f.fromJob} onChange={set('fromJob')} />
            </>
          )}
        </div>

        {cameraOpen && <CameraCapture onShot={addShot} onClose={() => setCameraOpen(false)} />}
        <p className="text-[11px] text-slate-500">Your name and the time are recorded automatically as the person who received it.</p>
        <button type="button" disabled={!ready || busy} onClick={save} className="w-full py-3 rounded-2xl text-sm font-black border-0 cursor-pointer disabled:opacity-40" style={{ backgroundColor: '#4f46e5', color: '#fff' }}>{busy ? 'Saving...' : 'Save: I received it'}</button>
      </div>
    </div>
  );
}

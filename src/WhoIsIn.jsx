/* =====================================================================
   WhoIsIn - "📍 Who's In": everyone who is checked in right now, by branch, with phone numbers.
   Open to every signed-in member. It reads from the whoIsIn function (the browser cannot read other people's
   attendance or phone numbers directly), which returns ONLY name, role, branch, check-in time and phone - never photos.
   ===================================================================== */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { roleLabel } from './permissions';

const since = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export default function WhoIsIn() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    httpsCallable(functions, 'whoIsIn')({})
      .then((res) => { setRows(res.data.rows || []); setError(''); })
      .catch((e) => { setRows((r) => r || []); setError(e.message || 'Could not load.'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // refresh every minute
    return () => clearInterval(t);
  }, [load]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = {};
    (rows || []).filter((r) => !q || `${r.username} ${r.branch} ${r.phone}`.toLowerCase().includes(q)).forEach((r) => {
      (map[r.branch || 'Unknown branch'] = map[r.branch || 'Unknown branch'] || []).push(r);
    });
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, search]);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">📍 Who's In</h2>
          <p className="text-xs text-slate-500">Everyone checked in right now, by branch. Updates every minute.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Name, branch or phone..." className="p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold w-56" />
          <button type="button" onClick={load} disabled={loading} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>{loading ? '...' : '↻ Refresh'}</button>
        </div>
      </div>

      {error && <p className="text-xs font-bold text-rose-700">{error}</p>}
      {rows === null && !error && <p className="text-xs text-slate-400">Loading...</p>}
      {rows && rows.length === 0 && !error && <p className="text-xs text-slate-400 italic bg-white border border-slate-200 rounded-3xl p-5">Nobody is checked in right now.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {groups.map(([branch, people]) => (
          <div key={branch} className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between" style={{ backgroundColor: '#eef2ff' }}>
              <p className="font-black text-slate-900 text-base">{branch}</p>
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ backgroundColor: '#4f46e5', color: '#fff' }}>{people.length} in</span>
            </div>
            <div className="divide-y divide-slate-100">
              {people.map((p) => (
                <div key={`${p.username}-${p.checkInMs}`} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-black text-slate-900 text-sm">{p.username} <span className="text-[10px] font-bold text-slate-400">{roleLabel(p.role)}</span></p>
                    <p className="text-[11px] text-slate-500">In since {new Date(p.checkInMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {since(p.checkInMs)}</p>
                  </div>
                  {p.phone
                    ? <a href={`tel:${p.phone}`} className="px-3 py-1.5 rounded-xl text-xs font-black no-underline" style={{ backgroundColor: '#dcfce7', color: '#166534' }}>📞 {p.phone}</a>
                    : <span className="text-[11px] text-slate-400 italic">No phone</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

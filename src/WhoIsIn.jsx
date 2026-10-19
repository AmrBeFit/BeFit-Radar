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
  const [data, setData] = useState(null); // { rows, branches, hiddenBranches, isAdmin }
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState('');   // '' = all branches
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    httpsCallable(functions, 'whoIsIn')({})
      .then((res) => { setData(res.data); setError(''); })
      .catch((e) => { setData((d) => d || { rows: [], branches: [], hiddenBranches: [], isAdmin: false }); setError(e.message || 'Could not load.'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // refresh every minute
    return () => clearInterval(t);
  }, [load]);

  const rows = data?.rows || [];
  const hidden = data?.hiddenBranches || [];
  const isAdmin = !!data?.isAdmin;
  const branchNames = useMemo(() => {
    const set = new Set([...(data?.branches || []), ...rows.map((r) => r.branch).filter(Boolean)]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data, rows]);
  const countOf = (b) => rows.filter((r) => r.branch === b).length;

  const toggleHidden = async (branch) => {
    try {
      const res = await httpsCallable(functions, 'setWhoIsInBranchHidden')({ branch, hidden: !hidden.includes(branch) });
      setData((d) => ({ ...d, hiddenBranches: res.data.hiddenBranches }));
      if (pick === branch) setPick('');
    } catch (e) { alert(e.message || 'Could not change this.'); }
  };

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = {};
    rows.filter((r) => (!pick || r.branch === pick) && (!q || String(r.username || '').toLowerCase().includes(q))).forEach((r) => {
      (map[r.branch || 'Unknown branch'] = map[r.branch || 'Unknown branch'] || []).push(r);
    });
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, search, pick]);

  const chip = (active, dim) => ({ backgroundColor: active ? '#4f46e5' : dim ? '#f1f5f9' : '#e0e7ff', color: active ? '#fff' : dim ? '#94a3b8' : '#3730a3' });

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-slate-900 tracking-tight">📍 Who's In</h2>
            <p className="text-xs text-slate-500">Everyone checked in right now, by branch. Updates every minute.</p>
          </div>
          <div className="flex items-center gap-2">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Employee name..." className="p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold w-56" />
            <button type="button" onClick={load} disabled={loading} className="px-3 py-2 rounded-xl text-xs font-black border-0 cursor-pointer disabled:opacity-50" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>{loading ? '...' : '↻ Refresh'}</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setPick('')} className="px-3 py-1.5 rounded-xl text-xs font-black border-0 cursor-pointer" style={chip(pick === '', false)}>All branches · {rows.filter((r) => !hidden.includes(r.branch) || isAdmin).length}</button>
          {branchNames.map((b) => {
            const isHidden = hidden.includes(b);
            return (
              <span key={b} className="inline-flex items-center rounded-xl overflow-hidden" style={chip(pick === b, isHidden)}>
                <button type="button" onClick={() => setPick(pick === b ? '' : b)} className="px-3 py-1.5 text-xs font-black border-0 cursor-pointer bg-transparent" style={{ color: 'inherit', textDecoration: isHidden ? 'line-through' : 'none' }}>
                  {b} · {countOf(b)}
                </button>
                {isAdmin && (
                  <button type="button" onClick={() => toggleHidden(b)} title={isHidden ? 'Hidden from everyone else - click to show' : 'Click to hide this branch from everyone else'} className="px-2 py-1.5 text-xs border-0 cursor-pointer bg-transparent" style={{ color: 'inherit', borderLeft: '1px solid rgba(100,116,139,.3)' }}>{isHidden ? '🙈' : '👁'}</button>
                )}
              </span>
            );
          })}
        </div>
        {isAdmin && <p className="text-[10px] text-slate-400">System Admin: press 👁 on a branch to hide it from everyone else (🙈 = hidden). You still see hidden branches.</p>}
      </div>

      {error && <p className="text-xs font-bold text-rose-700">{error}</p>}
      {data === null && !error && <p className="text-xs text-slate-400">Loading...</p>}
      {data && groups.length === 0 && !error && <p className="text-xs text-slate-400 italic bg-white border border-slate-200 rounded-3xl p-5">Nobody is checked in{pick ? ` at ${pick}` : ''}{search ? ' matching this name' : ' right now'}.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {groups.map(([branch, people]) => (
          <div key={branch} className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between" style={{ backgroundColor: '#eef2ff' }}>
              <p className="font-black text-slate-900 text-base">{branch}{hidden.includes(branch) ? ' 🙈' : ''}</p>
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

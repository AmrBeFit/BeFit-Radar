import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';

/* =====================================================================
   Checklist summary dashboard (Supervisor and above).
   For the chosen period it compares the branches on how completely the hourly checklist was done.

   Counting rules (per branch, per day, per hourly slot that has already ended, per checklist item):
     OK ............ ticked ✓
     Request ....... problem found and a maintenance request was raised from the checklist
     N/A ........... "not applicable at this branch" - left out of the totals entirely
     Not Completed . round happened but the item was not done (no request)
     Not Checked ... nothing recorded once its hour had passed (also: a whole day nobody opened)
   Completion % = (OK + Request) / (all counted cells - N/A)
   Rating       = 100 - (Not Checked / all counted cells x 100): every missed cell lowers it, so the
                  branch with the fewest Not Checked is ranked best.
   An hour only counts once it has fully passed, so the current hour never penalises anyone.
   ===================================================================== */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const daysBetween = (fromYmd, toYmd) => {
  const out = [];
  const d = new Date(fromYmd + 'T00:00:00');
  const end = new Date(toYmd + 'T00:00:00');
  let guard = 0;
  while (d <= end && guard < 400) { out.push(ymd(d)); d.setDate(d.getDate() + 1); guard += 1; }
  return out;
};

// Status colours (fixed set, never reused for anything else) - each also carries an icon + label + number,
// so meaning never rests on colour alone.
const SEG = [
  { key: 'ok', label: 'OK', icon: '✓', color: '#0ca30c' },
  { key: 'request', label: 'Maintenance request', icon: '🛠', color: '#2a78d6' },
  { key: 'notCompleted', label: 'Not Completed', icon: '✗', color: '#ec835a' },
  { key: 'notChecked', label: 'Not Checked', icon: '!', color: '#d03b3b' }
];
const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';

const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

function Donut({ totals }) {
  const [hover, setHover] = useState(null);
  const sum = SEG.reduce((a, s) => a + (totals[s.key] || 0), 0);
  const size = 190;
  const cx = size / 2;
  const r = 72;
  const sw = 26;
  const C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = SEG.map((s) => {
    const v = totals[s.key] || 0;
    const frac = sum > 0 ? v / sum : 0;
    const len = frac * C;
    const arc = { ...s, v, frac, len, off: offset };
    offset += len;
    return arc;
  });
  const active = arcs.find((a) => a.key === hover);
  const completion = sum > 0 ? ((totals.ok + totals.request) / sum) * 100 : null;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Checklist results distribution">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={GRID} strokeWidth={sw} />
        {sum > 0 && arcs.filter((a) => a.v > 0).map((a) => (
          <circle
            key={a.key}
            cx={cx} cy={cx} r={r} fill="none"
            stroke={a.color}
            strokeWidth={hover === a.key ? sw + 5 : sw}
            strokeDasharray={`${Math.max(0, a.len - (arcs.filter((x) => x.v > 0).length > 1 ? 2 : 0))} ${C}`}
            strokeDashoffset={-a.off}
            transform={`rotate(-90 ${cx} ${cx})`}
            style={{ cursor: 'pointer', transition: 'stroke-width .15s' }}
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${a.label}: ${a.v} (${(a.frac * 100).toFixed(1)}%)`}</title>
          </circle>
        ))}
        <text x={cx} y={cx - 4} textAnchor="middle" style={{ fontSize: 26, fontWeight: 900, fill: INK }}>
          {active ? `${(active.frac * 100).toFixed(1)}%` : fmtPct(completion)}
        </text>
        <text x={cx} y={cx + 16} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: INK2 }}>
          {active ? active.label : 'completion'}
        </text>
      </svg>
      <ul className="space-y-1.5 text-xs">
        {arcs.map((a) => (
          <li
            key={a.key}
            className="flex items-center gap-2"
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'default' }}
          >
            <span className="inline-block" style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: a.color }} />
            <span style={{ color: INK2, fontWeight: 700 }}>{a.icon} {a.label}</span>
            <span style={{ color: INK, fontWeight: 900 }}>{a.v}</span>
            <span style={{ color: MUTED }}>{(a.frac * 100).toFixed(1)}%</span>
          </li>
        ))}
        {totals.na > 0 && <li style={{ color: MUTED }}>N/A (not counted): {totals.na}</li>}
      </ul>
    </div>
  );
}

// One 100%-stacked bar per branch: how that branch's counted cells split between the four outcomes.
function StackedBranches({ rows }) {
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const sum = SEG.reduce((a, s) => a + r[s.key], 0);
        return (
          <div key={r.branch} className="flex items-center gap-3">
            <span className="text-xs font-bold whitespace-nowrap" style={{ color: INK, width: 110, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.branch}>{r.branch}</span>
            <div className="flex-1 flex" style={{ height: 22, gap: 2 }}>
              {sum === 0 ? (
                <div style={{ flex: 1, backgroundColor: GRID, borderRadius: 4 }} />
              ) : SEG.filter((s) => r[s.key] > 0).map((s) => {
                const p = (r[s.key] / sum) * 100;
                return (
                  <div
                    key={s.key}
                    title={`${r.branch} — ${s.label}: ${r[s.key]} (${p.toFixed(1)}%)`}
                    style={{ width: `${p}%`, backgroundColor: s.color, borderRadius: 4, minWidth: 3 }}
                    className="flex items-center justify-center"
                  >
                    {p >= 9 && <span style={{ fontSize: 10, fontWeight: 800, color: '#ffffff' }}>{Math.round(p)}%</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
        {SEG.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: INK2, fontWeight: 700 }}>
            <span className="inline-block" style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: s.color }} />
            {s.icon} {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Daily completion % across the period (one series, so no legend box - the title names it).
function TrendLine({ daily }) {
  const pts = daily.filter((d) => d.completion !== null);
  if (daily.length < 2 || pts.length === 0) return null;
  const W = 640, H = 190, L = 34, R = 14, T = 12, B = 26;
  const x = (i) => L + (daily.length === 1 ? 0 : (i / (daily.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const path = daily.map((d, i) => (d.completion === null ? null : `${x(i)},${y(d.completion)}`)).filter(Boolean).join(' ');
  const labelEvery = Math.ceil(daily.length / 8);
  const last = [...daily].reverse().find((d) => d.completion !== null);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 420, maxWidth: W }} role="img" aria-label="Daily completion percentage">
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={GRID} strokeWidth={1} />
            <text x={L - 6} y={y(g) + 3} textAnchor="end" style={{ fontSize: 9, fill: MUTED }}>{g}%</text>
          </g>
        ))}
        <polyline points={path} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {daily.map((d, i) => d.completion === null ? null : (
          <circle key={d.day} cx={x(i)} cy={y(d.completion)} r={4} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2}>
            <title>{`${d.day}: ${d.completion.toFixed(1)}%`}</title>
          </circle>
        ))}
        {daily.map((d, i) => (i % labelEvery === 0 || i === daily.length - 1) ? (
          <text key={`l${d.day}`} x={x(i)} y={H - 8} textAnchor="middle" style={{ fontSize: 9, fill: MUTED }}>{d.day.slice(5)}</text>
        ) : null)}
        {last && (
          <text x={Math.min(W - R, x(daily.findIndex((d) => d.day === last.day)) + 6)} y={y(last.completion) - 9} textAnchor="end" style={{ fontSize: 10, fontWeight: 800, fill: INK }}>
            {last.completion.toFixed(0)}%
          </text>
        )}
      </svg>
    </div>
  );
}

export default function ChecklistSummary({ config, slots, branchNames, intervalMinutes = 60 }) {
  const today = ymd(new Date());
  const [period, setPeriod] = useState('today');
  const [branchFilter, setBranchFilter] = useState('All');
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [docs, setDocs] = useState([]);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const range = useMemo(() => {
    const d = new Date();
    if (period === 'today') return { from: today, to: today };
    if (period === 'yesterday') { d.setDate(d.getDate() - 1); const y = ymd(d); return { from: y, to: y }; }
    if (period === '7d') { d.setDate(d.getDate() - 6); return { from: ymd(d), to: today }; }
    if (period === '30d') { d.setDate(d.getDate() - 29); return { from: ymd(d), to: today }; }
    const from = customFrom <= customTo ? customFrom : customTo;
    const to = customFrom <= customTo ? customTo : customFrom;
    return { from, to: to > today ? today : to };
  }, [period, customFrom, customTo, today]);

  useEffect(() => {
    const q = query(collection(db, 'branchChecklists'), where('dateStr', '>=', range.from), where('dateStr', '<=', range.to));
    const unsub = onSnapshot(q, (snap) => setDocs(snap.docs.map((d) => d.data())), (err) => console.warn('Checklist summary error:', err));
    return () => unsub();
  }, [range.from, range.to]);

  const stats = useMemo(() => {
    const now = new Date(tick);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const days = daysBetween(range.from, range.to);
    const itemIds = new Set((config?.items || []).map((i) => i.id));
    const byKey = {};
    docs.forEach((d) => { if (d.branch && d.dateStr) byKey[`${d.branch}__${d.dateStr}`] = d.checks || {}; });

    const dayAgg = {};
    days.forEach((day) => { dayAgg[day] = { ok: 0, request: 0, na: 0, notCompleted: 0, notChecked: 0 }; });

    const scopedBranches = branchFilter !== 'All' && branchNames.includes(branchFilter) ? [branchFilter] : branchNames;
    const rows = scopedBranches.map((branch) => {
      const r = { branch, ok: 0, request: 0, na: 0, notCompleted: 0, notChecked: 0 };
      days.forEach((day) => {
        const checks = byKey[`${branch}__${day}`] || {};
        slots.forEach((slot) => {
          const due = day < today ? true : day === today ? toMin(slot) + intervalMinutes <= nowMin : false;
          if (!due) return;
          itemIds.forEach((id) => {
            const c = checks[`${slot}__${id}`];
            const da = dayAgg[day];
            if (c && c.issue) { r.request += 1; da.request += 1; }
            else if (c && c.checked) { r.ok += 1; da.ok += 1; }
            else if (c && c.na) { r.na += 1; da.na += 1; }
            else if (c && c.notCompleted) { r.notCompleted += 1; da.notCompleted += 1; }
            else { r.notChecked += 1; da.notChecked += 1; }
          });
        });
      });
      const counted = r.ok + r.request + r.na + r.notCompleted + r.notChecked;
      const countedNoNA = counted - r.na;
      r.counted = counted;
      r.completion = countedNoNA > 0 ? ((r.ok + r.request) / countedNoNA) * 100 : null;
      r.rating = counted > 0 ? Math.max(0, 100 - (r.notChecked / counted) * 100) : null;
      return r;
    });

    const ranked = rows.filter((r) => r.rating !== null).sort((a, b) => (b.rating - a.rating) || ((b.completion || 0) - (a.completion || 0)) || a.branch.localeCompare(b.branch));
    const unranked = rows.filter((r) => r.rating === null);

    const total = rows.reduce((acc, r) => ({
      ok: acc.ok + r.ok, request: acc.request + r.request, na: acc.na + r.na,
      notCompleted: acc.notCompleted + r.notCompleted, notChecked: acc.notChecked + r.notChecked
    }), { ok: 0, request: 0, na: 0, notCompleted: 0, notChecked: 0 });
    const counted = total.ok + total.request + total.na + total.notCompleted + total.notChecked;
    const noNA = counted - total.na;
    total.completion = noNA > 0 ? ((total.ok + total.request) / noNA) * 100 : null;
    const daily = days.map((day) => {
      const a = dayAgg[day];
      const noNAday = a.ok + a.request + a.notCompleted + a.notChecked;
      return { day, completion: noNAday > 0 ? ((a.ok + a.request) / noNAday) * 100 : null };
    });
    return { ranked, unranked, total, daily };
  }, [docs, range, branchNames, branchFilter, config, slots, tick, intervalMinutes, today]);

  const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);
  const tone = (v) => (v === null ? '#94a3b8' : v >= 90 ? '#059669' : v >= 70 ? '#d97706' : '#e11d48');
  const best = stats.ranked[0];
  const medals = ['🥇', '🥈', '🥉'];

  const field = 'p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';
  const card = 'rounded-2xl border border-slate-200 p-3 bg-white';

  return (
    <div className="space-y-4 border border-indigo-100 rounded-3xl p-4" style={{ backgroundColor: '#f8faff' }}>
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <h3 className="text-sm font-black text-slate-900">📊 Branches summary</h3>
          <p className="text-[11px] text-slate-500">
            Only hours that have already ended are counted. Rating drops with every "Not Checked".
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className={field}>
            <option value="All">All branches</option>
            {branchNames.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className={field}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
          {period === 'custom' && (
            <>
              <input type="date" value={customFrom} max={today} onChange={(e) => setCustomFrom(e.target.value)} className={field} />
              <input type="date" value={customTo} max={today} onChange={(e) => setCustomTo(e.target.value)} className={field} />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase text-slate-500">{branchFilter === 'All' ? 'Overall completion' : `${branchFilter} completion`}</p>
          <p className="text-2xl font-black" style={{ color: tone(stats.total.completion) }}>{pct(stats.total.completion)}</p>
        </div>
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase text-slate-500">✓ OK</p>
          <p className="text-2xl font-black" style={{ color: '#059669' }}>{stats.total.ok}</p>
        </div>
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase text-slate-500">🛠️ Maintenance requests</p>
          <p className="text-2xl font-black" style={{ color: '#be123c' }}>{stats.total.request}</p>
        </div>
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase text-slate-500">✗ Not Completed</p>
          <p className="text-2xl font-black" style={{ color: '#ea580c' }}>{stats.total.notCompleted}</p>
        </div>
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase text-slate-500">Not Checked</p>
          <p className="text-2xl font-black" style={{ color: '#be123c' }}>{stats.total.notChecked}</p>
        </div>
      </div>

      {branchFilter !== 'All' ? null : best ? (
        <div className="rounded-2xl p-3 flex flex-wrap items-center gap-3" style={{ backgroundColor: '#ecfdf5', border: '1px solid #a7f3d0' }}>
          <span className="text-2xl">🏆</span>
          <div>
            <p className="text-[10px] font-extrabold uppercase" style={{ color: '#047857' }}>Best branch in closing the checklist</p>
            <p className="text-sm font-black text-slate-900">
              {best.branch} <span className="font-bold" style={{ color: '#047857' }}>— rating {pct(best.rating)} · {best.notChecked} not checked</span>
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400 italic">Nothing to rate yet for this period (no hour has ended).</p>
      )}

      {stats.total.ok + stats.total.request + stats.total.notCompleted + stats.total.notChecked > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className={card}>
            <p className="text-[10px] font-extrabold uppercase mb-3" style={{ color: INK2 }}>{branchFilter === 'All' ? 'Overall results' : `${branchFilter} — results`}</p>
            <Donut totals={stats.total} />
          </div>
          <div className={card}>
            <p className="text-[10px] font-extrabold uppercase mb-3" style={{ color: INK2 }}>Results split by branch (% of counted cells)</p>
            <StackedBranches rows={stats.ranked} />
          </div>
        </div>
      )}

      {stats.daily.length > 1 && (
        <div className={card}>
          <p className="text-[10px] font-extrabold uppercase mb-2" style={{ color: INK2 }}>Daily completion % ({branchFilter === 'All' ? 'all branches' : branchFilter})</p>
          <TrendLine daily={stats.daily} />
        </div>
      )}

      {stats.ranked.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-2xl bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] font-extrabold uppercase text-slate-500">
              <tr>
                <th className="p-3">#</th>
                <th className="p-3">Branch</th>
                <th className="p-3">Completion</th>
                <th className="p-3">Rating</th>
                <th className="p-3">✓ OK</th>
                <th className="p-3">🛠️ Requests</th>
                <th className="p-3">✗ Not Completed</th>
                <th className="p-3">Not Checked</th>
              </tr>
            </thead>
            <tbody>
              {stats.ranked.map((r, i) => (
                <tr key={r.branch} className="border-t border-slate-100">
                  <td className="p-3 font-black">{medals[i] || i + 1}</td>
                  <td className="p-3 font-bold text-slate-900 whitespace-nowrap">{r.branch}</td>
                  <td className="p-3 font-bold whitespace-nowrap" style={{ color: tone(r.completion) }}>{pct(r.completion)}</td>
                  <td className="p-3 min-w-[140px]">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#e2e8f0' }}>
                        <div style={{ width: `${Math.max(0, Math.min(100, r.rating))}%`, height: '100%', backgroundColor: tone(r.rating) }} />
                      </div>
                      <span className="font-black whitespace-nowrap" style={{ color: tone(r.rating) }}>{pct(r.rating)}</span>
                    </div>
                  </td>
                  <td className="p-3" style={{ color: '#059669', fontWeight: 700 }}>{r.ok}</td>
                  <td className="p-3" style={{ color: '#be123c', fontWeight: 700 }}>{r.request}</td>
                  <td className="p-3" style={{ color: '#ea580c', fontWeight: 700 }}>{r.notCompleted}</td>
                  <td className="p-3 font-black" style={{ color: r.notChecked > 0 ? '#be123c' : '#64748b' }}>{r.notChecked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stats.unranked.length > 0 && (
        <p className="text-[11px] text-slate-400">Not rated yet: {stats.unranked.map((r) => r.branch).join(', ')}</p>
      )}
    </div>
  );
}

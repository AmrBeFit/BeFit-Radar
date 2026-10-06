import React, { useState, useMemo } from 'react';

/* =====================================================================
   Facility team performance (Facility Member, Facility Manager, CEO, Admin).
   For maintenance requests CREATED in the chosen period:
     Response rate ......... share of requests that have been picked up (status no longer "New")
     Response speed ........ time from the request being created to the team's first action on it
                             (first status change / assignment - `firstResponseAt`; older requests fall back
                             to the assignment time, or the completion time if that is all there is)
     Time to finish ........ from creation until it was marked Completed
     Work time ............. from assignment until Completed (only when both moments were recorded)
   ===================================================================== */

const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return toYmd(dt); };
const tsToDate = (t) => (t && typeof t.toDate === 'function' ? t.toDate() : null);

const fmtDuration = (ms) => {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}%`);

const HOUR = 3600000;
const BUCKETS = [
  { key: 'h1', label: '≤ 1 hour', color: '#0ca30c', test: (ms) => ms <= HOUR },
  { key: 'h4', label: '1 – 4 hours', color: '#2a78d6', test: (ms) => ms > HOUR && ms <= 4 * HOUR },
  { key: 'h24', label: '4 – 24 hours', color: '#ec835a', test: (ms) => ms > 4 * HOUR && ms <= 24 * HOUR },
  { key: 'over', label: '> 24 hours', color: '#d03b3b', test: (ms) => ms > 24 * HOUR }
];
const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';

const CLOSED = ['Completed', 'False Report', 'Not Applicable'];

// One row per request (all time) - the period / previous-period slices are cut from these.
const buildRows = (requests) => requests
  .map((r) => {
    const created = tsToDate(r.createdAt);
    if (!created) return null;
    const assigned = tsToDate(r.assignedAt);
    const completedAt = tsToDate(r.completedAt);
    const status = r.status || 'New';
    const completed = status === 'Completed' ? completedAt : null;
    const firstResp = tsToDate(r.firstResponseAt) || assigned || completed || null;
    const responded = status !== 'New' || !!firstResp;
    return {
      id: r.id, number: r.requestNumber || '', title: r.title || '', branch: r.branch || '—', category: r.category || '—',
      created, status, responded, archived: !!r.isArchived,
      reopens: Number(r.reopenCount) || 0,
      respMs: firstResp ? Math.max(0, firstResp - created) : null,
      totalMs: completed ? Math.max(0, completed - created) : null,
      workMs: assigned && completed ? Math.max(0, completed - assigned) : null,
      assignedTo: r.assignedTo || ''
    };
  })
  .filter(Boolean);

const inRange = (rows, from, to) => rows.filter((r) => { const y = toYmd(r.created); return y >= from && y <= to; });

// SLA share. A request that has not been answered / finished yet but is already older than the target counts as a miss;
// one that is still inside its target time is left out (it can still go either way).
const slaShare = (rows, key, targetMs, now, isDone) => {
  let met = 0, eligible = 0;
  rows.forEach((r) => {
    if (r[key] !== null) { eligible += 1; if (r[key] <= targetMs) met += 1; return; }
    const open = !isDone(r) && !CLOSED.includes(r.status);
    if (open && now - r.created > targetMs) eligible += 1;
  });
  return { met, eligible, pct: eligible ? (met / eligible) * 100 : null };
};

const analyse = (rows, from, to, sla, now) => {
  const period = inRange(rows, from, to);
  const total = period.length;
  const respondedRows = period.filter((r) => r.responded);
  const respTimes = period.map((r) => r.respMs).filter((v) => v !== null);
  const totalTimes = period.map((r) => r.totalMs).filter((v) => v !== null);
  const workTimes = period.map((r) => r.workMs).filter((v) => v !== null);
  const completedCount = period.filter((r) => r.status === 'Completed').length;
  const respMs = sla.respHours * HOUR;
  const finMs = sla.finishHours * HOUR;

  const buckets = BUCKETS.map((b) => ({ ...b, count: respTimes.filter(b.test).length }));
  const noResp = period.filter((r) => !r.responded).length;
  const unknownTime = respondedRows.length - respTimes.length;

  const respSla = slaShare(period, 'respMs', respMs, now, (r) => r.responded);
  const finSla = slaShare(period, 'totalMs', finMs, now, () => false);

  // re-opened / first-time-fix: among requests that were finished at some point
  const everFinished = period.filter((r) => r.status === 'Completed' || r.reopens > 0);
  const reopened = everFinished.filter((r) => r.reopens > 0).length;

  // grouped breakdowns
  const group = (keyFn) => {
    const m = new Map();
    period.forEach((r) => {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return [...m.entries()].map(([name, list]) => {
      const rt = list.map((r) => r.respMs).filter((v) => v !== null);
      const tt = list.map((r) => r.totalMs).filter((v) => v !== null);
      return {
        name, total: list.length, completed: list.filter((r) => r.status === 'Completed').length,
        avgResp: avg(rt), avgTotal: avg(tt), respSla: slaShare(list, 'respMs', respMs, now, (r) => r.responded).pct
      };
    });
  };
  const byCategory = group((r) => r.category).sort((a, b) => (b.avgResp ?? -1) - (a.avgResp ?? -1));
  const byBranch = group((r) => r.branch).sort((a, b) => (b.avgResp ?? -1) - (a.avgResp ?? -1));

  // daily average response hours
  const dayMap = {};
  period.forEach((r) => {
    if (r.respMs === null) return;
    const y = toYmd(r.created);
    (dayMap[y] = dayMap[y] || []).push(r.respMs);
  });
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ day: d, avgMs: dayMap[d] ? avg(dayMap[d]) : null });

  return {
    period, total, noResp, unknownTime, completedCount, buckets, days, byCategory, byBranch,
    respSla, finSla, reopened, everFinished: everFinished.length,
    firstTimeFix: everFinished.length ? ((everFinished.length - reopened) / everFinished.length) * 100 : null,
    responseRate: total ? (respondedRows.length / total) * 100 : null,
    completionRate: total ? (completedCount / total) * 100 : null,
    avgResp: avg(respTimes), medResp: median(respTimes),
    avgTotal: avg(totalTimes), avgWork: avg(workTimes)
  };
};

// Open work right now (all time, not only the chosen period) - aging + workload.
const analyseOpen = (rows, sla, now) => {
  const finMs = sla.finishHours * HOUR;
  const open = rows.filter((r) => !CLOSED.includes(r.status) && !r.archived)
    .map((r) => ({ ...r, ageMs: Math.max(0, now - r.created) }))
    .sort((a, b) => b.ageMs - a.ageMs);
  const overdue = open.filter((r) => r.ageMs > finMs);
  const load = new Map();
  open.forEach((r) => { const k = r.assignedTo || ''; load.set(k, (load.get(k) || 0) + 1); });
  return { open, overdue, oldest: open[0] || null, unassigned: load.get('') || 0, load };
};

function SpeedBar({ buckets, noResp }) {
  const parts = [...buckets.map((b) => ({ key: b.key, label: b.label, color: b.color, count: b.count })), { key: 'none', label: 'No response yet', color: '#898781', count: noResp }];
  const sum = parts.reduce((a, p) => a + p.count, 0);
  return (
    <div className="space-y-3">
      <div className="flex" style={{ height: 26, gap: 2 }}>
        {sum === 0 ? <div style={{ flex: 1, backgroundColor: GRID, borderRadius: 4 }} /> : parts.filter((p) => p.count > 0).map((p) => {
          const pc = (p.count / sum) * 100;
          return (
            <div key={p.key} title={`${p.label}: ${p.count} (${pc.toFixed(1)}%)`} className="flex items-center justify-center"
              style={{ width: `${pc}%`, backgroundColor: p.color, borderRadius: 4, minWidth: 3 }}>
              {pc >= 9 && <span style={{ fontSize: 10, fontWeight: 800, color: '#ffffff' }}>{Math.round(pc)}%</span>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-[11px]" style={{ color: INK2, fontWeight: 700 }}>
            <span className="inline-block" style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: p.color }} />
            {p.label}: <span style={{ color: INK, fontWeight: 900 }}>{p.count}</span>
            <span style={{ color: MUTED }}>({sum ? ((p.count / sum) * 100).toFixed(0) : 0}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function TrendLine({ days }) {
  const pts = days.filter((d) => d.avgMs !== null);
  if (days.length < 2 || pts.length === 0) return null;
  const hours = days.map((d) => (d.avgMs === null ? null : d.avgMs / HOUR));
  const rawMax = Math.max(1, Math.ceil(Math.max(...hours.filter((h) => h !== null))));
  const maxH = rawMax <= 4 ? rawMax : Math.ceil(rawMax / 4) * 4; // so the four gridline steps are whole hours
  const W = 640, H = 190, L = 38, R = 14, T = 12, B = 26;
  const x = (i) => L + (i / (days.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / maxH) * (H - T - B);
  const path = hours.map((h, i) => (h === null ? null : `${x(i)},${y(h)}`)).filter(Boolean).join(' ');
  const every = Math.ceil(days.length / 8);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 420, maxWidth: W }} role="img" aria-label="Average response time per day">
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g * maxH)} y2={y(g * maxH)} stroke={GRID} strokeWidth={1} />
            <text x={L - 6} y={y(g * maxH) + 3} textAnchor="end" style={{ fontSize: 9, fill: MUTED }}>{(g * maxH).toFixed(maxH < 4 ? 1 : 0)}h</text>
          </g>
        ))}
        <polyline points={path} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {days.map((d, i) => d.avgMs === null ? null : (
          <circle key={d.day} cx={x(i)} cy={y(d.avgMs / HOUR)} r={4} fill="#2a78d6" stroke="#fcfcfb" strokeWidth={2}>
            <title>{`${d.day}: ${fmtDuration(d.avgMs)}`}</title>
          </circle>
        ))}
        {days.map((d, i) => (i % every === 0 || i === days.length - 1) ? (
          <text key={`l${d.day}`} x={x(i)} y={H - 8} textAnchor="middle" style={{ fontSize: 9, fill: MUTED }}>{d.day.slice(5)}</text>
        ) : null)}
      </svg>
    </div>
  );
}

const SLA_KEY = 'befit_facility_sla';
const loadSla = () => {
  try {
    const v = JSON.parse(window.localStorage.getItem(SLA_KEY) || 'null');
    if (v && v.respHours > 0 && v.finishHours > 0) return v;
  } catch (e) { /* storage not available */ }
  return { respHours: 1, finishHours: 24 };
};

// Change against the previous period. `lowerBetter` flips which direction is "good".
function Delta({ cur, prev, kind, lowerBetter }) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return <span style={{ color: MUTED }}>no previous data</span>;
  const diff = cur - prev;
  let text; let flat;
  if (kind === 'pct') { text = `${Math.abs(diff).toFixed(1)} pts`; flat = Math.abs(diff) < 0.05; }
  else if (prev === 0) { text = fmtDuration(Math.abs(diff)); flat = Math.abs(diff) < 60000; }
  else { text = `${Math.abs((diff / prev) * 100).toFixed(0)}%`; flat = Math.abs(diff / prev) < 0.005; }
  if (flat) return <span style={{ color: MUTED, fontWeight: 700 }}>■ same as previous</span>;
  const up = diff > 0;
  const good = lowerBetter ? !up : up;
  return (
    <span style={{ color: good ? '#059669' : '#e11d48', fontWeight: 800 }}>
      {up ? '▲' : '▼'} {text} {good ? 'better' : 'worse'}
    </span>
  );
}

function MiniBar({ pct, color }) {
  return (
    <div style={{ width: 70, height: 8, backgroundColor: GRID, borderRadius: 4 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, height: 8, backgroundColor: color, borderRadius: 4 }} />
    </div>
  );
}

function Breakdown({ title, rows, firstCol }) {
  if (!rows.length) return null;
  const maxResp = Math.max(...rows.map((r) => r.avgResp || 0), 1);
  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 text-[10px] font-extrabold uppercase text-slate-500">{title} (slowest response first)</div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] font-extrabold uppercase text-slate-500">
            <tr>
              <th className="p-3">{firstCol}</th><th className="p-3">Requests</th><th className="p-3">Avg response</th>
              <th className="p-3"></th><th className="p-3">Avg time to finish</th><th className="p-3">Response SLA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-slate-100">
                <td className="p-3 font-bold text-slate-900">{r.name}</td>
                <td className="p-3">{r.total}</td>
                <td className="p-3">{fmtDuration(r.avgResp)}</td>
                <td className="p-3"><MiniBar pct={r.avgResp ? (r.avgResp / maxResp) * 100 : 0} color="#2a78d6" /></td>
                <td className="p-3">{fmtDuration(r.avgTotal)}</td>
                <td className="p-3" style={{ fontWeight: 800, color: r.respSla === null ? '#94a3b8' : r.respSla >= 90 ? '#059669' : r.respSla >= 70 ? '#d97706' : '#e11d48' }}>{fmtPct(r.respSla)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function FacilityPerformance({ requests = [], branches = [], onBack }) {
  const today = toYmd(new Date());
  const [fromDate, setFromDate] = useState(addDays(today, -29));
  const [toDate, setToDate] = useState(today);
  const [branch, setBranch] = useState('All');
  const [sla, setSla] = useState(loadSla);
  const updateSla = (k, v) => {
    const n = Math.max(0.25, Math.min(720, Number(v) || 0));
    const next = { ...sla, [k]: n };
    setSla(next);
    try { window.localStorage.setItem(SLA_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  };

  const now = Date.now();
  const allRows = useMemo(() => buildRows(branch === 'All' ? requests : requests.filter((r) => r.branch === branch)), [requests, branch]);
  const f = fromDate <= toDate ? fromDate : toDate;
  const t = fromDate <= toDate ? toDate : fromDate;
  const spanDays = Math.round((new Date(`${t}T00:00:00`) - new Date(`${f}T00:00:00`)) / 86400000) + 1;
  const prevFrom = addDays(f, -spanDays);
  const prevTo = addDays(f, -1);

  const a = useMemo(() => analyse(allRows, f, t, sla, now), [allRows, f, t, sla.respHours, sla.finishHours]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = useMemo(() => analyse(allRows, prevFrom, prevTo, sla, now), [allRows, prevFrom, prevTo, sla.respHours, sla.finishHours]); // eslint-disable-line react-hooks/exhaustive-deps
  const o = useMemo(() => analyseOpen(allRows, sla, now), [allRows, sla.finishHours]); // eslint-disable-line react-hooks/exhaustive-deps

  // per team member: period results + current open load
  const people = useMemo(() => {
    const per = new Map();
    const get = (name) => { if (!per.has(name)) per.set(name, { name, total: 0, completed: 0, work: [], resp: [], rows: [] }); return per.get(name); };
    a.period.forEach((r) => {
      if (!r.assignedTo) return;
      const x = get(r.assignedTo);
      x.total += 1; x.rows.push(r);
      if (r.status === 'Completed') x.completed += 1;
      if (r.workMs !== null) x.work.push(r.workMs);
      if (r.respMs !== null) x.resp.push(r.respMs);
    });
    o.load.forEach((_, name) => { if (name) get(name); });
    const openTotal = o.open.length || 1;
    return [...per.values()].map((x) => ({
      ...x, avgWork: avg(x.work), avgResp: avg(x.resp),
      openNow: o.load.get(x.name) || 0,
      share: ((o.load.get(x.name) || 0) / openTotal) * 100,
      respSla: slaShare(x.rows, 'respMs', sla.respHours * HOUR, now, (r) => r.responded).pct
    })).sort((x, y) => y.openNow - x.openNow || y.completed - x.completed || x.name.localeCompare(y.name));
  }, [a, o, sla.respHours]); // eslint-disable-line react-hooks/exhaustive-deps

  const preset = (days) => { setToDate(today); setFromDate(addDays(today, -(days - 1))); };
  const field = 'p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';
  const card = 'rounded-2xl border border-slate-200 p-3 bg-white';
  const cap = 'text-[10px] font-extrabold uppercase text-slate-500';
  const tone = (v) => (v === null ? '#94a3b8' : v >= 90 ? '#059669' : v >= 70 ? '#d97706' : '#e11d48');
  const prevNote = p.total === 0;

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">⏱️ Facility team performance</h2>
          <p className="text-xs text-slate-500 max-w-xl">
            How fast and how reliably the Facility team handles maintenance requests created in the chosen period,
            compared with the {spanDays} day(s) before it ({prevFrom} → {prevTo}).
          </p>
        </div>
        <button onClick={onBack} className="px-3 py-1.5 rounded-xl text-xs font-bold border-0 cursor-pointer" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>
          ← Back to requests
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1.5">
          {[[7, '7d'], [30, '30d'], [90, '90d']].map(([d, l]) => (
            <button key={l} onClick={() => preset(d)} className="px-3 py-2 rounded-xl text-xs font-bold border-0 cursor-pointer" style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}>
              Last {l}
            </button>
          ))}
        </div>
        <div>
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">From</label>
          <input type="date" value={fromDate} max={today} onChange={(e) => setFromDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">To</label>
          <input type="date" value={toDate} max={today} onChange={(e) => setToDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Branch</label>
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className={field}>
            <option value="All">All branches</option>
            {[...branches].map((b) => b.name).sort((x, y) => x.localeCompare(y)).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Target: respond within (hours)</label>
          <input type="number" min="0.25" step="0.25" value={sla.respHours} onChange={(e) => updateSla('respHours', e.target.value)} className={field} style={{ width: 90 }} />
        </div>
        <div>
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Target: finish within (hours)</label>
          <input type="number" min="0.25" step="1" value={sla.finishHours} onChange={(e) => updateSla('finishHours', e.target.value)} className={field} style={{ width: 90 }} />
        </div>
      </div>

      {/* ---------- Open right now (aging) - not tied to the period ---------- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className={card}>
          <p className={cap}>Open requests now</p>
          <p className="text-2xl font-black text-slate-900">{o.open.length}</p>
          <p className="text-[11px] text-slate-400">{o.unassigned} not assigned to anyone</p>
        </div>
        <div className={card}>
          <p className={cap}>Overdue (open &gt; {sla.finishHours}h)</p>
          <p className="text-2xl font-black" style={{ color: o.overdue.length ? '#e11d48' : '#059669' }}>{o.overdue.length}</p>
          <p className="text-[11px] text-slate-400">still open past the finish target</p>
        </div>
        <div className={card}>
          <p className={cap}>Oldest open request</p>
          <p className="text-2xl font-black text-slate-900">{o.oldest ? fmtDuration(o.oldest.ageMs) : '—'}</p>
          <p className="text-[11px] text-slate-400">{o.oldest ? `${o.oldest.branch}${o.oldest.number ? ' · #' + o.oldest.number : ''}` : 'nothing open'}</p>
        </div>
        <div className={card}>
          <p className={cap}>Solved first time</p>
          <p className="text-2xl font-black" style={{ color: tone(a.firstTimeFix) }}>{fmtPct(a.firstTimeFix)}</p>
          <p className="text-[11px] text-slate-400">
            {a.everFinished ? `${a.reopened} of ${a.everFinished} finished request(s) were re-opened` : 'no finished requests in this period'}
          </p>
          <p className="text-[11px] mt-0.5"><Delta cur={a.firstTimeFix} prev={p.firstTimeFix} kind="pct" lowerBetter={false} /></p>
        </div>
      </div>

      {o.overdue.length > 0 && (
        <div className="border border-slate-200 rounded-2xl overflow-hidden">
          <div className="bg-slate-50 px-4 py-2 text-[10px] font-extrabold uppercase" style={{ color: '#be123c' }}>
            Overdue requests - oldest first{o.overdue.length > 10 ? ` (showing 10 of ${o.overdue.length})` : ''}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] font-extrabold uppercase text-slate-500">
                <tr><th className="p-3">Request #</th><th className="p-3">Branch</th><th className="p-3">Category</th><th className="p-3">Status</th><th className="p-3">Assigned to</th><th className="p-3">Open for</th></tr>
              </thead>
              <tbody>
                {o.overdue.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="p-3 font-mono font-bold text-slate-900">{r.number || '—'}</td>
                    <td className="p-3">{r.branch}</td>
                    <td className="p-3">{r.category}</td>
                    <td className="p-3">{r.status}</td>
                    <td className="p-3">{r.assignedTo || 'Unassigned'}</td>
                    <td className="p-3 font-bold" style={{ color: '#e11d48' }}>{fmtDuration(r.ageMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {a.total === 0 ? (
        <p className="text-xs text-slate-400 italic">No maintenance requests were created in this period.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className={card}>
              <p className={cap}>Response rate</p>
              <p className="text-2xl font-black" style={{ color: tone(a.responseRate) }}>{fmtPct(a.responseRate)}</p>
              <p className="text-[11px] text-slate-400">{a.total - a.noResp} of {a.total} requests picked up</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.responseRate} prev={p.responseRate} kind="pct" lowerBetter={false} /></p>
            </div>
            <div className={card}>
              <p className={cap}>Avg response speed</p>
              <p className="text-2xl font-black text-slate-900">{fmtDuration(a.avgResp)}</p>
              <p className="text-[11px] text-slate-400">median {fmtDuration(a.medResp)}</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.avgResp} prev={p.avgResp} kind="time" lowerBetter /></p>
            </div>
            <div className={card}>
              <p className={cap}>Avg time to finish</p>
              <p className="text-2xl font-black text-slate-900">{fmtDuration(a.avgTotal)}</p>
              <p className="text-[11px] text-slate-400">from request to Completed{a.avgWork !== null ? ` · work ${fmtDuration(a.avgWork)}` : ''}</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.avgTotal} prev={p.avgTotal} kind="time" lowerBetter /></p>
            </div>
            <div className={card}>
              <p className={cap}>Completion rate</p>
              <p className="text-2xl font-black" style={{ color: tone(a.completionRate) }}>{fmtPct(a.completionRate)}</p>
              <p className="text-[11px] text-slate-400">{a.completedCount} of {a.total} completed</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.completionRate} prev={p.completionRate} kind="pct" lowerBetter={false} /></p>
            </div>
            <div className={card}>
              <p className={cap}>Response target met</p>
              <p className="text-2xl font-black" style={{ color: tone(a.respSla.pct) }}>{fmtPct(a.respSla.pct)}</p>
              <p className="text-[11px] text-slate-400">{a.respSla.met} of {a.respSla.eligible} answered within {sla.respHours}h</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.respSla.pct} prev={p.respSla.pct} kind="pct" lowerBetter={false} /></p>
            </div>
            <div className={card}>
              <p className={cap}>Finish target met</p>
              <p className="text-2xl font-black" style={{ color: tone(a.finSla.pct) }}>{fmtPct(a.finSla.pct)}</p>
              <p className="text-[11px] text-slate-400">{a.finSla.met} of {a.finSla.eligible} finished within {sla.finishHours}h</p>
              <p className="text-[11px] mt-0.5"><Delta cur={a.finSla.pct} prev={p.finSla.pct} kind="pct" lowerBetter={false} /></p>
            </div>
            <div className={card}>
              <p className={cap}>Requests in period</p>
              <p className="text-2xl font-black text-slate-900">{a.total}</p>
              <p className="text-[11px] text-slate-400">previous period: {p.total}</p>
            </div>
            <div className={card}>
              <p className={cap}>Re-opened requests</p>
              <p className="text-2xl font-black" style={{ color: a.reopened ? '#d97706' : '#059669' }}>{a.reopened}</p>
              <p className="text-[11px] text-slate-400">counted from now on only</p>
            </div>
          </div>
          {prevNote && <p className="text-[11px] text-slate-400 -mt-2">There were no requests in the previous period, so there is nothing to compare with yet.</p>}
          <p className="text-[11px] text-slate-400 -mt-2">
            A request not answered / finished yet but already older than the target counts as a miss; one still inside its target time is left out until it is decided.
          </p>

          <div className={card}>
            <p className="text-[10px] font-extrabold uppercase mb-3" style={{ color: INK2 }}>How quickly requests got a first response</p>
            <SpeedBar buckets={a.buckets} noResp={a.noResp} />
            {a.unknownTime > 0 && (
              <p className="text-[11px] text-slate-400 mt-2">{a.unknownTime} older request(s) were picked up but their response time was not recorded, so they are not in this bar.</p>
            )}
          </div>

          {a.days.length > 1 && a.days.some((d) => d.avgMs !== null) && (
            <div className={card}>
              <p className="text-[10px] font-extrabold uppercase mb-2" style={{ color: INK2 }}>Average response time per day (hours, by the day the request was created)</p>
              <TrendLine days={a.days} />
            </div>
          )}

          <Breakdown title="By maintenance category" rows={a.byCategory} firstCol="Category" />
          {branch === 'All' && <Breakdown title="By branch" rows={a.byBranch} firstCol="Branch" />}
        </>
      )}

      {people.length > 0 && (
        <div className="border border-slate-200 rounded-2xl overflow-hidden">
          <div className="bg-slate-50 px-4 py-2 text-[10px] font-extrabold uppercase text-slate-500">
            Team members - results for the period, workload is what is open right now
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] font-extrabold uppercase text-slate-500">
                <tr>
                  <th className="p-3">Team member</th>
                  <th className="p-3">Open now</th>
                  <th className="p-3">Share of open work</th>
                  <th className="p-3">Requests</th>
                  <th className="p-3">Completed</th>
                  <th className="p-3">Avg response</th>
                  <th className="p-3">Avg work time</th>
                  <th className="p-3">Response SLA</th>
                </tr>
              </thead>
              <tbody>
                {people.map((x) => (
                  <tr key={x.name} className="border-t border-slate-100">
                    <td className="p-3 font-bold text-slate-900">{x.name}</td>
                    <td className="p-3 font-black" style={{ color: x.openNow ? '#d97706' : '#059669' }}>{x.openNow}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-2"><MiniBar pct={x.share} color="#ec835a" /><span style={{ color: INK2, fontWeight: 700 }}>{x.share.toFixed(0)}%</span></div>
                    </td>
                    <td className="p-3">{x.total}</td>
                    <td className="p-3" style={{ color: '#059669', fontWeight: 700 }}>{x.completed}</td>
                    <td className="p-3">{fmtDuration(x.avgResp)}</td>
                    <td className="p-3">{fmtDuration(x.avgWork)}</td>
                    <td className="p-3" style={{ fontWeight: 800, color: tone(x.respSla) }}>{fmtPct(x.respSla)}</td>
                  </tr>
                ))}
                {o.unassigned > 0 && (
                  <tr className="border-t border-slate-100" style={{ backgroundColor: '#fff7ed' }}>
                    <td className="p-3 font-bold text-slate-500 italic">Not assigned yet</td>
                    <td className="p-3 font-black" style={{ color: '#d97706' }}>{o.unassigned}</td>
                    <td className="p-3" colSpan={6}>
                      <div className="flex items-center gap-2"><MiniBar pct={(o.unassigned / (o.open.length || 1)) * 100} color="#898781" /><span style={{ color: INK2, fontWeight: 700 }}>{((o.unassigned / (o.open.length || 1)) * 100).toFixed(0)}%</span></div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useState, useMemo } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import MultiSelectFilter from './MultiSelectFilter';

/* =====================================================================
   Maintenance report: who did what.
   Every request with the person it was assigned to, when it was assigned and completed, and how long it took,
   plus a per-person summary. Exports to Excel.
   ===================================================================== */

// ---------- pure helpers (no React) ----------
const UNASSIGNED = '__unassigned__';

const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return toYmd(dt);
};
const tsToDate = (t) => (t && typeof t.toDate === 'function' ? t.toDate() : null);
const fmtDateTime = (d) =>
  d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    : '—';
const fmtDuration = (ms) => {
  if (ms == null || ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

// One report row per maintenance request.
const buildRow = (r) => {
  const created = tsToDate(r.createdAt);
  const assigned = tsToDate(r.assignedAt);
  const completed = tsToDate(r.completedAt);
  return {
    id: r.id,
    title: r.title || '(no title)',
    category: r.category || '',
    branch: r.branch || '',
    status: r.status || 'New',
    createdBy: r.createdBy || '',
    created,
    assignedTo: r.assignedTo || '',
    assignedPhone: r.assignedToPhone || '',
    assigned,
    completed,
    completedBy: r.completedBy || '',
    archived: !!r.isArchived,
    timeToAssign: created && assigned ? assigned - created : null,
    timeToComplete: assigned && completed ? completed - assigned : null,
    totalTime: created && completed ? completed - created : null
  };
};

// Per-person totals (requests with nobody assigned are grouped under UNASSIGNED).
const summarize = (rows, roleByName = {}) => {
  const map = new Map();
  rows.forEach((row) => {
    const key = row.assignedTo || UNASSIGNED;
    if (!map.has(key)) map.set(key, { name: key, role: roleByName[key] || '', total: 0, inProgress: 0, completed: 0, isNew: 0, durations: [] });
    const s = map.get(key);
    s.total += 1;
    if (row.status === 'Completed') {
      s.completed += 1;
      if (row.timeToComplete != null) s.durations.push(row.timeToComplete);
    } else if (row.status === 'In Progress') s.inProgress += 1;
    else s.isNew += 1;
  });
  return [...map.values()]
    .map((s) => ({
      ...s,
      avgMs: s.durations.length ? s.durations.reduce((a, b) => a + b, 0) / s.durations.length : null
    }))
    .sort((a, b) => b.completed - a.completed || b.total - a.total || a.name.localeCompare(b.name));
};
// ---------- end pure helpers ----------

const STATUS_TONE = {
  New: { bg: '#ffe4e6', fg: '#9f1239' },
  'In Progress': { bg: '#fef3c7', fg: '#92400e' },
  Completed: { bg: '#d1fae5', fg: '#065f46' }
};

export default function MaintenanceReport({ requests = [], usersList = [], branches = [], onBack }) {
  const today = toYmd(new Date());
  const [fromDate, setFromDate] = useState(addDays(today, -29));
  const [toDate, setToDate] = useState(today);
  const [assigneeFilter, setAssigneeFilter] = useState([]);
  const [branchFilter, setBranchFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState('All');

  const roleByName = useMemo(() => {
    const m = {};
    usersList.forEach((u) => { m[u.username] = u.role; });
    return m;
  }, [usersList]);

  const assigneeOptions = useMemo(() => {
    const names = new Set(
      usersList.filter((u) => u.role === 'Facility Member' || u.role === 'Facility Manager').map((u) => u.username)
    );
    requests.forEach((r) => { if (r.assignedTo) names.add(r.assignedTo); });
    return [
      { value: UNASSIGNED, label: '— Unassigned —' },
      ...[...names].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n, hint: roleByName[n] || '' }))
    ];
  }, [usersList, requests, roleByName]);

  const branchOptions = useMemo(
    () => branches.map((b) => ({ value: b.name, label: b.name })).sort((a, b) => a.label.localeCompare(b.label)),
    [branches]
  );

  // filtered rows (by the day the request was created)
  const baseRows = useMemo(() => {
    return requests
      .map(buildRow)
      .filter((row) => {
        const day = row.created ? toYmd(row.created) : today;
        if (day < fromDate || day > toDate) return false;
        if (assigneeFilter.length > 0 && !assigneeFilter.includes(row.assignedTo || UNASSIGNED)) return false;
        if (branchFilter.length > 0 && !branchFilter.includes(row.branch)) return false;
        return true;
      });
  }, [requests, fromDate, toDate, assigneeFilter, branchFilter, today]);

  const rows = useMemo(() => {
    const list = statusFilter === 'All' ? baseRows : baseRows.filter((r) => r.status === statusFilter);
    return [...list].sort((a, b) => (b.created ? b.created.getTime() : 0) - (a.created ? a.created.getTime() : 0));
  }, [baseRows, statusFilter]);

  const summary = useMemo(() => summarize(rows, roleByName), [rows, roleByName]);

  const count = (s) => baseRows.filter((r) => r.status === s).length;
  const unassignedCount = baseRows.filter((r) => !r.assignedTo).length;

  const exportExcel = async () => {
    const wb = new ExcelJS.Workbook();
    const style = (ws) => {
      const header = ws.getRow(1);
      header.font = { bold: true };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };

    const ws1 = wb.addWorksheet('Requests');
    ws1.columns = [
      { header: '#', key: 'n', width: 6 },
      { header: 'Request', key: 'title', width: 30 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Requested By', key: 'by', width: 20 },
      { header: 'Requested At', key: 'created', width: 22 },
      { header: 'Assigned To', key: 'to', width: 20 },
      { header: 'Assignee Role', key: 'role', width: 16 },
      { header: 'Assignee Phone', key: 'phone', width: 16 },
      { header: 'Assigned At', key: 'assigned', width: 22 },
      { header: 'Status', key: 'status', width: 13 },
      { header: 'Completed At', key: 'completed', width: 22 },
      { header: 'Completed By', key: 'completedBy', width: 18 },
      { header: 'Time To Assign', key: 'tta', width: 14 },
      { header: 'Time To Complete', key: 'ttc', width: 16 },
      { header: 'Total Time', key: 'total', width: 12 },
      { header: 'Archived', key: 'archived', width: 10 }
    ];
    style(ws1);
    rows.forEach((r, i) => {
      const row = ws1.addRow({
        n: i + 1,
        title: r.title,
        category: r.category,
        branch: r.branch,
        by: r.createdBy,
        created: fmtDateTime(r.created),
        to: r.assignedTo || 'Unassigned',
        role: roleByName[r.assignedTo] || '',
        phone: r.assignedPhone,
        assigned: fmtDateTime(r.assigned),
        status: r.status,
        completed: fmtDateTime(r.completed),
        completedBy: r.completedBy,
        tta: fmtDuration(r.timeToAssign),
        ttc: fmtDuration(r.timeToComplete),
        total: fmtDuration(r.totalTime),
        archived: r.archived ? 'Yes' : ''
      });
      const tone = STATUS_TONE[r.status];
      if (tone) row.getCell(11).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + tone.bg.slice(1).toUpperCase() } };
    });

    const ws2 = wb.addWorksheet('By Person');
    ws2.columns = [
      { header: 'Person', key: 'name', width: 24 },
      { header: 'Role', key: 'role', width: 18 },
      { header: 'Requests', key: 'total', width: 12 },
      { header: 'Completed', key: 'completed', width: 12 },
      { header: 'In Progress', key: 'inProgress', width: 13 },
      { header: 'New', key: 'isNew', width: 8 },
      { header: 'Avg Time To Complete', key: 'avg', width: 22 }
    ];
    style(ws2);
    summary.forEach((s) => ws2.addRow({
      name: s.name === UNASSIGNED ? 'Unassigned' : s.name,
      role: s.role,
      total: s.total,
      completed: s.completed,
      inProgress: s.inProgress,
      isNew: s.isNew,
      avg: fmtDuration(s.avgMs)
    }));

    const buffer = await wb.xlsx.writeBuffer();
    saveAs(
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Maintenance_Report_${fromDate}_to_${toDate}.xlsx`
    );
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';
  const chips = [
    { k: 'all', text: `Requests: ${baseRows.length}`, bg: '#f1f5f9', fg: '#334155' },
    { k: 'new', text: `New: ${count('New')}`, ...STATUS_TONE.New },
    { k: 'prog', text: `In Progress: ${count('In Progress')}`, ...STATUS_TONE['In Progress'] },
    { k: 'done', text: `Completed: ${count('Completed')}`, ...STATUS_TONE.Completed },
    { k: 'none', text: `Unassigned: ${unassignedCount}`, bg: '#e0e7ff', fg: '#3730a3' }
  ];

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Maintenance report: who did what</h2>
          <p className="text-xs text-slate-500">Every request with the person in charge, when it was assigned and completed, and how long it took.</p>
        </div>
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-1.5 rounded-xl text-xs transition cursor-pointer"
            >
              ← Requests list
            </button>
          )}
          <button
            onClick={exportExcel}
            disabled={rows.length === 0}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-extrabold px-4 py-1.5 rounded-xl text-xs shadow-md transition cursor-pointer"
          >
            Export Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 bg-slate-50 p-4 rounded-2xl border">
        <div>
          <label className={label}>Requested from</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Requested to</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Assigned to</label>
          <MultiSelectFilter options={assigneeOptions} selected={assigneeFilter} onChange={setAssigneeFilter} allLabel="Everyone" noun="people" />
        </div>
        <div>
          <label className={label}>Branches</label>
          <MultiSelectFilter options={branchOptions} selected={branchFilter} onChange={setBranchFilter} allLabel="All branches" noun="branches" />
        </div>
        <div>
          <label className={label}>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={field}>
            <option value="All">All statuses</option>
            <option value="New">New</option>
            <option value="In Progress">In Progress</option>
            <option value="Completed">Completed</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-[11px] font-bold">
        {chips.map((c) => (
          <span key={c.k} className="px-2.5 py-1 rounded-full" style={{ backgroundColor: c.bg, color: c.fg }}>{c.text}</span>
        ))}
      </div>

      {summary.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-black text-slate-900">By person</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                  <th className="p-3">Person</th>
                  <th className="p-3">Requests</th>
                  <th className="p-3">Completed</th>
                  <th className="p-3">In progress</th>
                  <th className="p-3">Avg time to complete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs font-medium">
                {summary.map((s) => (
                  <tr key={s.name} className="hover:bg-slate-50">
                    <td className="p-3">
                      <span className="font-bold text-slate-900">{s.name === UNASSIGNED ? 'Unassigned' : s.name}</span>
                      {s.role && <span className="ml-1.5 text-[10px] text-slate-400">{s.role}</span>}
                    </td>
                    <td className="p-3 text-slate-700">{s.total}</td>
                    <td className="p-3 font-bold" style={{ color: '#065f46' }}>{s.completed}</td>
                    <td className="p-3 text-slate-700">{s.inProgress}</td>
                    <td className="p-3 text-slate-700">{fmtDuration(s.avgMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-black text-slate-900">All requests ({rows.length})</h3>
        {rows.length === 0 ? (
          <p className="text-xs text-slate-400 italic">No requests match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                  <th className="p-3">Request</th>
                  <th className="p-3">Branch</th>
                  <th className="p-3">Requested</th>
                  <th className="p-3">Assigned to</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Completed</th>
                  <th className="p-3">Time to complete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs font-medium">
                {rows.map((r) => {
                  const tone = STATUS_TONE[r.status] || STATUS_TONE.New;
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 align-top">
                      <td className="p-3">
                        <span className="font-bold text-slate-900">{r.title}</span>
                        {r.category && <span className="block text-[10px] text-slate-400">{r.category}</span>}
                        {r.archived && <span className="block text-[10px] text-slate-400">Archived</span>}
                      </td>
                      <td className="p-3 text-slate-700">{r.branch}</td>
                      <td className="p-3 text-slate-700 whitespace-nowrap">
                        {fmtDateTime(r.created)}
                        <span className="block text-[10px] text-slate-400">by {r.createdBy || '—'}</span>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        {r.assignedTo
                          ? (<><span className="font-bold text-slate-900">{r.assignedTo}</span><span className="block text-[10px] text-slate-400">{r.assigned ? fmtDateTime(r.assigned) : ''}</span></>)
                          : <span className="text-slate-400">Unassigned</span>}
                      </td>
                      <td className="p-3">
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap" style={{ backgroundColor: tone.bg, color: tone.fg }}>{r.status}</span>
                      </td>
                      <td className="p-3 text-slate-700 whitespace-nowrap">
                        {fmtDateTime(r.completed)}
                        {r.completedBy && <span className="block text-[10px] text-slate-400">by {r.completedBy}</span>}
                      </td>
                      <td className="p-3 text-slate-700 whitespace-nowrap">{fmtDuration(r.timeToComplete)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-400">
        Assignment and completion times are recorded from now on, so older requests may show "—" for them.
      </p>
    </div>
  );
}

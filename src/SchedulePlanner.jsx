import React, { useState, useEffect, useMemo } from 'react';
import { db, functions } from './firebase';
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import MultiSelectFilter from './MultiSelectFilter';

/* =====================================================================
   Attendance roster ("Schedule")
   - Admin / Branch Manager / Supervisor plan who works where, on which days and hours
   - Admin, CEO, HR, Branch Manager (and the Supervisor who created them) see the schedule
   - "Plan vs Actual" compares every planned shift with the real check-ins
   - every employee sees their own upcoming shifts in the Attendance portal
   ===================================================================== */

// ---------- small helpers ----------
const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return toYmd(d);
};
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const hhmmOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmt12 = (hhmm) => {
  if (!hhmm || hhmm === '—') return '—';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
};
const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const dayLabel = (s) => parseYmd(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
// minutes between local midnight of `ymd` and the moment `d` (works for shifts that cross midnight)
// Wall-clock minutes between local midnight of `ymd` and the moment `d`, exactly as the clock shows them:
// seconds are dropped (09:00:40 is 09:00, like the screen) and daylight-saving days are handled correctly.
const minsSince = (ymd, d) => {
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((dayStart - parseYmd(ymd)) / 86400000);
  return dayDiff * 1440 + d.getHours() * 60 + d.getMinutes();
};
const byDateTime = (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || (a.username || '').localeCompare(b.username || '');
const norm = (r) => (r || '').trim().toLowerCase();

// Egypt's week starts on Saturday. `i` is JavaScript's getDay() (0 = Sunday).
const WEEKDAYS = [
  { i: 6, l: 'Sat' }, { i: 0, l: 'Sun' }, { i: 1, l: 'Mon' }, { i: 2, l: 'Tue' },
  { i: 3, l: 'Wed' }, { i: 4, l: 'Thu' }, { i: 5, l: 'Fri' }
];

const PERIODS = [
  { key: '1d', label: '1 day', days: 1 },
  { key: '1w', label: '1 week', days: 7 },
  { key: '2w', label: '2 weeks', days: 14 },
  { key: '3w', label: '3 weeks', days: 21 },
  { key: '1m', label: '1 month (maximum)', days: 30 }
];

// NO grace period: one minute after the planned start is "Late", one minute before the planned end is "Left early".
// After the planned end the Departure column shows a dash (overtime is not calculated). This is how many minutes
// past the planned end still count as "On time" before that dash appears (0 = any minute after the end).
const DASH_AFTER_PLANNED_END_MIN = 0;

// colors are inline so they render the same everywhere
const TONES = {
  on_time:      { bg: '#d1fae5', fg: '#065f46', argb: 'FFD1FAE5', label: 'On time' },
  late:         { bg: '#fef3c7', fg: '#92400e', argb: 'FFFEF3C7', label: 'Late' },
  absent:       { bg: '#ffe4e6', fg: '#9f1239', argb: 'FFFFE4E6', label: 'Absent' },
  wrong_branch: { bg: '#ffedd5', fg: '#9a3412', argb: 'FFFFEDD5', label: 'Wrong branch' },
  upcoming:     { bg: '#e0e7ff', fg: '#3730a3', argb: 'FFE0E7FF', label: 'Upcoming' },
  unplanned:    { bg: '#f1f5f9', fg: '#475569', argb: 'FFF1F5F9', label: 'Unplanned' }
};

function ToneBadge({ category, text }) {
  const t = TONES[category] || TONES.unplanned;
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap"
      style={{ backgroundColor: t.bg, color: t.fg }}
    >
      {text || t.label}
    </span>
  );
}

async function saveWorkbook(fileName, sheets) {
  const wb = new ExcelJS.Workbook();
  sheets.forEach((s) => {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.columns;
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    s.rows.forEach((r) => {
      const row = ws.addRow(r.data);
      if (r.tone && s.toneColumn) {
        row.getCell(s.toneColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TONES[r.tone].argb } };
      }
    });
  });
  const buffer = await wb.xlsx.writeBuffer();
  saveAs(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    fileName
  );
}

/* =====================================================================
   Hook: loads the shifts this account is allowed to see.
   Admin / CEO / HR / Branch Manager / Supervisor read the whole roster (the screen narrows it down),
   everyone else only their own shifts.
   ===================================================================== */
export function useAttendancePlans({ enabled, role, userId }) {
  const [plans, setPlans] = useState([]);

  useEffect(() => {
    if (!enabled || !userId) {
      setPlans([]);
      return undefined;
    }
    const seesEverything = ['Admin', 'CEO', 'HR', 'Branch Manager', 'Supervisor'].includes(role);
    const source = seesEverything
      ? collection(db, 'attendancePlans')
      : query(collection(db, 'attendancePlans'), where('userId', '==', userId));

    const unsub = onSnapshot(
      source,
      (snap) => setPlans(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.warn('Could not load the schedule:', err.message)
    );
    return () => unsub();
  }, [enabled, role, userId]);

  return plans;
}

/* =====================================================================
   Card shown in the Attendance portal: the employee's own upcoming shifts
   ===================================================================== */
export function MyScheduleCard({ plans, userId }) {
  const today = toYmd(new Date());
  const horizon = addDays(today, 14);

  const mine = useMemo(
    () => (plans || []).filter((p) => p.userId === userId && p.date >= today && p.date <= horizon).sort(byDateTime),
    [plans, userId, today, horizon]
  );
  const todayShifts = mine.filter((p) => p.date === today);
  const later = mine.filter((p) => p.date !== today);

  return (
    <div className="text-left space-y-3 pt-2">
      <h3 className="text-sm font-black text-slate-900">📅 My Schedule</h3>

      {todayShifts.length > 0 && (
        <div className="p-3 rounded-xl text-xs space-y-1" style={{ backgroundColor: '#e0e7ff', color: '#3730a3', border: '1px solid #c7d2fe' }}>
          <p className="font-black uppercase tracking-wider text-[10px]">Planned for you today</p>
          {todayShifts.map((p) => (
            <p key={p.id} className="font-bold text-sm">
              📍 {p.branch} &middot; {fmt12(p.startTime)} – {fmt12(p.endTime)}
            </p>
          ))}
        </div>
      )}

      {mine.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No shifts are planned for you in the next 2 weeks.</p>
      ) : (
        later.length > 0 && (
          <div className="space-y-1.5" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {later.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                <span className="font-bold text-slate-800">{dayLabel(p.date)}</span>
                <span className="text-slate-600 font-semibold">📍 {p.branch}</span>
                <span className="text-slate-500 font-bold">{fmt12(p.startTime)} – {fmt12(p.endTime)}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

/* =====================================================================
   Main component (the "Schedule" tab)
   ===================================================================== */
export default function SchedulePlanner({ user, usersList = [], branches = [], attendanceRecords = [], plans = [] }) {
  const role = user?.role || '';
  const isAdmin = role === 'Admin';
  const isBM = role === 'Branch Manager';
  const isSupervisor = role === 'Supervisor';
  const canPlan = isAdmin || isBM || isSupervisor;

  // branches come from the live profile, so a change made by a manager or an Admin applies without logging in again
  const liveMe = usersList.find((u) => u.id === user?.id) || user;
  const myBranchesKey = Array.isArray(liveMe?.assignedBranches) ? liveMe.assignedBranches.join('|') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const myBranches = useMemo(() => (Array.isArray(liveMe?.assignedBranches) ? liveMe.assignedBranches : []), [myBranchesKey]);
  const [section, setSection] = useState('plan');

  const sharesBranch = (u) => (Array.isArray(u.assignedBranches) ? u.assignedBranches : []).some((b) => myBranches.includes(b));

  // people this account may plan:
  //   Admin -> Branch Managers, Supervisors, Users
  //   Branch Manager -> Supervisors and Users who share a branch with them
  //   Supervisor -> Users who share a branch with them
  const plannableUsers = useMemo(() => {
    return usersList
      .filter((u) => {
        const r = norm(u.role);
        if (isAdmin) return ['branch manager', 'supervisor', 'user', 'staff'].includes(r);
        if (isBM) return ['supervisor', 'user', 'staff'].includes(r) && sharesBranch(u);
        if (isSupervisor) return ['user', 'staff'].includes(r) && sharesBranch(u);
        return false;
      })
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usersList, isAdmin, isBM, isSupervisor, myBranches]);

  // branches this account may plan at (Admin: all)
  const plannableBranches = useMemo(() => {
    const names = branches.map((b) => b.name);
    return (isAdmin ? names : names.filter((n) => myBranches.includes(n))).sort((a, b) => a.localeCompare(b));
  }, [branches, isAdmin, myBranches]);

  // which shifts this account can see
  const visiblePlans = useMemo(() => {
    if (isAdmin || role === 'CEO' || role === 'HR') return plans;
    // Branch Manager and Supervisor see EVERY shift at their own branches (whoever planned it),
    // plus any shift they planned themselves
    if (isBM || isSupervisor) return plans.filter((p) => myBranches.includes(p.branch) || p.createdBy === user.id);
    return [];
  }, [plans, isAdmin, isBM, isSupervisor, role, myBranches, user]);

  // whose attendance the plan-vs-actual report may show as "unplanned"
  const scopeUsernames = useMemo(() => {
    if (isAdmin || role === 'CEO' || role === 'HR') return new Set(usersList.map((u) => u.username));
    const s = new Set(plannableUsers.map((u) => u.username));
    if (user?.username) s.add(user.username);
    return s;
  }, [isAdmin, role, usersList, plannableUsers, user]);

  const tabClass = (active) =>
    `px-4 py-2 rounded-xl text-xs font-bold transition-all ${active ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200 w-fit">
        <button onClick={() => setSection('plan')} className={tabClass(section === 'plan')}>📋 Schedule</button>
        <button onClick={() => setSection('report')} className={tabClass(section === 'report')}>📊 Plan vs Actual</button>
        {(isBM || isSupervisor) && (
          <button onClick={() => setSection('team')} className={tabClass(section === 'team')}>👥 My Team</button>
        )}
      </div>

      {section === 'plan' && (
        <>
          {canPlan ? (
            <CreatePlanForm
              plannableUsers={plannableUsers}
              plannableBranches={plannableBranches}
              onOpenTeam={(isBM || isSupervisor) ? () => setSection('team') : null}
            />
          ) : (
            <div className="bg-white border border-slate-200 p-4 rounded-3xl shadow-sm text-xs text-slate-500">
              You can view the schedule here. Only an Admin, Branch Manager or Supervisor can change it.
            </div>
          )}
          <ScheduleList
            visiblePlans={visiblePlans}
            user={user}
            isAdmin={isAdmin}
            plannableBranches={plannableBranches}
          />
        </>
      )}

      {section === 'team' && (isBM || isSupervisor) && (
        <TeamBranchesPanel
          user={user}
          isBM={isBM}
          usersList={usersList}
          branches={branches}
          myBranches={myBranches}
        />
      )}

      {section === 'report' && (
        <PlanVsActualReport
          visiblePlans={visiblePlans}
          attendanceRecords={attendanceRecords}
          scopeUsernames={scopeUsernames}
        />
      )}
    </div>
  );
}

/* =====================================================================
   Create a plan (1 day up to 1 month)
   ===================================================================== */
function CreatePlanForm({ plannableUsers, plannableBranches, onOpenTeam }) {
  const today = toYmd(new Date());
  const [period, setPeriod] = useState('1w');
  const [startDate, setStartDate] = useState(addDays(today, 1));
  const [days, setDays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [branch, setBranch] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('17:00');
  const [saving, setSaving] = useState(false);
  const [resultBanner, setResultBanner] = useState(null); // { type: 'success' | 'warning', message }

  const periodDays = PERIODS.find((p) => p.key === period).days;

  const plannedDates = useMemo(() => {
    if (!startDate) return [];
    const out = [];
    for (let i = 0; i < periodDays; i++) {
      const ds = addDays(startDate, i);
      if (days.includes(parseYmd(ds).getDay())) out.push(ds);
    }
    return out;
  }, [startDate, periodDays, days]);

  const userOptions = useMemo(
    () => plannableUsers.map((u) => ({ value: u.id, label: u.username, hint: u.role || '' })),
    [plannableUsers]
  );

  const toggleDay = (i) => setDays((prev) => (prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i]));
  const totalShifts = selectedIds.length * plannedDates.length;

  const handleCreate = async () => {
    if (selectedIds.length === 0) return alert('Please choose at least one employee.');
    if (!branch) return alert('Please choose the branch.');
    if (!startDate || startDate < today) return alert('The start date cannot be in the past.');
    if (startDate > addDays(today, 30)) return alert('You can only plan up to one month ahead.');
    if (plannedDates.length === 0) return alert('No working day is selected inside this period.');
    if (!startTime || !endTime || endTime <= startTime) {
      return alert('The end time must be after the start time. For a night shift, create two shifts (before and after midnight).');
    }
    if (!window.confirm(`Create ${totalShifts} shift(s) for ${selectedIds.length} employee(s) at ${branch}?`)) return;

    setSaving(true);
    setResultBanner(null);
    try {
      const createPlans = httpsCallable(functions, 'createAttendancePlans', { timeout: 120000 });
      const res = await createPlans({ userIds: selectedIds, dates: plannedDates, branch, startTime, endTime });
      const { created = 0, skipped = 0 } = res.data || {};
      // Red/warning whenever something did NOT go through as planned (nothing created, or
      // some shifts were skipped) - green only when every shift was created cleanly.
      const isWarning = created === 0 || skipped > 0;
      setResultBanner({
        type: isWarning ? 'warning' : 'success',
        message:
          `Done! ${created} shift(s) created.` +
          (skipped > 0 ? ` ${skipped} shift(s) were skipped because they overlap a shift that already exists.` : '')
      });
      setSelectedIds([]);
    } catch (err) {
      setResultBanner({ type: 'warning', message: 'Could not save the schedule: ' + (err.message || err) });
    } finally {
      setSaving(false);
    }
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Create a schedule</h2>
        <p className="text-xs text-slate-500">
          Choose the period, the people, the branch and the working hours. The employees will see their shifts in their Attendance page.
        </p>
      </div>

      {resultBanner && (
        <div
          className="p-3 rounded-xl text-xs font-bold flex items-start justify-between gap-3"
          style={
            resultBanner.type === 'warning'
              ? { backgroundColor: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }
              : { backgroundColor: '#ecfdf5', border: '1px solid #a7f3d0', color: '#065f46' }
          }
        >
          <span>{resultBanner.type === 'warning' ? '⚠️ ' : '✅ '}{resultBanner.message}</span>
          <button
            type="button"
            onClick={() => setResultBanner(null)}
            className="shrink-0 opacity-70 hover:opacity-100 font-black"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {(plannableUsers.length === 0 || plannableBranches.length === 0) && (
        <div className="p-3 rounded-xl text-xs font-semibold" style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', color: '#78350f' }}>
          {plannableBranches.length === 0
            ? 'No branch is assigned to your account yet, so you cannot plan. Ask an Admin to assign your branches.'
            : 'No employees were found in your branches yet. Add your team to your branches first.'}
          {plannableBranches.length > 0 && onOpenTeam && (
            <button
              type="button"
              onClick={onOpenTeam}
              className="ml-2 px-3 py-1 rounded-lg text-[11px] font-black cursor-pointer"
              style={{ backgroundColor: '#78350f', color: '#ffffff' }}
            >
              Open My Team
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className={label}>Period</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className={field}>
            {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Start date</label>
          <input type="date" value={startDate} min={today} max={addDays(today, 30)} onChange={(e) => setStartDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Shift starts</label>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Shift ends</label>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={field} />
        </div>
      </div>

      <div>
        <label className={label}>Working days</label>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((w) => {
            const on = days.includes(w.i);
            return (
              <button
                key={w.i}
                type="button"
                onClick={() => toggleDay(w.i)}
                className="px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-all cursor-pointer"
                style={on ? { backgroundColor: '#4f46e5', color: '#fff', borderColor: '#4f46e5' } : { backgroundColor: '#fff', color: '#64748b', borderColor: '#e2e8f0' }}
              >
                {w.l}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={label}>Employees</label>
          <MultiSelectFilter
            options={userOptions}
            selected={selectedIds}
            onChange={setSelectedIds}
            allLabel="Choose employees..."
            noun="employees"
          />
        </div>
        <div>
          <label className={label}>Branch</label>
          <select value={branch} onChange={(e) => setBranch(e.target.value)} className={field}>
            <option value="">Select branch...</option>
            {plannableBranches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1">
        <p className="text-xs font-semibold text-slate-500">
          {plannedDates.length > 0
            ? `${selectedIds.length} employee(s) × ${plannedDates.length} day(s) = ${totalShifts} shift(s), from ${dayLabel(plannedDates[0])} to ${dayLabel(plannedDates[plannedDates.length - 1])}`
            : 'Pick at least one working day.'}
        </p>
        <button
          type="button"
          onClick={handleCreate}
          disabled={saving}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-bold px-6 py-2.5 rounded-xl text-xs shadow-md transition cursor-pointer"
        >
          {saving ? 'Saving...' : '📅 Create schedule'}
        </button>
      </div>
    </div>
  );
}

/* =====================================================================
   My Team: a Branch Manager / Supervisor assigns branches to the people under them
   (Branch Manager -> Supervisors and Users, Supervisor -> Users). Without branches an
   employee cannot be planned. Only the manager's OWN branches can be used.
   ===================================================================== */
function TeamBranchesPanel({ user, isBM, usersList, branches, myBranches }) {
  const [search, setSearch] = useState('');
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkBranches, setBulkBranches] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const myBranchNames = useMemo(
    () => branches.map((b) => b.name).filter((n) => myBranches.includes(n)).sort((a, b) => a.localeCompare(b)),
    [branches, myBranches]
  );
  const branchOptions = useMemo(() => myBranchNames.map((n) => ({ value: n, label: n })), [myBranchNames]);

  // people this account may manage: the right role AND (shares a branch, has no branch yet, or was created by me)
  const team = useMemo(() => {
    const q = search.trim().toLowerCase();
    return usersList
      .filter((u) => {
        const r = norm(u.role);
        const roleOk = isBM ? ['supervisor', 'user', 'staff'].includes(r) : ['user', 'staff'].includes(r);
        if (!roleOk || u.id === user.id) return false;
        const ub = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
        const inScope = ub.length === 0 || ub.some((b) => myBranches.includes(b)) || u.createdBy === user.id;
        if (!inScope) return false;
        if (onlyUnassigned && ub.length > 0) return false;
        return !q || (u.username || '').toLowerCase().includes(q);
      })
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  }, [usersList, isBM, myBranches, user, search, onlyUnassigned]);

  // only people that are on screen can be acted on in bulk
  const selectedShown = team.filter((u) => selectedIds.includes(u.id));
  const allSelected = team.length > 0 && selectedShown.length === team.length;
  const toggleOne = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSelectedIds(allSelected ? [] : team.map((u) => u.id));

  const openEdit = (u) => {
    const ub = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
    setEditing({
      id: u.id,
      username: u.username,
      role: u.role,
      mine: ub.filter((b) => myBranches.includes(b)),
      other: ub.filter((b) => !myBranches.includes(b))
    });
  };
  const toggleMine = (name) =>
    setEditing((e) => ({ ...e, mine: e.mine.includes(name) ? e.mine.filter((b) => b !== name) : [...e.mine, name] }));

  const saveEdit = async () => {
    setBusy(true);
    try {
      const update = httpsCallable(functions, 'updateTeamBranches');
      await update({ targetUserId: editing.id, branches: editing.mine, mode: 'set' });
      setEditing(null);
    } catch (err) {
      alert('Could not save: ' + (err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const applyBulk = async () => {
    if (selectedShown.length === 0) return alert('Select at least one person first.');
    if (bulkBranches.length === 0) return alert('Choose the branch(es) you want to add.');
    if (!window.confirm(`Add ${bulkBranches.join(', ')} to ${selectedShown.length} person(s)?`)) return;
    setBusy(true);
    const update = httpsCallable(functions, 'updateTeamBranches');
    let ok = 0;
    const failed = [];
    for (const u of selectedShown) {
      try {
        await update({ targetUserId: u.id, branches: bulkBranches, mode: 'add' });
        ok += 1;
      } catch (err) {
        failed.push(`${u.username}: ${err.message || err}`);
      }
    }
    setBusy(false);
    setSelectedIds([]);
    alert(`Updated ${ok} person(s).` + (failed.length ? `\nCould not update:\n${failed.join('\n')}` : ''));
  };

  const chip = (text, tone) => (
    <span
      key={text}
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={
        tone === 'mine' ? { backgroundColor: '#e0e7ff', color: '#3730a3' }
        : tone === 'none' ? { backgroundColor: '#fef3c7', color: '#92400e' }
        : { backgroundColor: '#f1f5f9', color: '#64748b' }
      }
    >
      {text}
    </span>
  );

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">My team &amp; branches</h2>
        <p className="text-xs text-slate-500">
          {isBM ? 'Supervisors and Users' : 'Users'} at your branches, plus people who have no branch yet.
          Add them to your branches so you can plan their shifts. You can only use your own branches, and their other branches are never touched.
        </p>
      </div>

      {myBranchNames.length === 0 && (
        <div className="p-3 rounded-xl text-xs font-semibold" style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', color: '#78350f' }}>
          No branch is assigned to your account yet. Ask an Admin to assign your branches first.
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-end gap-3 bg-slate-50 p-4 rounded-2xl border">
        <div className="flex-1">
          <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Search</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a name..."
            className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
          />
        </div>
        <label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer pb-2">
          <input type="checkbox" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />
          Only people with no branch
        </label>
      </div>

      <div className="flex flex-col md:flex-row md:items-end gap-3 p-4 rounded-2xl" style={{ backgroundColor: '#eef2ff', border: '1px solid #c7d2fe' }}>
        <div className="flex-1">
          <label className="block text-[10px] font-extrabold uppercase mb-1" style={{ color: '#4338ca' }}>Add the selected people ({selectedShown.length}) to</label>
          <MultiSelectFilter options={branchOptions} selected={bulkBranches} onChange={setBulkBranches} allLabel="Choose branch(es)..." noun="branches" />
        </div>
        <button
          type="button"
          onClick={applyBulk}
          disabled={busy || selectedShown.length === 0 || bulkBranches.length === 0}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-bold px-5 py-2 rounded-xl text-xs shadow-md transition cursor-pointer"
        >
          {busy ? 'Saving...' : 'Add to branches'}
        </button>
      </div>

      {team.length === 0 ? (
        <p className="text-xs text-slate-400 italic">
          {onlyUnassigned || search ? 'Nobody matches this filter.' : 'No team members found yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                <th className="p-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select everyone shown" /></th>
                <th className="p-3">Employee</th>
                <th className="p-3">Branches</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs font-medium">
              {team.map((u) => {
                const ub = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
                return (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="p-3"><input type="checkbox" checked={selectedIds.includes(u.id)} onChange={() => toggleOne(u.id)} /></td>
                    <td className="p-3">
                      <span className="font-bold text-slate-900">{u.username}</span>
                      <span className="ml-1.5 text-[10px] text-slate-400">{u.role}</span>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {ub.length === 0
                          ? chip('No branch yet', 'none')
                          : ub.map((b) => chip(b, myBranches.includes(b) ? 'mine' : 'other'))}
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => openEdit(u)}
                        disabled={myBranchNames.length === 0}
                        className="bg-indigo-50 hover:bg-indigo-600 text-indigo-600 hover:text-white border border-indigo-200 px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer disabled:opacity-40"
                      >
                        ✏️ Edit branches
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Branches of {editing.username}</h3>
              <button onClick={() => setEditing(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <p className="text-xs text-slate-500">Tick the branches of yours where this person works.</p>
            <div className="space-y-1" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {myBranchNames.map((name) => (
                <label key={name} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs font-semibold text-slate-800">
                  <input type="checkbox" checked={editing.mine.includes(name)} onChange={() => toggleMine(name)} />
                  {name}
                </label>
              ))}
            </div>
            {editing.other.length > 0 && (
              <p className="text-[11px] text-slate-400">
                Also works at: {editing.other.join(', ')} (not yours, so it stays as it is).
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold cursor-pointer">Cancel</button>
              <button onClick={saveEdit} disabled={busy} className="px-4 py-2 bg-indigo-600 disabled:bg-slate-300 text-white rounded-xl text-xs font-bold shadow-md cursor-pointer">
                {busy ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   The schedule itself: filter, edit, delete, export
   ===================================================================== */
function ScheduleList({ visiblePlans, user, isAdmin, plannableBranches }) {
  const today = toYmd(new Date());
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(addDays(today, 30));
  const [userFilter, setUserFilter] = useState([]);
  const [branchFilter, setBranchFilter] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const canModify = (p) => isAdmin || p.createdBy === user.id;

  const userOptions = useMemo(
    () => [...new Set(visiblePlans.map((p) => p.username))].sort().map((n) => ({ value: n, label: n })),
    [visiblePlans]
  );
  const branchOptions = useMemo(
    () => [...new Set(visiblePlans.map((p) => p.branch))].sort().map((n) => ({ value: n, label: n })),
    [visiblePlans]
  );

  const filtered = useMemo(() => {
    return visiblePlans
      .filter((p) => p.date >= fromDate && p.date <= toDate)
      .filter((p) => userFilter.length === 0 || userFilter.includes(p.username))
      .filter((p) => branchFilter.length === 0 || branchFilter.includes(p.branch))
      .sort(byDateTime);
  }, [visiblePlans, fromDate, toDate, userFilter, branchFilter]);

  const modifiable = filtered.filter(canModify);
  // only shifts that are on screen AND that this account may change can be deleted in bulk
  const selectedShown = modifiable.filter((p) => selectedIds.includes(p.id));
  const allSelected = modifiable.length > 0 && selectedShown.length === modifiable.length;

  const toggleOne = (id) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleAll = () => setSelectedIds(allSelected ? [] : modifiable.map((p) => p.id));

  const deleteOne = async (p) => {
    if (!window.confirm(`Delete the shift of ${p.username} on ${dayLabel(p.date)}?`)) return;
    try {
      await deleteDoc(doc(db, 'attendancePlans', p.id));
    } catch (err) {
      alert('Could not delete: ' + err.message);
    }
  };

  const deleteSelected = async () => {
    if (selectedShown.length === 0) return;
    if (!window.confirm(`Delete ${selectedShown.length} selected shift(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      for (let i = 0; i < selectedShown.length; i += 400) {
        const batch = writeBatch(db);
        selectedShown.slice(i, i + 400).forEach((p) => batch.delete(doc(db, 'attendancePlans', p.id)));
        await batch.commit();
      }
      setSelectedIds([]);
    } catch (err) {
      alert('Could not delete: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing.branch) return alert('Please choose the branch.');
    if (!editing.startTime || !editing.endTime || editing.endTime <= editing.startTime) {
      return alert('The end time must be after the start time.');
    }
    try {
      await updateDoc(doc(db, 'attendancePlans', editing.id), {
        branch: editing.branch,
        startTime: editing.startTime,
        endTime: editing.endTime
      });
      setEditing(null);
    } catch (err) {
      alert('Could not save: ' + err.message);
    }
  };

  const exportSchedule = () => {
    saveWorkbook(`Schedule_${today}.xlsx`, [{
      name: 'Schedule',
      toneColumn: null,
      columns: [
        { header: '#', key: 'n', width: 6 },
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Day', key: 'day', width: 12 },
        { header: 'Employee', key: 'user', width: 24 },
        { header: 'Role', key: 'role', width: 18 },
        { header: 'Branch', key: 'branch', width: 20 },
        { header: 'Shift Starts', key: 'start', width: 13 },
        { header: 'Shift Ends', key: 'end', width: 13 },
        { header: 'Planned By', key: 'by', width: 22 }
      ],
      rows: filtered.map((p, i) => ({
        data: {
          n: i + 1,
          date: p.date,
          day: parseYmd(p.date).toLocaleDateString('en-US', { weekday: 'long' }),
          user: p.username,
          role: p.userRole || '',
          branch: p.branch,
          start: fmt12(p.startTime),
          end: fmt12(p.endTime),
          by: p.createdByUsername || ''
        }
      }))
    }]);
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Planned shifts ({filtered.length})</h2>
          <p className="text-xs text-slate-500">Everything that is planned in the selected dates.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedShown.length > 0 && (
            <button
              onClick={deleteSelected}
              disabled={busy}
              className="bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-extrabold px-3 py-1.5 rounded-xl text-xs shadow-md transition cursor-pointer"
            >
              {busy ? 'Deleting...' : `Delete selected (${selectedShown.length})`}
            </button>
          )}
          <button
            onClick={exportSchedule}
            disabled={filtered.length === 0}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-extrabold px-4 py-1.5 rounded-xl text-xs shadow-md transition cursor-pointer"
          >
            Export Excel
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-2xl border">
        <div>
          <label className={label}>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Employees</label>
          <MultiSelectFilter options={userOptions} selected={userFilter} onChange={setUserFilter} allLabel="All employees" noun="employees" />
        </div>
        <div>
          <label className={label}>Branches</label>
          <MultiSelectFilter options={branchOptions} selected={branchFilter} onChange={setBranchFilter} allLabel="All branches" noun="branches" />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No shifts are planned in these dates.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                <th className="p-3">
                  {modifiable.length > 0 && <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shifts you can change" />}
                </th>
                <th className="p-3">Date</th>
                <th className="p-3">Employee</th>
                <th className="p-3">Branch</th>
                <th className="p-3">Hours</th>
                <th className="p-3">Planned by</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs font-medium">
              {filtered.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="p-3">
                    {canModify(p) && <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleOne(p.id)} />}
                  </td>
                  <td className="p-3 font-bold text-slate-900 whitespace-nowrap">{dayLabel(p.date)}</td>
                  <td className="p-3">
                    <span className="font-bold text-slate-900">{p.username}</span>
                    <span className="ml-1.5 text-[10px] text-slate-400">{p.userRole}</span>
                  </td>
                  <td className="p-3 text-slate-700">📍 {p.branch}</td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">{fmt12(p.startTime)} – {fmt12(p.endTime)}</td>
                  <td className="p-3 text-slate-500">{p.createdByUsername}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    {canModify(p) && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditing({ id: p.id, username: p.username, date: p.date, branch: p.branch, startTime: p.startTime, endTime: p.endTime })}
                          className="bg-indigo-50 hover:bg-indigo-600 text-indigo-600 hover:text-white border border-indigo-200 px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer"
                        >
                          ✏️ Edit
                        </button>
                        <button
                          onClick={() => deleteOne(p)}
                          className="bg-rose-600 hover:bg-rose-700 text-white px-2.5 py-1 rounded-xl text-xs font-bold shadow-sm transition-all cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-3xl shadow-xl w-full max-w-sm p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Edit shift &middot; {editing.username}</h3>
              <button onClick={() => setEditing(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <p className="text-xs text-slate-500">{dayLabel(editing.date)}</p>
            <div>
              <label className={label}>Branch</label>
              <select value={editing.branch} onChange={(e) => setEditing({ ...editing, branch: e.target.value })} className={field}>
                {[...new Set([...plannableBranches, editing.branch])].map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Shift starts</label>
                <input type="time" value={editing.startTime} onChange={(e) => setEditing({ ...editing, startTime: e.target.value })} className={field} />
              </div>
              <div>
                <label className={label}>Shift ends</label>
                <input type="time" value={editing.endTime} onChange={(e) => setEditing({ ...editing, endTime: e.target.value })} className={field} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold cursor-pointer">Cancel</button>
              <button onClick={saveEdit} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow-md cursor-pointer">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   Plan vs Actual
   ===================================================================== */

// Compare one planned shift with the sessions the employee really had.
function evaluatePlan(plan, sessions, todayYmd, nowMin) {
  const startMin = minutesOf(plan.startTime);
  const endMin = minutesOf(plan.endTime);
  const isFuture = plan.date > todayYmd;
  const isToday = plan.date === todayYmd;

  if (sessions.length === 0) {
    if (isFuture || (isToday && nowMin <= startMin)) return { category: 'upcoming', arrival: 'Upcoming', departure: '—' };
    if (isToday && nowMin <= endMin) return { category: 'late', arrival: 'Not checked in yet', departure: '—' };
    return { category: 'absent', arrival: 'Absent', departure: '—' };
  }

  const atPlanned = sessions.filter((s) => s.branch === plan.branch);
  let category;
  let arrival;
  if (atPlanned.length === 0) {
    category = 'wrong_branch';
    arrival = `At ${[...new Set(sessions.map((s) => s.branch))].join(', ')}`;
  } else {
    const late = minsSince(plan.date, atPlanned[0].inDate) - startMin;
    if (late > 0) {
      category = 'late';
      arrival = `Late by ${fmtMin(late)}`;
    } else {
      category = 'on_time';
      arrival = 'On time';
    }
  }

  const last = sessions[sessions.length - 1];
  let departure;
  if (!last.outDate) {
    departure = plan.date < todayYmd ? 'No check-out' : 'Still in';
  } else {
    const outMin = minsSince(plan.date, last.outDate);
    if (outMin < endMin) departure = `Left early by ${fmtMin(endMin - outMin)}`;
    else if (outMin > endMin + DASH_AFTER_PLANNED_END_MIN) departure = '—'; // stayed after the planned end (overtime): nothing is calculated, just a dash
    else departure = 'On time';
  }
  return { category, arrival, departure };
}

function PlanVsActualReport({ visiblePlans, attendanceRecords, scopeUsernames }) {
  const today = toYmd(new Date());
  const [fromDate, setFromDate] = useState(addDays(today, -6));
  const [toDate, setToDate] = useState(today);
  const [userFilter, setUserFilter] = useState([]);
  const [branchFilter, setBranchFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [includeUnplanned, setIncludeUnplanned] = useState(false);
  const [tick, setTick] = useState(0);

  // keep "upcoming / not checked in yet" fresh while the page stays open
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  // real sessions grouped by employee and by LOCAL day (taken from the check-in time itself)
  const sessionsMap = useMemo(() => {
    const map = new Map();
    attendanceRecords.forEach((r) => {
      if (r.isArchived) return;
      const inDate = r.checkInTime?.toDate ? r.checkInTime.toDate() : null;
      if (!inDate) return;
      const date = toYmd(inDate);
      const key = `${r.username}|${date}`;
      if (!map.has(key)) map.set(key, { username: r.username, date, sessions: [] });
      map.get(key).sessions.push({
        branch: r.branch,
        inDate,
        outDate: r.checkOutTime?.toDate ? r.checkOutTime.toDate() : null
      });
    });
    map.forEach((v) => v.sessions.sort((a, b) => a.inDate - b.inDate));
    return map;
  }, [attendanceRecords]);

  const userOptions = useMemo(() => {
    const names = new Set(visiblePlans.map((p) => p.username));
    if (includeUnplanned) scopeUsernames.forEach((n) => names.add(n));
    return [...names].filter(Boolean).sort().map((n) => ({ value: n, label: n }));
  }, [visiblePlans, includeUnplanned, scopeUsernames]);

  const branchOptions = useMemo(
    () => [...new Set(visiblePlans.map((p) => p.branch))].sort().map((n) => ({ value: n, label: n })),
    [visiblePlans]
  );

  const baseRows = useMemo(() => {
    const now = new Date();
    const todayYmd = toYmd(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const inRange = (d) => d >= fromDate && d <= toDate;
    const keyOf = (username, date) => `${username}|${date}`;

    const plannedKeys = new Set(visiblePlans.map((p) => keyOf(p.username, p.date)));
    const shiftsPerKey = new Map();
    visiblePlans.forEach((p) => {
      const k = keyOf(p.username, p.date);
      shiftsPerKey.set(k, (shiftsPerKey.get(k) || 0) + 1);
    });

    // one row per planned shift
    const rows = visiblePlans.filter((p) => inRange(p.date)).map((p) => {
      const k = keyOf(p.username, p.date);
      const day = sessionsMap.get(k);
      let sessions = day ? day.sessions : [];
      // several shifts on the same day: only count the sessions that fall around this shift
      if (shiftsPerKey.get(k) > 1) {
        const s0 = minutesOf(p.startTime) - 120;
        const e0 = minutesOf(p.endTime) + 120;
        sessions = sessions.filter((s) => {
          const a = minsSince(p.date, s.inDate);
          const b = s.outDate ? minsSince(p.date, s.outDate) : a;
          return a <= e0 && b >= s0;
        });
      }
      const ev = evaluatePlan(p, sessions, todayYmd, nowMin);
      const last = sessions[sessions.length - 1];
      const worked = sessions.reduce((sum, s) => (s.outDate ? sum + Math.max(0, Math.round((s.outDate - s.inDate) / 60000)) : sum), 0);
      return {
        key: p.id,
        date: p.date,
        username: p.username,
        role: p.userRole || '',
        plannedBranch: p.branch,
        plannedStart: p.startTime,
        plannedEnd: p.endTime,
        actualBranches: [...new Set(sessions.map((s) => s.branch))].join(', ') || '—',
        actualIn: sessions.length ? hhmmOf(sessions[0].inDate) : '—',
        actualOut: last && last.outDate ? hhmmOf(last.outDate) : '—',
        arrival: ev.arrival,
        departure: ev.departure,
        category: ev.category,
        workedMin: worked
      };
    });

    // attendance nobody planned (optional)
    if (includeUnplanned) {
      sessionsMap.forEach((v, k) => {
        if (!inRange(v.date) || plannedKeys.has(k) || !scopeUsernames.has(v.username)) return;
        const last = v.sessions[v.sessions.length - 1];
        const worked = v.sessions.reduce((sum, s) => (s.outDate ? sum + Math.max(0, Math.round((s.outDate - s.inDate) / 60000)) : sum), 0);
        rows.push({
          key: `unplanned-${k}`,
          date: v.date,
          username: v.username,
          role: '',
          plannedBranch: '—',
          plannedStart: '—',
          plannedEnd: '—',
          actualBranches: [...new Set(v.sessions.map((s) => s.branch))].join(', '),
          actualIn: hhmmOf(v.sessions[0].inDate),
          actualOut: last.outDate ? hhmmOf(last.outDate) : '—',
          arrival: 'Not planned',
          departure: last.outDate ? '' : 'Still in',
          category: 'unplanned',
          workedMin: worked
        });
      });
    }

    return rows
      .filter((r) => userFilter.length === 0 || userFilter.includes(r.username))
      .filter((r) => {
        if (branchFilter.length === 0) return true;
        if (r.category === 'unplanned') return r.actualBranches.split(', ').some((b) => branchFilter.includes(b));
        return branchFilter.includes(r.plannedBranch);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePlans, sessionsMap, fromDate, toDate, userFilter, branchFilter, includeUnplanned, scopeUsernames, tick]);

  const rows = useMemo(() => {
    const list = statusFilter === 'all' ? baseRows : baseRows.filter((r) => r.category === statusFilter);
    return [...list].sort((a, b) => b.date.localeCompare(a.date) || a.username.localeCompare(b.username));
  }, [baseRows, statusFilter]);

  const count = (c) => baseRows.filter((r) => r.category === c).length;
  const plannedCount = baseRows.filter((r) => r.category !== 'unplanned').length;
  const attended = count('on_time') + count('late') + count('wrong_branch');
  const decided = attended + count('absent');
  const attendanceRate = decided > 0 ? Math.round((attended / decided) * 100) : null;

  const exportReport = () => {
    saveWorkbook(`Plan_vs_Actual_${fromDate}_to_${toDate}.xlsx`, [
      {
        name: 'Plan vs Actual',
        toneColumn: 14,
        columns: [
          { header: '#', key: 'n', width: 6 },
          { header: 'Date', key: 'date', width: 14 },
          { header: 'Day', key: 'day', width: 12 },
          { header: 'Employee', key: 'user', width: 24 },
          { header: 'Role', key: 'role', width: 16 },
          { header: 'Planned Branch', key: 'pb', width: 20 },
          { header: 'Planned In', key: 'pin', width: 12 },
          { header: 'Planned Out', key: 'pout', width: 12 },
          { header: 'Actual Branch(es)', key: 'ab', width: 22 },
          { header: 'Actual In', key: 'ain', width: 12 },
          { header: 'Actual Out', key: 'aout', width: 12 },
          { header: 'Arrival', key: 'arr', width: 22 },
          { header: 'Departure', key: 'dep', width: 22 },
          { header: 'Result', key: 'res', width: 16 },
          { header: 'Time Worked', key: 'wk', width: 14 }
        ],
        rows: rows.map((r, i) => ({
          tone: r.category,
          data: {
            n: i + 1,
            date: r.date,
            day: parseYmd(r.date).toLocaleDateString('en-US', { weekday: 'long' }),
            user: r.username,
            role: r.role,
            pb: r.plannedBranch,
            pin: fmt12(r.plannedStart),
            pout: fmt12(r.plannedEnd),
            ab: r.actualBranches,
            ain: fmt12(r.actualIn),
            aout: fmt12(r.actualOut),
            arr: r.arrival,
            dep: r.departure,
            res: TONES[r.category].label,
            wk: r.workedMin > 0 ? fmtMin(r.workedMin) : ''
          }
        }))
      },
      {
        name: 'Schedule',
        columns: [
          { header: 'Date', key: 'date', width: 14 },
          { header: 'Employee', key: 'user', width: 24 },
          { header: 'Branch', key: 'branch', width: 20 },
          { header: 'Shift Starts', key: 'start', width: 13 },
          { header: 'Shift Ends', key: 'end', width: 13 },
          { header: 'Planned By', key: 'by', width: 22 }
        ],
        rows: visiblePlans
          .filter((p) => p.date >= fromDate && p.date <= toDate)
          .filter((p) => userFilter.length === 0 || userFilter.includes(p.username))
          .filter((p) => branchFilter.length === 0 || branchFilter.includes(p.branch))
          .sort(byDateTime)
          .map((p) => ({ data: { date: p.date, user: p.username, branch: p.branch, start: fmt12(p.startTime), end: fmt12(p.endTime), by: p.createdByUsername || '' } }))
      }
    ]);
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  const chips = [
    { k: 'planned', text: `Planned shifts: ${plannedCount}`, bg: '#f1f5f9', fg: '#334155' },
    { k: 'on_time', text: `On time: ${count('on_time')}`, ...TONES.on_time },
    { k: 'late', text: `Late: ${count('late')}`, ...TONES.late },
    { k: 'absent', text: `Absent: ${count('absent')}`, ...TONES.absent },
    { k: 'wrong_branch', text: `Wrong branch: ${count('wrong_branch')}`, ...TONES.wrong_branch },
    { k: 'upcoming', text: `Upcoming: ${count('upcoming')}`, ...TONES.upcoming }
  ];
  if (includeUnplanned) chips.push({ k: 'unplanned', text: `Unplanned: ${count('unplanned')}`, ...TONES.unplanned });
  if (attendanceRate !== null) chips.push({ k: 'rate', text: `Attendance rate: ${attendanceRate}%`, bg: '#4f46e5', fg: '#ffffff' });

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Plan vs Actual</h2>
          <p className="text-xs text-slate-500">Every planned shift next to what really happened at the branch.</p>
        </div>
        <button
          onClick={exportReport}
          disabled={rows.length === 0}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-extrabold px-4 py-1.5 rounded-xl text-xs shadow-md transition cursor-pointer"
        >
          Export Excel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 bg-slate-50 p-4 rounded-2xl border">
        <div>
          <label className={label}>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={field} />
        </div>
        <div>
          <label className={label}>Employees</label>
          <MultiSelectFilter options={userOptions} selected={userFilter} onChange={setUserFilter} allLabel="All employees" noun="employees" />
        </div>
        <div>
          <label className={label}>Branches</label>
          <MultiSelectFilter options={branchOptions} selected={branchFilter} onChange={setBranchFilter} allLabel="All branches" noun="branches" />
        </div>
        <div>
          <label className={label}>Result</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={field}>
            <option value="all">All results</option>
            {Object.keys(TONES).filter((k) => includeUnplanned || k !== 'unplanned').map((k) => (
              <option key={k} value={k}>{TONES[k].label}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer w-fit">
        <input type="checkbox" checked={includeUnplanned} onChange={(e) => { setIncludeUnplanned(e.target.checked); if (!e.target.checked && statusFilter === 'unplanned') setStatusFilter('all'); }} />
        Also show attendance that nobody planned
      </label>

      <div className="flex flex-wrap gap-2 text-[11px] font-bold">
        {chips.map((c) => (
          <span key={c.k} className="px-2.5 py-1 rounded-full" style={{ backgroundColor: c.bg, color: c.fg }}>{c.text}</span>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 italic">Nothing to compare in these dates.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                <th className="p-3">Date</th>
                <th className="p-3">Employee</th>
                <th className="p-3">Planned</th>
                <th className="p-3">Actual</th>
                <th className="p-3">Arrival</th>
                <th className="p-3">Departure</th>
                <th className="p-3">Worked</th>
                <th className="p-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs font-medium">
              {rows.map((r) => (
                <tr key={r.key} className="hover:bg-slate-50">
                  <td className="p-3 font-bold text-slate-900 whitespace-nowrap">{dayLabel(r.date)}</td>
                  <td className="p-3">
                    <span className="font-bold text-slate-900">{r.username}</span>
                    {r.role && <span className="ml-1.5 text-[10px] text-slate-400">{r.role}</span>}
                  </td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">
                    {r.category === 'unplanned' ? '—' : (<>📍 {r.plannedBranch}<br /><span className="text-slate-500">{fmt12(r.plannedStart)} – {fmt12(r.plannedEnd)}</span></>)}
                  </td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">
                    {r.actualIn === '—' ? '—' : (<>📍 {r.actualBranches}<br /><span className="text-slate-500">{fmt12(r.actualIn)} – {fmt12(r.actualOut)}</span></>)}
                  </td>
                  <td className="p-3 text-slate-700">{r.arrival}</td>
                  <td className="p-3 text-slate-700">{r.departure}</td>
                  <td className="p-3 text-slate-700 whitespace-nowrap">{r.workedMin > 0 ? fmtMin(r.workedMin) : '—'}</td>
                  <td className="p-3"><ToneBadge category={r.category} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

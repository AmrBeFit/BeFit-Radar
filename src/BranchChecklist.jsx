import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
import ChecklistSummary from './ChecklistSummary';
import {
  collection,
  doc,
  setDoc,
  addDoc,
  onSnapshot,
  serverTimestamp
} from 'firebase/firestore';

/* =====================================================================
   Branch checklist: the paper "Daily Checklist" clipboard, digitized.
   -----------------------------------------------------------------
   One master list of items (set by Admin), checked off every hour
   through the day, per branch. Whoever is checked in at that branch right
   now can tick items for the current (or a recently-passed) time slot -
   never a future one, and never a past day's slots once the day is over.
   Admin / Branch Manager / Supervisor can sign off the whole day, the way
   the paper sheet has a "Head Coach / Admin Signature" line at the bottom.
   ===================================================================== */

const pad = (n) => String(n).padStart(2, '0');
const toLocalYmd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Builds the list of time slots ("06:00", "06:30", ...) between start and end (inclusive of start AND end,
// so a 23:00 closing time gives a 23:00 column), at a fixed interval. Wrapping past midnight (e.g. 07:00 -> next day 09:00, like
// the Arena sheet) is supported: if end <= start, the range is treated as continuing into the next day.
const buildSlots = (startTime, endTime, intervalMinutes) => {
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMin(startTime);
  let end = toMin(endTime);
  if (end <= start) end += 24 * 60;
  const slots = [];
  for (let t = start; t <= end; t += intervalMinutes) {
    const mins = t % (24 * 60);
    const label = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    if (!slots.includes(label)) slots.push(label);
  }
  return slots;
};

// A slot is "reachable" (can be ticked today) once its time has arrived and the day isn't over.
// Slots are compared as plain minute-of-day numbers against the current time.
const isSlotReachable = (slot, nowHmValue) => {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  return toMin(slot) <= toMin(nowHmValue);
};

const sanitizeForId = (s) => (s || '').replace(/[/\s]+/g, '-');

const DEFAULT_ITEMS = [
  'Desk', 'Benches', 'Flooring', 'Cardio machines', 'Toilets', 'Lockers', 'Mirrors', 'Music'
].map((label, i) => ({ id: `item${i + 1}`, label }));

// The checklist is ticked once per HOUR. This is a fixed constant on purpose: an older config document
// in Firestore may still say intervalMinutes: 30 (from when this was half-hourly), so the value saved
// there is deliberately ignored and never read back.
const INTERVAL_MINUTES = 60;

const DEFAULT_CONFIG = { items: DEFAULT_ITEMS, startTime: '06:00', endTime: '23:00' };

export default function BranchChecklist({ currentUser, branchesList = [], openBranch, canSignOff = false, isAdmin = false, canSeeSummary = false, onReportIssue, plans = [], plansAvailable = false }) {
  const myUsername = currentUser?.username || currentUser?.displayName || '';
  const myRole = currentUser?.role || '';

  const branchNames = useMemo(
    () => [...branchesList].map((b) => (typeof b === 'string' ? b : b.name)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [branchesList]
  );

  const today = toLocalYmd();
  const [selectedBranch, setSelectedBranch] = useState(openBranch || branchNames[0] || '');
  const [selectedDate, setSelectedDate] = useState(today);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [dayDoc, setDayDoc] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [tick, setTick] = useState(Date.now()); // re-renders every minute so "current slot" stays live

  // Prefer the branch the employee is actually checked into right now, once known.
  useEffect(() => {
    if (openBranch) setSelectedBranch(openBranch);
  }, [openBranch]);

  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Master item list + operating hours (Admin-owned).
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'branchChecklistConfig', 'config'), (snap) => {
      if (snap.exists()) setConfig({ ...DEFAULT_CONFIG, ...snap.data() });
    });
    return () => unsub();
  }, []);

  const docId = useMemo(
    () => `${sanitizeForId(selectedBranch)}_${selectedDate}`,
    [selectedBranch, selectedDate]
  );

  useEffect(() => {
    if (!selectedBranch || !selectedDate) { setDayDoc(null); return undefined; }
    const unsub = onSnapshot(doc(db, 'branchChecklists', docId), (snap) => {
      setDayDoc(snap.exists() ? snap.data() : null);
    });
    return () => unsub();
  }, [docId, selectedBranch, selectedDate]);

  // Each branch has its own working hours (set by Admin / Branch Manager / Supervisor). The checklist only
  // shows the hours inside them; a branch with no hours of its own falls back to the shared default window.
  const slotsByBranch = useMemo(() => {
    const map = {};
    branchesList.forEach((b) => {
      if (!b || typeof b === 'string' || !b.name) return;
      const start = b.openTime && b.closeTime ? b.openTime : config.startTime;
      const end = b.openTime && b.closeTime ? b.closeTime : config.endTime;
      map[b.name] = buildSlots(start, end, INTERVAL_MINUTES);
    });
    return map;
  }, [branchesList, config.startTime, config.endTime]);

  const defaultSlots = useMemo(
    () => buildSlots(config.startTime, config.endTime, INTERVAL_MINUTES),
    [config.startTime, config.endTime]
  );
  const slots = slotsByBranch[selectedBranch] || defaultSlots;
  const selectedBranchObj = useMemo(
    () => branchesList.find((b) => b && typeof b !== 'string' && b.name === selectedBranch),
    [branchesList, selectedBranch]
  );
  const branchHasHours = !!(selectedBranchObj && selectedBranchObj.openTime && selectedBranchObj.closeTime);

  const isToday = selectedDate === today;
  const currentHm = nowHM();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reachableSlots = useMemo(() => new Set(isToday ? slots.filter((s) => isSlotReachable(s, currentHm)) : []), [slots, isToday, tick]);

  const isCheckedInHere = isToday && openBranch && openBranch === selectedBranch;
  // Once the day has been signed off, the sheet is frozen for everyone except Admin.
  const signedOff = !!dayDoc?.signedOffBy;
  const lockedBySignOff = signedOff && !isAdmin;
  const canTick = (isCheckedInHere || isAdmin) && !lockedBySignOff;

  // An hour is "missed" once the next hour has begun (always true for any past day). An empty cell in a
  // missed hour is shaded and labelled "Not Checked!".
  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const isMissedSlot = (slot) => {
    if (selectedDate < today) return true;
    if (!isToday) return false;
    return toMinutes(slot) + INTERVAL_MINUTES <= toMinutes(currentHm);
  };

  const rawChecks = dayDoc?.checks || {};
  const cellKey = (slot, itemId) => `${slot}__${itemId}`;

  // A cell flagged "problem" while its maintenance request still exists is LOCKED (it can't be changed
  // from here). If that request is later deleted, the cell unlocks so it can be corrected. We watch each
  // linked request; anything we can't confirm is deleted (including a permission error) stays locked.
  const linkedRequestIds = useMemo(() => {
    const ids = new Set();
    Object.values(rawChecks).forEach((c) => { if (c && c.issue && c.requestId) ids.add(c.requestId); });
    return [...ids].sort();
  }, [rawChecks]);
  const linkedKey = linkedRequestIds.join('|');
  const [deletedRequestIds, setDeletedRequestIds] = useState({});
  useEffect(() => {
    if (linkedRequestIds.length === 0) return undefined;
    const unsubs = linkedRequestIds.map((rid) =>
      onSnapshot(
        doc(db, 'requests', rid),
        (snap) => setDeletedRequestIds((prev) => (prev[rid] === !snap.exists() ? prev : { ...prev, [rid]: !snap.exists() })),
        () => {}
      )
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedKey]);
  // What the grid shows: a cell whose maintenance request has been deleted goes back to looking exactly
  // like a cell nobody has touched yet (no leftover icon, no checker name, counts as not done).
  const checks = useMemo(() => {
    const out = {};
    Object.entries(rawChecks).forEach(([k, c]) => {
      if (c && c.issue && c.requestId && deletedRequestIds[c.requestId] === true) return;
      out[k] = c;
    });
    return out;
  }, [rawChecks, deletedRequestIds]);
  const isCellLocked = (slot, itemId) => {
    const c = checks[cellKey(slot, itemId)];
    if (!c || !c.issue) return false;
    // Older flags (made before the request id was recorded) can't be checked, so only Admin may change them.
    if (!c.requestId) return !isAdmin;
    return deletedRequestIds[c.requestId] !== true;
  };
  const isCellRequestDeleted = (c) => !!(c && c.issue && c.requestId && deletedRequestIds[c.requestId] === true);

  // Tapping a cell opens a small panel (below) instead of toggling directly, because a cell now has
  // three possible outcomes: mark OK, undo, or report a problem (which files an actual maintenance
  // request so it isn't just a silent "not checked" box).
  const [activeCell, setActiveCell] = useState(null); // { slot, itemId } | null
  const [issueNote, setIssueNote] = useState('');
  const [submittingIssue, setSubmittingIssue] = useState(false);

  // Multi-select: lets whoever is filling the checklist tick several items at once (e.g. the whole
  // current round) instead of opening the one-cell panel every single time.
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedCells, setSelectedCells] = useState(new Set());

  const toggleCellSelection = (slot, itemId) => {
    if (isCellLocked(slot, itemId)) return;
    const key = cellKey(slot, itemId);
    setSelectedCells((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const exitMultiSelect = () => {
    setMultiSelectMode(false);
    setSelectedCells(new Set());
  };

  const bulkApply = async (kind) => {
    // kind: 'ok' | 'na' | 'nc' (not completed)
    const keys = [...selectedCells].filter((k) => { const [sl, it] = k.split('__'); return !isCellLocked(sl, it); });
    if (keys.length === 0) return;
    const patchMap = {};
    keys.forEach((key) => {
      const base = { checked: false, issue: false, na: false, notCompleted: false, by: myUsername, at: serverTimestamp() };
      if (kind === 'ok') patchMap[key] = { ...base, checked: true };
      else if (kind === 'na') patchMap[key] = { ...base, na: true };
      else patchMap[key] = { ...base, notCompleted: true };
    });
    try {
      await setDoc(
        doc(db, 'branchChecklists', docId),
        {
          branch: selectedBranch,
          dateStr: selectedDate,
          checks: patchMap,
          lastUpdatedBy: myUsername,
          lastUpdatedAt: serverTimestamp()
        },
        { merge: true }
      );
      exitMultiSelect();
    } catch (err) {
      console.error(err);
      alert('Could not save these checks. Please try again.');
    }
  };

  const saveCell = async (slot, itemId, patch) => {
    const key = cellKey(slot, itemId);
    try {
      await setDoc(
        doc(db, 'branchChecklists', docId),
        {
          branch: selectedBranch,
          dateStr: selectedDate,
          checks: { [key]: { checked: false, issue: false, na: false, notCompleted: false, ...patch, by: myUsername, at: serverTimestamp() } },
          lastUpdatedBy: myUsername,
          lastUpdatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error(err);
      alert('Could not save that check. Please try again.');
    }
  };

  const markOk = async (slot, itemId) => {
    if (!canTick || !reachableSlots.has(slot) || isCellLocked(slot, itemId)) return;
    const already = checks[cellKey(slot, itemId)]?.checked;
    // Marking OK always clears any earlier "Not applicable" flag on this cell.
    await saveCell(slot, itemId, { checked: !already, na: false });
    setActiveCell(null);
  };

  // Third outcome: the item simply doesn't exist at this branch (e.g. no "Cardio machines" at a
  // small branch). Distinct from OK and from an issue - shown in amber, and doesn't block progress.
  const markNA = async (slot, itemId) => {
    if (!canTick || !reachableSlots.has(slot) || isCellLocked(slot, itemId)) return;
    const already = checks[cellKey(slot, itemId)]?.na;
    await saveCell(slot, itemId, { na: !already, checked: false });
    setActiveCell(null);
  };

  // Fourth outcome: the round happened but this item was NOT completed. Unlike "Report a problem", this
  // is only a record on the checklist - it never opens or files a maintenance request.
  const markNotCompleted = async (slot, itemId) => {
    if (!canTick || !reachableSlots.has(slot) || isCellLocked(slot, itemId)) return;
    const already = checks[cellKey(slot, itemId)]?.notCompleted;
    await saveCell(slot, itemId, { notCompleted: !already, checked: false, na: false });
    setActiveCell(null);
  };

  // Reports a problem found during the round: hands off to the REAL "Create Maintenance Request" form
  // (pre-filled with the branch, a title and a description) so the person can attach a live photo and
  // pick a category just like any other maintenance request. The checklist cell is NOT marked yet -
  // the parent marks it only once the request has actually been SUBMITTED (checklistRef below carries
  // everything needed to do that), so merely opening the form never shows "request made".
  const submitIssue = async (slot, item) => {
    setSubmittingIssue(true);
    try {
      const prefill = {
        checklistRef: { docId, slot, itemId: item.id, branch: selectedBranch, dateStr: selectedDate, note: issueNote.trim() },
        branch: selectedBranch,
        title: `Checklist: ${item.label} (${selectedBranch})`,
        description: issueNote.trim() || `Flagged as not OK during the ${slot} branch checklist round.`
      };

      setIssueNote('');
      setActiveCell(null);

      if (onReportIssue) {
        // Lets the parent (Dashboard) switch to the Requests tab and open the real form, pre-filled.
        onReportIssue(prefill);
      } else {
        // Fallback for older setups that haven't wired up onReportIssue yet: file the request directly.
        const created = await addDoc(collection(db, 'requests'), {
          title: prefill.title,
          description: prefill.description,
          branch: selectedBranch,
          category: '',
          imageUrl: 'NO_IMAGE',
          status: 'New',
          isArchived: false,
          createdBy: myUsername,
          createdAt: serverTimestamp()
        });
        await saveCell(slot, item.id, { checked: false, issue: true, issueNote: issueNote.trim(), requestId: created.id });
        alert('✅ تم تقديم طلب صيانة / Maintenance request submitted.');
      }
    } catch (err) {
      console.error(err);
      alert('Could not report the problem. Please try again.');
    } finally {
      setSubmittingIssue(false);
    }
  };

  // Progress: only counts slots that have already arrived today (or, for a past day, all of them).
  const relevantSlots = isToday ? slots.filter((s) => reachableSlots.has(s)) : slots;
  const totalCells = relevantSlots.length * config.items.length;
  const checkedCells = relevantSlots.reduce(
    (sum, slot) =>
      sum + config.items.filter((it) => {
        const c = checks[cellKey(slot, it.id)];
        return c?.checked || c?.na; // "Not applicable" counts as handled, not as remaining work
      }).length,
    0
  );
  const pct = totalCells > 0 ? Math.round((checkedCells / totalCells) * 100) : 0;

  const handleSignOff = async () => {
    if (!window.confirm(`Confirm that today's checklist for ${selectedBranch} has been reviewed?`)) return;
    try {
      await setDoc(
        doc(db, 'branchChecklists', docId),
        {
          branch: selectedBranch,
          dateStr: selectedDate,
          signedOffBy: myUsername,
          signedOffRole: myRole,
          signedOffAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (err) {
      console.error(err);
      alert('Could not save the sign-off.');
    }
  };

  // ---------- Admin settings: edit items / operating hours ----------
  // The item list is edited as real rows (add / delete), not a free-text box. Each item keeps a STABLE id:
  // existing items keep the id they already had, and a newly added one gets a fresh unique id. That
  // matters because past days' ticks are stored against these ids - re-numbering items by position
  // (the old behaviour) would silently re-assign old ticks to the wrong item the moment one in the
  // middle of the list was removed.
  const [itemsDraft, setItemsDraft] = useState([]); // [{ id, label }]
  const [newItemLabel, setNewItemLabel] = useState('');
  const [startDraft, setStartDraft] = useState(config.startTime);
  const [endDraft, setEndDraft] = useState(config.endTime);
  useEffect(() => {
    setItemsDraft(config.items.map((i) => ({ id: i.id, label: i.label })));
    setNewItemLabel('');
    setStartDraft(config.startTime);
    setEndDraft(config.endTime);
  }, [showSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const addDraftItem = () => {
    const labelText = newItemLabel.trim();
    if (!labelText) return;
    setItemsDraft((prev) => [...prev, { id: `item_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, label: labelText }]);
    setNewItemLabel('');
  };

  const removeDraftItem = (id) => {
    setItemsDraft((prev) => prev.filter((it) => it.id !== id));
  };

  const renameDraftItem = (id, labelText) => {
    setItemsDraft((prev) => prev.map((it) => (it.id === id ? { ...it, label: labelText } : it)));
  };

  const saveSettings = async () => {
    const items = itemsDraft
      .map((it) => ({ id: it.id, label: it.label.trim() }))
      .filter((it) => it.label);
    if (items.length === 0) { alert('Add at least one checklist item.'); return; }
    try {
      await setDoc(doc(db, 'branchChecklistConfig', 'config'), {
        items,
        startTime: startDraft,
        endTime: endDraft,
        intervalMinutes: INTERVAL_MINUTES
      });
      setShowSettings(false);
    } catch (err) {
      console.error(err);
      alert('Could not save the settings.');
    }
  };

  // For each hour: the distinct people who ticked ANYTHING in that hour's column, filled in automatically
  // from the saved ticks (the `by` stamped on every cell) - nobody types this in.
  const checkersBySlot = useMemo(() => {
    const map = {};
    slots.forEach((slot) => {
      const names = new Set();
      config.items.forEach((it) => {
        const c = checks[cellKey(slot, it.id)];
        if (c && (c.checked || c.na || c.issue || c.notCompleted) && c.by) names.add(c.by);
      });
      map[slot] = [...names];
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, config.items, checks]);

  // A whole hour that went by with NOTHING ticked in its column, plus who was scheduled on shift at this
  // branch during that hour (from the schedule). Shown in red under the column so it is clear who was
  // responsible for the round that was skipped. Only roles that can read the roster have this data.
  const missedShiftNamesBySlot = useMemo(() => {
    const map = {};
    if (!selectedBranch || !selectedDate) return map;
    slots.forEach((slot) => {
      if (!isMissedSlot(slot)) return;
      const anyTick = config.items.some((it) => {
        const c = checks[cellKey(slot, it.id)];
        return c && (c.checked || c.na || c.issue || c.notCompleted);
      });
      if (anyTick) return;
      const slotStart = toMinutes(slot);
      const names = new Set();
      plans.forEach((p) => {
        if (p.branch !== selectedBranch || p.date !== selectedDate || !p.username || !p.startTime || !p.endTime) return;
        if (toMinutes(p.startTime) < slotStart + INTERVAL_MINUTES && toMinutes(p.endTime) > slotStart) names.add(p.username);
      });
      map[slot] = [...names];
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, config.items, checks, plans, selectedBranch, selectedDate, tick]);

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">✅ Branch Checklist</h2>
          <p className="text-xs text-slate-500 max-w-xl">
            Tick each item off every hour as you go through the branch. Anyone checked in here right now can
            tick the current time slot; only Admin, Branch Manager or Supervisor can sign off the whole day.
          </p>
          {branchHasHours && (
            <p className="text-[11px] font-semibold text-indigo-700 mt-1">
              🕒 {selectedBranch} works {selectedBranchObj.openTime} – {selectedBranchObj.closeTime}; only these hours are listed.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canSeeSummary && (
            <button
              onClick={() => setShowSummary((v) => !v)}
              className="font-bold px-3 py-1.5 rounded-xl text-xs transition cursor-pointer border-0"
              style={showSummary ? { backgroundColor: '#4f46e5', color: '#ffffff' } : { backgroundColor: '#e0e7ff', color: '#3730a3' }}
            >
              {showSummary ? '✕ Close summary' : '📊 Branches summary'}
            </button>
          )}
          {canTick && (
            <button
              onClick={() => (multiSelectMode ? exitMultiSelect() : setMultiSelectMode(true))}
              className={`font-bold px-3 py-1.5 rounded-xl text-xs transition cursor-pointer ${
                multiSelectMode
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
              }`}
            >
              {multiSelectMode ? `✕ Cancel selecting (${selectedCells.size})` : '🖊️ Select multiple'}
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-3 py-1.5 rounded-xl text-xs transition cursor-pointer"
            >
              {showSettings ? 'Close settings' : '⚙️ Edit items / hours'}
            </button>
          )}
        </div>
      </div>

      {multiSelectMode && (
        <p className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl px-3 py-2">
          Tap every item you want to mark, then use the bar at the bottom to apply them all at once.
        </p>
      )}

      {showSummary && canSeeSummary && (
        <ChecklistSummary config={config} slots={defaultSlots} slotsByBranch={slotsByBranch} branchNames={branchNames} intervalMinutes={INTERVAL_MINUTES} />
      )}

      {showSettings && isAdmin && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <p className="text-xs text-slate-500">
            The item list applies to <span className="font-bold">every branch</span> (one shared checklist format). The time window below is only the
            default for branches that have no working hours of their own; a branch's own hours (set in the Schedule page) take priority.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Opens at</label>
              <input type="time" value={startDraft} onChange={(e) => setStartDraft(e.target.value)} className={field} />
            </div>
            <div>
              <label className={label}>Closes at</label>
              <input type="time" value={endDraft} onChange={(e) => setEndDraft(e.target.value)} className={field} />
            </div>
          </div>
          <div className="space-y-2">
            <label className={label}>Checklist items ({itemsDraft.length})</label>
            <div className="space-y-1.5">
              {itemsDraft.map((it) => (
                <div key={it.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={it.label}
                    onChange={(e) => renameDraftItem(it.id, e.target.value)}
                    className={field}
                  />
                  <button
                    type="button"
                    onClick={() => removeDraftItem(it.id)}
                    title="Delete this item"
                    className="shrink-0 px-3 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer"
                    style={{ backgroundColor: '#e11d48', color: '#ffffff' }}
                  >
                    🗑️ Delete
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                value={newItemLabel}
                onChange={(e) => setNewItemLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDraftItem(); } }}
                placeholder="New item name..."
                className={field}
              />
              <button
                type="button"
                onClick={addDraftItem}
                className="shrink-0 px-4 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer"
                style={{ backgroundColor: '#059669', color: '#ffffff' }}
              >
                ➕ Add
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              Changes only take effect when you press "Save settings". Deleting an item removes it from the list
              going forward; ticks already recorded on past days are kept.
            </p>
          </div>
          <button
            onClick={saveSettings}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-5 py-2 rounded-xl text-xs shadow-md transition cursor-pointer"
          >
            Save settings
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-4 rounded-2xl border">
        <div>
          <label className={label}>Branch</label>
          <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)} className={field}>
            {branchNames.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Date</label>
          <input
            type="date"
            value={selectedDate}
            max={today}
            onChange={(e) => setSelectedDate(e.target.value)}
            className={field}
          />
        </div>
        <div className="flex flex-col justify-end">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2.5 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11px] font-bold text-slate-600 whitespace-nowrap">{pct}% done</span>
          </div>
        </div>
      </div>

      {lockedBySignOff && (
        <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
          This checklist has been signed off and is locked. Only an Admin can edit it now.
        </p>
      )}

      {!canTick && !lockedBySignOff && isToday && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          You can view this branch's checklist, but you need to be checked in at <span className="font-bold">{selectedBranch}</span> to tick items.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="p-2 bg-slate-100 border border-slate-200 text-left sticky left-0 z-10 min-w-[160px]">Item</th>
              {slots.map((slot) => (
                <th
                  key={slot}
                  className={`p-2 border border-slate-200 font-bold text-[10px] whitespace-nowrap ${
                    isToday && slot === [...reachableSlots].sort().slice(-1)[0] ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {slot}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {config.items.map((item) => (
              <tr key={item.id}>
                <td className="p-2 border border-slate-200 font-bold text-slate-800 sticky left-0 bg-white z-10 whitespace-nowrap">
                  {item.label}
                </td>
                {slots.map((slot) => {
                  const cell = checks[cellKey(slot, item.id)];
                  const reachable = !isToday || reachableSlots.has(slot);
                  const clickable = canTick && isToday && reachableSlots.has(slot) && !isCellLocked(slot, item.id);
                  const hasValue = !!(cell?.issue || cell?.checked || cell?.na || cell?.notCompleted);
                  const missed = !hasValue && isMissedSlot(slot);
                  const selected = multiSelectMode && selectedCells.has(cellKey(slot, item.id));
                  const tip = cell?.issue
                    ? (isCellRequestDeleted(cell)
                        ? `The maintenance request for this item was deleted - you can change this cell now (reported by ${cell.by || '?'})`
                        : `Maintenance request filed by ${cell.by || '?'} - locked while that request exists`)
                    : cell?.na
                    ? `Marked not applicable by ${cell.by || '?'}`
                    : cell?.notCompleted
                    ? `Not completed - recorded by ${cell.by || '?'}`
                    : cell?.checked && cell.by
                    ? `Checked by ${cell.by}`
                    : '';
                  return (
                    <td
                      key={slot}
                      title={tip}
                      onClick={() => {
                        if (!clickable) return;
                        if (multiSelectMode) toggleCellSelection(slot, item.id);
                        else setActiveCell({ slot, itemId: item.id });
                      }}
                      style={missed ? { backgroundColor: '#ffe4e6' } : undefined}
                      className={`p-2 border border-slate-200 text-center ${
                        clickable ? 'cursor-pointer hover:bg-indigo-50' : ''
                      } ${!reachable && isToday ? 'bg-slate-50' : ''} ${cell?.issue ? 'bg-rose-50' : ''} ${
                        cell?.na ? 'bg-amber-50' : ''
                      } ${cell?.notCompleted ? 'bg-orange-50' : ''} ${selected ? 'ring-2 ring-inset ring-indigo-500 bg-indigo-50' : ''}`}
                    >
                      {cell?.issue ? (
                        <span className="text-rose-600 font-black" style={isCellRequestDeleted(cell) ? { opacity: 0.45 } : undefined}>🛠️</span>
                      ) : cell?.checked ? (
                        <span className="text-emerald-600 font-black">✓</span>
                      ) : cell?.na ? (
                        <span className="text-amber-600 font-black text-[10px]">N/A</span>
                      ) : cell?.notCompleted ? (
                        <span className="font-black" style={{ color: '#ea580c' }}>✗</span>
                      ) : missed ? (
                        <span className="font-black text-[9px] leading-tight block" style={{ color: '#be123c' }}>Not Checked!</span>
                      ) : reachable ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        ''
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="p-2 border border-slate-200 font-bold text-slate-600 sticky left-0 bg-slate-50 z-10 whitespace-nowrap text-[10px] uppercase">
                Checked by
              </td>
              {slots.map((slot) => {
                const names = checkersBySlot[slot] || [];
                return (
                  <td key={slot} className="p-1.5 border border-slate-200 align-top bg-slate-50 min-w-[84px]">
                    {names.length > 0 ? (
                      <div className="space-y-0.5">
                        {names.map((n) => (
                          <div key={n} className="text-[10px] font-bold text-slate-700 bg-white border border-slate-200 rounded-md px-1.5 py-0.5 text-center">
                            {n}
                          </div>
                        ))}
                      </div>
                    ) : missedShiftNamesBySlot[slot] && plansAvailable ? (
                      missedShiftNamesBySlot[slot].length > 0 ? (
                        <div className="space-y-0.5" title="Nothing was checked this hour. These people were scheduled on shift.">
                          {missedShiftNamesBySlot[slot].map((n) => (
                            <div key={n} className="text-[10px] font-extrabold text-rose-700 bg-rose-50 border border-rose-300 rounded-md px-1.5 py-0.5 text-center">
                              {n}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[9px] italic text-slate-400 text-center leading-tight">No shift planned</div>
                      )
                    ) : (
                      <div className="text-[10px] text-slate-300 text-center">—</div>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="border-t pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          {dayDoc?.signedOffBy ? (
            <p className="text-xs text-emerald-700 font-bold">
              ✅ Signed off by {dayDoc.signedOffBy} {dayDoc.signedOffRole ? `(${dayDoc.signedOffRole})` : ''}
            </p>
          ) : (
            <p className="text-xs text-slate-400 italic">Not signed off yet.</p>
          )}
        </div>
        {canSignOff && !dayDoc?.signedOffBy && (
          <button
            onClick={handleSignOff}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold px-5 py-2 rounded-xl text-xs shadow-md transition cursor-pointer"
          >
            Confirm day reviewed
          </button>
        )}
      </div>

      {/* Cell action panel: mark OK, undo, or report a problem (files a real maintenance request) */}
      {activeCell && (() => {
        const item = config.items.find((it) => it.id === activeCell.itemId);
        const cell = checks[cellKey(activeCell.slot, activeCell.itemId)];
        if (!item) return null;
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl p-5 max-w-sm w-full space-y-4">
              <div>
                <h3 className="font-black text-slate-900 text-sm">{item.label}</h3>
                <p className="text-[11px] text-slate-400">{selectedBranch} · {activeCell.slot}</p>
              </div>

              {isCellLocked(activeCell.slot, activeCell.itemId) ? (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
                  🛠️ A maintenance request was already submitted for this ({cell.by}). It can be changed again only if that request is deleted.
                </p>
              ) : (
                <>
                  {cell?.issue && (
                    <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                      The maintenance request linked to this item no longer exists, so you can set its status again.
                    </p>
                  )}
                  <button
                    onClick={() => markOk(activeCell.slot, activeCell.itemId)}
                    className={`w-full font-extrabold px-4 py-2.5 rounded-xl text-xs shadow-md transition cursor-pointer ${
                      cell?.checked ? 'bg-slate-100 text-slate-700' : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    }`}
                  >
                    {cell?.checked ? '↩️ Undo (mark not checked)' : '✓ Mark OK'}
                  </button>

                  <button
                    onClick={() => markNA(activeCell.slot, activeCell.itemId)}
                    className={`w-full font-extrabold px-4 py-2.5 rounded-xl text-xs shadow-md transition cursor-pointer ${
                      cell?.na ? 'bg-slate-100 text-slate-700' : 'bg-amber-500 hover:bg-amber-600 text-white'
                    }`}
                  >
                    {cell?.na ? '↩️ Undo (not applicable)' : '➖ Not applicable at this branch'}
                  </button>

                  <button
                    onClick={() => markNotCompleted(activeCell.slot, activeCell.itemId)}
                    className="w-full font-extrabold px-4 py-2.5 rounded-xl text-xs shadow-md transition cursor-pointer border-0"
                    style={cell?.notCompleted ? { backgroundColor: '#f1f5f9', color: '#334155' } : { backgroundColor: '#ea580c', color: '#ffffff' }}
                  >
                    {cell?.notCompleted ? '↩️ Undo (not completed)' : '✗ Not Completed (no maintenance request)'}
                  </button>

                  <div className="border-t pt-3 space-y-2">
                    <p className="text-[11px] font-bold text-slate-500 uppercase">Or, if something's wrong:</p>
                    <textarea
                      value={issueNote}
                      onChange={(e) => setIssueNote(e.target.value)}
                      rows={3}
                      placeholder="What's wrong? (optional)"
                      className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
                    />
                    <button
                      onClick={() => submitIssue(activeCell.slot, item)}
                      disabled={submittingIssue}
                      className="w-full bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-extrabold px-4 py-2.5 rounded-xl text-xs shadow-md transition cursor-pointer"
                    >
                      {submittingIssue ? 'Opening...' : '⚠️ Report a problem (opens the maintenance request form)'}
                    </button>
                  </div>
                </>
              )}

              <button
                onClick={() => { setActiveCell(null); setIssueNote(''); }}
                className="w-full text-xs font-bold text-slate-500 hover:text-slate-700 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        );
      })()}

      {/* Floating bulk-action bar: shown while in "Select multiple" mode with at least one cell picked */}
      {multiSelectMode && selectedCells.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-white border border-slate-200 shadow-2xl rounded-2xl px-4 py-3 flex items-center gap-2 flex-wrap justify-center">
          <span className="text-xs font-black text-slate-700 whitespace-nowrap">{selectedCells.size} selected</span>
          <button
            onClick={() => bulkApply('ok')}
            className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold px-4 py-2 rounded-xl text-xs shadow-md transition cursor-pointer whitespace-nowrap"
          >
            ✓ Mark OK
          </button>
          <button
            onClick={() => bulkApply('na')}
            className="bg-amber-500 hover:bg-amber-600 text-white font-extrabold px-4 py-2 rounded-xl text-xs shadow-md transition cursor-pointer whitespace-nowrap"
          >
            ➖ Not applicable
          </button>
          <button
            onClick={() => bulkApply('nc')}
            className="font-extrabold px-4 py-2 rounded-xl text-xs shadow-md transition cursor-pointer whitespace-nowrap border-0"
            style={{ backgroundColor: '#ea580c', color: '#ffffff' }}
          >
            ✗ Not Completed
          </button>
          <button
            onClick={() => setSelectedCells(new Set())}
            className="text-xs font-bold text-slate-400 hover:text-slate-600 cursor-pointer whitespace-nowrap"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useMemo } from 'react';
import { db } from './firebase';
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
   One master list of items (set by Admin), checked off every 30 minutes
   through the day, per branch. Whoever is checked in at that branch right
   now can tick items for the current (or a recently-passed) time slot -
   never a future one, and never a past day's slots once the day is over.
   Admin / Branch Manager / Supervisor can sign off the whole day, the way
   the paper sheet has a "Head Coach / Admin Signature" line at the bottom.
   ===================================================================== */

const pad = (n) => String(n).padStart(2, '0');
const toLocalYmd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowHM = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Builds the list of time slots ("06:00", "06:30", ...) between start and end (inclusive of start,
// exclusive of end), at a fixed interval. Wrapping past midnight (e.g. 07:00 -> next day 09:00, like
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
  for (let t = start; t < end; t += intervalMinutes) {
    const mins = t % (24 * 60);
    slots.push(`${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
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

const DEFAULT_CONFIG = { items: DEFAULT_ITEMS, startTime: '06:00', endTime: '23:00', intervalMinutes: 30 };

export default function BranchChecklist({ currentUser, branchesList = [], openBranch, canSignOff = false, isAdmin = false, onReportIssue }) {
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

  const slots = useMemo(
    () => buildSlots(config.startTime, config.endTime, config.intervalMinutes),
    [config.startTime, config.endTime, config.intervalMinutes]
  );

  const isToday = selectedDate === today;
  const currentHm = nowHM();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reachableSlots = useMemo(() => new Set(isToday ? slots.filter((s) => isSlotReachable(s, currentHm)) : []), [slots, isToday, tick]);

  const isCheckedInHere = isToday && openBranch && openBranch === selectedBranch;
  const canTick = isCheckedInHere || isAdmin;

  const checks = dayDoc?.checks || {};
  const cellKey = (slot, itemId) => `${slot}__${itemId}`;

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
    // kind: 'ok' | 'na'
    const keys = [...selectedCells];
    if (keys.length === 0) return;
    const patchMap = {};
    keys.forEach((key) => {
      patchMap[key] =
        kind === 'ok'
          ? { checked: true, issue: false, na: false, by: myUsername, at: serverTimestamp() }
          : { checked: false, issue: false, na: true, by: myUsername, at: serverTimestamp() };
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
          checks: { [key]: { checked: false, issue: false, na: false, ...patch, by: myUsername, at: serverTimestamp() } },
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
    if (!canTick || !reachableSlots.has(slot)) return;
    const already = checks[cellKey(slot, itemId)]?.checked;
    // Marking OK always clears any earlier "Not applicable" flag on this cell.
    await saveCell(slot, itemId, { checked: !already, na: false });
    setActiveCell(null);
  };

  // Third outcome: the item simply doesn't exist at this branch (e.g. no "Cardio machines" at a
  // small branch). Distinct from OK and from an issue - shown in amber, and doesn't block progress.
  const markNA = async (slot, itemId) => {
    if (!canTick || !reachableSlots.has(slot)) return;
    const already = checks[cellKey(slot, itemId)]?.na;
    await saveCell(slot, itemId, { na: !already, checked: false });
    setActiveCell(null);
  };

  // Reports a problem found during the round: marks this checklist cell as an "issue", then hands
  // off to the REAL "Create Maintenance Request" form (pre-filled with the branch, a title and a
  // description) so the person can attach a live photo and pick a category just like any other
  // maintenance request - instead of silently filing a bare-bones request behind the scenes.
  const submitIssue = async (slot, item) => {
    setSubmittingIssue(true);
    try {
      await saveCell(slot, item.id, { checked: false, issue: true, issueNote: issueNote.trim() });

      const prefill = {
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
        await addDoc(collection(db, 'requests'), {
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
  const [itemsDraft, setItemsDraft] = useState('');
  const [startDraft, setStartDraft] = useState(config.startTime);
  const [endDraft, setEndDraft] = useState(config.endTime);
  useEffect(() => {
    setItemsDraft(config.items.map((i) => i.label).join('\n'));
    setStartDraft(config.startTime);
    setEndDraft(config.endTime);
  }, [showSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = async () => {
    const labels = itemsDraft.split('\n').map((s) => s.trim()).filter(Boolean);
    if (labels.length === 0) { alert('Add at least one checklist item.'); return; }
    const items = labels.map((label, i) => ({ id: `item${i + 1}`, label }));
    try {
      await setDoc(doc(db, 'branchChecklistConfig', 'config'), {
        items,
        startTime: startDraft,
        endTime: endDraft,
        intervalMinutes: 30
      });
      setShowSettings(false);
    } catch (err) {
      console.error(err);
      alert('Could not save the settings.');
    }
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">✅ Branch Checklist</h2>
          <p className="text-xs text-slate-500 max-w-xl">
            Tick each item off every 30 minutes as you go through the branch. Anyone checked in here right now can
            tick the current time slot; only Admin, Branch Manager or Supervisor can sign off the whole day.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
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

      {showSettings && isAdmin && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <p className="text-xs text-slate-500">
            This item list and time window apply to <span className="font-bold">every branch</span> (one shared checklist format).
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
          <div>
            <label className={label}>Checklist items (one per line)</label>
            <textarea value={itemsDraft} onChange={(e) => setItemsDraft(e.target.value)} rows={8} className={field} />
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

      {!canTick && isToday && (
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
                  const clickable = canTick && isToday && reachableSlots.has(slot);
                  const selected = multiSelectMode && selectedCells.has(cellKey(slot, item.id));
                  const tip = cell?.issue
                    ? `Issue reported by ${cell.by || '?'}`
                    : cell?.na
                    ? `Marked not applicable by ${cell.by || '?'}`
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
                      className={`p-2 border border-slate-200 text-center ${
                        clickable ? 'cursor-pointer hover:bg-indigo-50' : ''
                      } ${!reachable && isToday ? 'bg-slate-50' : ''} ${cell?.issue ? 'bg-rose-50' : ''} ${
                        cell?.na ? 'bg-amber-50' : ''
                      } ${selected ? 'ring-2 ring-inset ring-indigo-500 bg-indigo-50' : ''}`}
                    >
                      {cell?.issue ? (
                        <span className="text-rose-600 font-black">🛠️</span>
                      ) : cell?.checked ? (
                        <span className="text-emerald-600 font-black">✓</span>
                      ) : cell?.na ? (
                        <span className="text-amber-600 font-black text-[10px]">N/A</span>
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

              {cell?.issue ? (
                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
                  🛠️ A maintenance request was already submitted for this ({cell.by}).
                </p>
              ) : (
                <>
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

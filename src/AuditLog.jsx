import React, { useState, useEffect, useMemo } from 'react';
import { db, functions } from './firebase';
import { collection, onSnapshot, query, orderBy, limit as fsLimit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

/* =====================================================================
   Audit Log - Admin only.
   -----------------------------------------------------------------
   Every create/update/delete across the app's main collections lands in the `auditLog`
   collection, written only by Cloud Functions (see functions/index.js: the onDocumentWritten
   triggers for create/update, and deleteRecordWithAudit for delete). The Firestore rule for
   `auditLog` is read-only for Admin and `allow write: if false` for everyone including Admin -
   nobody in the app itself can edit or erase an entry, which is what keeps it trustworthy as a
   record of what actually happened.

   "Undo" next to ANY entry calls the undoAuditEntry callable: for a deletion it restores the
   record from the snapshot captured at delete time; for an edit it rolls the record back to
   exactly how it looked right before that change (later edits, if any, get overwritten too -
   it's a rewind, not a selective per-field revert); for a creation it removes the record (and
   logs that removal as its own, further undo-able, delete entry).
   ===================================================================== */

const ACTION_TONE = {
  create: { bg: '#d1fae5', fg: '#065f46', label: 'Created' },
  update: { bg: '#fef3c7', fg: '#92400e', label: 'Updated' },
  delete: { bg: '#ffe4e6', fg: '#9f1239', label: 'Deleted' }
};

const COLLECTION_LABELS = {
  requests: 'Maintenance Request',
  ceo_requests: 'CEO Service Request',
  leaveRequests: 'Leave Request',
  integrityReports: 'Integrity Report',
  attendance: 'Attendance Record',
  users: 'User Account',
  locationViolations: 'Location Violation',
  attendancePlans: 'Shift Plan',
  branches: 'Branch',
  categories: 'Category',
  towelTransactions: 'Towel Transaction'
};

const tsToDate = (t) => (t && typeof t.toDate === 'function' ? t.toDate() : null);
const fmtDateTime = (d) =>
  d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    : '—';

// Picks a human-readable label for a record from whichever field it actually has - the audited
// collections don't share one common "name" field, so this just tries the usual suspects in order.
const describeRecord = (data) => {
  if (!data) return '(no data)';
  return data.title || data.name || data.username || data.serviceType || data.itemDetails || data.branch || '(untitled)';
};

const fmtDateOnly = (d) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtTimeOnly = (d) => (d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—');

// When the underlying record was originally created: read from the record's own timestamp field
// (collections name it differently); a creation entry itself is the creation moment.
const originalCreatedAt = (e) => {
  const rec = e.after || e.before || {};
  const cand = [rec.createdAt, rec.timestamp, rec.submittedAt, rec.requestedAt, rec.date, rec.checkInTime, rec.checkIn];
  for (const c of cand) { const d = tsToDate(c); if (d) return d; }
  return e.action === 'create' ? tsToDate(e.createdAt) : null;
};

const fmtVal = (v) => {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'object') {
    const d = tsToDate(v);
    if (d) return fmtDateTime(d);
    if (Array.isArray(v)) return v.length ? v.map(fmtVal).join(', ') : '—';
    try { const j = JSON.stringify(v); return j.length > 60 ? j.slice(0, 57) + '...' : j; } catch (e) { return '(object)'; }
  }
  const t = String(v);
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
};

// What actually changed: for an edit, each field that differs (before -> after); for a creation or
// deletion, a one-line statement. Internal bookkeeping fields are skipped so the column stays readable.
const SKIP_FIELDS = new Set(['updatedAt', 'createdAt', 'fcmTokens', 'lastSeen']);
// Automatic background updates (heartbeat / device tracking) - not a person's action.
const NOISE_FIELDS = new Set(['lastActive', 'lastDeviceId', 'lastSeen', 'fcmTokens', 'updatedAt']);
const isNoiseEntry = (e) => {
  if (e.action !== 'update') return false;
  const b = e.before || {};
  const a = e.after || {};
  const changed = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter((k) => fmtVal(b[k]) !== fmtVal(a[k]));
  return changed.length > 0 && changed.every((k) => NOISE_FIELDS.has(k));
};

const describeChange = (e) => {
  if (e.action === 'create') return [{ text: 'New record created' }];
  if (e.action === 'delete') return [{ text: 'Record deleted' }];
  const b = e.before || {};
  const a = e.after || {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter((k) => !SKIP_FIELDS.has(k));
  const out = [];
  keys.forEach((k) => {
    if (fmtVal(b[k]) !== fmtVal(a[k])) out.push({ field: k, from: fmtVal(b[k]), to: fmtVal(a[k]) });
  });
  return out.length ? out : [{ text: 'Minor update' }];
};

export default function AuditLog({ isAdmin }) {
  const [entries, setEntries] = useState([]);
  const [actionFilter, setActionFilter] = useState('All');
  const [collectionFilter, setCollectionFilter] = useState('All');
  const [accountFilter, setAccountFilter] = useState('All');
  const [undoingId, setUndoingId] = useState(null);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [hideAuto, setHideAuto] = useState(true);
  const [usersMap, setUsersMap] = useState({});

  // The create/update triggers sometimes only know the signed-in user's id; map it back to a name.
  useEffect(() => {
    if (!isAdmin) return undefined;
    const unsub = onSnapshot(collection(db, 'users'), (snap) => {
      const m = {};
      snap.docs.forEach((d) => { const u = d.data(); m[d.id] = u.name || u.username || d.id; });
      setUsersMap(m);
    }, () => {});
    return () => unsub();
  }, [isAdmin]);
  const accountOf = (e) => usersMap[e.performedByUsername] || e.performedByUsername || 'Unknown';

  useEffect(() => {
    if (!isAdmin) { setEntries([]); return undefined; }
    // Most recent 300 entries - plenty for "what just happened" without the list growing
    // unbounded; the underlying auditLog collection itself keeps everything forever.
    const q = query(collection(db, 'auditLog'), orderBy('createdAt', 'desc'), fsLimit(300));
    const unsub = onSnapshot(q, (snap) => {
      setEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => console.warn('Audit log listener error:', err));
    return () => unsub();
  }, [isAdmin]);

  const collectionsPresent = useMemo(() => {
    return Array.from(new Set(entries.map((e) => e.collectionName))).sort();
  }, [entries]);

  const accountsPresent = useMemo(() => {
    return Array.from(new Set(entries.map((e) => accountOf(e)))).sort((a, b) => a.localeCompare(b));
  }, [entries, usersMap]);

  const visibleEntries = useMemo(() => {
    return entries.filter((e) => {
      if (accountFilter !== 'All' && accountOf(e) !== accountFilter) return false;
      if (hideAuto && isNoiseEntry(e)) return false;
      const t = tsToDate(e.createdAt);
      if (dateFrom && (!t || t < new Date(dateFrom + 'T00:00:00'))) return false;
      if (dateTo && (!t || t > new Date(dateTo + 'T23:59:59'))) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = [describeRecord(e.after || e.before), accountOf(e), e.branch, COLLECTION_LABELS[e.collectionName] || e.collectionName,
          ...describeChange(e).map((c) => (c.text ? c.text : `${c.field} ${c.from} ${c.to}`))].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (actionFilter !== 'All' && e.action !== actionFilter) return false;
      if (collectionFilter !== 'All' && e.collectionName !== collectionFilter) return false;
      return true;
    });
  }, [entries, actionFilter, collectionFilter, accountFilter, hideAuto, dateFrom, dateTo, search, usersMap]);

  const handleUndo = async (entry) => {
    const typeLabel = COLLECTION_LABELS[entry.collectionName] || entry.collectionName;
    const recordLabel = describeRecord(entry.before || entry.after);
    let confirmMsg;
    if (entry.action === 'delete') {
      confirmMsg = `Restore this deleted ${typeLabel} ("${recordLabel}")? It will come back exactly as it was.`;
    } else if (entry.action === 'update') {
      confirmMsg = `Undo this edit to "${recordLabel}"? It will roll back to exactly how it looked right before this change - if it's been edited again SINCE this entry, those later changes will be overwritten too.`;
    } else {
      confirmMsg = `Undo the creation of "${recordLabel}"? This removes it (the same as deleting it) - you'll still be able to undo that if needed.`;
    }
    if (!window.confirm(confirmMsg)) return;
    setUndoingId(entry.id);
    try {
      const undoAuditEntry = httpsCallable(functions, 'undoAuditEntry');
      await undoAuditEntry({ auditId: entry.id });
      alert('Done.');
    } catch (err) {
      alert('Could not undo: ' + (err.message || err));
    } finally {
      setUndoingId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm">
        <p className="text-xs text-slate-400 italic">Only Admin can view the audit log.</p>
      </div>
    );
  }

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="border-b pb-4">
        <h2 className="text-lg font-black text-slate-900 tracking-tight">🕵️ Audit Log</h2>
        <p className="text-xs text-slate-500 max-w-xl">
          Every create, update and delete across the app, newest first - who did it, and when.
          Any entry can be reversed with "Undo" below, as long as nobody already has: a deletion
          brings the record back, an edit rolls it back to how it looked right before that change,
          and undoing a creation removes the record.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div>
          <label className={label}>Account</label>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} className={`${field} max-w-[220px]`}>
            <option value="All">All accounts</option>
            {accountsPresent.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Action</label>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className={`${field} max-w-[160px]`}>
            <option value="All">All actions</option>
            <option value="create">Created</option>
            <option value="update">Updated</option>
            <option value="delete">Deleted</option>
          </select>
        </div>
        <div>
          <label className={label}>Type</label>
          <select value={collectionFilter} onChange={(e) => setCollectionFilter(e.target.value)} className={`${field} max-w-[220px]`}>
            <option value="All">All types</option>
            {collectionsPresent.map((c) => <option key={c} value={c}>{COLLECTION_LABELS[c] || c}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>From (last edit)</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={`${field} max-w-[160px]`} />
        </div>
        <div>
          <label className={label}>To (last edit)</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={`${field} max-w-[160px]`} />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className={label}>Search</label>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Record, field, value, branch..." className={field} />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input id="auditHideAuto" type="checkbox" checked={hideAuto} onChange={(e) => setHideAuto(e.target.checked)} />
          <label htmlFor="auditHideAuto" className="text-[11px] font-bold text-slate-600 cursor-pointer">Hide automatic activity (last active / device)</label>
        </div>
        {(accountFilter !== 'All' || actionFilter !== 'All' || collectionFilter !== 'All' || dateFrom || dateTo || search) && (
          <div className="flex items-end pb-1">
            <button type="button" onClick={() => { setAccountFilter('All'); setActionFilter('All'); setCollectionFilter('All'); setDateFrom(''); setDateTo(''); setSearch(''); }}
              className="px-3 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer" style={{ backgroundColor: '#e2e8f0', color: '#334155' }}>
              Clear filters
            </button>
          </div>
        )}
      </div>

      {visibleEntries.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No activity matches this filter.</p>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-2xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] font-extrabold uppercase text-slate-500">
              <tr>
                <th className="p-3">Last edit date</th>
                <th className="p-3">Last edit time</th>
                <th className="p-3">Created date</th>
                <th className="p-3">Created time</th>
                <th className="p-3">Account</th>
                <th className="p-3">Action</th>
                <th className="p-3">Record</th>
                <th className="p-3">What changed</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((e) => {
                const tone = ACTION_TONE[e.action] || ACTION_TONE.update;
                const recordLabel = describeRecord(e.after || e.before);
                const changes = describeChange(e);
                return (
                  <tr key={e.id} className="border-t border-slate-100 align-top">
                    <td className="p-3 whitespace-nowrap text-slate-500">{fmtDateOnly(tsToDate(e.createdAt))}</td>
                    <td className="p-3 whitespace-nowrap text-slate-500">{fmtTimeOnly(tsToDate(e.createdAt))}</td>
                    <td className="p-3 whitespace-nowrap text-slate-500">{fmtDateOnly(originalCreatedAt(e))}</td>
                    <td className="p-3 whitespace-nowrap text-slate-500">{fmtTimeOnly(originalCreatedAt(e))}</td>
                    <td className="p-3 whitespace-nowrap font-semibold text-slate-700">{accountOf(e)}</td>
                    <td className="p-3 whitespace-nowrap">
                      <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-black" style={{ backgroundColor: tone.bg, color: tone.fg }}>
                        {tone.label}
                      </span>
                    </td>
                    <td className="p-3 min-w-[160px]">
                      <p className="font-bold text-slate-900">{recordLabel}</p>
                      <p className="text-[11px] text-slate-400">
                        {COLLECTION_LABELS[e.collectionName] || e.collectionName}{e.branch ? ` • ${e.branch}` : ''}
                      </p>
                      {e.restored && (
                        <p className="text-[11px] font-bold mt-0.5" style={{ color: '#059669' }}>
                          ✓ Undone by {e.restoredBy || 'Admin'} on {fmtDateTime(tsToDate(e.restoredAt))}
                        </p>
                      )}
                    </td>
                    <td className="p-3 min-w-[220px]">
                      {changes.map((c, idx) => (
                        <p key={idx} className="text-[11px] text-slate-600 break-words">
                          {c.text ? c.text : (
                            <>
                              <span className="font-bold text-slate-800">{c.field}</span>: {c.from} <span className="text-slate-400">→</span> {c.to}
                            </>
                          )}
                        </p>
                      ))}
                    </td>
                    <td className="p-3">
                      {!e.restored && (
                        <button
                          type="button"
                          onClick={() => handleUndo(e)}
                          disabled={undoingId === e.id}
                          className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-sm cursor-pointer border-0 disabled:opacity-50 whitespace-nowrap"
                          style={{ backgroundColor: '#0284c7', color: '#ffffff' }}
                        >
                          {undoingId === e.id ? 'Undoing...' : '↩️ Undo'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

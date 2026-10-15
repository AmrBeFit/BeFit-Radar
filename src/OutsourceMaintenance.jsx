import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, functions } from './firebase';
import { collection, query, where, onSnapshot, orderBy, limit, doc, getDoc, addDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { roleLabel } from './permissions';

/* =====================================================================
   OUTSOURCE MAINTENANCE - an outside maintenance technician who has to be escorted while working at a branch.

   Who may ask:    Admin, CEO, QA (Member / Manager), Facility Manager, Branch Manager (and Branch Manager+).
                   A Branch Manager only for their own branches.
   Normal areas:   ONE approval from any User / Supervisor checked in at the branch, a Branch Manager of the
                   branch, or an Admin. The approver becomes the escort straight away.
   Women's areas:  (any area ticked "needs two approvals" in Settings -> Outsource Areas, by default
                   "Women Toilets") TWO approvals: the Branch Manager AND the Supervisor of that branch.
                   Either of them then picks the escort - themselves, the other approver or a User of the branch.
                   The request is also shown to Users, Admin, Facility Manager/Members and QA.

   Every decision is made by a Cloud Function (this page cannot write requests to Firestore directly), so the
   rules also hold if someone tries to bypass the screen. The national ID and its photo live in a separate
   locked document and are only readable by the requester, the escort, the branch's Branch Manager /
   Supervisor, the Facility Manager and Admin.
   ===================================================================== */

const REQUESTER_ROLES = ['Admin', 'CEO', 'QA', 'QA Manager', 'Facility Manager', 'Branch Manager', 'Branch Manager+'];
const SEES_ALL_ROLES = ['Admin', 'CEO', 'QA', 'QA Manager', 'Facility Manager', 'Facility Member'];

const toEnglishDigits = (v) => String(v == null ? '' : v)
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
const digitsOnly = (v, max) => toEnglishDigits(v).replace(/[^0-9]/g, '').slice(0, max);

// the role this screen reasons with (Branch Manager+ acts as Branch Manager, Coach as User)
const baseRole = (r) => (r === 'Branch Manager+' ? 'Branch Manager' : r === 'QA Manager' ? 'QA' : r === 'Coach' ? 'User' : r || '');
const isBM = (r) => baseRole(r) === 'Branch Manager';
const isSup = (r) => baseRole(r) === 'Supervisor';
const isPlainUser = (r) => ['User', 'Staff'].includes(baseRole(r));

const fmtTs = (ts) => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const tsMs = (ts) => (ts && ts.toMillis ? ts.toMillis() : 0);

const STATUS_STYLE = {
  Pending: { bg: '#f59e0b', label: 'Waiting for approval' },
  Approved: { bg: '#2563eb', label: 'Approved' },
  'In Progress': { bg: '#7c3aed', label: 'In progress' },
  Completed: { bg: '#059669', label: 'Completed' },
  Rejected: { bg: '#e11d48', label: 'Rejected' },
  Cancelled: { bg: '#64748b', label: 'Cancelled' }
};
const OPEN_STATUSES = ['Pending', 'Approved', 'In Progress'];

const field = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-semibold';
const label = 'block text-[11px] font-bold text-slate-600 mb-1';

// Shrinks a photo to a small JPEG (about 100-250 KB) so it can be stored in the locked ID document.
const compressImage = (file, maxSide = 1000, quality = 0.72) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the photo.'));
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error('This file is not a valid image.'));
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

/* ---------- Admin: the list of areas inside a branch (Settings tab) ---------- */
export function OutsourceAreasSettings() {
  const [areas, setAreas] = useState([]);
  const [name, setName] = useState('');
  const [sensitive, setSensitive] = useState(false);
  useEffect(() => onSnapshot(
    collection(db, 'outsourceAreas'),
    (snap) => setAreas(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''))),
    (err) => console.warn('outsourceAreas listener:', err.message)
  ), []);

  const add = async (n, s) => {
    const clean = String(n || '').trim();
    if (!clean) return;
    if (areas.some((a) => (a.name || '').toLowerCase() === clean.toLowerCase())) return alert('That area already exists.');
    try {
      await addDoc(collection(db, 'outsourceAreas'), { name: clean, sensitive: !!s });
      setName(''); setSensitive(false);
    } catch (err) { alert('Could not add the area: ' + err.message); }
  };
  const toggle = async (a) => {
    try { await updateDoc(doc(db, 'outsourceAreas', a.id), { sensitive: !a.sensitive }); }
    catch (err) { alert('Could not change the area: ' + err.message); }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete the area "${a.name}"? Old requests keep their text.`)) return;
    try { await deleteDoc(doc(db, 'outsourceAreas', a.id)); }
    catch (err) { alert('Could not delete the area: ' + err.message); }
  };

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
      <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
        <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span> Outsource Maintenance Areas ({areas.length})
      </h2>
      <p className="text-[11px] text-slate-500">
        The places inside a branch an outside technician can work in. Tick <strong>Needs 2 approvals</strong> for sensitive places
        (e.g. Women Toilets): then the Branch Manager <em>and</em> the Supervisor of the branch must both approve.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); add(name, sensitive); }} className="flex flex-wrap gap-2 items-center">
        <input
          type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="New area name"
          className="flex-1 min-w-[160px] p-3 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700 cursor-pointer">
          <input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} /> Needs 2 approvals
        </label>
        <button type="submit" style={{ backgroundColor: '#4f46e5', color: '#ffffff' }} className="px-5 py-3 rounded-xl text-xs font-bold shadow-md hover:opacity-90 transition cursor-pointer border-0">
          Add Area
        </button>
      </form>
      <div className="space-y-2 pt-2 border-t">
        {areas.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-400 italic">No areas yet - nobody can send an outsource request until you add at least one.</p>
            <button onClick={() => add('Women Toilets', true)} className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 cursor-pointer">
              + Add "Women Toilets" (2 approvals)
            </button>
          </div>
        ) : areas.map((a) => (
          <div key={a.id} className="flex flex-wrap justify-between items-center gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs font-bold text-slate-800">
            <span>📍 {a.name} {a.sensitive && <span className="ml-1 px-2 py-0.5 rounded-lg bg-rose-100 text-rose-700">2 approvals</span>}</span>
            <span className="flex gap-2">
              <button onClick={() => toggle(a)} className="bg-white border border-slate-300 text-slate-700 px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer">
                {a.sensitive ? 'Make normal' : 'Make sensitive'}
              </button>
              <button onClick={() => remove(a)} className="bg-rose-600 text-white hover:bg-rose-700 px-2.5 py-1 rounded-lg text-[11px] font-bold border-0 cursor-pointer">Delete</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- one request card ---------- */
function VisitCard({ g, me, openBranch, usersList, busyId, onAct, canApproveOs = true }) {
  const [confirmClosed, setConfirmClosed] = useState(false);
  const [confirmCount, setConfirmCount] = useState(false);
  const [confirmReopened, setConfirmReopened] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [priv, setPriv] = useState(null);
  const [privErr, setPrivErr] = useState('');
  const [escortPick, setEscortPick] = useState('');

  const role = me.role || '';
  const isAdmin = role === 'Admin';
  const assigned = Array.isArray(me.assignedBranches) ? me.assignedBranches : [];
  const approvals = Array.isArray(g.approvals) ? g.approvals : [];
  const style = STATUS_STYLE[g.status] || STATUS_STYLE.Pending;
  const busy = busyId === g.id;

  const assignedHere = assigned.includes(g.branch);
  const checkedInHere = !!openBranch && openBranch === g.branch;
  const alreadyApproved = approvals.some((a) => a.uid === me.id);
  const myBucket = isBM(role) ? 'BM' : isSup(role) ? 'SUP' : '';
  const bucketTaken = g.sensitive && approvals.some((a) => a.bucket === myBucket);

  let eligible;
  if (isAdmin) eligible = true;
  else if (!canApproveOs) eligible = false; // switched off for this account in the Permissions tab
  else if (g.sensitive) eligible = (isBM(role) || isSup(role)) && assignedHere;
  else eligible = (isBM(role) && assignedHere) || ((isSup(role) || isPlainUser(role)) && checkedInHere);

  const canApprove = g.status === 'Pending' && (g.createdByUid !== me.id || isAdmin) && !alreadyApproved && eligible && !bucketTaken;
  const canReject = (g.status === 'Pending' || g.status === 'Approved') && (eligible || isAdmin) && g.createdByUid !== me.id;
  const canCancel = (g.status === 'Pending' || g.status === 'Approved') && (g.createdByUid === me.id || isAdmin);
  const isEscort = g.escortUid === me.id || (isAdmin && (g.status === 'Approved' || g.status === 'In Progress') && !!g.escortUid);
  const isApprover = approvals.some((a) => a.uid === me.id);
  const canPickEscort = g.sensitive && g.status === 'Approved' && (isApprover || isAdmin);

  const canSeeId = isAdmin || g.createdByUid === me.id || g.escortUid === me.id
    || role === 'Facility Manager' || ((isBM(role) || isSup(role)) && assignedHere);

  // candidates for the escort of a women's-area visit: the two approvers + Users assigned to the branch
  const escortOptions = useMemo(() => {
    if (!canPickEscort) return [];
    const map = new Map();
    approvals.forEach((a) => map.set(a.uid, `${a.username} (${roleLabel(a.role)})`));
    if (isAdmin) map.set(me.id, `${me.username || 'Me'} (Admin)`);
    (usersList || []).forEach((u) => {
      if (['User', 'Staff', 'Supervisor', 'Branch Manager', 'Branch Manager+'].includes(u.role) && Array.isArray(u.assignedBranches) && u.assignedBranches.includes(g.branch)) {
        map.set(u.id, `${u.username} (${roleLabel(u.role)})`);
      }
    });
    return [...map.entries()].map(([id, text]) => ({ id, text })).sort((a, b) => a.text.localeCompare(b.text));
  }, [canPickEscort, approvals, usersList, g.branch, isAdmin, me.id, me.username]);

  const count = g.workerCount || 1;

  const showId = async () => {
    setPrivErr('');
    try {
      const snap = await getDoc(doc(db, 'outsourcePrivate', g.id));
      if (!snap.exists()) { setPrivErr('No ID details were found for this request.'); return; }
      setPriv(snap.data());
    } catch (err) {
      setPrivErr('You are not allowed to see the ID details of this request.');
    }
  };

  let approveHint = '';
  if (g.status === 'Pending' && (g.createdByUid !== me.id || isAdmin) && !alreadyApproved && !canApprove) {
    if (g.sensitive) {
      if (bucketTaken) approveHint = `A ${myBucket === 'BM' ? 'Branch Manager' : 'Supervisor'} already approved - the other approval has to come from the ${myBucket === 'BM' ? 'Supervisor' : 'Branch Manager'}.`;
    } else if (!eligible && (isSup(role) || isPlainUser(role))) {
      approveHint = `Check in at ${g.branch} to approve.`;
    }
  }

  return (
    <div className={`p-4 border rounded-2xl bg-white space-y-3 ${g.sensitive ? 'border-rose-200' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-black text-slate-900">🛠️ {g.maintenanceType}</p>
          <p className="text-xs text-slate-500 font-semibold">{g.workerName} · {g.company}</p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-[11px] font-black text-white" style={{ backgroundColor: style.bg }}>{style.label}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[11px] font-bold">
        <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-700">🏢 {g.branch}</span>
        <span className={`px-2 py-0.5 rounded-lg ${g.sensitive ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-700'}`}>
          📍 {g.area}{g.sensitive ? ' · 2 approvals' : ''}
        </span>
        <span className="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">👷 {count} technician{count > 1 ? 's' : ''}{g.countMayIncrease ? ' (may be more)' : ''}</span>
      </div>

      {g.countMayIncrease && (g.status === 'Pending' || g.status === 'Approved') && (
        <p className="text-xs font-black text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
          🔔 The requester says the number of technicians may increase beyond {count}. Please check the final number with them before approving or letting anyone in.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
        <p className="sm:col-span-2"><span className="font-bold text-slate-500">Work to be done:</span> {g.description}</p>
        {g.expectedDate && (
          <p className="sm:col-span-2"><span className="font-bold text-slate-500">Expected:</span> <span className="font-black text-slate-800">📅 {g.expectedDate} · 🕒 {g.expectedTime}</span></p>
        )}
        <p><span className="font-bold text-slate-500">Phone:</span> <span className="font-mono">{g.phone}</span></p>
        <p className="sm:col-span-2 text-[11px] text-slate-400">Requested by {g.createdBy}{g.createdByRole ? ` (${roleLabel(g.createdByRole)})` : ''} · {fmtTs(g.createdAt)}</p>
      </div>

      {canSeeId && (
        <div className="text-xs">
          {!priv ? (
            <button onClick={showId} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-[11px] font-bold hover:bg-slate-200 cursor-pointer border-0">
              🪪 Show national ID &amp; photo
            </button>
          ) : (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 space-y-2">
              <p><span className="font-bold text-slate-500">National ID:</span> <span className="font-mono font-black">{priv.nationalId}</span></p>
              {priv.idPhoto && <img src={priv.idPhoto} alt="National ID" className="max-h-56 rounded-lg border border-amber-200" />}
              <button onClick={() => setPriv(null)} className="text-[11px] font-bold text-slate-500 underline cursor-pointer bg-transparent border-0">Hide</button>
            </div>
          )}
          {privErr && <p className="text-[11px] text-rose-600 font-semibold mt-1">{privErr}</p>}
        </div>
      )}

      {(approvals.length > 0 || g.escortUsername) && (
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-[11px] space-y-0.5">
          {approvals.map((a) => (
            <p key={a.uid} className="text-slate-600">✅ Approved by <strong>{a.username}</strong> ({roleLabel(a.role)}) · {fmtTs(a.at)}</p>
          ))}
          {g.sensitive && g.status === 'Pending' && approvals.length === 1 && (
            <p className="text-amber-700 font-bold">⏳ Waiting for the {approvals[0].bucket === 'BM' ? 'Supervisor' : 'Branch Manager'} of {g.branch}.</p>
          )}
          {g.sensitive && g.status === 'Approved' && !g.escortUid && (
            <p className="text-amber-700 font-bold">👤 Both approved - an escort still has to be chosen.</p>
          )}
          {g.escortUsername && <p className="text-indigo-700 font-black">🛡️ Escort: {g.escortUsername} ({roleLabel(g.escortRole)})</p>}
        </div>
      )}

      {g.status === 'Rejected' && (
        <p className="text-xs text-rose-700 font-semibold">❌ Rejected by {g.rejectedBy}{g.rejectReason ? `: ${g.rejectReason}` : ''}</p>
      )}
      {(g.startedAt || g.finishedAt) && (
        <p className="text-[11px] text-slate-500 font-semibold">
          {g.startedAt && <>▶️ Started {fmtTs(g.startedAt)} by {g.startedBy}</>}
          {g.finishedAt && <> · ⏹️ Finished {fmtTs(g.finishedAt)} by {g.finishedBy}</>}
        </p>
      )}

      {/* choose the escort (women's areas) */}
      {canPickEscort && (
        <div className="space-y-2 p-2.5 rounded-xl bg-rose-50 border border-rose-100">
          <label className="block text-[11px] font-bold text-rose-900">{g.escortUid ? 'Change the escort' : 'Choose the escort'}</label>
          <div className="flex flex-wrap gap-2">
            <select value={escortPick} onChange={(e) => setEscortPick(e.target.value)} className={`${field} flex-1 min-w-[180px]`}>
              <option value="">Select a person...</option>
              {escortOptions.map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
            </select>
            <button
              disabled={busy || !escortPick}
              onClick={() => onAct(g.id, 'setEscort', { escortUid: escortPick })}
              className="px-4 py-2 rounded-xl text-xs font-black bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 cursor-pointer border-0"
            >
              Assign escort
            </button>
          </div>
        </div>
      )}

      {/* escort steps */}
      {(g.status === 'Approved' || g.status === 'In Progress') && (
        <p className="text-xs font-black text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          ⚠️ Only {count} technician{count > 1 ? 's are' : ' is'} allowed in{g.countMayIncrease ? ' (the requester said more may come - confirm any extra person with the requester first)' : ''}. Nobody else may enter.
        </p>
      )}

      {g.status === 'Approved' && isEscort && (
        <div className="space-y-2 p-2.5 rounded-xl bg-indigo-50 border border-indigo-100">
          <label className="flex items-start gap-2 text-[11px] font-bold text-indigo-900 cursor-pointer">
            <input type="checkbox" checked={confirmCount} onChange={(e) => setConfirmCount(e.target.checked)} className="mt-0.5" />
            I counted them: exactly {count} technician{count > 1 ? 's' : ''} {count > 1 ? 'are' : 'is'} entering, and I checked the ID of the one on this request.
          </label>
          {g.sensitive && (
            <label className="flex items-start gap-2 text-[11px] font-bold text-indigo-900 cursor-pointer">
              <input type="checkbox" checked={confirmClosed} onChange={(e) => setConfirmClosed(e.target.checked)} className="mt-0.5" />
              The area is closed, a sign is on the door and nobody is inside.
            </label>
          )}
          <button
            disabled={busy || !confirmCount || (g.sensitive && !confirmClosed)}
            onClick={() => onAct(g.id, 'start', { confirmClosed, confirmCount })}
            className="px-4 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 cursor-pointer border-0"
          >
            ▶️ Technician arrived - start work
          </button>
        </div>
      )}
      {g.status === 'In Progress' && isEscort && (
        <div className="space-y-2 p-2.5 rounded-xl bg-violet-50 border border-violet-100">
          {g.sensitive && (
            <label className="flex items-start gap-2 text-[11px] font-bold text-violet-900 cursor-pointer">
              <input type="checkbox" checked={confirmReopened} onChange={(e) => setConfirmReopened(e.target.checked)} className="mt-0.5" />
              The technician has left and the area was checked and is ready to reopen.
            </label>
          )}
          <button
            disabled={busy || (g.sensitive && !confirmReopened)}
            onClick={() => onAct(g.id, 'finish', { confirmReopened })}
            className="px-4 py-2 rounded-xl text-xs font-black bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 cursor-pointer border-0"
          >
            ⏹️ Work finished - technician left
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canApprove && (
          <button disabled={busy} onClick={() => onAct(g.id, 'approve')} className="px-4 py-2 rounded-xl text-xs font-black bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 cursor-pointer border-0">
            {g.sensitive ? '✅ Approve' : '✅ Approve & escort the technician'}
          </button>
        )}
        {canReject && (
          <button disabled={busy} onClick={() => onAct(g.id, 'reject')} className="px-3 py-2 rounded-xl text-xs font-black bg-rose-100 text-rose-700 border border-rose-300 hover:bg-rose-200 disabled:opacity-40 cursor-pointer">
            Reject
          </button>
        )}
        {canCancel && (
          <button disabled={busy} onClick={() => onAct(g.id, 'cancel')} className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 cursor-pointer border-0">
            Cancel request
          </button>
        )}
        {isAdmin && (
          <button disabled={busy} onClick={() => onAct(g.id, 'delete')} className="px-3 py-2 rounded-xl text-xs font-bold bg-white text-rose-600 border border-rose-200 hover:bg-rose-50 disabled:opacity-40 cursor-pointer">
            🗑️ Delete
          </button>
        )}
        {Array.isArray(g.history) && g.history.length > 0 && (
          <button onClick={() => setShowHistory((v) => !v)} className="ml-auto text-[11px] font-bold text-slate-400 hover:text-slate-600 cursor-pointer bg-transparent border-0">
            {showHistory ? 'Hide log' : 'Log'}
          </button>
        )}
      </div>
      {approveHint && <p className="text-[11px] font-semibold text-amber-700">{approveHint}</p>}

      {showHistory && (
        <div className="text-[11px] text-slate-500 space-y-0.5 border-t pt-2">
          {g.history.map((h, i) => (
            <p key={i}>{fmtTs(h.at)} · <strong>{h.action}</strong> · {h.by}{h.role ? ` (${roleLabel(h.role)})` : ''}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- how many requests wait for THIS person's approval (page banner + the tab badge in the Dashboard) ---------- */
export function countWaitingForMe(list, me, openBranch) {
  const role = me?.role || '';
  const assigned = Array.isArray(me?.assignedBranches) ? me.assignedBranches : [];
  return (list || []).filter((g) => {
    if (g.status !== 'Pending' || (g.createdByUid === me.id && role !== 'Admin')) return false;
    if ((g.approvals || []).some((a) => a.uid === me.id)) return false;
    const here = assigned.includes(g.branch);
    if (role === 'Admin') return true;
    if (g.sensitive) {
      const bucket = isBM(role) ? 'BM' : isSup(role) ? 'SUP' : '';
      return !!bucket && here && !(g.approvals || []).some((a) => a.bucket === bucket);
    }
    if (isBM(role)) return here;
    if (isSup(role) || isPlainUser(role)) return openBranch === g.branch;
    return false;
  }).length;
}

// Live count for the badge on the Outsource Maintenance tab. Listens with the same query shapes as the page.
export function useOutsourceWaiting(me, openBranch, enabled) {
  const [list, setList] = useState([]);
  const assigned = Array.isArray(me?.assignedBranches) ? me.assignedBranches : [];
  const assignedKey = assigned.join('|');
  const role = me?.role || '';
  const seesAll = SEES_ALL_ROLES.includes(role);
  useEffect(() => {
    if (!enabled || !me?.id) { setList([]); return undefined; }
    const sources = {};
    const publish = () => {
      const map = new Map();
      Object.values(sources).forEach((docs) => docs.forEach((d) => map.set(d.id, d)));
      setList([...map.values()]);
    };
    const listen = (key, q) => onSnapshot(
      q,
      (snap) => { sources[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); publish(); },
      () => {}
    );
    const col = collection(db, 'outsourceVisits');
    const unsubs = [];
    if (seesAll) unsubs.push(listen('all', query(col, orderBy('createdAt', 'desc'), limit(300))));
    else assigned.forEach((b) => unsubs.push(listen('branch:' + b, query(col, where('branch', '==', b), limit(150)))));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, me?.id, seesAll, assignedKey]);
  return useMemo(() => countWaitingForMe(list, me || {}, openBranch), [list, me, openBranch]);
}

/* ---------- the page ---------- */
export default function OutsourceMaintenance({ currentUser, branchesList = [], usersList = [], categories = [], openBranch = null, canRequestOs, canApproveOs = true }) {
  const me = currentUser || {};
  const role = me.role || '';
  const canRequest = typeof canRequestOs === 'boolean' ? canRequestOs : REQUESTER_ROLES.includes(role);
  const seesAll = SEES_ALL_ROLES.includes(role);
  const assigned = useMemo(() => (Array.isArray(me.assignedBranches) ? me.assignedBranches : []), [me.assignedBranches]);
  const assignedKey = assigned.join('|');

  const allBranchNames = useMemo(
    () => branchesList.map((b) => (typeof b === 'string' ? b : b.name)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [branchesList]
  );
  const requestBranches = (isBM(role) && assigned.length > 0) ? [...assigned].sort() : allBranchNames;

  /* ----- areas (Settings) ----- */
  const [areas, setAreas] = useState([]);
  useEffect(() => onSnapshot(
    collection(db, 'outsourceAreas'),
    (snap) => setAreas(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''))),
    (err) => console.warn('outsourceAreas listener:', err.message)
  ), []);

  /* ----- data: exactly the shapes the security rules allow ----- */
  const [requests, setRequests] = useState([]);
  const sourcesRef = useRef({});
  useEffect(() => {
    if (!me.id) return undefined;
    sourcesRef.current = {};
    const publish = () => {
      const map = new Map();
      Object.values(sourcesRef.current).forEach((docs) => docs.forEach((d) => map.set(d.id, d)));
      setRequests([...map.values()]);
    };
    const listen = (key, q) => onSnapshot(
      q,
      (snap) => { sourcesRef.current[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); publish(); },
      (err) => console.warn('Outsource listener error (' + key + '):', err.message)
    );
    const unsubs = [];
    const col = collection(db, 'outsourceVisits');
    if (seesAll) {
      unsubs.push(listen('all', query(col, orderBy('createdAt', 'desc'), limit(300))));
    } else {
      unsubs.push(listen('mine', query(col, where('createdByUid', '==', me.id), limit(150))));
      assigned.forEach((b) => unsubs.push(listen('branch:' + b, query(col, where('branch', '==', b), limit(150)))));
    }
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id, seesAll, assignedKey]);

  /* ----- new request form ----- */
  const empty = { branch: '', maintenanceTypes: [], description: '', workerCount: '', workerName: '', nationalId: '', phone: '', company: '', areaNames: [], countMayIncrease: false, expectedDate: '', expectedTime: '' };
  const [form, setForm] = useState(empty);
  const [idPhoto, setIdPhoto] = useState('');
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const chosenArea = areas.find((a) => form.areaNames.includes(a.name) && a.sensitive) || null;
  const sensitive = !!chosenArea?.sensitive;
  const branchValue = form.branch || (requestBranches.length === 1 ? requestBranches[0] : '');
  const typeNames = useMemo(() => [...categories].map((c) => c.name).filter(Boolean).sort((a, b) => a.localeCompare(b)), [categories]);

  const pickPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { setIdPhoto(await compressImage(file)); }
    catch (err) { alert(err.message); }
  };

  const submit = async (e) => {
    e.preventDefault();
    const name = form.workerName.trim().replace(/\s+/g, ' ');
    if (!branchValue) return alert('Please choose the branch.');
    if (form.maintenanceTypes.length === 0) return alert('Please tick at least one type of maintenance.');
    const countNum = parseInt(form.workerCount, 10);
    if (!Number.isInteger(countNum) || countNum < 1 || countNum > 20) return alert('Please enter how many technicians will enter (1 to 20).');
    if (form.description.trim().length < 3) return alert('Please describe the maintenance work.');
    if (name.split(' ').filter((w) => w.length >= 2).length < 2) return alert("Please enter the technician's full name (at least two names).");
    if (!/^[0-9]{14}$/.test(form.nationalId)) return alert('The national ID must be exactly 14 digits.');
    if (!idPhoto) return alert('Please add a photo of the national ID (take it or upload it).');
    if (!/^01[0-9]{9}$/.test(form.phone)) return alert('The phone number must be 11 digits and start with 01.');
    if (form.company.trim().length < 2) return alert('Please enter the maintenance company name.');
    if (!form.expectedDate) return alert('Please choose the expected date of the maintenance.');
    if (!form.expectedTime) return alert('Please choose the expected time of the maintenance.');
    if (form.areaNames.length === 0) return alert('Please tick at least one place of the maintenance inside the branch.');

    setSaving(true);
    try {
      const create = httpsCallable(functions, 'createOutsourceRequest');
      await create({ ...form, workerCount: countNum, branch: branchValue, workerName: name, idPhoto });
      setForm(empty); setIdPhoto(''); setShowForm(false);
      alert(sensitive
        ? 'Request sent. This place needs two approvals: the Branch Manager and the Supervisor of the branch. One of them will choose the escort.'
        : 'Request sent. The first eligible person to approve becomes the technician\'s escort.');
    } catch (err) {
      alert(err.message || 'Could not send the request.');
    } finally {
      setSaving(false);
    }
  };

  /* ----- actions on a request ----- */
  const [busyId, setBusyId] = useState(null);
  const act = async (id, action, extra = {}) => {
    let reason = '';
    if (action === 'reject') {
      reason = window.prompt('Reason for rejecting (optional):');
      if (reason === null) return;
    }
    if (action === 'cancel' && !window.confirm('Cancel this request?')) return;
    if (action === 'delete' && !window.confirm('Delete this request permanently (with the ID photo)? This cannot be undone.')) return;
    setBusyId(id);
    try {
      const respond = httpsCallable(functions, 'respondOutsourceRequest');
      await respond({ id, action, reason, ...extra });
    } catch (err) {
      alert(err.message || 'Could not complete that action.');
    } finally {
      setBusyId(null);
    }
  };

  /* ----- lists ----- */
  const [view, setView] = useState('open');
  const [branchFilter, setBranchFilter] = useState('All');
  const scoped = useMemo(() => requests.filter((g) => branchFilter === 'All' || g.branch === branchFilter), [requests, branchFilter]);
  const openList = useMemo(
    () => scoped.filter((g) => OPEN_STATUSES.includes(g.status)).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)),
    [scoped]
  );
  const historyList = useMemo(
    () => scoped.filter((g) => !OPEN_STATUSES.includes(g.status)).sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt)),
    [scoped]
  );
  const waitingForMe = useMemo(() => (canApproveOs ? countWaitingForMe(openList, me, openBranch) : 0), [openList, me, openBranch, canApproveOs]);

  const branchFilterOptions = useMemo(() => ['All', ...Array.from(new Set(requests.map((g) => g.branch))).sort()], [requests]);
  const shown = view === 'open' ? openList : historyList;

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-2">
        <h2 className="text-lg font-black text-slate-900">🧑‍🔧 Outsource Maintenance</h2>
        <p className="text-xs text-slate-500">
          For an outside maintenance technician who has to be escorted while working at a branch. Any Admin, Supervisor or Branch Manager
          of the branch can approve and becomes the escort. Sensitive places (like Women Toilets) need <strong>two approvals - the
          Branch Manager and the Supervisor</strong> (or one System Admin approval) - and whoever approved chooses the escort.
        </p>
        {waitingForMe > 0 && (
          <p className="text-xs font-black text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            ⏳ {waitingForMe} request(s) are waiting for your approval.
          </p>
        )}
        {canRequest && (
          <button onClick={() => setShowForm((v) => !v)} className="px-4 py-2 rounded-xl text-xs font-black bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer border-0">
            {showForm ? 'Close form' : '+ New outsource request'}
          </button>
        )}
      </div>

      {canRequest && showForm && (
        <form onSubmit={submit} className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-3">
          <h3 className="text-sm font-black text-slate-900">New outsource maintenance request</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Branch</label>
              <select required value={branchValue} onChange={(e) => set('branch', e.target.value)} className={field}>
                <option value="">Select branch...</option>
                {requestBranches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={label}>Type of maintenance <span className="text-slate-400 font-semibold">(tick one or more)</span></label>
              <div className="flex flex-wrap gap-2">
                {typeNames.length === 0 && <span className="text-xs text-slate-400">No types set up yet</span>}
                {typeNames.map((t) => {
                  const on = form.maintenanceTypes.includes(t);
                  return (
                    <label key={t} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold cursor-pointer select-none transition-all ${on ? 'bg-indigo-600 text-white border-indigo-700 shadow-sm' : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-400'}`}>
                      <input type="checkbox" checked={on} className="accent-indigo-300" onChange={() => set('maintenanceTypes', on ? form.maintenanceTypes.filter((x) => x !== t) : [...form.maintenanceTypes, t])} />
                      {t}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <label className={label}>Maintenance work to be done</label>
            <textarea required rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Explain the maintenance that will be done" className={`${field} bg-slate-50`} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Expected date of the maintenance</label>
              <input type="date" required value={form.expectedDate} min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => set('expectedDate', e.target.value)} className={field} />
            </div>
            <div>
              <label className={label}>Expected time</label>
              <input type="time" required value={form.expectedTime}
                onChange={(e) => set('expectedTime', e.target.value)} className={field} />
            </div>
          </div>

          <div>
            <label className={label}>How many maintenance technicians will enter?</label>
            <div className="flex items-center gap-2">
              <input
                type="text" inputMode="numeric" required value={form.workerCount} placeholder="Enter the number"
                onChange={(e) => set('workerCount', digitsOnly(e.target.value, 2))}
                className={`${field} font-mono flex-1`}
              />
            </div>
            <label className="flex items-center gap-2 mt-1.5 text-xs font-bold text-amber-800">
              <input type="checkbox" checked={form.countMayIncrease} onChange={(e) => set('countMayIncrease', e.target.checked)} />
              The number may increase (more technicians might come)
            </label>
            <p className="text-[10px] text-slate-400 mt-0.5">Only this number will be allowed in after approval. Below, give the details of ONE of them (name, ID, phone).</p>
          </div>

          <div>
            <label className={label}>Full name of one technician (the one whose ID you attach)</label>
            <input type="text" required value={form.workerName} onChange={(e) => set('workerName', e.target.value)} placeholder="Full name as on the ID" className={field} />
          </div>

          <div>
            <label className={label}>National ID of that technician (14 digits)</label>
            <input
              type="text" inputMode="numeric" required value={form.nationalId}
              onChange={(e) => set('nationalId', digitsOnly(e.target.value, 14))}
              placeholder="14 digits" className={`${field} font-mono`}
            />
            <p className="text-[10px] text-slate-400 mt-0.5">{form.nationalId.length}/14</p>
          </div>

          <div>
            <label className={label}>Photo of the national ID</label>
            <div className="flex flex-wrap gap-2 items-center">
              <label className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">
                📷 Take photo
                <input type="file" accept="image/*" capture="environment" onChange={pickPhoto} className="hidden" />
              </label>
              <label className="px-3 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer">
                🖼️ Upload from device
                <input type="file" accept="image/*" onChange={pickPhoto} className="hidden" />
              </label>
              {idPhoto && <button type="button" onClick={() => setIdPhoto('')} className="text-[11px] font-bold text-rose-600 underline cursor-pointer bg-transparent border-0">Remove</button>}
            </div>
            {idPhoto && <img src={idPhoto} alt="ID preview" className="mt-2 max-h-40 rounded-lg border border-slate-200" />}
            <p className="text-[10px] text-slate-400 mt-1">🔒 Only the requester, the escort, the branch's Branch Manager / Supervisor, the Facility Manager and System Admin can see it.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Phone of that technician (11 digits, starts with 01)</label>
              <input
                type="text" inputMode="numeric" required value={form.phone}
                onChange={(e) => set('phone', digitsOnly(e.target.value, 11))}
                placeholder="01xxxxxxxxx" className={`${field} font-mono`}
              />
              <p className="text-[10px] text-slate-400 mt-0.5">{form.phone.length}/11</p>
            </div>
            <div>
              <label className={label}>Maintenance company name</label>
              <input type="text" required value={form.company} onChange={(e) => set('company', e.target.value)} className={field} />
            </div>
          </div>

          <div>
            <label className={label}>Place of the maintenance inside the branch</label>
            <div className="flex flex-wrap gap-2">
              {areas.length === 0 && <span className="text-xs text-slate-400">No places set up yet - ask the System Admin (Settings)</span>}
              {areas.map((a) => {
                const on = form.areaNames.includes(a.name);
                return (
                  <label key={a.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold cursor-pointer select-none transition-all ${on ? (a.sensitive ? 'bg-rose-600 text-white border-rose-700' : 'bg-indigo-600 text-white border-indigo-700') + ' shadow-sm' : 'bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-400'}`}>
                    <input type="checkbox" checked={on} className="accent-indigo-300" onChange={() => set('areaNames', on ? form.areaNames.filter((x) => x !== a.name) : [...form.areaNames, a.name])} />
                    {a.name}{a.sensitive ? ' (2 approvals)' : ''}
                  </label>
                );
              })}
            </div>
          </div>
          {sensitive && (
            <p className="text-[11px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
              This place needs two approvals: the Branch Manager and the Supervisor of the branch. One of them then chooses the escort
              (themselves, the other approver, or an Admin / Supervisor / Branch Manager of the branch).
            </p>
          )}

          <button type="submit" disabled={saving} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-black py-2.5 rounded-xl text-sm cursor-pointer border-0">
            {saving ? 'Sending...' : 'Send request'}
          </button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
          <button onClick={() => setView('open')} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border-0 ${view === 'open' ? 'bg-white text-indigo-600 shadow-sm' : 'bg-transparent text-slate-600'}`}>
            Open ({openList.length})
          </button>
          <button onClick={() => setView('history')} className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer border-0 ${view === 'history' ? 'bg-white text-indigo-600 shadow-sm' : 'bg-transparent text-slate-600'}`}>
            History ({historyList.length})
          </button>
        </div>
        {branchFilterOptions.length > 2 && (
          <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className="p-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
            {branchFilterOptions.map((b) => <option key={b} value={b}>{b === 'All' ? 'All branches' : b}</option>)}
          </select>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-slate-400 italic bg-white border border-slate-200 rounded-2xl p-4">
          {view === 'open' ? 'No open outsource requests.' : 'No past outsource requests.'}
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((g) => (
            <VisitCard key={g.id} g={g} me={me} openBranch={openBranch} usersList={usersList} busyId={busyId} onAct={act} canApproveOs={canApproveOs} />
          ))}
        </div>
      )}
    </div>
  );
}

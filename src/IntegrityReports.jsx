import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db } from './firebase';
import {
  collection,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  query,
  where,
  orderBy
} from 'firebase/firestore';

/* =====================================================================
   Integrity / wrongdoing reports.
   -----------------------------------------------------------------
   IMPORTANT - this is deliberately anonymous. The employee submitting
   a report is NOT signed in and their identity , and the
   UI below says so plainly. Only system Admin can read the list of
   reports and change a report's status; the person who submitted a
   report can also see it (and its status) in their own "My Reports" list,
   but nobody else can.
   ===================================================================== */

// Same Cloudinary account already used across the app (Attendance, Towels).
const CLOUDINARY_CLOUD_NAME = 'gwgnpo4v';
const CLOUDINARY_UPLOAD_PRESET = 'ggwrpeyx';

const STATUS_OPTIONS = ['New', 'Under Review', 'Resolved', 'Dismissed'];
const STATUS_TONE = {
  New: { bg: '#ffe4e6', fg: '#9f1239' },
  'Under Review': { bg: '#fef3c7', fg: '#92400e' },
  Resolved: { bg: '#d1fae5', fg: '#065f46' },
  Dismissed: { bg: '#e2e8f0', fg: '#475569' }
};

const tsToDate = (t) => (t && typeof t.toDate === 'function' ? t.toDate() : null);
const fmtDateTime = (d) =>
  d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    : '—';

export default function IntegrityReports({ currentUser, branchesList = [], usersList = [], canReview = false }) {
  const [reports, setReports] = useState([]);
  const [view, setView] = useState('submit'); // 'submit' | 'mine' | 'review'
  const [submitting, setSubmitting] = useState(false);

  // form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [reportedAgainst, setReportedAgainst] = useState([]); // usernames
  const [photoUrl, setPhotoUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('All');
  const [savingStatusId, setSavingStatusId] = useState(null);

  // "Reported against" picker (own inline widget, not MultiSelectFilter - this one is
  // deliberately NOT given a "select all" shortcut).
  const [peoplePickerOpen, setPeoplePickerOpen] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState('');
  const peoplePickerRef = useRef(null);

  // camera
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  const myUsername = currentUser?.username || currentUser?.displayName || '';
  const myUid = currentUser?.id || currentUser?.uid || '';
  const myRole = currentUser?.role || '';
  // Deleting a report is Admin-only (HR can review and read, but not delete) - matches the
  // Firestore rule (`allow delete: if isAdmin();` on integrityReports).
  const isAdminUser = myRole.trim().toLowerCase() === 'admin';
  const [deletingId, setDeletingId] = useState(null);

  // Reports are only ever fetched if this account can review them (Admin/HR) or is
  // looking at their own - the Firestore rules enforce the same scope on the server,
  // this listener just matches what the rules already allow.
  useEffect(() => {
    if (!canReview) { setReports([]); return; }
    const q = query(collection(db, 'integrityReports'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setReports(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, [canReview]);

  // A reporter (whether or not they can review the whole list) can also see their own
  // submitted reports. This is a separately-scoped query - filtered by reporterUid - so it
  // matches the security rule's "resource.data.reporterUid == request.auth.uid" clause exactly
  // (an unfiltered query would be rejected outright for anyone who isn't Admin/HR).
  // Sorted client-side so no composite index is needed for this query.
  const [myReports, setMyReports] = useState([]);
  useEffect(() => {
    if (!myUid) { setMyReports([]); return; }
    const q = query(collection(db, 'integrityReports'), where('reporterUid', '==', myUid));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => (tsToDate(b.createdAt)?.getTime() || 0) - (tsToDate(a.createdAt)?.getTime() || 0));
      setMyReports(list);
    }, (err) => console.warn('My reports listener error:', err));
    return () => unsub();
  }, [myUid]);

  // close the people picker when clicking outside it or pressing Escape
  useEffect(() => {
    if (!peoplePickerOpen) return;
    const onOutside = (e) => {
      if (peoplePickerRef.current && !peoplePickerRef.current.contains(e.target)) setPeoplePickerOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPeoplePickerOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [peoplePickerOpen]);

  // People the report can be filed against - everyone except the reporter themselves.
  const peopleOptions = useMemo(() => {
    return usersList
      .filter((u) => u.username && u.username !== myUsername)
      .map((u) => ({ value: u.username, label: u.username, role: u.role || '' }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [usersList, myUsername]);

  const visiblePeopleOptions = useMemo(
    () => peopleOptions.filter((o) => o.label.toLowerCase().includes(peopleQuery.trim().toLowerCase())),
    [peopleOptions, peopleQuery]
  );

  const togglePerson = (username) => {
    setReportedAgainst((prev) => (prev.includes(username) ? prev.filter((v) => v !== username) : [...prev, username]));
  };

  const branchNames = useMemo(
    () => [...branchesList].map((b) => (typeof b === 'string' ? b : b.name)).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [branchesList]
  );

  const visibleReports = useMemo(() => {
    const list = statusFilter === 'All' ? reports : reports.filter((r) => r.status === statusFilter);
    return list;
  }, [reports, statusFilter]);

  // ---------- photo capture / upload ----------
  const uploadToCloudinary = async (base64Data) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', base64Data);
      formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
        method: 'POST',
        body: formData
      });
      if (!response.ok) throw new Error('Cloudinary upload failed');
      const data = await response.json();
      return data.secure_url;
    } catch (err) {
      console.warn('Photo upload failed:', err);
      alert('Could not upload the photo. You can still submit the report without it, or try again.');
      return '';
    } finally {
      setIsUploading(false);
    }
  };

  const startCameraStream = async () => {
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      alert('Camera access denied or no camera available.');
      setIsCameraOpen(false);
    }
  };

  useEffect(() => {
    if (isCameraOpen) startCameraStream();
    else if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    return () => { if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; } };
  }, [isCameraOpen]);

  const capturePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    setIsCameraOpen(false);
    const url = await uploadToCloudinary(dataUrl);
    if (url) setPhotoUrl(url);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const url = await uploadToCloudinary(reader.result);
      if (url) setPhotoUrl(url);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // ---------- submit ----------
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !description.trim() || !branch) {
      alert('Please fill in a title, description and branch before submitting.');
      return;
    }
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'integrityReports'), {
        title: title.trim(),
        description: description.trim(),
        branch,
        reportedAgainst,
        photoUrl: photoUrl || '',
        reporterUid: myUid,
        reporterUsername: myUsername,
        reporterRole: myRole,
        status: 'New',
        createdAt: serverTimestamp()
      });
      setTitle('');
      setDescription('');
      setBranch('');
      setReportedAgainst([]);
      setPhotoUrl('');
      alert('Your report has been submitted. Only Admin can see it.');
      setView('mine');
    } catch (err) {
      console.error(err);
      alert('Could not submit the report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const changeStatus = async (reportId, newStatus) => {
    setSavingStatusId(reportId);
    try {
      await updateDoc(doc(db, 'integrityReports', reportId), {
        status: newStatus,
        statusUpdatedAt: serverTimestamp(),
        statusUpdatedBy: myUsername
      });
    } catch (err) {
      console.error(err);
      alert('Could not update the status.');
    } finally {
      setSavingStatusId(null);
    }
  };

  const handleDelete = async (report) => {
    const confirmed = window.confirm(
      `Delete this report permanently ("${report.title}")? This cannot be undone.`
    );
    if (!confirmed) return;
    setDeletingId(report.id);
    try {
      await deleteDoc(doc(db, 'integrityReports', report.id));
    } catch (err) {
      console.error(err);
      alert('Could not delete the report.');
    } finally {
      setDeletingId(null);
    }
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">🚩 Report a Concern</h2>
          <p className="text-xs text-slate-500 max-w-xl">
            <span className="font-bold text-slate-700">Your voice matters.</span> If something doesn't feel
            right — unsafe conditions, dishonesty, anything — this is the place to say so.
            Only <span className="font-bold text-slate-700">Admin </span> will read it, and therefore
            it's not linked to your account.
          </p>
          {/* Arabic version - same honest meaning as the English text above (not a "true anonymity" claim):
              the report is tied to the reporter's account, and only Admin can read it. */}
          <p dir="rtl" lang="ar" className="text-xs text-slate-500 max-w-xl mt-1.5">
            <span className="font-bold text-slate-700">هذا البلاغ مجهولاً.</span> لا يتم تسجيله مرتبطًا
            بحسابك، ولا يطّلع عليه سوى <span className="font-bold text-slate-700">مسئول النظام </span> فقط،
            دون سواه. يمكنك متابعة بلاغك وحالته الحالية من قسم "بلاغاتي".
          </p>
        </div>
        <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
          <button
            onClick={() => setView('submit')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${view === 'submit' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            New report
          </button>
          <button
            onClick={() => setView('mine')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${view === 'mine' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            My reports {myReports.length > 0 && `(${myReports.length})`}
          </button>
          {canReview && (
            <button
              onClick={() => setView('review')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${view === 'review' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              Review all {reports.length > 0 && `(${reports.length})`}
            </button>
          )}
        </div>
      </div>

      {view === 'submit' && (
        <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
          <div>
            <label className={label}>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary, e.g. 'Missing cash from register'"
              className={field}
              maxLength={120}
            />
          </div>
          <div>
            <label className={label}>Branch (required)</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} className={field}>
              <option value="">Select a branch...</option>
              {branchNames.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Reported against (optional - pick one or more people)</label>
            <div className="relative" ref={peoplePickerRef}>
              <button
                type="button"
                onClick={() => setPeoplePickerOpen((o) => !o)}
                className={`${field} flex items-center justify-between gap-2 text-left cursor-pointer`}
              >
                <span className="truncate">
                  {reportedAgainst.length === 0 ? 'Nobody selected' : reportedAgainst.join(', ')}
                </span>
                <span className="text-slate-400 text-[10px] shrink-0">{peoplePickerOpen ? '▲' : '▼'}</span>
              </button>

              {peoplePickerOpen && (
                <div
                  className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg p-2 space-y-2"
                  style={{ zIndex: 40 }}
                >
                  {peopleOptions.length > 6 && (
                    <input
                      type="text"
                      autoFocus
                      value={peopleQuery}
                      onChange={(e) => setPeopleQuery(e.target.value)}
                      placeholder="Search people..."
                      className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                    />
                  )}
                  {reportedAgainst.length > 0 && (
                    <div className="text-right">
                      <button type="button" onClick={() => setReportedAgainst([])} className="text-[11px] font-bold text-slate-500 hover:underline cursor-pointer">
                        Clear
                      </button>
                    </div>
                  )}
                  <div className="overflow-y-auto space-y-0.5" style={{ maxHeight: 220 }}>
                    {visiblePeopleOptions.length === 0 && (
                      <p className="text-[11px] text-slate-400 italic px-2 py-1">No matches</p>
                    )}
                    {visiblePeopleOptions.map((o) => (
                      <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs">
                        <input type="checkbox" checked={reportedAgainst.includes(o.value)} onChange={() => togglePerson(o.value)} />
                        <span className="font-semibold text-slate-800 truncate">{o.label}</span>
                        {o.role && <span className="ml-auto text-[10px] text-slate-400 shrink-0">{o.role}</span>}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div>
            <label className={label}>What happened - please be as detailed as you can</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder="Who, what, when, where - as much detail as you have."
              className={field}
            />
          </div>
          <div>
            <label className={label}>Photo (optional)</label>
            {photoUrl ? (
              <div className="flex items-center gap-3">
                <img src={photoUrl} alt="attached" className="w-24 h-24 object-cover rounded-xl border border-slate-200" />
                <button type="button" onClick={() => setPhotoUrl('')} className="text-xs font-bold text-rose-600 hover:text-rose-700">
                  Remove photo
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCameraOpen(true)}
                  disabled={isUploading}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2 rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
                >
                  📷 Take photo
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2 rounded-xl text-xs transition cursor-pointer disabled:opacity-50"
                >
                  📁 Upload photo
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                {isUploading && <span className="text-xs text-slate-400">Uploading...</span>}
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting || isUploading}
            className="bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-extrabold px-6 py-2.5 rounded-xl text-xs shadow-md transition-all cursor-pointer"
          >
            {submitting ? 'Submitting...' : 'Submit report'}
          </button>
        </form>
      )}

      {view === 'mine' && (
        <div className="space-y-2">
          {myReports.length === 0 ? (
            <p className="text-xs text-slate-400 italic">You haven't submitted any reports yet.</p>
          ) : (
            myReports.map((r) => {
              const tone = STATUS_TONE[r.status] || STATUS_TONE.New;
              return (
                <div key={r.id} className="border border-slate-200 rounded-2xl p-4 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 className="font-bold text-slate-900 text-sm">{r.title}</h4>
                      <p className="text-[11px] text-slate-400">{r.branch} • {fmtDateTime(tsToDate(r.createdAt))}</p>
                      {Array.isArray(r.reportedAgainst) && r.reportedAgainst.length > 0 && (
                        <p className="text-[11px] text-slate-500">Reported against: <span className="font-bold">{r.reportedAgainst.join(', ')}</span></p>
                      )}
                    </div>
                    <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap" style={{ backgroundColor: tone.bg, color: tone.fg }}>
                      {r.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 whitespace-pre-wrap">{r.description}</p>
                  {r.photoUrl && <img src={r.photoUrl} alt="" className="w-20 h-20 object-cover rounded-lg border border-slate-200 mt-1" />}
                </div>
              );
            })
          )}
        </div>
      )}

      {view === 'review' && canReview && (
        <div className="space-y-4">
          <div>
            <label className={label}>Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${field} max-w-xs`}>
              <option value="All">All statuses</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {visibleReports.length === 0 ? (
            <p className="text-xs text-slate-400 italic">No reports match this filter.</p>
          ) : (
            <div className="space-y-3">
              {visibleReports.map((r) => {
                const tone = STATUS_TONE[r.status] || STATUS_TONE.New;
                return (
                  <div key={r.id} className="border border-slate-200 rounded-2xl p-4 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div>
                        <h4 className="font-bold text-slate-900 text-sm">{r.title}</h4>
                        <p className="text-[11px] text-slate-400">
                          {r.branch} • {fmtDateTime(tsToDate(r.createdAt))} • reported by{' '}
                          <span className="font-bold text-slate-600">{r.reporterUsername}</span>
                          {r.reporterRole && <span> ({r.reporterRole})</span>}
                        </p>
                        {Array.isArray(r.reportedAgainst) && r.reportedAgainst.length > 0 && (
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Reported against: <span className="font-bold text-slate-700">{r.reportedAgainst.join(', ')}</span>
                          </p>
                        )}
                      </div>
                      <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap" style={{ backgroundColor: tone.bg, color: tone.fg }}>
                        {r.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 whitespace-pre-wrap">{r.description}</p>
                    {r.photoUrl && <img src={r.photoUrl} alt="" className="w-28 h-28 object-cover rounded-lg border border-slate-200" />}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      {isAdminUser ? (
                        <>
                          <span className="text-[10px] font-bold text-slate-400 uppercase">Change status:</span>
                          <select
                            value={r.status}
                            onChange={(e) => changeStatus(r.id, e.target.value)}
                            disabled={savingStatusId === r.id}
                            className="p-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                          >
                            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </>
                      ) : (
                        // HR can read reports but only Admin can change status (matches the security rule) -
                        // an editable dropdown here would just fail silently, so HR sees a plain status instead.
                        <span className="text-[10px] text-slate-400">Only Admin can change the status.</span>
                      )}
                      {r.statusUpdatedBy && (
                        <span className="text-[10px] text-slate-400">last changed by {r.statusUpdatedBy}</span>
                      )}
                      {isAdminUser && (
                        <button
                          type="button"
                          onClick={() => handleDelete(r)}
                          disabled={deletingId === r.id}
                          className="ml-auto text-[11px] font-bold text-rose-600 hover:text-rose-700 disabled:opacity-50 cursor-pointer"
                        >
                          {deletingId === r.id ? 'Deleting...' : '🗑️ Delete report'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Camera modal */}
      {isCameraOpen && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-4 max-w-md w-full space-y-3">
            <video ref={videoRef} autoPlay playsInline className="w-full rounded-xl bg-black" />
            <canvas ref={canvasRef} className="hidden" />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsCameraOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={capturePhoto}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 text-white"
              >
                Capture
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

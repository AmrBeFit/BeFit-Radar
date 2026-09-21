import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, onSnapshot, addDoc, updateDoc, doc } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

const BRANCHES = ['Main Branch', 'Branch A', 'Branch B', 'Branch C', 'WaterWay', 'Maxim the Gym'];
const MAX_SESSIONS = 5;

export default function AttendancePortal({ currentUser }) {
  const [attendanceList, setAttendanceList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBranch, setSelectedBranch] = useState(BRANCHES[0]);
  const [filterBranch, setFilterBranch] = useState('All');
  const [actionLoading, setActionLoading] = useState(false);

  // 1. الاستماع للتغييرات اللحظية في Firebase
  useEffect(() => {
    setLoading(true);
    const q = collection(db, 'attendance');

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
      
      // ترتيب البيانات زمنيًا من الأحدث للأقدم
      data.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      setAttendanceList(data);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching attendance data:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [currentUser]);

  const currentUserId = currentUser?.uid || '';
  const currentUserName = currentUser?.displayName || currentUser?.email || '';

  // 2. دالة لتوحيد صيغ التواريخ (تتجنب أخطاء تفاوت المناطق الزمنية)
  const normalizeDate = (dateString) => {
    if (!dateString) return '';
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const todayNormalized = normalizeDate(new Date());

  // 3. فلترة جلسات اليوم للمستخدم الحالي بمرونة
  const todaySessions = attendanceList.filter(item => {
    const isUser = (currentUserId && item.userId === currentUserId) || 
                   (currentUserName && item.userName === currentUserName) || 
                   (!currentUserId && !currentUserName); // في حالة عدم وجود مستخدم مسجل
    const itemDate = normalizeDate(item.date || item.createdAt);
    return isUser && itemDate === todayNormalized;
  }).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  // 4. تحديد الجلسة النشطة وأحدث جلسة مسجلة
  const activeSession = todaySessions.find(item => !item.checkOut);
  const latestSession = todaySessions.length > 0 
    ? todaySessions[todaySessions.length - 1] 
    : attendanceList.find(item => (item.userId === currentUserId || item.userName === currentUserName));

  const isCheckedIn = Boolean(activeSession);
  const isMaxReached = todaySessions.length >= MAX_SESSIONS && !isCheckedIn;

  // 5. تسجيل الحضور Check In
  const handleCheckIn = async () => {
    if (!selectedBranch) return alert('PLEASE SELECT A BRANCH FIRST!');
    if (isCheckedIn) return alert(`You are already checked in at ${activeSession.branch}! Please check out first.`);
    if (isMaxReached) return alert(`You have reached the maximum allowed sessions (${MAX_SESSIONS}) for today!`);

    setActionLoading(true);
    try {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

      await addDoc(collection(db, 'attendance'), {
        userId: currentUserId,
        userName: currentUserName || 'Employee',
        branch: selectedBranch,
        date: todayNormalized,
        checkIn: timeStr,
        checkOut: null,
        status: 'ACTIVE',
        createdAt: now.toISOString()
      });

      alert(`Checked in successfully at ${selectedBranch}`);
    } catch (err) {
      console.error("Error checking in:", err);
      alert("Error checking in: " + err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // 6. تسجيل الانصراف Check Out
  const handleCheckOut = async () => {
    if (!activeSession) {
      alert('No active check-in session found to check out from!');
      return;
    }

    setActionLoading(true);
    try {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

      const recordRef = doc(db, 'attendance', activeSession.id);
      await updateDoc(recordRef, {
        checkOut: timeStr,
        status: 'COMPLETED'
      });

      alert('Checked out successfully.');
    } catch (err) {
      console.error("Error checking out:", err);
      alert("Error checking out: " + err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const displayedList = filterBranch === 'All' 
    ? attendanceList 
    : attendanceList.filter(item => (item.branch || item.assignedBranch) === filterBranch);

  const exportToExcel = () => {
    if (displayedList.length === 0) return alert('No data available to export');
    
    const formattedData = displayedList.map(item => ({
      "User Name": item.userName || item.displayName || 'N/A',
      "Branch": item.branch || item.assignedBranch || 'N/A',
      "Date": item.date || 'N/A',
      "Check In": item.checkIn || 'N/A',
      "Check Out": item.checkOut || 'N/A',
      "Status": item.status || (item.checkOut ? 'COMPLETED' : 'ACTIVE')
    }));

    const worksheet = XLSX.utils.json_to_sheet(formattedData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
    XLSX.writeFile(workbook, `Attendance_Report_${filterBranch}.xlsx`);
  };

  const exportToPDF = () => {
    if (displayedList.length === 0) return alert('No data available to export');

    const pdfDoc = new jsPDF();
    pdfDoc.text(`Attendance & Departure Report (${filterBranch})`, 14, 15);

    const tableColumn = ["User Name", "Branch", "Date", "Check In", "Check Out", "Status"];
    const tableRows = displayedList.map(item => [
      item.userName || item.displayName || 'N/A',
      item.branch || item.assignedBranch || 'N/A',
      item.date || 'N/A',
      item.checkIn || 'N/A',
      item.checkOut || 'N/A',
      item.status || (item.checkOut ? 'COMPLETED' : 'ACTIVE')
    ]);

    pdfDoc.autoTable({
      head: [tableColumn],
      body: tableRows,
      startY: 20,
    });

    pdfDoc.save(`Attendance_Report_${filterBranch}.pdf`);
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', backgroundColor: '#f9fafb', minHeight: '100vh' }}>
      
      {/* Live Attendance Portal Box */}
      <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', padding: '32px', borderRadius: '24px', maxWidth: '520px', margin: '0 auto 30px auto', textAlign: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
        <h2 style={{ margin: '0 0 8px 0', fontSize: '26px', fontWeight: '800', color: '#000' }}>Live Attendance Portal</h2>
        <p style={{ color: '#6b7280', fontSize: '12px', margin: '0 0 24px 0' }}>Record your daily Check-In and Check-Out with live photo capture.</p>

        {/* Branch Selector */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '16px', padding: '16px', backgroundColor: '#fff', marginBottom: '16px', textAlign: 'left' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: '#111827', marginBottom: '8px' }}>Select Branch for Attendance</label>
          <select 
            value={selectedBranch} 
            onChange={(e) => setSelectedBranch(e.target.value)}
            disabled={isCheckedIn}
            style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: isCheckedIn ? '#f3f4f6' : '#fff', fontSize: '14px', outline: 'none', cursor: isCheckedIn ? 'not-allowed' : 'pointer' }}
          >
            {BRANCHES.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        {/* Status Box Today */}
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '16px', padding: '16px', backgroundColor: '#fff', marginBottom: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', textAlign: 'center' }}>
          <div>
            <span style={{ fontSize: '11px', color: '#6b7280', display: 'block', fontWeight: '600' }}>Status Today</span>
            <strong style={{ fontSize: '13px', color: '#111827', marginTop: '4px', display: 'block' }}>
              {isCheckedIn ? 'ACTIVE' : (latestSession?.checkOut ? 'Completed' : 'Not Started')}
            </strong>
          </div>
          <div>
            <span style={{ fontSize: '11px', color: '#6b7280', display: 'block', fontWeight: '600' }}>Check-In</span>
            <strong style={{ fontSize: '12px', color: '#111827', marginTop: '4px', display: 'block' }}>
              {latestSession?.checkIn ? `${latestSession.date || ''} ${latestSession.checkIn}` : '—'}
            </strong>
          </div>
          <div>
            <span style={{ fontSize: '11px', color: '#6b7280', display: 'block', fontWeight: '600' }}>Check-Out</span>
            <strong style={{ fontSize: '12px', color: '#111827', marginTop: '4px', display: 'block' }}>
              {latestSession?.checkOut ? `${latestSession.date || ''} ${latestSession.checkOut}` : '—'}
            </strong>
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          <button 
            onClick={handleCheckIn}
            disabled={actionLoading || isCheckedIn || isMaxReached}
            style={{ 
              padding: '24px 12px', 
              borderRadius: '20px', 
              backgroundColor: '#fff', 
              border: '1px solid #e5e7eb', 
              cursor: (actionLoading || isCheckedIn || isMaxReached) ? 'not-allowed' : 'pointer', 
              opacity: (isCheckedIn || isMaxReached) ? 0.4 : 1,
              boxShadow: '0 2px 4px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ width: '22px', height: '22px', borderRadius: '50%', backgroundColor: '#34d399', margin: '0 auto 12px auto' }}></div>
            <strong style={{ color: '#111827', display: 'block', fontSize: '14px', letterSpacing: '0.5px' }}>CHECK IN</strong>
            <span style={{ fontSize: '11px', color: '#9ca3af', display: 'block', marginTop: '4px' }}>
              {isMaxReached ? '(Limit Reached)' : '(Requires Live Photo)'}
            </span>
          </button>

          <button 
            onClick={handleCheckOut}
            disabled={actionLoading || !isCheckedIn}
            style={{ 
              padding: '24px 12px', 
              borderRadius: '20px', 
              backgroundColor: '#fff', 
              border: '1px solid #e5e7eb', 
              cursor: (actionLoading || !isCheckedIn) ? 'not-allowed' : 'pointer', 
              opacity: !isCheckedIn ? 0.4 : 1,
              boxShadow: '0 2px 4px rgba(0,0,0,0.02)'
            }}
          >
            <div style={{ width: '22px', height: '22px', borderRadius: '50%', backgroundColor: '#f87171', margin: '0 auto 12px auto' }}></div>
            <strong style={{ color: '#111827', display: 'block', fontSize: '14px', letterSpacing: '0.5px' }}>CHECK OUT</strong>
            <span style={{ fontSize: '11px', color: '#9ca3af', display: 'block', marginTop: '4px' }}>(Requires Live Photo)</span>
          </button>
        </div>
      </div>

      {/* Reports Section */}
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
          <h3 style={{ fontSize: '20px', fontWeight: 'bold', margin: 0, color: '#111827' }}>Attendance & Departure Reports</h3>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <select 
              value={filterBranch} 
              onChange={(e) => setFilterBranch(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', backgroundColor: '#fff' }}
            >
              <option value="All">All Branches</option>
              {BRANCHES.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>

            <button 
              onClick={exportToExcel}
              style={{ backgroundColor: '#107c41', color: '#fff', padding: '8px 16px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '600', fontSize: '13px' }}
            >
              📊 Excel
            </button>

            <button 
              onClick={exportToPDF}
              style={{ backgroundColor: '#ac0808', color: '#fff', padding: '8px 16px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '600', fontSize: '13px' }}
            >
              📄 PDF
            </button>
          </div>
        </div>

        {loading ? (
          <p style={{ textAlign: 'center', color: '#6b7280' }}>Loading attendance records...</p>
        ) : (
          <div style={{ backgroundColor: '#fff', borderRadius: '12px', overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ backgroundColor: '#f9fafb', borderBottom: '1px solid #e5e7eb', color: '#4b5563', fontSize: '13px' }}>
                  <th style={{ padding: '12px 16px' }}>User Name</th>
                  <th style={{ padding: '12px 16px' }}>Branch</th>
                  <th style={{ padding: '12px 16px' }}>Date</th>
                  <th style={{ padding: '12px 16px' }}>Check In</th>
                  <th style={{ padding: '12px 16px' }}>Check Out</th>
                  <th style={{ padding: '12px 16px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {displayedList.length === 0 ? (
                  <tr>
                    <td colSpan="6" style={{ textAlign: 'center', padding: '24px', color: '#9ca3af' }}>No attendance records found.</td>
                  </tr>
                ) : (
                  displayedList.map((row) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6', fontSize: '14px', color: '#1f2937' }}>
                      <td style={{ padding: '12px 16px' }}>{row.userName || row.displayName || 'N/A'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: '#e0f2fe', color: '#0369a1', fontSize: '12px', fontWeight: '600' }}>
                          {row.branch || row.assignedBranch || 'N/A'}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px' }}>{row.date || 'N/A'}</td>
                      <td style={{ padding: '12px 16px' }}>{row.checkIn || 'N/A'}</td>
                      <td style={{ padding: '12px 16px' }}>{row.checkOut || 'N/A'}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ padding: '4px 10px', borderRadius: '12px', backgroundColor: row.checkOut ? '#d1fae5' : '#fef3c7', color: row.checkOut ? '#065f46' : '#92400e', fontSize: '12px', fontWeight: '600' }}>
                          {row.checkOut ? 'COMPLETED' : 'ACTIVE'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
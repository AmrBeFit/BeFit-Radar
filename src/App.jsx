import React, { useState, useEffect } from 'react';
import Login from './Login';
import Dashboard from './Dashboard';
import { db } from './firebase';
import { collection, onSnapshot, addDoc, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';

const MAX_SESSIONS = 5;

// 1. Target Branch Specific CEONotificationListener Component
function CEONotificationListener({ user }) {
  const [audioEnabled, setAudioEnabled] = useState(false);

  const currentUserIdentifier = user?.username || user?.displayName || user?.email || user?.name || '';
  const userRole = (user?.role || '').toUpperCase();
  const isAdminOrCEO = userRole === 'ADMIN' || userRole === 'CEO';

  const playOriginalAudio = () => {
    try {
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
      audio.play().catch(e => console.log("Audio autoplay restricted:", e));
    } catch (e) {
      console.log("Audio play error:", e);
    }
  };

  // Update: notifications are now enabled automatically - nobody has to click a button.
  // Browsers only require SOME user gesture (any click/tap/keypress anywhere on the page) before
  // audio is allowed to play and before the notification permission prompt can appear, so instead of
  // showing a dedicated "Enable Audio" button, we silently unlock everything on the very first
  // interaction the person makes anywhere in the app (e.g. clicking a tab, typing in a field).
  useEffect(() => {
    // Ask for Notification permission proactively on mount (works in most browsers even without a gesture)
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    if (audioEnabled) return;

    const silentlyUnlock = () => {
      try {
        const unlockAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        unlockAudio.volume = 0;
        unlockAudio.play().then(() => {
          unlockAudio.pause();
          unlockAudio.currentTime = 0;
        }).catch(() => {});
      } catch (e) {
        // ignore
      }

      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }

      setAudioEnabled(true);
      window.removeEventListener('click', silentlyUnlock);
      window.removeEventListener('touchstart', silentlyUnlock);
      window.removeEventListener('keydown', silentlyUnlock);
    };

    window.addEventListener('click', silentlyUnlock);
    window.addEventListener('touchstart', silentlyUnlock);
    window.addEventListener('keydown', silentlyUnlock);

    return () => {
      window.removeEventListener('click', silentlyUnlock);
      window.removeEventListener('touchstart', silentlyUnlock);
      window.removeEventListener('keydown', silentlyUnlock);
    };
  }, [audioEnabled]);

  useEffect(() => {
    if (!currentUserIdentifier && !isAdminOrCEO) return;

    const pageStartTimestamp = Date.now();

    const unsubscribe = onSnapshot(collection(db, 'requests'), async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const newRequest = change.doc.data();

          const isManagement = 
            newRequest.createdByRole === 'CEO' || 
            newRequest.role === 'CEO' || 
            newRequest.createdByRole === 'ADMIN' || 
            newRequest.role === 'ADMIN' ||
            newRequest.type === 'SUMMON';

          let requestTime = pageStartTimestamp;
          if (newRequest.createdAt) {
            if (typeof newRequest.createdAt.toMillis === 'function') {
              requestTime = newRequest.createdAt.toMillis();
            } else {
              requestTime = new Date(newRequest.createdAt).getTime();
            }
          }

          if (requestTime < pageStartTimestamp - 10000) {
            continue;
          }

          let shouldNotify = false;
          let alertMsg = '';

          if (isManagement) {
            // CEO/Admin/SUMMON requests - unchanged from before
            const targetBranch = newRequest.targetBranch;
            shouldNotify = isAdminOrCEO;

            if (!shouldNotify && currentUserIdentifier && targetBranch) {
              try {
                const attSnapshot = await getDocs(collection(db, 'attendance'));

                const activeSession = attSnapshot.docs
                  .map(doc => doc.data())
                  .find(a => {
                    const matchesUser = 
                      a.username === currentUserIdentifier || 
                      a.email === currentUserIdentifier || 
                      a.name === currentUserIdentifier ||
                      a.userId === user?.id;

                    const isActive = !a.checkOutTime && !a.checkOut;
                    const matchesBranch = a.branch === targetBranch || a.branchName === targetBranch;

                    return matchesUser && isActive && matchesBranch;
                  });

                if (activeSession) {
                  shouldNotify = true;
                }
              } catch (err) {
                console.error("Error verifying active attendance branch:", err);
              }
            }

            alertMsg = newRequest.type === 'SUMMON'
              ? `🚨 URGENT CALL FROM MANAGEMENT!\nTarget Branch: ${newRequest.targetBranch}\nSender: ${newRequest.senderName || 'Admin/CEO'}`
              : `🔔 NEW MANAGEMENT REQUEST!\n${newRequest.title || newRequest.details || 'A new request has been submitted.'}`;
          } else {
            // Update: any regular new maintenance request - always notifies Admin and CEO, and notifies the Facility Manager if the request is in one of their branches (or all branches if none are assigned)
            const isFacilityManagerRole = userRole === 'FACILITY MANAGER';
            const userAssignedBranches = Array.isArray(user?.assignedBranches) ? user.assignedBranches : [];
            const branchMatches = userAssignedBranches.length === 0 || userAssignedBranches.includes(newRequest.branch);

            shouldNotify = isAdminOrCEO || (isFacilityManagerRole && branchMatches);

            alertMsg = `🔧 NEW MAINTENANCE REQUEST!\n${newRequest.title || 'Untitled'}\nBranch: ${newRequest.branch || 'N/A'} • ${newRequest.category || ''}\nBy: ${newRequest.createdByUsername || newRequest.createdBy || 'Unknown'}`;
          }

          if (!shouldNotify) {
            continue;
          }

          if ('vibrate' in navigator) {
            try {
              navigator.vibrate([500, 200, 500, 200, 500]);
            } catch (e) {
              console.log("Vibration error:", e);
            }
          }

          playOriginalAudio();

          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification(isManagement ? '🚨 URGENT CALL FOR YOUR BRANCH!' : '🔧 New Maintenance Request', {
                body: newRequest.details || newRequest.title || `Branch: ${newRequest.targetBranch || newRequest.branch || ''}`,
                requireInteraction: true
              });
            } catch (e) {
              console.log("Notification Constructor Error:", e);
            }
          }

          setTimeout(() => {
            alert(alertMsg);
          }, 200);
        }
      }
    }, (error) => {
      console.error("Firestore Notification Listener Error:", error);
    });

    return () => unsubscribe();
  }, [currentUserIdentifier, isAdminOrCEO, user]);

  // Update: no visible UI anymore - unlocking happens silently on first interaction, nothing to click
  return null;
}

// 2. Dynamic Summon Branch Widget (Without Live Requests Viewer)
export function SummonBranchWidget({ user }) {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const unsubBranches = onSnapshot(collection(db, 'branches'), (snapshot) => {
      const branchList = snapshot.docs.map(doc => doc.data().name || doc.data().branchName || doc.id);
      branchList.sort((a, b) => a.localeCompare(b));

      setBranches(branchList);
      if (branchList.length > 0 && !selectedBranch) {
        setSelectedBranch(branchList[0]);
      }
    });

    return () => unsubBranches();
  }, []);

  const roleUpper = user?.role?.toUpperCase() || user?.createdByRole?.toUpperCase() || '';
  const canSummon = roleUpper === 'CEO' || roleUpper === 'ADMIN';

  const handleSummon = async () => {
    if (!selectedBranch) {
      alert("PLEASE SELECT A BRANCH FIRST!");
      return;
    }

    const confirmCall = window.confirm(`Are you sure you want to send an URGENT CALL to ${selectedBranch}?`);
    if (!confirmCall) return;

    setLoading(true);
    try {
      await addDoc(collection(db, 'requests'), {
        title: `🚨 Urgent Call from ${user.role || 'Management'}`,
        details: `Urgent summons for ${selectedBranch} initiated by ${user.name || user.role}`,
        targetBranch: selectedBranch,
        createdByRole: user.role || 'CEO',
        senderName: user.name || user.role || 'Management',
        type: 'SUMMON',
        status: 'NEW',
        createdAt: new Date().toISOString()
      });

      alert(`✅ Call notification sent to ${selectedBranch} successfully!`);
    } catch (error) {
      console.error("Error sending summon:", error);
      alert("Failed to send summon request!");
    } finally {
      setLoading(false);
    }
  };

  if (!canSummon) return null;

  return (
    <div style={{
      maxWidth: '680px',
      margin: '0 auto 24px auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '20px',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{
        backgroundColor: '#fff1f2',
        border: '1px solid #fecdd3',
        borderRadius: '20px',
        padding: '20px 24px',
        boxShadow: '0 4px 12px rgba(225, 29, 72, 0.05)'
      }}>
        <h3 style={{ margin: '0 0 6px 0', color: '#9f1239', fontSize: '18px', fontWeight: '800' }}>
          📢 Urgent Branch Summon (CEO / Admin)
        </h3>
        <p style={{ fontSize: '12px', color: '#881337', margin: '0 0 16px 0' }}>
          Select a branch to trigger an instant sound, vibration & screen alert on active devices.
        </p>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <select
            value={selectedBranch}
            onChange={(e) => setSelectedBranch(e.target.value)}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '12px',
              border: '1px solid #fda4af',
              backgroundColor: '#ffffff',
              fontSize: '14px',
              fontWeight: '600',
              color: '#1f2937',
              outline: 'none'
            }}
          >
            {branches.length === 0 ? (
              <option value="">No branches found</option>
            ) : (
              branches.map(branch => (
                <option key={branch} value={branch}>{branch}</option>
              ))
            )}
          </select>

          <button
            onClick={handleSummon}
            disabled={loading || branches.length === 0}
            style={{
              backgroundColor: '#e11d48',
              color: '#ffffff',
              border: 'none',
              borderRadius: '12px',
              padding: '12px 20px',
              fontWeight: '800',
              fontSize: '13px',
              cursor: (loading || branches.length === 0) ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 12px rgba(225, 29, 72, 0.25)',
              whiteSpace: 'nowrap'
            }}
          >
            {loading ? 'Sending...' : '🚨 Summon Now'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 3. Maintenance Status Selector Helper (Strict Control Logic)
export function MaintenanceStatusSelector({ request, user, onStatusChange }) {
  const roleUpper = (user?.role || '').toUpperCase();
  const isAdmin = roleUpper === 'ADMIN';
  const isFacilityManager = roleUpper === 'FACILITY MANAGER' || roleUpper === 'FACILITY_MANAGER';

  // 1. Only Admin and Facility Manager can change status
  if (!isAdmin && !isFacilityManager) {
    return (
      <span style={{
        padding: '6px 10px',
        borderRadius: '8px',
        fontWeight: '800',
        fontSize: '11px',
        backgroundColor: request.status === 'COMPLETED' ? '#d1fae5' : request.status === 'IN PROGRESS' ? '#fef3c7' : '#fee2e2',
        color: request.status === 'COMPLETED' ? '#059669' : request.status === 'IN PROGRESS' ? '#d97706' : '#dc2626'
      }}>
        {request.status || 'NEW'}
      </span>
    );
  }

  const currentStatus = (request.status || 'NEW').toUpperCase();

  // 2. Determine allowed status choices
  const getAvailableStatuses = () => {
    if (isAdmin) {
      // Admin has full control in all directions
      return ['NEW', 'IN PROGRESS', 'COMPLETED'];
    }

    if (isFacilityManager) {
      // Facility Manager can only move forward
      if (currentStatus === 'COMPLETED') return ['COMPLETED'];
      if (currentStatus === 'IN PROGRESS') return ['IN PROGRESS', 'COMPLETED'];
      return ['NEW', 'IN PROGRESS', 'COMPLETED'];
    }

    return [currentStatus];
  };

  const availableStatuses = getAvailableStatuses();

  const getStatusStyle = (status) => {
    switch (status) {
      case 'IN PROGRESS':
        return { bg: '#fef3c7', text: '#d97706', border: '#fcd34d' };
      case 'COMPLETED':
        return { bg: '#d1fae5', text: '#059669', border: '#6ee7b7' };
      default:
        return { bg: '#fee2e2', text: '#dc2626', border: '#fca5a5' };
    }
  };

  const style = getStatusStyle(currentStatus);

  return (
    <select
      value={currentStatus}
      onChange={(e) => onStatusChange(request.id, e.target.value)}
      disabled={isFacilityManager && currentStatus === 'COMPLETED'}
      style={{
        padding: '6px 10px',
        borderRadius: '8px',
        border: `1px solid ${style.border}`,
        backgroundColor: style.bg,
        color: style.text,
        fontWeight: '800',
        fontSize: '11px',
        outline: 'none',
        cursor: (isFacilityManager && currentStatus === 'COMPLETED') ? 'not-allowed' : 'pointer'
      }}
    >
      {availableStatuses.map((statusOption) => (
        <option key={statusOption} value={statusOption}>
          {statusOption === 'NEW' && '🔴 NEW'}
          {statusOption === 'IN PROGRESS' && '🟡 IN PROGRESS'}
          {statusOption === 'COMPLETED' && '🟢 COMPLETED'}
        </option>
      ))}
    </select>
  );
}

// 4. Dynamic Live Attendance Portal Component
export function LiveAttendancePortal({ 
  todaySessions = [], 
  onCheckIn, 
  onCheckOut 
}) {
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'branches'), (snapshot) => {
      const branchList = snapshot.docs.map(doc => doc.data().name || doc.data().branchName || doc.id);
      branchList.sort((a, b) => a.localeCompare(b));

      setBranches(branchList);
      if (branchList.length > 0) {
        setSelectedBranch(branchList[0]);
      }
    }, (error) => {
      console.error("Error fetching branches:", error);
    });

    return () => unsubscribe();
  }, []);

  const activeSession = todaySessions.find(s => !s.checkOutTime && !s.checkOut);
  const isCheckedIn = Boolean(activeSession);
  const isMaxReached = todaySessions.length >= MAX_SESSIONS && !isCheckedIn;

  const handleCheckInClick = () => {
    if (!selectedBranch) {
      alert("PLEASE SELECT THE BRANCH FIRST!");
      return;
    }
    if (isCheckedIn) {
      alert("You are already checked in! Please check out first.");
      return;
    }
    if (isMaxReached) {
      alert(`Maximum daily limit of ${MAX_SESSIONS} sessions reached!`);
      return;
    }
    if (onCheckIn) {
      onCheckIn(selectedBranch);
    }
  };

  return (
    <div style={{
      maxWidth: '520px',
      margin: '20px auto',
      backgroundColor: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: '24px',
      padding: '32px 24px',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.03)',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '800', color: '#111827', margin: '0 0 8px 0' }}>
          Live Attendance Portal
        </h2>
        <p style={{ fontSize: '12px', color: '#6b7280', margin: 0 }}>
          Record your daily Check-In and Check-Out with live photo capture.
        </p>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: '700', color: '#374151', marginBottom: '8px' }}>
          Select Branch for Attendance :
        </label>
        <select 
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          disabled={isCheckedIn || branches.length === 0}
          style={{
            width: '100%',
            padding: '12px',
            borderRadius: '12px',
            border: '1px solid #d1d5db',
            backgroundColor: isCheckedIn ? '#f3f4f6' : '#ffffff',
            fontSize: '14px',
            fontWeight: '600',
            color: '#1f2937',
            outline: 'none',
            cursor: isCheckedIn ? 'not-allowed' : 'pointer'
          }}
        >
          {branches.length === 0 ? (
            <option value="">No branches found</option>
          ) : (
            branches.map(branch => (
              <option key={branch} value={branch}>{branch}</option>
            ))
          )}
        </select>
      </div>

      <div style={{
        backgroundColor: '#fafafa',
        border: '1px solid #f3f4f6',
        borderRadius: '16px',
        padding: '16px',
        marginBottom: '20px'
      }}>
        <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#374151', marginBottom: '12px', textAlign: 'left' }}>
          Today's Sessions ({todaySessions.length}/{MAX_SESSIONS})
        </div>

        {todaySessions.length === 0 ? (
          <div style={{ fontSize: '12px', color: '#9ca3af', textAlign: 'center', padding: '10px 0' }}>
            No check-ins recorded for today yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {todaySessions.slice(0, MAX_SESSIONS).map((session, index) => {
              const completed = Boolean(session.checkOut || session.checkOutTime);
              return (
                <div 
                  key={session.id || index} 
                  style={{ 
                    display: 'grid', 
                    gridTemplateColumns: '1fr 1fr 1fr 1fr', 
                    alignItems: 'center', 
                    padding: '8px 12px', 
                    borderRadius: '8px', 
                    backgroundColor: '#fff', 
                    border: '1px solid #e5e7eb',
                    fontSize: '12px'
                  }}
                >
                  <span style={{ fontWeight: 'bold', color: '#4b5563', textAlign: 'left' }}>
                    Session #{index + 1}
                  </span>
                  
                  <span style={{ 
                    fontWeight: 'bold', 
                    color: completed ? '#059669' : '#d97706',
                    backgroundColor: completed ? '#ecfdf5' : '#fffbe2',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    justifySelf: 'center'
                  }}>
                    {completed ? 'Completed' : 'Active'}
                  </span>

                  <span style={{ color: '#374151', fontWeight: '500' }}>
                    In: {session.checkInTime || session.checkIn || '—'}
                  </span>

                  <span style={{ color: '#374151', fontWeight: '500' }}>
                    Out: {session.checkOutTime || session.checkOut || '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <button
          onClick={handleCheckInClick}
          disabled={isCheckedIn || isMaxReached || branches.length === 0}
          style={{
            backgroundColor: (isCheckedIn || isMaxReached || branches.length === 0) ? '#f3f4f6' : '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: '16px',
            padding: '24px 16px',
            cursor: (isCheckedIn || isMaxReached || branches.length === 0) ? 'not-allowed' : 'pointer',
            opacity: (isCheckedIn || isMaxReached || branches.length === 0) ? 0.5 : 1,
            textAlign: 'center',
            boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
            transition: 'all 0.2s ease'
          }}
        >
          <div style={{
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            backgroundColor: '#34d399',
            margin: '0 auto 12px auto',
            boxShadow: '0 0 10px rgba(52, 211, 153, 0.5)'
          }}></div>
          <strong style={{ display: 'block', fontSize: '14px', color: '#111827', marginBottom: '4px' }}>
            CHECK IN
          </strong>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            {isMaxReached ? '(Limit Reached)' : '(Requires Live Photo)'}
          </span>
        </button>

        <button
          onClick={onCheckOut}
          disabled={!isCheckedIn}
          style={{
            backgroundColor: !isCheckedIn ? '#f3f4f6' : '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: '16px',
            padding: '24px 16px',
            cursor: !isCheckedIn ? 'not-allowed' : 'pointer',
            opacity: !isCheckedIn ? 0.5 : 1,
            textAlign: 'center',
            boxShadow: '0 2px 4px rgba(0,0,0,0.02)',
            transition: 'all 0.2s ease'
          }}
        >
          <div style={{
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            backgroundColor: '#f87171',
            margin: '0 auto 12px auto',
            boxShadow: '0 0 10px rgba(248, 113, 113, 0.5)'
          }}></div>
          <strong style={{ display: 'block', fontSize: '14px', color: '#111827', marginBottom: '4px' }}>
            CHECK OUT
          </strong>
          <span style={{ fontSize: '11px', color: '#6b7280' }}>
            (Requires Live Photo)
          </span>
        </button>
      </div>
    </div>
  );
}

// 5. Main App Component
export default function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    const savedUser = localStorage.getItem('befit_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, []);

  const handleLoginSuccess = (userData) => {
    localStorage.setItem('befit_user', JSON.stringify(userData));
    setUser(userData);
  };

  const handleLogout = () => {
    localStorage.removeItem('befit_user');
    setUser(null);
  };

  return (
    <>
      <CEONotificationListener user={user} />

      {!user ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : (
        <>
          <SummonBranchWidget user={user} />
          <Dashboard user={user} onLogout={handleLogout} />
        </>
      )}
    </>
  );
}
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db } from './firebase';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc,
  doc, 
  serverTimestamp 
} from 'firebase/firestore';

// Excel export libraries
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// Import Towel Management Component
import TowelManagement from './TowelManagement';

export default function Dashboard({ user, onLogout }) {
  // Navigation Tabs
  const [activeTab, setActiveTab] = useState('requests');

  // Base States
  const [requests, setRequests] = useState([]);
  const [ceoRequests, setCeoRequests] = useState([]);
  const [branches, setBranches] = useState([]);
  const [categories, setCategories] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [activityLogs, setActivityLogs] = useState([]);

  // Fullscreen Image Lightbox Modal State
  const [fullscreenImage, setFullscreenImage] = useState(null);

  // Selection States for Bulk Actions (Admin)
  const [selectedReqIds, setSelectedReqIds] = useState([]);
  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState([]);
  const [selectedCeoIds, setSelectedCeoIds] = useState([]);

  // Archive Filter View Toggle for Admin
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);

  // Form states (Maintenance)
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [noImageChecked, setNoImageChecked] = useState(false);
  const [loading, setLoading] = useState(false);

  // Attendance Form States
  const [attendanceBranch, setAttendanceBranch] = useState('');

  // Assignment Modal State
  const [assignModalReq, setAssignModalReq] = useState(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState('');

  // CEO Request Form States
  const [ceoServiceType, setCeoServiceType] = useState('Drink');
  const [ceoItemDetails, setCeoItemDetails] = useState('');
  const [ceoSelectedBranch, setCeoSelectedBranch] = useState('');

  // User Management States
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUserPhone, setNewUserPhone] = useState('');
  const [newUserRole, setNewUserRole] = useState(
    user?.role === 'Facility Manager' ? 'Facility Member' : 'User'
  );
  const [newUserBranches, setNewUserBranches] = useState([]);

  // Edit States
  const [editingUser, setEditingUser] = useState(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editUserPhone, setEditUserPhone] = useState('');
  const [editUserRole, setEditUserRole] = useState('User');
  const [editUserBranches, setEditUserBranches] = useState([]);

  // Branch & Category Management States
  const [newBranchName, setNewBranchName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');

  // Live "now" ticker - used to recompute Online/Offline status every few seconds
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const tickInterval = setInterval(() => setNowTick(Date.now()), 20000);
    return () => clearInterval(tickInterval);
  }, []);

  // Live Camera Modal States
  const [showWebcam, setShowWebcam] = useState(false);
  const [cameraMode, setCameraMode] = useState('request');
  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);

  // Reports Filter States
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');
  const [reportUserFilter, setReportUserFilter] = useState('All');
  const [reportBranchFilter, setReportBranchFilter] = useState('All');

  // Filter & Sort states (Requests)
  const [statusFilter, setStatusFilter] = useState('All');
  const [branchFilter, setBranchFilter] = useState('All');
  const [sortOrder, setSortOrder] = useState('desc');

  // Sort states (Users table)
  const [userSortField, setUserSortField] = useState(null); // 'username' | 'role' | null
  const [userSortDirection, setUserSortDirection] = useState('asc'); // 'asc' | 'desc'

  const handleUserSort = (field) => {
    if (userSortField === field) {
      setUserSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setUserSortField(field);
      setUserSortDirection('asc');
    }
  };

  // User identity & Role Checks
  const currentUserIdentifier = user?.username || user?.displayName || user?.email || '';
  const userRole = user?.role || 'User';
  const assignedBranches = Array.isArray(user?.assignedBranches) ? user.assignedBranches : [];

  const isAdmin = userRole === 'Admin';
  const isCEO = userRole === 'CEO';
  const isSupervisor = userRole === 'Supervisor';
  const isBranchManager = userRole === 'Branch Manager';
  const isFacilityManager = userRole === 'Facility Manager';
  const isFacilityMember = userRole === 'Facility Member';
  const isStaff = userRole === 'User' || userRole === 'Staff';

  // ✅ تحديث: تغيير حالة طلب الصيانة أصبح مقصورًا على مدير الصيانة (Facility Manager) والـ Admin فقط
  const canManageStatus = isAdmin || isFacilityManager;
  const canViewReports = isAdmin || isCEO || isBranchManager || isSupervisor;
  const canManageUsers = isAdmin || isCEO || isBranchManager || isFacilityManager;

  const facilityMembers = useMemo(() => {
    return usersList.filter(u => u.role === 'Facility Member');
  }, [usersList]);

  const branchesNamesList = useMemo(() => {
    return branches.map(b => b.name);
  }, [branches]);

  // ✅ تحديث: قايمة الفروع اللي تظهر للمستخدم في اختيار الفرع (مقصورة على الفروع المتخصص لها فقط)
  // الـ Admin والـ Facility Manager مستثنيين ودايمًا بيشوفوا كل الفروع
  const visibleBranchesForUser = useMemo(() => {
    if (isAdmin || isFacilityManager) return branches;
    if (assignedBranches.length > 0) {
      return branches.filter(b => assignedBranches.includes(b.name));
    }
    return branches;
  }, [branches, assignedBranches, isAdmin, isFacilityManager]);

  // Active users currently present in branches
  const currentlyPresentUsers = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    return attendanceRecords.filter(a => a.dateStr === todayStr && !a.checkOutTime);
  }, [attendanceRecords]);

  // ✅ تحديث: مافيش حد يشوف الحسابات إلا اللي عمل إنشاءها بنفسه، إلا الـ Admin اللي بيشوف الكل دايمًا
  const manageableUsersList = useMemo(() => {
    return usersList.filter(u => {
      if (isAdmin) return true;
      if (isFacilityManager) return u.role === 'Facility Member' && u.createdBy === user?.id;
      if (isBranchManager) return ['Supervisor', 'User'].includes(u.role) && u.createdBy === user?.id;
      // أي دور تاني ليه صلاحية إدارة المستخدمين (مثل CEO) بيشوف بس الحسابات اللي هو عملها
      return u.createdBy === user?.id;
    });
  }, [usersList, isAdmin, isFacilityManager, isBranchManager, user?.id]);

  // Active users present in selected CEO branch
  const activeUsersInCeoBranch = useMemo(() => {
    if (!ceoSelectedBranch) return [];
    return currentlyPresentUsers.filter(a => a.branch === ceoSelectedBranch);
  }, [currentlyPresentUsers, ceoSelectedBranch]);

  // Check if current user is present
  const isCurrentUserPresentCurrently = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    return attendanceRecords.some(a => a.username === currentUserIdentifier && a.dateStr === todayStr && !a.checkOutTime);
  }, [attendanceRecords, currentUserIdentifier]);

  const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  const getStatusBadgeStyle = (status) => {
    const s = (status || '').toLowerCase().trim();
    if (s === 'completed' || s === 'done') return { bg: '#059669', color: '#ffffff' }; 
    if (s === 'in progress' || s === 'inprogress' || s === 'pending') return { bg: '#f59e0b', color: '#ffffff' }; 
    return { bg: '#e11d48', color: '#ffffff' }; 
  };

  // LOG DELETION ACTIONS
  const handleDeleteLog = async (logId) => {
    if (!isAdmin) return alert("Only Admin can delete activity logs.");
    try {
      await deleteDoc(doc(db, 'logs', logId));
    } catch (err) {
      alert("Error deleting log: " + err.message);
    }
  };

  const handleClearAllLogs = async () => {
    if (!isAdmin) return alert("Only Admin can clear all logs.");
    if (activityLogs.length === 0) return alert("Logs list is already empty.");

    if (window.confirm("Are you sure you want to clear all activity notifications logs?")) {
      try {
        await Promise.all(activityLogs.map(log => deleteDoc(doc(db, 'logs', log.id))));
        alert("All activity logs cleared successfully!");
      } catch (err) {
        alert("Error clearing logs: " + err.message);
      }
    }
  };

  // BULK & ARCHIVE ACTIONS (MAINTENANCE REQUESTS)
  const handleToggleSelectReq = (id) => {
    setSelectedReqIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleSelectAllReqs = (filteredList) => {
    if (selectedReqIds.length === filteredList.length) {
      setSelectedReqIds([]);
    } else {
      setSelectedReqIds(filteredList.map(r => r.id));
    }
  };

  const handleBulkDeleteReqs = async () => {
    if (!isAdmin) return;
    if (selectedReqIds.length === 0) return alert("Select items first!");
    if (window.confirm(`Delete ${selectedReqIds.length} maintenance request(s)?`)) {
      try {
        await Promise.all(selectedReqIds.map(id => deleteDoc(doc(db, 'requests', id))));
        setSelectedReqIds([]);
        alert('Selected requests deleted!');
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  };

  const handleArchiveReq = async (id, isArchived) => {
    if (!isAdmin) return;
    try {
      await updateDoc(doc(db, 'requests', id), { isArchived: !isArchived });
    } catch (err) {
      alert('Error archiving: ' + err.message);
    }
  };

  // BULK & ARCHIVE ACTIONS (ATTENDANCE)
  const handleToggleSelectAttendance = (id) => {
    setSelectedAttendanceIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleSelectAllAttendance = (filteredList) => {
    if (selectedAttendanceIds.length === filteredList.length) {
      setSelectedAttendanceIds([]);
    } else {
      setSelectedAttendanceIds(filteredList.map(a => a.id));
    }
  };

  const handleBulkDeleteAttendance = async () => {
    if (!isAdmin) return;
    if (selectedAttendanceIds.length === 0) return alert("Select records first!");
    if (window.confirm(`Delete ${selectedAttendanceIds.length} attendance record(s)?`)) {
      try {
        await Promise.all(selectedAttendanceIds.map(id => deleteDoc(doc(db, 'attendance', id))));
        setSelectedAttendanceIds([]);
        alert('Selected records deleted!');
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  };

  const handleArchiveAttendance = async (id, isArchived) => {
    if (!isAdmin) return;
    try {
      await updateDoc(doc(db, 'attendance', id), { isArchived: !isArchived });
    } catch (err) {
      alert('Error archiving record: ' + err.message);
    }
  };

  // BULK & ARCHIVE ACTIONS (CEO REQUESTS)
  const handleToggleSelectCeo = (id) => {
    setSelectedCeoIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleSelectAllCeo = (filteredList) => {
    if (selectedCeoIds.length === filteredList.length) {
      setSelectedCeoIds([]);
    } else {
      setSelectedCeoIds(filteredList.map(c => c.id));
    }
  };

  const handleBulkDeleteCeo = async () => {
    if (!isAdmin) return;
    if (selectedCeoIds.length === 0) return alert("Select requests first!");
    if (window.confirm(`Delete ${selectedCeoIds.length} CEO request(s)?`)) {
      try {
        await Promise.all(selectedCeoIds.map(id => deleteDoc(doc(db, 'ceo_requests', id))));
        setSelectedCeoIds([]);
        alert('Selected requests deleted!');
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }
  };

  const handleArchiveCeo = async (id, isArchived) => {
    if (!isAdmin) return;
    try {
      await updateDoc(doc(db, 'ceo_requests', id), { isArchived: !isArchived });
    } catch (err) {
      alert('Error archiving request: ' + err.message);
    }
  };

  // BRANCH & CATEGORY ACTIONS
  const handleAddBranch = async (e) => {
    e.preventDefault();
    if (!isAdmin) return alert("Only Admin can add branches.");
    if (!newBranchName.trim()) return;
    try {
      await addDoc(collection(db, 'branches'), { name: newBranchName.trim() });
      setNewBranchName('');
    } catch (err) {
      alert('Error adding branch: ' + err.message);
    }
  };

  const handleDeleteBranch = async (branchId) => {
    if (!isAdmin) return alert("Only Admin can delete branches.");
    if (window.confirm("Are you sure you want to delete this branch?")) {
      try {
        await deleteDoc(doc(db, 'branches', branchId));
      } catch (err) {
        alert('Error deleting branch: ' + err.message);
      }
    }
  };

  const handleAddCategory = async (e) => {
    e.preventDefault();
    if (!isAdmin) return alert("Only Admin can add categories.");
    if (!newCategoryName.trim()) return;
    try {
      await addDoc(collection(db, 'categories'), { name: newCategoryName.trim() });
      setNewCategoryName('');
    } catch (err) {
      alert('Error adding category: ' + err.message);
    }
  };

  const handleDeleteCategory = async (catId) => {
    if (!isAdmin) return alert("Only Admin can delete categories.");
    if (window.confirm("Are you sure you want to delete this category?")) {
      try {
        await deleteDoc(doc(db, 'categories', catId));
      } catch (err) {
        alert('Error deleting category: ' + err.message);
      }
    }
  };

  // CEO SPECIAL REQUEST ACTIONS
  const handleCreateCeoRequest = async (e) => {
    e.preventDefault();
    if (!isCEO && !isAdmin) return alert("Exclusive to CEO / Admin.");
    if (!ceoSelectedBranch) return alert("Please select a branch.");

    if (!ceoItemDetails.trim()) {
      return alert("Please specify the item details.");
    }

    setLoading(true);
    try {
      await addDoc(collection(db, 'ceo_requests'), {
        serviceType: ceoServiceType,
        itemDetails: ceoItemDetails.trim(),
        targetBranch: ceoSelectedBranch,
        status: 'Pending',
        isArchived: false,
        createdBy: currentUserIdentifier,
        createdAt: serverTimestamp()
      });

      setCeoItemDetails('');
      alert(`CEO Service Request sent to users present in branch: ${ceoSelectedBranch}`);
    } catch (err) {
      alert('Error submitting CEO request: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateCeoRequestStatus = async (requestId, newStatus) => {
    try {
      const docRef = doc(db, 'ceo_requests', requestId);
      await updateDoc(docRef, {
        status: newStatus,
        handledBy: currentUserIdentifier || 'User',
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Error updating CEO request status:", error);
    }
  };

  const handleDeleteCeoRequest = async (requestId) => {
    if (!isAdmin) return alert("Exclusive to Admin only.");
    if (window.confirm('Are you sure you want to delete this CEO request permanently?')) {
      try {
        await deleteDoc(doc(db, 'ceo_requests', requestId));
        alert('CEO Request deleted successfully!');
      } catch (err) {
        alert('Error deleting CEO request: ' + err.message);
      }
    }
  };

  // MAINTENANCE ACTIONS
  const handleUpdateStatus = async (req, newStatus) => {
    if (req.status === newStatus) return;

    const currentStatus = req.status || 'New';

    if (!isAdmin) {
      if (newStatus === 'New' && (currentStatus === 'In Progress' || currentStatus === 'Completed')) {
        return alert("You cannot revert the request to (New) once it has been started.");
      }

      if (newStatus === 'In Progress' && currentStatus === 'Completed') {
        return alert("You cannot change the status from (Completed) back to (In Progress).");
      }
    }

    if (isFacilityManager && newStatus === 'In Progress') {
      setAssignModalReq(req);
      return;
    }

    try {
      let updatePayload = { status: newStatus };

      await updateDoc(doc(db, 'requests', req.id), updatePayload);
      await addDoc(collection(db, 'logs'), {
        type: 'STATUS_CHANGE',
        title: req.title || 'Maintenance Request',
        fromStatus: currentStatus,
        toStatus: newStatus,
        performedBy: currentUserIdentifier,
        timestamp: serverTimestamp()
      });
    } catch (err) {
      alert('Error updating status: ' + err.message);
    }
  };

  const handleConfirmAssignment = async () => {
    if (!assignModalReq) return;
    if (!selectedAssigneeId) return alert("Please select a team member!");

    const selectedMember = facilityMembers.find(m => m.id === selectedAssigneeId);
    if (!selectedMember) return alert("Invalid member selected.");

    try {
      await updateDoc(doc(db, 'requests', assignModalReq.id), {
        status: 'In Progress',
        assignedTo: selectedMember.username,
        assignedToPhone: selectedMember.phone || 'N/A',
        assignedAt: serverTimestamp()
      });

      await addDoc(collection(db, 'logs'), {
        type: 'STATUS_CHANGE',
        title: assignModalReq.title || 'Maintenance Request',
        fromStatus: assignModalReq.status || 'New',
        toStatus: 'In Progress',
        assignedTo: selectedMember.username,
        performedBy: currentUserIdentifier,
        timestamp: serverTimestamp()
      });

      setAssignModalReq(null);
      setSelectedAssigneeId('');
      alert(`Request assigned to ${selectedMember.username}!`);
    } catch (err) {
      alert('Error assigning request: ' + err.message);
    }
  };

  const handleDeleteRequest = async (reqId) => {
    if (!isAdmin) return alert("Sorry, this action is exclusive to Admin only.");
    if (window.confirm('Are you sure you want to delete this maintenance request?')) {
      try {
        await deleteDoc(doc(db, 'requests', reqId));
      } catch (err) {
        alert('Error deleting request: ' + err.message);
      }
    }
  };

  // USER MANAGEMENT ACTIONS
  const handleAddUser = async (e) => {
    e.preventDefault();
    if (!canManageUsers) return alert("You don't have permission to add users.");
    if (!newUsername.trim() || !newPassword.trim()) return alert("Please fill username and password.");

    let targetRole = newUserRole;
    if (isFacilityManager) {
      targetRole = 'Facility Member';
      if (!newUserPhone.trim()) {
        return alert("Phone number is required for Facility Members!");
      }
    }

    if (isBranchManager && !['Supervisor', 'User'].includes(targetRole)) {
      return alert("Branch Managers are only allowed to create Supervisor or Staff (User) accounts.");
    }

    // Branch Manager لازم يحدد فرع/فروع لكل حساب بينشئه
    if (isBranchManager && newUserBranches.length === 0) {
      return alert("Please assign at least one branch to this account.");
    }

    setLoading(true);
    try {
      await addDoc(collection(db, 'users'), {
        username: newUsername.trim(),
        password: newPassword.trim(),
        phone: newUserPhone.trim() || '',
        role: targetRole,
        assignedBranches: ['Supervisor', 'Branch Manager', 'User'].includes(targetRole) ? newUserBranches : [],
        createdBy: user?.id || null,
        createdByUsername: user?.username || '',
        createdAt: serverTimestamp()
      });

      setNewUsername('');
      setNewPassword('');
      setNewUserPhone('');
      setNewUserRole(isFacilityManager ? 'Facility Member' : isBranchManager ? 'User' : 'User');
      setNewUserBranches([]);
      alert('User added successfully!');
    } catch (err) {
      alert('Error adding user: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    if (!canManageUsers) return alert("Permission denied.");
    if (!editingUser) return;

    // مافيش حد يعدّل حساب إلا اللي أنشأه، إلا الـ Admin اللي ليه كل الصلاحيات دايمًا
    if (!isAdmin && editingUser.createdBy !== user?.id) {
      return alert("You can only edit accounts that you created yourself.");
    }

    if (isFacilityManager && editingUser.role !== 'Facility Member') {
      return alert("Facility Managers can only edit Facility Members.");
    }

    if (isBranchManager && !['Supervisor', 'User'].includes(editingUser.role)) {
      return alert("Branch Managers can only edit Supervisor or Staff (User) accounts.");
    }

    if (isBranchManager && editUserBranches.length === 0) {
      return alert("Please assign at least one branch to this account.");
    }

    try {
      await updateDoc(doc(db, 'users', editingUser.id), {
        username: editUsername.trim(),
        password: editPassword.trim(),
        phone: editUserPhone.trim(),
        role: editUserRole,
        assignedBranches: ['Supervisor', 'Branch Manager', 'User'].includes(editUserRole) ? editUserBranches : []
      });
      alert('User updated successfully!');
      setEditingUser(null);
    } catch (err) {
      alert('Error updating user: ' + err.message);
    }
  };

  const handleDeleteUser = async (targetUser) => {
    if (!canManageUsers) return alert("Permission denied.");

    // مافيش حد يحذف حساب إلا اللي أنشأه، إلا الـ Admin
    if (!isAdmin && targetUser.createdBy !== user?.id) {
      return alert("You can only delete accounts that you created yourself.");
    }

    if (isFacilityManager && targetUser.role !== 'Facility Member') {
      return alert("Facility Managers can only delete Facility Members.");
    }

    if (isBranchManager && (targetUser.role === 'Branch Manager' || targetUser.role === 'Admin' || targetUser.role === 'CEO')) {
      return alert("Branch Managers are not allowed to delete other Managers or Admins.");
    }

    if (window.confirm(`Are you sure you want to delete user "${targetUser.username}"?`)) {
      try {
        await deleteDoc(doc(db, 'users', targetUser.id));
        alert('User deleted successfully!');
      } catch (err) {
        alert('Error deleting user: ' + err.message);
      }
    }
  };

  const handleDeleteFullRecord = async (recordId) => {
    if (!isAdmin) return alert("Exclusive to Admin only.");
    if (window.confirm('Are you sure you want to delete this entire attendance record?')) {
      try {
        await deleteDoc(doc(db, 'attendance', recordId));
        alert('Record deleted successfully!');
      } catch (err) {
        alert('Error deleting record: ' + err.message);
      }
    }
  };

  // CAMERA LOGIC
  const startLiveCamera = async (mode = 'request') => {
    if ((mode === 'checkin' || mode === 'checkout') && !attendanceBranch) {
      return alert("Please select a branch first.");
    }
    setCameraMode(mode);
    setShowWebcam(true);
    try {
      const constraints = { video: { facingMode: { exact: "environment" } } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      mediaStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      alert("Unable to access camera: " + err.message);
      setShowWebcam(false);
    }
  };

  const stopLiveCamera = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    setShowWebcam(false);
  };

  const capturePhotoFromCamera = async () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth || 1280;
    canvas.height = videoRef.current.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      const capturedFile = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' });
      stopLiveCamera();

      if (cameraMode === 'request') {
        setImageFile(capturedFile);
        setImagePreview(URL.createObjectURL(capturedFile));
        setNoImageChecked(false);
      } else if (cameraMode === 'checkin' || cameraMode === 'checkout') {
        handleAttendanceSubmit(capturedFile, cameraMode);
      }
    }, 'image/jpeg', 0.9);
  };

  // ATTENDANCE SUBMIT
  const handleAttendanceSubmit = async (file, mode) => {
    setLoading(true);
    try {
      const cloudName = "gwgnpo4v";
      const uploadPreset = "ggwrpeyx"; 

      const cloudinaryData = new FormData();
      cloudinaryData.append("file", file);
      cloudinaryData.append("upload_preset", uploadPreset);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: 'POST',
        body: cloudinaryData
      });

      const data = await res.json();
      if (!res.ok) throw new Error('Failed to upload photo');
      const photoUrl = data.secure_url;

      const todayStr = new Date().toISOString().split('T')[0];

      if (mode === 'checkin') {
        await addDoc(collection(db, 'attendance'), {
          username: currentUserIdentifier,
          branch: attendanceBranch || (branches[0]?.name || 'General'),
          dateStr: todayStr,
          checkInTime: serverTimestamp(),
          checkInPhoto: photoUrl,
          checkOutTime: null,
          checkOutPhoto: null,
          isArchived: false,
          status: 'Checked In'
        });
        alert('Check-In Successful! 🟢');
      } else if (mode === 'checkout') {
        const activeRecord = attendanceRecords.find(a => 
          a.username === currentUserIdentifier && 
          a.dateStr === todayStr && 
          !a.checkOutTime
        );

        if (activeRecord) {
          await updateDoc(doc(db, 'attendance', activeRecord.id), {
            checkOutTime: serverTimestamp(),
            checkOutPhoto: photoUrl,
            status: 'Completed'
          });
          alert('Check-Out Successful! 🔴');
        } else {
          alert('No active Check-In found for today.');
        }
      }
    } catch (err) {
      alert('Error recording attendance: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // FORCE LOGOUT MONITORING
  useEffect(() => {
    if (!user?.id) return;

    const unsubUserSelf = onSnapshot(doc(db, 'users', user.id), (docSnap) => {
      if (docSnap.exists() && docSnap.data().forceLogout) {
        updateDoc(doc(db, 'users', user.id), { forceLogout: false });
        alert('You have been forcefully logged out by the Administrator.');
        onLogout();
      }
    });

    return () => unsubUserSelf();
  }, [user?.id, onLogout]);

  // ONLINE PRESENCE HEARTBEAT - marks this account as online and refreshes lastActive periodically
  useEffect(() => {
    if (!user?.id) return;

    const sendHeartbeat = () => {
      updateDoc(doc(db, 'users', user.id), {
        isOnline: true,
        lastActive: serverTimestamp()
      }).catch(() => {});
    };

    sendHeartbeat(); // فوراً عند فتح الداشبورد
    const heartbeatInterval = setInterval(sendHeartbeat, 45000); // كل 45 ثانية

    return () => clearInterval(heartbeatInterval);
  }, [user?.id]);

  // Helper: determine if a user is currently Online based on lastActive freshness
  const isUserOnline = (u) => {
    if (!u) return false;
    if (u.isOnline === false) return false; // تم تسجيل الخروج صراحةً
    if (!u.lastActive) return false;
    const lastMs = u.lastActive.toDate ? u.lastActive.toDate().getTime() : new Date(u.lastActive).getTime();
    return (nowTick - lastMs) < 90000; // آخر نبضة خلال آخر 90 ثانية
  };

  const handleForceLogout = async (targetUser) => {
    if (!window.confirm(`متأكد إنك عايز تعمل Force Logout للمستخدم "${targetUser.username}"؟`)) return;
    try {
      await updateDoc(doc(db, 'users', targetUser.id), { forceLogout: true });
      alert(`تم إرسال أمر تسجيل الخروج لـ ${targetUser.username}.`);
    } catch (err) {
      alert('خطأ أثناء تنفيذ Force Logout: ' + err.message);
    }
  };

  const handleLogoutClick = async () => {
    if (user?.id) {
      try {
        await updateDoc(doc(db, 'users', user.id), { isOnline: false });
      } catch (err) {
        // تجاهل أي خطأ هنا - الأهم إن المستخدم يقدر يسجل خروج برضو
      }
    }
    onLogout();
  };

  // FIRESTORE LISTENERS WITH ALPHABETICAL SORTING
  useEffect(() => {
    const unsubReq = onSnapshot(collection(db, 'requests'), (snapshot) => {
      setRequests(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
    });

    const unsubCeoReq = onSnapshot(collection(db, 'ceo_requests'), (snapshot) => {
      const data = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setCeoRequests(data);
    });

    // Fetch and Sort Branches Alphabetically (A-Z)
    const unsubBranches = onSnapshot(collection(db, 'branches'), (snapshot) => {
      const list = snapshot.docs.map(item => ({ id: item.id, name: item.data().name || item.data().title || 'Unnamed' }));
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setBranches(list);
    });

    // Fetch and Sort Categories Alphabetically (A-Z)
    const unsubCategories = onSnapshot(collection(db, 'categories'), (snapshot) => {
      const list = snapshot.docs.map(item => ({ id: item.id, name: item.data().name || item.data().title || 'Unnamed' }));
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setCategories(list);
    });

    const unsubAttendance = onSnapshot(collection(db, 'attendance'), (snapshot) => {
      setAttendanceRecords(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
    });

    const unsubLogs = onSnapshot(collection(db, 'logs'), (snapshot) => {
      const logsData = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      logsData.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
      setActivityLogs(logsData);
    });

    let unsubUsers = () => {};
    if (canManageUsers || isFacilityManager || isFacilityMember) {
      unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        setUsersList(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      });
    }

    return () => {
      unsubReq(); unsubCeoReq(); unsubBranches(); unsubCategories(); unsubAttendance(); unsubLogs(); unsubUsers();
    };
  }, [canManageUsers, isFacilityManager, isFacilityMember]);

  // ROLE-BASED MAINTENANCE REQUESTS FILTER
  const filteredRequests = useMemo(() => {
    let result = [...requests];

    if (isAdmin && showArchivedOnly) {
      result = result.filter(r => r.isArchived === true);
    } else {
      result = result.filter(r => !r.isArchived);
    }

    if (isStaff) {
      result = result.filter(r => r.createdBy === currentUserIdentifier);
    } else if (isSupervisor || isBranchManager) {
      if (assignedBranches.length > 0) {
        result = result.filter(r => assignedBranches.includes(r.branch));
      }
    }

    if (statusFilter !== 'All') result = result.filter(r => (r.status || 'New') === statusFilter);
    if (branchFilter !== 'All') result = result.filter(r => r.branch === branchFilter);

    return result.sort((a, b) => (sortOrder === 'desc' ? (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0) : (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
  }, [requests, isStaff, isSupervisor, isBranchManager, assignedBranches, currentUserIdentifier, statusFilter, branchFilter, sortOrder, isAdmin, showArchivedOnly]);

  // ROLE-BASED ATTENDANCE REPORT FILTER
  const filteredAttendanceReports = useMemo(() => {
    let list = [...attendanceRecords];

    if (isAdmin && showArchivedOnly) {
      list = list.filter(a => a.isArchived === true);
    } else {
      list = list.filter(a => !a.isArchived);
    }

    if (isStaff) {
      list = list.filter(a => a.username === currentUserIdentifier);
    } else if (isSupervisor) {
      if (assignedBranches.length > 0) {
        list = list.filter(a => assignedBranches.includes(a.branch));
      }
    }

    if (reportUserFilter !== 'All') list = list.filter(a => a.username === reportUserFilter);
    if (reportBranchFilter !== 'All') list = list.filter(a => a.branch === reportBranchFilter);

    if (reportStartDate) {
      const start = new Date(reportStartDate).getTime();
      list = list.filter(a => {
        const time = a.checkInTime?.toDate ? a.checkInTime.toDate().getTime() : 0;
        return time >= start;
      });
    }

    if (reportEndDate) {
      const end = new Date(reportEndDate).setHours(23, 59, 59, 999);
      list = list.filter(a => {
        const time = a.checkInTime?.toDate ? a.checkInTime.toDate().getTime() : 0;
        return time <= end;
      });
    }

    return list.sort((a, b) => (b.checkInTime?.seconds || 0) - (a.checkInTime?.seconds || 0));
  }, [attendanceRecords, isStaff, isSupervisor, assignedBranches, currentUserIdentifier, reportUserFilter, reportBranchFilter, reportStartDate, reportEndDate, isAdmin, showArchivedOnly]);

  const pendingCeoRequestsForUser = useMemo(() => {
    let list = [...ceoRequests];
    if (isAdmin && showArchivedOnly) {
      list = list.filter(c => c.isArchived === true);
    } else {
      list = list.filter(c => !c.isArchived);
    }
    return list;
  }, [ceoRequests, isAdmin, showArchivedOnly]);

  const todayUserAttendance = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    return attendanceRecords.find(a => a.username === currentUserIdentifier && a.dateStr === todayStr);
  }, [attendanceRecords, currentUserIdentifier]);

  // EXPORT TO EXCEL FUNCTION
  const exportAttendanceToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Report');

    worksheet.columns = [
      { header: '#', key: 'id', width: 6 },
      { header: 'Employee', key: 'username', width: 22 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Check-In Date/Time', key: 'checkInTime', width: 25 },
      { header: 'Check-In Photo Link', key: 'checkInPhoto', width: 45 },
      { header: 'Check-Out Date/Time', key: 'checkOutTime', width: 25 },
      { header: 'Check-Out Photo Link', key: 'checkOutPhoto', width: 45 },
      { header: 'Status', key: 'status', width: 15 },
    ];

    worksheet.getRow(1).font = { bold: true };

    filteredAttendanceReports.forEach((item, index) => {
      worksheet.addRow({
        id: index + 1,
        username: item.username || 'N/A',
        branch: item.branch || 'N/A',
        checkInTime: formatDate(item.checkInTime),
        checkInPhoto: item.checkInPhoto || 'No Photo',
        checkOutTime: formatDate(item.checkOutTime),
        checkOutPhoto: item.checkOutPhoto || 'No Photo',
        status: item.status || 'N/A',
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `Attendance_Report_${new Date().toISOString().split('T')[0]}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, fileName);
  };

  const handleAddRequest = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;

    if (!selectedBranch || selectedBranch === "") {
      alert("Please select a branch before submitting the request.");
      return;
    }

    if (!selectedCategory || selectedCategory === "") {
      alert("Please select a category before submitting the request.");
      return;
    }

    if (!imageFile && !noImageChecked) return alert("Please capture a photo using the camera or check 'No photo available'.");

    setLoading(true);
    try {
      let imageUrl = '';
      if (imageFile && !noImageChecked) {
        const cloudName = "gwgnpo4v"; 
        const uploadPreset = "ggwrpeyx"; 

        const formData = new FormData();
        formData.append('file', imageFile);
        formData.append('upload_preset', uploadPreset);

        const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { 
          method: 'POST', 
          body: formData 
        });
        
        const data = await res.json();
        if (res.ok) {
          imageUrl = data.secure_url;
        } else {
          throw new Error('Failed to upload image to Cloudinary');
        }
      }

      await addDoc(collection(db, 'requests'), {
        title: title.trim(),
        description: description.trim(),
        branch: selectedBranch,
        category: selectedCategory,
        imageUrl: noImageChecked ? 'NO_IMAGE' : imageUrl,
        status: 'New',
        isArchived: false,
        createdBy: currentUserIdentifier,
        createdAt: serverTimestamp()
      });

      setTitle(''); 
      setDescription(''); 
      setSelectedBranch(''); 
      setSelectedCategory(''); 
      setImageFile(null); 
      setImagePreview(null); 
      setNoImageChecked(false);
      alert('Maintenance request submitted successfully!');
    } catch (err) { alert(err.message); } finally { setLoading(false); }
  };

  const toggleBranchSelectionForUser = (bName) => {
    setNewUserBranches(prev => 
      prev.includes(bName) ? prev.filter(b => b !== bName) : [...prev, bName]
    );
  };

  const toggleBranchSelectionForEditUser = (bName) => {
    setEditUserBranches(prev => 
      prev.includes(bName) ? prev.filter(b => b !== bName) : [...prev, bName]
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-4 md:p-8 font-sans" dir="ltr">

      {/* COMPACT PRINT STYLES */}
      <style>{`
        select option {
          background-color: #ffffff !important;
          color: #0f172a !important;
        }
        @media print {
          @page { size: A4 portrait; margin: 6mm; }
          body { background: #ffffff !important; color: #000000 !important; font-size: 9px !important; }
          .print\\:hidden { display: none !important; }
          header, button, nav { display: none !important; }
          .report-table th, .report-table td { padding: 2px 4px !important; font-size: 9px !important; line-height: 1.1 !important; }
          .report-table img { display: none !important; }
        }
      `}</style>

      {/* FULLSCREEN IMAGE LIGHTBOX MODAL */}
      {fullscreenImage && (
        <div 
          onClick={() => setFullscreenImage(null)}
          className="fixed inset-0 bg-black/90 backdrop-blur-md z-[100] flex items-center justify-center p-4 cursor-zoom-out print:hidden"
        >
          <div className="relative max-w-4xl max-h-[90vh] flex items-center justify-center">
            <img 
              src={fullscreenImage} 
              alt="Enlarged preview" 
              className="max-w-full max-h-[90vh] object-contain rounded-2xl shadow-2xl border border-white/20"
            />
            <button 
              onClick={() => setFullscreenImage(null)}
              className="absolute -top-4 -right-4 bg-rose-600 hover:bg-rose-700 text-white font-bold w-10 h-10 rounded-full flex items-center justify-center shadow-lg text-lg border-2 border-white transition"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* LIVE CAMERA MODAL */}
      {showWebcam && (
        <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md z-50 flex items-center justify-center p-4 print:hidden">
          <div className="bg-white border border-slate-200 rounded-3xl p-5 max-w-lg w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                <span>📷</span> Camera View ({cameraMode.toUpperCase()})
              </h3>
              <button onClick={stopLiveCamera} className="text-slate-400 hover:text-slate-700 font-bold text-sm">✕</button>
            </div>
            <div className="relative bg-black rounded-2xl overflow-hidden aspect-video flex items-center justify-center">
              <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={stopLiveCamera} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold">Cancel</button>
              <button onClick={capturePhotoFromCamera} className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 shadow-md">
                📸 Take Photo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FACILITY MANAGER ASSIGNMENT MODAL */}
      {assignModalReq && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Assign Request (In Progress)</h3>
              <button onClick={() => setAssignModalReq(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <p className="text-xs text-slate-600">
              Select a <strong>Facility Member</strong> to handle this issue:
            </p>
            <div className="space-y-3">
              <select
                value={selectedAssigneeId}
                onChange={(e) => setSelectedAssigneeId(e.target.value)}
                className="w-full p-3 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
              >
                <option value="" className="bg-white text-slate-900">-- Select Member --</option>
                {facilityMembers.map(m => (
                  <option key={m.id} value={m.id} className="bg-white text-slate-900">
                    {m.username} ({m.phone || 'No Phone'})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setAssignModalReq(null)} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold">Cancel</button>
              <button onClick={handleConfirmAssignment} className="px-4 py-2 bg-amber-500 text-slate-900 font-extrabold rounded-xl text-xs shadow-md">Confirm & Assign</button>
            </div>
          </div>
        </div>
      )}

      {/* CEO BANNER */}
      {!isCEO && !isAdmin && !isFacilityManager && !isFacilityMember && isCurrentUserPresentCurrently && pendingCeoRequestsForUser.filter(r => r.status === 'Pending').length > 0 && (
        <div 
          style={{ backgroundColor: '#1e293b', color: '#ffffff', borderColor: '#f59e0b' }} 
          className="p-4 rounded-2xl shadow-xl mb-6 flex justify-between items-center border print:hidden"
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl p-2 rounded-xl" style={{ backgroundColor: 'rgba(245, 158, 11, 0.2)' }}>🚨</span>
            <div>
              <h4 className="font-black text-sm uppercase tracking-wide" style={{ color: '#fbbf24' }}>CEO Service Request Alert!</h4>
              <p className="text-xs font-medium" style={{ color: '#f8fafc' }}>
                There is an active CEO request for your current branch!
              </p>
            </div>
          </div>
          <button 
            onClick={() => setActiveTab('ceo_services')} 
            style={{ backgroundColor: '#f59e0b', color: '#0f172a' }}
            className="font-black px-4 py-2 rounded-xl text-xs shadow-lg transition active:scale-95 cursor-pointer border-0"
          >
            View Request
          </button>
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center bg-white border border-slate-200 p-5 rounded-3xl shadow-sm mb-6 gap-4 print:hidden">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center font-black text-xl text-white shadow-md">
            {currentUserIdentifier.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">BeFit Eye • Welcome, <span className="text-indigo-600">{currentUserIdentifier}</span></h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-block text-[10px] uppercase font-black px-3 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                ROLE: {userRole}
              </span>
              {assignedBranches.length > 0 && (
                <span className="inline-block text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border">
                  Branches: {assignedBranches.join(', ')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* TABS NAVIGATION */}
        <div className="flex flex-wrap items-center gap-2 bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
          <button 
            onClick={() => setActiveTab('towels')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'towels' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            🧺 Towels
          </button>

          <button 
            onClick={() => setActiveTab('requests')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'requests' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            🛠️ Maintenance
          </button>

          {!isFacilityManager && !isFacilityMember && (
            <>
              <button 
                onClick={() => setActiveTab('attendance')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'attendance' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                🕒 Attendance
              </button>

              <button 
                onClick={() => setActiveTab('ceo_services')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all relative ${activeTab === 'ceo_services' ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                👑 CEO Services
                {!isCEO && !isAdmin && isCurrentUserPresentCurrently && pendingCeoRequestsForUser.filter(r => r.status === 'Pending').length > 0 && (
                  <span className="absolute -top-1 -right-1 bg-rose-600 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-black">
                    {pendingCeoRequestsForUser.filter(r => r.status === 'Pending').length}
                  </span>
                )}
              </button>
            </>
          )}

          {canViewReports && !isFacilityManager && !isFacilityMember && (
            <button 
              onClick={() => setActiveTab('reports')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'reports' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              📊 Reports
            </button>
          )}

          {canManageUsers && (
            <button 
              onClick={() => setActiveTab('users')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'users' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              👥 Users
            </button>
          )}

          {isAdmin && (
            <button 
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'settings' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              ⚙️ Settings
            </button>
          )}
        </div>

        <button onClick={handleLogoutClick} className="bg-slate-100 hover:bg-rose-600 hover:text-white border border-slate-300 text-slate-700 px-5 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-sm cursor-pointer">
          Logout
        </button>
      </header>

      {/* TAB 0: TOWEL MANAGEMENT */}
      {activeTab === 'towels' && (
        <TowelManagement currentUser={user} branchesList={branchesNamesList} />
      )}

      {/* TAB 1: MAINTENANCE REQUESTS */}
      {activeTab === 'requests' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span> Create Maintenance Request
            </h2>
            <form onSubmit={handleAddRequest} className="space-y-4">
              <input type="text" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="w-full p-3 bg-slate-50 border rounded-xl text-sm" />
              
              <div className="grid grid-cols-2 gap-3">
                <select 
                  required
                  value={selectedBranch} 
                  onChange={(e) => setSelectedBranch(e.target.value)} 
                  className="p-3 bg-white text-slate-900 border rounded-xl text-xs font-semibold"
                >
                  <option value="" disabled className="bg-white text-slate-900">Select Branch...</option>
                  {visibleBranchesForUser.map(b => <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>)}
                </select>

                <select 
                  required
                  value={selectedCategory} 
                  onChange={(e) => setSelectedCategory(e.target.value)} 
                  className="p-3 bg-white text-slate-900 border rounded-xl text-xs font-semibold"
                >
                  <option value="" disabled className="bg-white text-slate-900">Select Category...</option>
                  {categories.map(c => <option key={c.id} value={c.name} className="bg-white text-slate-900">{c.name}</option>)}
                </select>
              </div>

              <div className="space-y-3 border p-3.5 rounded-xl bg-slate-50">
                <label className="block text-xs font-bold text-slate-700">Take Photo (Live Camera Only)</label>
                <button type="button" disabled={noImageChecked} onClick={() => startLiveCamera('request')} className="w-full border-2 border-dashed border-indigo-500 p-3 rounded-xl bg-indigo-50 hover:bg-indigo-100 transition flex items-center justify-center gap-2">
                  <span>📷</span> <span className="text-xs font-bold text-indigo-700">Open Live Camera</span>
                </button>
                {imagePreview && !noImageChecked && (
                  <div className="relative rounded-xl overflow-hidden border h-32 group">
                    <img 
                      src={imagePreview} 
                      alt="Preview" 
                      onClick={() => setFullscreenImage(imagePreview)}
                      className="w-full h-full object-cover cursor-pointer hover:opacity-90 transition" 
                    />
                    <button type="button" onClick={() => { setImageFile(null); setImagePreview(null); }} className="absolute top-2 right-2 bg-rose-600 text-white rounded-full w-6 h-6 text-xs font-bold shadow-md">✕</button>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="noImg" checked={noImageChecked} onChange={(e) => setNoImageChecked(e.target.checked)} />
                  <label htmlFor="noImg" className="text-xs text-slate-600">No photo available</label>
                </div>
              </div>

              <textarea rows="3" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description..." className="w-full p-3 bg-slate-50 border rounded-xl text-sm"></textarea>
              <button type="submit" disabled={loading} className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl text-sm shadow-md hover:bg-indigo-700 transition cursor-pointer">
                {loading ? 'Submitting...' : 'Submit Request'}
              </button>
            </form>
          </div>

          <div className="lg:col-span-2 space-y-6">
            
            <div className="bg-white border border-slate-200 p-5 rounded-3xl shadow-sm space-y-3">
              <div className="flex justify-between items-center">
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                  <span>🔔</span> Activity Notifications Log
                </h3>
                {isAdmin && activityLogs.length > 0 && (
                  <button 
                    onClick={handleClearAllLogs}
                    className="text-[11px] bg-rose-50 hover:bg-rose-600 text-rose-600 hover:text-white font-extrabold px-2.5 py-1 rounded-xl border border-rose-200 transition cursor-pointer"
                  >
                    Clear All Logs 🗑️
                  </button>
                )}
              </div>

              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {activityLogs.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">No recent status updates logged.</p>
                ) : (
                  activityLogs.map((log) => (
                    <div key={log.id} className="p-2.5 bg-slate-50 border border-slate-100 rounded-xl text-xs flex justify-between items-center gap-2 hover:bg-slate-100/80 transition">
                      <div className="flex-1">
                        <span className="font-bold text-slate-800">{log.performedBy}</span> updated{' '}
                        <span className="font-bold text-indigo-600">"{log.title}"</span> from{' '}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ backgroundColor: getStatusBadgeStyle(log.fromStatus).bg }}>{log.fromStatus}</span> to{' '}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ backgroundColor: getStatusBadgeStyle(log.toStatus).bg }}>{log.toStatus}</span>
                        {log.assignedTo && <span className="font-bold text-amber-600 ml-1">(Assigned: {log.assignedTo})</span>}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-slate-400 font-medium">{formatDate(log.timestamp)}</span>
                        {isAdmin && (
                          <button 
                            onClick={() => handleDeleteLog(log.id)}
                            className="text-slate-400 hover:text-rose-600 font-bold px-1.5 py-0.5 hover:bg-rose-50 rounded transition cursor-pointer"
                            title="Delete log"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold">Requests List</h2>
                  {isAdmin && (
                    <button
                      onClick={() => setShowArchivedOnly(!showArchivedOnly)}
                      className={`px-3 py-1 rounded-xl text-xs font-bold border transition ${
                        showArchivedOnly ? 'bg-amber-500 text-slate-900 border-amber-600' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {showArchivedOnly ? '📂 Viewing Archived' : '📁 Show Archived'}
                    </button>
                  )}
                </div>
                
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <select 
                    value={statusFilter} 
                    onChange={(e) => setStatusFilter(e.target.value)} 
                    className="p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="All" className="bg-white text-slate-900">All Statuses</option>
                    <option value="New" className="bg-white text-slate-900">New</option>
                    <option value="In Progress" className="bg-white text-slate-900">In Progress</option>
                    <option value="Completed" className="bg-white text-slate-900">Completed</option>
                  </select>

                  <select 
                    value={branchFilter} 
                    onChange={(e) => setBranchFilter(e.target.value)} 
                    className="p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="All" className="bg-white text-slate-900">All Branches</option>
                    {branches.map(b => (
                      <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>
                    ))}
                  </select>

                  <select 
                    value={sortOrder} 
                    onChange={(e) => setSortOrder(e.target.value)} 
                    className="p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="desc" className="bg-white text-slate-900">Newest First</option>
                    <option value="asc" className="bg-white text-slate-900">Oldest First</option>
                  </select>
                </div>
              </div>

              {isAdmin && filteredRequests.length > 0 && (
                <div className="flex items-center justify-between p-3 bg-slate-100 border rounded-2xl text-xs font-bold">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedReqIds.length === filteredRequests.length && filteredRequests.length > 0}
                      onChange={() => handleSelectAllReqs(filteredRequests)}
                    />
                    <span>Select All ({filteredRequests.length})</span>
                  </label>

                  {selectedReqIds.length > 0 && (
                    <button
                      onClick={handleBulkDeleteReqs}
                      className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-3 py-1.5 rounded-xl shadow-md transition"
                    >
                      Delete Selected ({selectedReqIds.length})
                    </button>
                  )}
                </div>
              )}

              <div className="space-y-4">
                {filteredRequests.map(req => {
                  const statusStyle = getStatusBadgeStyle(req.status);
                  const hasImage = req.imageUrl && req.imageUrl !== 'NO_IMAGE';

                  return (
                    <div key={req.id} className="p-4 border rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:shadow-sm transition bg-white">
                      <div className="flex items-start md:items-center gap-3">
                        {isAdmin && (
                          <input
                            type="checkbox"
                            checked={selectedReqIds.includes(req.id)}
                            onChange={() => handleToggleSelectReq(req.id)}
                            className="mt-1 md:mt-0"
                          />
                        )}

                        {hasImage && (
                          <div className="relative shrink-0 w-14 h-14 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 group">
                            <img 
                              src={req.imageUrl} 
                              alt="Maintenance Attachment" 
                              onClick={() => setFullscreenImage(req.imageUrl)}
                              className="w-full h-full object-cover cursor-pointer hover:scale-110 transition-transform duration-200" 
                            />
                          </div>
                        )}

                        <div>
                          <h3 className="font-bold text-slate-900">{req.title}</h3>
                          {req.description && <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{req.description}</p>}
                          <p className="text-xs text-slate-500 font-medium mt-1">{req.branch} • {req.category}</p>
                          <p className="text-[11px] text-slate-400">By {req.createdBy} - {formatDate(req.createdAt)}</p>
                          
                          {req.assignedTo && (
                            <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 bg-amber-50 border border-amber-200 rounded-xl text-xs font-bold text-amber-900">
                              <span>👤 In Charge: <strong>{req.assignedTo}</strong></span>
                              <span>📞 <strong>{req.assignedToPhone || 'N/A'}</strong></span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 w-full md:w-auto justify-end">
                        {canManageStatus ? (
                          <select 
                            value={req.status || 'New'} 
                            onChange={(e) => handleUpdateStatus(req, e.target.value)}
                            style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}
                            className="text-xs font-bold px-3 py-1.5 rounded-xl border-0 cursor-pointer shadow-sm focus:outline-none"
                          >
                            <option value="New" className="bg-white text-slate-900">New</option>
                            <option value="In Progress" className="bg-white text-slate-900">In Progress</option>
                            <option value="Completed" className="bg-white text-slate-900">Completed</option>
                          </select>
                        ) : (
                          <span className="px-3 py-1 text-xs font-bold text-white rounded-xl" style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}>
                            {req.status || 'New'}
                          </span>
                        )}

                        {isAdmin && (
                          <>
                            <button 
                              onClick={() => handleArchiveReq(req.id, req.isArchived)}
                              className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-sm cursor-pointer"
                              title="Archive Request"
                            >
                              {req.isArchived ? 'Unarchive' : 'Archive 📁'}
                            </button>

                            <button 
                              onClick={() => handleDeleteRequest(req.id)}
                              className="bg-rose-600 hover:bg-rose-700 text-white font-black px-3 py-1.5 rounded-xl text-xs shadow-md cursor-pointer border-0"
                              style={{ backgroundColor: '#e11d48', color: '#ffffff' }}
                            >
                              DELETE
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* TAB 2: ATTENDANCE */}
      {activeTab === 'attendance' && !isFacilityManager && !isFacilityMember && (
        <div className="space-y-6">
          <div className="max-w-xl mx-auto bg-white border border-slate-200 p-8 rounded-3xl shadow-sm space-y-6 text-center">
            <div className="space-y-2">
              <h2 className="text-2xl font-black text-slate-900">Live Attendance Portal</h2>
              <p className="text-xs text-slate-500">Record your daily Check-In and Check-Out with live photo capture.</p>
            </div>

            <div className="text-left bg-slate-50 p-4 rounded-2xl border border-slate-200">
              <label className="block text-xs font-bold text-slate-700 mb-1">Select Branch for Attendance</label>
              <select
                value={attendanceBranch}
                onChange={(e) => setAttendanceBranch(e.target.value)}
                className="w-full p-3 bg-white border border-slate-300 rounded-xl text-xs font-bold text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="" disabled className="bg-white text-slate-900">Select Branch...</option>
                {branches.map(b => (
                  <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>
                ))}
              </select>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl flex justify-around text-xs font-bold">
              <div>
                <p className="text-slate-400">Status Today</p>
                <p className="text-slate-800 text-sm">{todayUserAttendance ? todayUserAttendance.status : 'Not Checked In'}</p>
              </div>
              <div>
                <p className="text-slate-400">Check-In</p>
                <p className="text-emerald-600 text-sm">{todayUserAttendance?.checkInTime ? formatDate(todayUserAttendance.checkInTime) : '--:--'}</p>
              </div>
              <div>
                <p className="text-slate-400">Check-Out</p>
                <p className="text-rose-600 text-sm">{todayUserAttendance?.checkOutTime ? formatDate(todayUserAttendance.checkOutTime) : '--:--'}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4">
              <button
                disabled={loading || !!todayUserAttendance}
                onClick={() => startLiveCamera('checkin')}
                className={`p-6 rounded-2xl font-black text-sm flex flex-col items-center gap-2 shadow-md transition-all ${
                  todayUserAttendance 
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95'
                }`}
              >
                <span className="text-3xl">🟢</span>
                <span>CHECK IN</span>
                <span className="text-[10px] font-normal opacity-80">(Requires Live Photo)</span>
              </button>

              <button
                disabled={loading || !todayUserAttendance || !!todayUserAttendance?.checkOutTime}
                onClick={() => startLiveCamera('checkout')}
                className={`p-6 rounded-2xl font-black text-sm flex flex-col items-center gap-2 shadow-md transition-all ${
                  !todayUserAttendance || todayUserAttendance?.checkOutTime 
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                    : 'bg-rose-600 hover:bg-rose-700 text-white active:scale-95'
                }`}
              >
                <span className="text-3xl">🔴</span>
                <span>CHECK OUT</span>
                <span className="text-[10px] font-normal opacity-80">(Requires Live Photo)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: CEO SERVICES */}
      {activeTab === 'ceo_services' && !isFacilityManager && !isFacilityMember && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {(isCEO || isAdmin) && (
            <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
              <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#f59e0b' }}></span> Request CEO Service
              </h2>
              
              <form onSubmit={handleCreateCeoRequest} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Target Branch</label>
                  <select 
                    value={ceoSelectedBranch} 
                    onChange={(e) => setCeoSelectedBranch(e.target.value)} 
                    className="w-full p-3 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
                  >
                    <option value="" disabled className="bg-white text-slate-900">Select Branch...</option>
                    {branches.map(b => <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>)}
                  </select>
                </div>

                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-black text-emerald-900">
                      🟢 Currently Present in {ceoSelectedBranch || 'Selected Branch'}:
                    </span>
                    <span className="bg-emerald-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                      {activeUsersInCeoBranch.length} Employee(s)
                    </span>
                  </div>
                  {activeUsersInCeoBranch.length === 0 ? (
                    <p className="text-[11px] text-emerald-700 italic">No employees checked in right now.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {activeUsersInCeoBranch.map(u => (
                        <span key={u.id} className="text-[10px] font-bold bg-white text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded-lg shadow-sm">
                          👤 {u.username}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Service Type</label>
                  <select 
                    value={ceoServiceType} 
                    onChange={(e) => setCeoServiceType(e.target.value)} 
                    className="w-full p-3 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
                  >
                    <option value="Drink" className="bg-white text-slate-900">☕ Drink / Beverage</option>
                    <option value="Food" className="bg-white text-slate-900">🍽️ Food</option>
                    <option value="Water" className="bg-white text-slate-900">💧 Water</option>
                    <option value="Cleaning" className="bg-white text-slate-900">🧹 Cleaning Service</option>
                    <option value="Others" className="bg-white text-slate-900">⚙️ Others</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Specific Item Name / Details</label>
                  <input 
                    type="text" 
                    required 
                    value={ceoItemDetails} 
                    onChange={(e) => setCeoItemDetails(e.target.value)} 
                    placeholder="e.g. espresso from 9 Bar, Special Request..." 
                    style={{ color: '#0f172a' }}
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold" 
                  />
                </div>

                <button 
                  type="submit" 
                  disabled={loading} 
                  style={{ backgroundColor: '#0f172a', color: '#ffffff' }}
                  className="w-full hover:opacity-90 font-black py-3 rounded-xl text-sm shadow-md transition cursor-pointer border-0"
                >
                  {loading ? 'Sending Request...' : 'Send CEO Request'}
                </button>
              </form>
            </div>
          )}

          <div className={`${(isCEO || isAdmin) ? 'lg:col-span-2' : 'lg:col-span-3'} bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4`}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">CEO Active & Past Requests</h2>
              {isAdmin && (
                <button
                  onClick={() => setShowArchivedOnly(!showArchivedOnly)}
                  className={`px-3 py-1 rounded-xl text-xs font-bold border transition ${
                    showArchivedOnly ? 'bg-amber-500 text-slate-900 border-amber-600' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {showArchivedOnly ? '📂 Viewing Archived' : '📁 Show Archived'}
                </button>
              )}
            </div>

            {isAdmin && pendingCeoRequestsForUser.length > 0 && (
              <div className="flex items-center justify-between p-3 bg-slate-100 border rounded-2xl text-xs font-bold">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedCeoIds.length === pendingCeoRequestsForUser.length && pendingCeoRequestsForUser.length > 0}
                    onChange={() => handleSelectAllCeo(pendingCeoRequestsForUser)}
                  />
                  <span>Select All ({pendingCeoRequestsForUser.length})</span>
                </label>

                {selectedCeoIds.length > 0 && (
                  <button
                    onClick={handleBulkDeleteCeo}
                    className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-3 py-1.5 rounded-xl shadow-md transition"
                  >
                    Delete Selected ({selectedCeoIds.length})
                  </button>
                )}
              </div>
            )}

            <div className="space-y-3">
              {pendingCeoRequestsForUser.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No CEO service requests currently available for your branch.</p>
              ) : (
                pendingCeoRequestsForUser.map(cReq => (
                  <div key={cReq.id} className="p-4 border border-amber-200 bg-amber-50/50 rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div className="flex items-center gap-3">
                      {isAdmin && (
                        <input
                          type="checkbox"
                          checked={selectedCeoIds.includes(cReq.id)}
                          onChange={() => handleToggleSelectCeo(cReq.id)}
                        />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-black text-slate-900 text-sm">[{cReq.serviceType}] {cReq.itemDetails}</span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-amber-200 text-amber-900 border border-amber-300">
                            BRANCH: {cReq.targetBranch}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">Requested by: {cReq.createdBy} - {formatDate(cReq.createdAt)}</p>
                        {cReq.handledBy && <p className="text-xs text-emerald-600 font-bold mt-0.5">Completed by: {cReq.handledBy}</p>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span 
                        style={{
                          backgroundColor: cReq.status === 'Completed' ? '#059669' : '#f59e0b',
                          color: '#ffffff'
                        }}
                        className="px-3 py-1.5 rounded-xl text-xs font-black uppercase shadow-sm"
                      >
                        {cReq.status}
                      </span>

                      {cReq.status === 'Pending' && (
                        <button 
                          onClick={() => handleUpdateCeoRequestStatus(cReq.id, 'Completed')}
                          style={{
                            backgroundColor: '#10b981',
                            color: '#ffffff'
                          }}
                          className="font-bold px-3 py-1.5 rounded-xl text-xs shadow-sm transition active:scale-95 cursor-pointer border-0"
                        >
                          Mark as Done ✓
                        </button>
                      )}

                      {isAdmin && (
                        <>
                          <button
                            onClick={() => handleArchiveCeo(cReq.id, cReq.isArchived)}
                            className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-sm"
                          >
                            {cReq.isArchived ? 'Unarchive' : 'Archive 📁'}
                          </button>

                          <button
                            onClick={() => handleDeleteCeoRequest(cReq.id)}
                            className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-3 py-1.5 rounded-xl text-xs shadow-md transition-all cursor-pointer"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: REPORTS */}
      {activeTab === 'reports' && canViewReports && !isFacilityManager && !isFacilityMember && (
        <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
          <div className="flex flex-col md:flex-row justify-between md:items-center gap-4 border-b pb-4">
            <div className="flex items-center gap-3">
              <div>
                <h2 className="text-lg font-black text-slate-900 tracking-tight">ATTENDANCE REPORT</h2>
                <p className="text-xs text-slate-500">Filter and export employee attendance logs.</p>
              </div>
              {isAdmin && (
                <button
                  onClick={() => setShowArchivedOnly(!showArchivedOnly)}
                  className={`px-3 py-1 rounded-xl text-xs font-bold border transition ${
                    showArchivedOnly ? 'bg-amber-500 text-slate-900 border-amber-600' : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {showArchivedOnly ? '📂 Viewing Archived' : '📁 Show Archived'}
                </button>
              )}
            </div>

            <div className="flex items-center gap-3 print:hidden">
              <button 
                onClick={exportAttendanceToExcel}
                style={{ backgroundColor: '#059669', color: '#ffffff' }}
                className="hover:opacity-90 active:scale-95 px-4 py-2.5 rounded-xl text-xs font-black shadow-md flex items-center gap-2 transition border-0 cursor-pointer"
              >
                <span>EXPORT EXCEL</span>
              </button>

              <button 
                onClick={() => window.print()}
                style={{ backgroundColor: '#4f46e5', color: '#ffffff' }}
                className="hover:opacity-90 active:scale-95 px-4 py-2.5 rounded-xl text-xs font-black shadow-md flex items-center gap-2 transition border-0 cursor-pointer"
              >
                <span>PRINT / PDF</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50 p-4 rounded-2xl border print:hidden">
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Start Date</label>
              <input 
                type="date" 
                value={reportStartDate} 
                onChange={(e) => setReportStartDate(e.target.value)}
                className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
              />
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">End Date</label>
              <input 
                type="date" 
                value={reportEndDate} 
                onChange={(e) => setReportEndDate(e.target.value)}
                className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
              />
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">User Filter</label>
              <select 
                value={reportUserFilter} 
                onChange={(e) => setReportUserFilter(e.target.value)}
                className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
              >
                <option value="All" className="bg-white text-slate-900">All Users</option>
                {usersList.map(u => (
                  <option key={u.id} value={u.username} className="bg-white text-slate-900">{u.username}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Branch Filter</label>
              <select 
                value={reportBranchFilter} 
                onChange={(e) => setReportBranchFilter(e.target.value)}
                className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium"
              >
                <option value="All" className="bg-white text-slate-900">All Branches</option>
                {branches.map(b => (
                  <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {isAdmin && filteredAttendanceReports.length > 0 && (
            <div className="flex items-center justify-between p-3 bg-slate-100 border rounded-2xl text-xs font-bold">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedAttendanceIds.length === filteredAttendanceReports.length && filteredAttendanceReports.length > 0}
                  onChange={() => handleSelectAllAttendance(filteredAttendanceReports)}
                />
                <span>Select All ({filteredAttendanceReports.length})</span>
              </label>

              {selectedAttendanceIds.length > 0 && (
                <button
                  onClick={handleBulkDeleteAttendance}
                  className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-3 py-1.5 rounded-xl shadow-md transition"
                >
                  Delete Selected ({selectedAttendanceIds.length})
                </button>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse report-table">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-[11px] font-black uppercase tracking-wider">
                  {isAdmin && <th className="p-2.5">Select</th>}
                  <th className="p-2.5">User</th>
                  <th className="p-2.5">Branch</th>
                  <th className="p-2.5">Check-In</th>
                  <th className="p-2.5 print:hidden">In Photo</th>
                  <th className="p-2.5">Check-Out</th>
                  <th className="p-2.5 print:hidden">Out Photo</th>
                  <th className="p-2.5">Status</th>
                  {isAdmin && <th className="p-2.5 print:hidden">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {filteredAttendanceReports.map((rec) => (
                  <tr key={rec.id} className="hover:bg-slate-50 leading-tight">
                    {isAdmin && (
                      <td className="p-2.5">
                        <input
                          type="checkbox"
                          checked={selectedAttendanceIds.includes(rec.id)}
                          onChange={() => handleToggleSelectAttendance(rec.id)}
                        />
                      </td>
                    )}
                    <td className="p-2.5 font-bold text-slate-900">{rec.username}</td>
                    <td className="p-2.5">{rec.branch}</td>
                    <td className="p-2.5 text-emerald-700 font-bold">{formatDate(rec.checkInTime)}</td>
                    <td className="p-2.5 print:hidden">
                      {rec.checkInPhoto && (
                        <img 
                          src={rec.checkInPhoto} 
                          alt="In" 
                          onClick={() => setFullscreenImage(rec.checkInPhoto)}
                          className="w-8 h-8 object-cover rounded border border-slate-300 cursor-pointer hover:scale-110 transition-transform" 
                        />
                      )}
                    </td>
                    <td className="p-2.5 text-rose-700 font-bold">{formatDate(rec.checkOutTime)}</td>
                    <td className="p-2.5 print:hidden">
                      {rec.checkOutPhoto && (
                        <img 
                          src={rec.checkOutPhoto} 
                          alt="Out" 
                          onClick={() => setFullscreenImage(rec.checkOutPhoto)}
                          className="w-8 h-8 object-cover rounded border border-slate-300 cursor-pointer hover:scale-110 transition-transform" 
                        />
                      )}
                    </td>
                    <td className="p-2.5"><span className="px-2 py-0.5 rounded font-black text-[9px] uppercase bg-emerald-100 text-emerald-800">{rec.status}</span></td>
                    {isAdmin && (
                      <td className="p-2.5 print:hidden space-x-1">
                        <button
                          onClick={() => handleArchiveAttendance(rec.id, rec.isArchived)}
                          className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-2 py-1 rounded text-[10px] font-extrabold"
                        >
                          {rec.isArchived ? 'Unarchive' : 'Archive 📁'}
                        </button>

                        <button 
                          onClick={() => handleDeleteFullRecord(rec.id)} 
                          className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[11px] font-bold shadow-sm transition"
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: USERS MANAGEMENT */}
      {activeTab === 'users' && canManageUsers && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span> Add New User
            </h2>
            <form onSubmit={handleAddUser} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Username</label>
                <input 
                  type="text" 
                  required 
                  value={newUsername} 
                  onChange={(e) => setNewUsername(e.target.value)} 
                  placeholder="Enter username" 
                  className="w-full p-3 bg-slate-50 border rounded-xl text-sm" 
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Password</label>
                <input 
                  type="password" 
                  required 
                  value={newPassword} 
                  onChange={(e) => setNewPassword(e.target.value)} 
                  placeholder="Enter password" 
                  className="w-full p-3 bg-slate-50 border rounded-xl text-sm" 
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Phone Number</label>
                <input 
                  type="text" 
                  value={newUserPhone} 
                  onChange={(e) => setNewUserPhone(e.target.value)} 
                  placeholder="e.g. +201000000000" 
                  className="w-full p-3 bg-slate-50 border rounded-xl text-sm font-semibold" 
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">User Role</label>
                <select
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value)}
                  className="w-full p-3 bg-white text-slate-900 border rounded-xl text-sm"
                >
                  {isFacilityManager ? (
                    <option value="Facility Member" className="bg-white text-slate-900">Facility Member</option>
                  ) : isBranchManager ? (
                    <>
                      <option value="User" className="bg-white text-slate-900">User (Staff)</option>
                      <option value="Supervisor" className="bg-white text-slate-900">Supervisor</option>
                    </>
                  ) : (
                    <>
                      <option value="User" className="bg-white text-slate-900">User (Staff)</option>
                      <option value="Supervisor" className="bg-white text-slate-900">Supervisor</option>
                      <option value="Branch Manager" className="bg-white text-slate-900">Branch Manager</option>
                      <option value="Facility Manager" className="bg-white text-slate-900">Facility Manager</option>
                      <option value="Facility Member" className="bg-white text-slate-900">Facility Member</option>
                      <option value="CEO" className="bg-white text-slate-900">CEO</option>
                      <option value="Admin" className="bg-white text-slate-900">Admin</option>
                    </>
                  )}
                </select>
              </div>

              {(newUserRole === 'Supervisor' || newUserRole === 'Branch Manager' || newUserRole === 'User') && (
                <div className="space-y-2 border p-3 rounded-xl bg-slate-50">
                  <label className="block text-xs font-bold text-slate-700">Assign Branches</label>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {(isBranchManager ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => (
                      <label key={b.id} className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={newUserBranches.includes(b.name)} 
                          onChange={() => toggleBranchSelectionForUser(b.name)} 
                        />
                        <span>{b.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button 
                type="submit" 
                disabled={loading} 
                className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl text-sm shadow-md hover:bg-indigo-700 transition"
              >
                {loading ? 'Creating User...' : 'Add User'}
              </button>
            </form>
          </div>

          <div className="lg:col-span-2 bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-lg font-bold text-slate-900">
              {isFacilityManager ? 'Facility Team Members' : `System Users (${manageableUsersList.length})`}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                    <th
                      className="p-3 cursor-pointer select-none hover:bg-slate-200 transition-colors"
                      onClick={() => handleUserSort('username')}
                    >
                      Username {userSortField === 'username' ? (userSortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th className="p-3">Phone</th>
                    <th
                      className="p-3 cursor-pointer select-none hover:bg-slate-200 transition-colors"
                      onClick={() => handleUserSort('role')}
                    >
                      Role {userSortField === 'role' ? (userSortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Assigned Branches</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs font-medium">
                  {[...manageableUsersList]
                    .sort((a, b) => {
                      if (!userSortField) return 0;
                      const valA = String(a[userSortField] || '').toLowerCase();
                      const valB = String(b[userSortField] || '').toLowerCase();
                      if (valA < valB) return userSortDirection === 'asc' ? -1 : 1;
                      if (valA > valB) return userSortDirection === 'asc' ? 1 : -1;
                      return 0;
                    })
                    .map((u) => {
                      const canEditThisUser = isAdmin || u.createdBy === user?.id;
                      const canDeleteThisUser = isAdmin || u.createdBy === user?.id;
                      const userBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
                      const online = isUserOnline(u);

                      return (
                        <tr key={u.id} className="hover:bg-slate-50">
                          <td className="p-3 font-bold text-slate-900">{u.username}</td>
                          <td className="p-3 font-semibold text-slate-700">{u.phone || 'N/A'}</td>
                          <td className="p-3">
                            <span className={`px-2 py-0.5 rounded font-black text-[10px] uppercase ${
                              u.role === 'Admin' 
                                ? 'bg-rose-100 text-rose-800 border border-rose-300' 
                                : u.role === 'Facility Manager' || u.role === 'Facility Member'
                                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                : 'bg-indigo-100 text-indigo-800 border border-indigo-300'
                            }`}>
                              {u.role || 'User'}
                            </span>
                          </td>
                          <td className="p-3">
                            {online ? (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase border border-emerald-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Online
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-black uppercase border border-slate-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Offline
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-slate-600">
                            {userBranches.length > 0 ? userBranches.join(', ') : <span className="text-slate-400 italic">None</span>}
                          </td>
                          <td className="p-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {canEditThisUser && u.id !== user?.id && (
                                <button
                                  onClick={() => handleForceLogout(u)}
                                  disabled={!online}
                                  title={online ? 'Force log this user out now' : 'User is already offline'}
                                  className="bg-amber-50 hover:bg-amber-600 hover:text-white border border-amber-300 text-amber-700 px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-amber-50 disabled:hover:text-amber-700"
                                >
                                  🔒 Force Logout
                                </button>
                              )}

                              {canEditThisUser && (
                                <button 
                                  onClick={() => {
                                    setEditingUser(u);
                                    setEditUsername(u.username || '');
                                    setEditPassword(u.password || '');
                                    setEditUserPhone(u.phone || '');
                                    setEditUserRole(u.role || 'User');
                                    setEditUserBranches(Array.isArray(u.assignedBranches) ? u.assignedBranches : []);
                                  }}
                                  className="bg-indigo-50 hover:bg-indigo-600 text-indigo-600 hover:text-white border border-indigo-200 px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer"
                                >
                                  ✏️ Edit
                                </button>
                              )}

                              {canDeleteThisUser && (
                                <button 
                                  onClick={() => handleDeleteUser(u)}
                                  className="bg-rose-600 hover:bg-rose-700 text-white font-bold px-3 py-1 rounded-xl text-xs shadow-sm transition-all cursor-pointer"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: SETTINGS */}
      {activeTab === 'settings' && isAdmin && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span> Branches Management ({branches.length})
            </h2>
            <form onSubmit={handleAddBranch} className="flex gap-2">
              <input 
                type="text" 
                required 
                value={newBranchName} 
                onChange={(e) => setNewBranchName(e.target.value)} 
                placeholder="New Branch Name" 
                className="flex-1 p-3 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" 
              />
              <button 
                type="submit" 
                style={{ backgroundColor: '#4f46e5', color: '#ffffff' }}
                className="px-5 py-3 rounded-xl text-xs font-bold shadow-md hover:opacity-90 transition cursor-pointer border-0"
              >
                Add Branch
              </button>
            </form>

            <div className="space-y-2 pt-2 border-t">
              {branches.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No branches added yet.</p>
              ) : (
                branches.map((b) => (
                  <div key={b.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs font-bold text-slate-800">
                    <span>🏢 {b.name}</span>
                    <button
                      onClick={() => handleDeleteBranch(b.id)}
                      className="bg-rose-600 text-white hover:bg-rose-700 px-2.5 py-1 rounded-lg transition text-[11px] font-bold"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-md font-bold text-slate-900 flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-indigo-600"></span> Maintenance Categories ({categories.length})
            </h2>
            <form onSubmit={handleAddCategory} className="flex gap-2">
              <input 
                type="text" 
                required 
                value={newCategoryName} 
                onChange={(e) => setNewCategoryName(e.target.value)} 
                placeholder="New Category Name" 
                className="flex-1 p-3 bg-slate-50 border rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500" 
              />
              <button 
                type="submit" 
                style={{ backgroundColor: '#4f46e5', color: '#ffffff' }}
                className="px-5 py-3 rounded-xl text-xs font-bold shadow-md hover:opacity-90 transition cursor-pointer border-0"
              >
                Add Category
              </button>
            </form>

            <div className="space-y-2 pt-2 border-t">
              {categories.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No categories added yet.</p>
              ) : (
                categories.map((c) => (
                  <div key={c.id} className="flex justify-between items-center p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs font-bold text-slate-800">
                    <span>⚙️ {c.name}</span>
                    <button
                      onClick={() => handleDeleteCategory(c.id)}
                      className="bg-rose-600 text-white hover:bg-rose-700 px-2.5 py-1 rounded-lg transition text-[11px] font-bold"
                    >
                      Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      )}

      {/* EDIT USER MODAL WITH BRANCH ASSIGNMENT SELECTION */}
      {editingUser && canManageUsers && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Edit User: {editingUser.username}</h3>
              <button onClick={() => setEditingUser(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <form onSubmit={handleUpdateUser} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Username</label>
                <input type="text" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} required className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Password</label>
                <input type="text" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} required className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Phone Number</label>
                <input type="text" value={editUserPhone} onChange={(e) => setEditUserPhone(e.target.value)} className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-semibold" />
              </div>

              {isAdmin && (
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">User Role</label>
                  <select
                    value={editUserRole}
                    onChange={(e) => setEditUserRole(e.target.value)}
                    className="w-full p-2.5 bg-white text-slate-900 border rounded-xl text-xs"
                  >
                    <option value="User" className="bg-white text-slate-900">User (Staff)</option>
                    <option value="Supervisor" className="bg-white text-slate-900">Supervisor</option>
                    <option value="Branch Manager" className="bg-white text-slate-900">Branch Manager</option>
                    <option value="Facility Manager" className="bg-white text-slate-900">Facility Manager</option>
                    <option value="Facility Member" className="bg-white text-slate-900">Facility Member</option>
                    <option value="CEO" className="bg-white text-slate-900">CEO</option>
                    <option value="Admin" className="bg-white text-slate-900">Admin</option>
                  </select>
                </div>
              )}

              {(editUserRole === 'Supervisor' || editUserRole === 'Branch Manager' || editUserRole === 'User') && (
                <div className="space-y-2 border p-3 rounded-xl bg-slate-50">
                  <label className="block text-xs font-bold text-slate-700">Assign Branches</label>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {(isBranchManager ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => (
                      <label key={b.id} className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                        <input 
                          type="checkbox" 
                          checked={editUserBranches.includes(b.name)} 
                          onChange={() => toggleBranchSelectionForEditUser(b.name)} 
                        />
                        <span>{b.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditingUser(null)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FOOTER BRANDING */}
      <footer className="mt-12 py-6 border-t border-slate-200 text-center print:hidden">
        <p className="text-xs font-black text-slate-400 uppercase tracking-widest">
          POWERED BY Amr Shata
        </p>
      </footer>

    </div>
  );
}
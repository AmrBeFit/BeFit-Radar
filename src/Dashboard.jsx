import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, auth, functions } from './firebase';
import { updatePassword } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  setDoc,
  getDoc,
  writeBatch,
  deleteDoc,
  doc, 
  serverTimestamp,
  getDocs,
  query,
  where,
  Timestamp
} from 'firebase/firestore';

// Excel export libraries
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// Import Towel Management Component
import TowelManagement from './TowelManagement';
import MultiSelectFilter from './MultiSelectFilter';
import SchedulePlanner, { useAttendancePlans, MyScheduleCard } from './SchedulePlanner';
import MaintenanceReport from './MaintenanceReport';
import IntegrityReports from './IntegrityReports';
import AuditLog from './AuditLog';
import PermissionsManager from './PermissionsManager';
import { hasPermission } from './permissions';
import BranchChecklist from './BranchChecklist';

// value used by the "Assigned to" filter for requests nobody has been assigned to
const UNASSIGNED_FILTER = '__unassigned__';

// BUG FIX: "today"'s date, in the EMPLOYEE'S OWN local timezone (Cairo), not UTC.
// `new Date().toISOString().split('T')[0]` (the old code) returns the UTC date, which is a
// DIFFERENT calendar day from roughly midnight to 3 AM Cairo time (UTC+3) - e.g. a 12:34 AM
// check-in on Sep 29 Cairo time was being saved with dateStr "2026-09-28". A few hours later,
// once UTC had also rolled over to the 29th, the app compared that stored "2026-09-28" against
// today's real value and no longer recognized the session as open - Check-In showed available
// again (risking a duplicate) and Check-Out stayed disabled, even though the employee never
// checked out. This helper reads the LOCAL calendar date instead, so it always matches what the
// employee actually sees on their own clock.
const toLocalYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Every delete of an audited record (maintenance/CEO requests, leave requests, attendance,
// location violations, branches, categories) now goes through this instead of a plain deleteDoc -
// the Cloud Function behind it (deleteRecordWithAudit) saves a full snapshot to the Audit Log
// BEFORE removing the record, so an Admin can later bring it back with "Undo" there. Throws the
// same way a failed deleteDoc would, so existing try/catch blocks around each call site don't
// need to change.
const deleteWithAudit = async (collectionName, docId) => {
  const fn = httpsCallable(functions, 'deleteRecordWithAudit');
  await fn({ collectionName, docId });
};

// Egyptian mobile numbers: exactly 11 digits, starting with "01" (01xxxxxxxxx).
const isValidEgyptPhone = (p) => /^01\d{9}$/.test((p || '').trim());

// Straight-line distance between two GPS points, in meters (Haversine formula).
// Used to check whether someone checking in/out is actually near the branch's saved location.
const distanceInMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Decimal degrees -> "30°01'55.81"N" style text, the format Google Maps shows when you
// long-press a pin. Used to show the Admin a human-readable version of a saved branch location.
const decimalToDms = (deg, axis) => {
  if (deg == null || Number.isNaN(deg)) return '';
  const dir = axis === 'lat' ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const minFloat = (abs - d) * 60;
  const m = Math.floor(minFloat);
  const s = ((minFloat - m) * 60).toFixed(2);
  return `${d}°${String(m).padStart(2, '0')}'${s}"${dir}`;
};

// Parses one or two "30°01'55.81"N" style coordinates out of free text (e.g. pasted straight
// from Google Maps as "30°01'55.81"N 31°29'54.34"E"), so the Admin can paste that format
// directly into the Latitude/Longitude fields instead of having to convert it by hand.
const parseDmsCoordinates = (text) => {
  const regex = /(\d+(?:\.\d+)?)\s*[°°]\s*(\d+(?:\.\d+)?)\s*['’′]\s*(\d+(?:\.\d+)?)\s*["”″]?\s*([NSEWnsew])/g;
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return null;

  const toDecimal = (m) => {
    const [, d, mnt, sec, dir] = m;
    let val = parseFloat(d) + parseFloat(mnt) / 60 + parseFloat(sec) / 3600;
    if (/[SW]/i.test(dir)) val = -val;
    return { val, dir: dir.toUpperCase() };
  };

  const parsed = matches.map(toDecimal);
  const lat = parsed.find((p) => p.dir === 'N' || p.dir === 'S');
  const lng = parsed.find((p) => p.dir === 'E' || p.dir === 'W');
  if (!lat && !lng) return null;
  return { lat: lat ? lat.val : null, lng: lng ? lng.val : null };
};

// Wraps the browser's geolocation API in a promise with a sane timeout, since Check-In/Check-Out
// need one fresh GPS reading before deciding whether to allow the camera to open.
const getCurrentPositionAsync = (options = {}) =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location services are not available on this device/browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
      ...options
    });
  });

// This one Admin account is a hidden "owner" account: it must never show up anywhere in the
// app's UI (System Users table, any person-picker/assignee dropdown, reports, attendance lists,
// "who's currently present" panels, etc.) for anyone, including other Admins. Its data in
// Firestore is untouched and the account itself still works normally when logged in - this
// filter only hides it from `usersList`, which is the single shared source every one of those
// screens reads from.
const HIDDEN_ADMIN_USERNAME = 'amr shata';
const isHiddenAdminUser = (u) => (u?.username || '').trim().toLowerCase() === HIDDEN_ADMIN_USERNAME;

// Update: device/browser tracking helpers.
// Note: browsers never expose a real hardware "serial number" for privacy/security reasons - no web API can read one.
// As the closest practical substitute, we generate a persistent random Device ID stored in this browser's localStorage,
// which lets us reliably detect when two different accounts are being used from the same physical browser/device.
const getOrCreateDeviceId = () => {
  try {
    let id = localStorage.getItem('befit_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('befit_device_id', id);
    }
    return id;
  } catch (e) {
    return 'unknown-device';
  }
};

const parseDeviceInfo = () => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

  let deviceType = 'Desktop';
  if (/ipad|tablet/i.test(ua)) deviceType = 'Tablet';
  else if (/mobile|android|iphone/i.test(ua)) deviceType = 'Mobile';

  let browser = 'Unknown Browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera';
  else if (ua.includes('Chrome/') && !ua.includes('Edg')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';

  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { deviceType, browser, os, userAgent: ua };
};

// Checkout reminder: after this many hours checked in without a check-out, the employee is reminded
// (notification + vibration + sound + a pop-up). Set REPEAT to 0 for a single reminder instead of one every hour.
const CHECKOUT_REMINDER_AFTER_HOURS = 7;
const CHECKOUT_REMINDER_REPEAT_MINUTES = 60;

// Shows a system notification. Android browsers only allow it through the service worker,
// desktop browsers also allow the plain Notification object, so try both.
const showLocalNotification = async (title, options) => {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    if ('serviceWorker' in navigator) {
      let reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        // no service worker yet (e.g. push is not set up): register the tiny one that only shows notifications
        try {
          await navigator.serviceWorker.register('/notification-sw.js');
          reg = await navigator.serviceWorker.ready;
        } catch (e) {
          reg = null;
        }
      }
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
    }
    new Notification(title, options);
  } catch (e) {
    // notifications are a bonus - the pop-up, sound and vibration still work
  }
};

// "1h 20m" between two Firestore timestamps ('' when either is missing)
const formatDuration = (start, end) => {
  const s = start?.toMillis ? start.toMillis() : null;
  const e = end?.toMillis ? end.toMillis() : null;
  if (s == null || e == null || e < s) return '';
  const mins = Math.round((e - s) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

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
  // Surfaces a query failure (e.g. a missing Firestore index) instead of silently leaving the
  // attendance list empty - a compound query like "username == X AND checkInTime >= cutoff" needs a
  // composite index, and without one Firestore rejects the whole query for every role except
  // Admin/CEO/HR (whose query has only the single checkInTime filter, so it never hits this).
  const [attendanceLoadError, setAttendanceLoadError] = useState(null);
  const [activityLogs, setActivityLogs] = useState([]);

  // Fullscreen Image Lightbox Modal State
  const [fullscreenImage, setFullscreenImage] = useState(null);

  // Selection States for Bulk Actions (Admin)
  const [selectedReqIds, setSelectedReqIds] = useState([]);
  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState([]);
  const [selectedCeoIds, setSelectedCeoIds] = useState([]);

  // Archive Filter View Toggle for Admin
  const [showArchivedOnly, setShowArchivedOnly] = useState(false);

  // Admin-only "Force Check-Out" modal: for someone who forgot to check out. The date is locked to
  // their own check-in day (not freely editable) - only the TIME is chosen - so this can never be
  // used to invent attendance on a day the person never actually showed up for.
  const [forceCheckoutRec, setForceCheckoutRec] = useState(null);
  const [forceCheckoutTime, setForceCheckoutTime] = useState('18:00');

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
  const [assignTargetStatus, setAssignTargetStatus] = useState('In Progress'); // the status the assign pop-up will set
  const [maintView, setMaintView] = useState('list'); // 'list' | 'report' (who did what)

  // Per-request "Action Taken" (written by the assigned Facility Member) and
  // "Notes" (written by the Facility Manager) - draft text kept locally until saved.
  const [actionTakenDrafts, setActionTakenDrafts] = useState({});
  const [notesDrafts, setNotesDrafts] = useState({});

  // CEO Request Form States
  const [ceoServiceType, setCeoServiceType] = useState('Drink');
  const [ceoItemDetails, setCeoItemDetails] = useState('');
  const [ceoSelectedBranch, setCeoSelectedBranch] = useState('');

  // Leave Request States
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [leaveStartDate, setLeaveStartDate] = useState('');
  const [leaveEndDate, setLeaveEndDate] = useState('');
  const [leaveReason, setLeaveReason] = useState('');

  // User Management States
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUserPhone, setNewUserPhone] = useState('');
  const [newUserRole, setNewUserRole] = useState(
    user?.role === 'Facility Manager' ? 'Facility Member' : 'User'
  );
  const [newUserBranches, setNewUserBranches] = useState([]);
  // Admin-only exception: lets an Admin create an account without a phone number
  // (everyone else must provide one).
  const [skipPhoneForAdmin, setSkipPhoneForAdmin] = useState(false);

  // Edit States
  const [editingUser, setEditingUser] = useState(null);
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editUserPhone, setEditUserPhone] = useState('');
  const [editUserRole, setEditUserRole] = useState('User');
  const [editUserBranches, setEditUserBranches] = useState([]);

  // Multi-select in the "System Users" table, for deleting several accounts at once.
  const [selectedUserIds, setSelectedUserIds] = useState(new Set());
  const toggleUserSelection = (id) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Branch & Category Management States
  const [newBranchName, setNewBranchName] = useState('');
  // Per-branch draft for the GPS geofence (lat/lng/radius) Admin sets in Settings, keyed by branch id.
  const [branchLocationEdits, setBranchLocationEdits] = useState({});
  const [isLocatingBranchId, setIsLocatingBranchId] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');

  // Live "now" ticker - used to recompute Online/Offline status every few seconds
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const tickInterval = setInterval(() => setNowTick(Date.now()), 20000);
    return () => clearInterval(tickInterval);
  }, []);

  // Update: force default password change on first login + self-service password change
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [forcedNewPassword, setForcedNewPassword] = useState('');
  const [forcedConfirmPassword, setForcedConfirmPassword] = useState('');

  const [showSelfPasswordModal, setShowSelfPasswordModal] = useState(false);
  const [selfNewPassword, setSelfNewPassword] = useState('');
  const [selfConfirmPassword, setSelfConfirmPassword] = useState('');

  // Live Camera Modal States
  const [showWebcam, setShowWebcam] = useState(false);
  const [cameraMode, setCameraMode] = useState('request');
  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const [isCheckingLocation, setIsCheckingLocation] = useState(false);
  // Holds the GPS reading captured (and already verified against the branch) right before the
  // camera opened for Check-In/Check-Out, so handleAttendanceSubmit can save it with the record.
  const geoRef = useRef(null);

  // Location Violations: every time someone tries to Check-In/Check-Out but is blocked by the
  // GPS geofence (denied location access, or physically outside the branch's allowed radius).
  const [locationViolations, setLocationViolations] = useState([]);

  // Reports Filter States
  const [reportStartDate, setReportStartDate] = useState('');
  const [reportEndDate, setReportEndDate] = useState('');
  const [reportUserFilters, setReportUserFilters] = useState([]);     // empty = all users
  const [reportBranchFilters, setReportBranchFilters] = useState([]); // empty = all branches

  // Filter & Sort states (Requests)
  const [statusFilter, setStatusFilter] = useState('All');
  const [branchFilter, setBranchFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [assigneeFilters, setAssigneeFilters] = useState([]); // empty = everyone
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
  // The hidden admin account ("amr shata") is filtered out of attendance reports, the users list,
  // open-session list and location violations EVERYWHERE - including this account's own view of
  // them, which meant this account could never see its own attendance either. This flag relaxes
  // that filter by exactly one case: when the person currently looking at the screen IS that
  // hidden admin, their own records stop being hidden FROM THEMSELVES - everyone else still never
  // sees this account anywhere in these lists, which is the whole point of hiding it.
  const viewerIsHiddenAdmin = currentUserIdentifier.trim().toLowerCase() === HIDDEN_ADMIN_USERNAME;
  const userRole = user?.role || 'User';
  // Branches come from the live profile, so a change made by a manager or an Admin applies immediately
  // (no need to log out and in again). The key keeps the array stable between the frequent presence updates.
  const liveProfile = usersList.find(u => u.id === user?.id) || user;
  const branchesKey = Array.isArray(liveProfile?.assignedBranches) ? liveProfile.assignedBranches.join('|') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const assignedBranches = useMemo(() => (Array.isArray(liveProfile?.assignedBranches) ? liveProfile.assignedBranches : []), [branchesKey]);

  const isAdmin = userRole === 'Admin';
  const isCEO = userRole === 'CEO';
  const isSupervisor = userRole === 'Supervisor';
  const isBranchManager = userRole === 'Branch Manager';
  const isFacilityManager = userRole === 'Facility Manager';
  const isFacilityMember = userRole === 'Facility Member';
  // "Finance and Administration" is a new role with the exact same permissions as a plain User/Staff
  // account (submits its own maintenance requests, does its own attendance, etc.) - the one
  // difference is organizational, not a permission at all: it reports directly to Admin and is
  // deliberately left OUT of every "who does this Branch Manager/Supervisor manage" list elsewhere
  // in this file, so it never shows up in their team/approval screens.
  const isStaff = userRole === 'User' || userRole === 'Staff' || userRole === 'Finance and Administration';
  const isHR = userRole === 'HR';
  // QA: read-only access to the Branch Checklist (never ticks or signs off), and can only submit
  // maintenance requests - no Towels, Attendance, Schedule, CEO Services, Reports or user management.
  const isQA = userRole === 'QA';

  // Per-account permissions: the role gives the DEFAULT, and Admin can switch individual permissions on/off
  // for one account in the Permissions tab (stored as users/{id}.permissions). liveProfile is used so a
  // change made by Admin applies immediately, with no need to log out and in.
  const perm = (key) => hasPermission(liveProfile ? { ...liveProfile, role: userRole } : { role: userRole }, key);

  // Once per browser session, Admin/CEO/Facility Manager accounts silently ping the server to check
  // for maintenance requests that have sat unattended (status "New") for 24+ hours, and push a
  // reminder if any are found. This is deliberately a plain callable function (checkStaleRequests),
  // not a Cloud Scheduler job - it just rides along on these roles opening the app, which they do
  // routinely anyway, so there's no extra Google Cloud API/billing dependency. sessionStorage keeps
  // it from firing more than once per browser tab session.
  useEffect(() => {
    if (!(isAdmin || isCEO || isFacilityManager)) return;
    if (sessionStorage.getItem('staleRequestsChecked')) return;
    sessionStorage.setItem('staleRequestsChecked', '1');
    const checkStaleRequests = httpsCallable(functions, 'checkStaleRequests');
    checkStaleRequests().catch(() => {}); // best-effort, never bothers the user if it fails
  }, [isAdmin, isCEO, isFacilityManager]);

  // Attendance selfies are deleted 60 days after check-in. No Cloud Scheduler: like the check above, this
  // rides along when HR / Admin / a Branch Manager opens the app (the server only does real work at most
  // once every 12 hours, whoever calls it).
  useEffect(() => {
    if (!(isAdmin || isHR || isBranchManager)) return;
    if (sessionStorage.getItem('photosPurged')) return;
    sessionStorage.setItem('photosPurged', '1');
    const purgeOldAttendancePhotos = httpsCallable(functions, 'purgeOldAttendancePhotos');
    purgeOldAttendancePhotos().catch(() => {}); // best-effort
  }, [isAdmin, isHR, isBranchManager]);

  // One-time move of OLD selfies (still sitting on the attendance records) into the locked document.
  // Admin only; repeats each session until nothing is left to move.
  useEffect(() => {
    if (!isAdmin) return;
    if (sessionStorage.getItem('photosMigrated')) return;
    sessionStorage.setItem('photosMigrated', '1');
    const migrateAttendancePhotos = httpsCallable(functions, 'migrateAttendancePhotos');
    migrateAttendancePhotos().catch(() => {});
  }, [isAdmin]);

  // Same idea, for the Schedule tab: once per session, Admin/CEO/Branch Manager/Supervisor accounts
  // ping the server to check whether anyone planned to start a shift 30+ minutes ago never checked
  // in at all (a likely no-show) - and push a heads-up if so, early enough that someone can still
  // call them or arrange cover. todayYmd/nowMinutes are this browser's own local wall clock, since
  // that's the clock shift times were planned against.
  useEffect(() => {
    if (!(isAdmin || isCEO || isBranchManager || isSupervisor)) return;
    if (sessionStorage.getItem('absencesChecked')) return;
    sessionStorage.setItem('absencesChecked', '1');
    const now = new Date();
    const checkExpectedAbsences = httpsCallable(functions, 'checkExpectedAbsences');
    checkExpectedAbsences({
      todayYmd: toLocalYmd(),
      nowMinutes: now.getHours() * 60 + now.getMinutes()
    }).catch(() => {}); // best-effort, never bothers the user if it fails
  }, [isAdmin, isCEO, isBranchManager, isSupervisor]);

  // Update: changing a maintenance request's status is now restricted to the Facility Manager and Admin only
  const canManageStatus = perm('manageRequestStatus');
  // HR can view attendance reports for all branches (but not manage users)
  // Update: CEO now also sees the full check-in/check-out attendance reports across every branch (view-only, same as everyone else here - this tab was never editable).
  const canViewReports = perm('tab_reports');
  // The Schedule tab (planned shifts + plan-vs-actual report): those who plan it or need to see it
  const canSeeSchedule = perm('tab_schedule');
  // The CEO can no longer add, edit or delete users - Admin, Branch Manager and Facility Manager can create,
  // edit and delete; Supervisor can view/edit/delete Users only (cannot create accounts).
  const canManageUsers = perm('tab_users');

  // Integrity / wrongdoing reports: every signed-in account can submit one; only Admin and HR can review the list
  const canReviewIntegrity = perm('reviewIntegrity');

  // Branch checklist: anyone checked in at a branch can tick items; only Admin/Branch Manager/Supervisor sign off
  // the day, and only Admin edits the shared item list - same visibility as the Attendance tab otherwise.
  // CEO can view every branch's checklist but never ticks/edits it (CEO never checks in at a branch, so
  // BranchChecklist's own canTick stays false for them automatically - see isAdmin/openBranch passed below).
  const canSeeChecklist = perm('tab_checklist');
  const canSignOffChecklist = perm('signOffChecklist');
  const canApproveLeave = perm('approveLeave');
  const canViewLeaveQueue = canApproveLeave || perm('viewLeaveQueue');
  // Attendance selfies: only HR, Admin and Branch Managers may look at them, and only when really necessary.
  // They are also deleted automatically 60 days after check-in (see purgeOldAttendancePhotos in functions).
  const canViewAttendancePhotos = isAdmin || isHR || isBranchManager;
  const canSeeTowels = perm('tab_towels');
  // See every branch's maintenance requests (default: Admin and CEO only)
  const canViewAllRequests = perm('viewAllRequests') || isCEO;
  const canSeeAttendance = perm('tab_attendance');
  const canSeeCeoServices = perm('tab_ceoServices');

  // People a maintenance task can be assigned to: Facility Members and Facility Managers
  const taskAssignees = useMemo(() => {
    return usersList
      .filter(u => u.role === 'Facility Member' || u.role === 'Facility Manager')
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  }, [usersList]);

  const branchesNamesList = useMemo(() => {
    return branches.map(b => b.name);
  }, [branches]);

  // Update: the list of branches shown to a user when selecting a branch (restricted to their own assigned branches)
  // Admin and Facility Manager are exceptions and always see all branches
  const visibleBranchesForUser = useMemo(() => {
    if (isAdmin || isFacilityManager) return branches;
    if (assignedBranches.length > 0) {
      return branches.filter(b => assignedBranches.includes(b.name));
    }
    return branches;
  }, [branches, assignedBranches, isAdmin, isFacilityManager]);

  // Active users currently present in branches
  const currentlyPresentUsers = useMemo(() => {
    const todayStr = toLocalYmd();
    return attendanceRecords.filter(a => a.dateStr === todayStr && !a.checkOutTime && (viewerIsHiddenAdmin || !isHiddenAdminUser(a)));
  }, [attendanceRecords, viewerIsHiddenAdmin]);

  // Leave requests this account is allowed to review: ONLY Admin, HR and the Branch Manager of the
  // person's branch. Admin/HR see everyone's; a Branch Manager only sees requests from people
  // assigned to one of their own branches. (CEO and Supervisor no longer approve leaves.)
  // A Supervisor also gets this same branch-scoped list, but VIEW ONLY: the Approve/Reject buttons
  // are gated by canApproveLeave below, and the Firestore rule rejects a Supervisor's decision anyway.
  const leaveRequestsForApproval = useMemo(() => {
    if (isAdmin || (isHR && canViewLeaveQueue)) return leaveRequests;
    if (canViewLeaveQueue && assignedBranches.length > 0) {
      return leaveRequests.filter(r => {
        const reqBranches = Array.isArray(r.assignedBranches) ? r.assignedBranches : [];
        return reqBranches.some(b => assignedBranches.includes(b));
      });
    }
    return [];
  }, [leaveRequests, isAdmin, isHR, canViewLeaveQueue, assignedBranches]);

  const myLeaveRequests = useMemo(
    () => leaveRequests.filter(r => r.username === currentUserIdentifier),
    [leaveRequests, currentUserIdentifier]
  );

  // Update: nobody can see accounts except the ones they created themselves, except Admin who always sees everyone.
  // Facility Managers, Branch Managers and Supervisors are the exception: their teams are shared -
  // every Facility Manager sees every Facility Member, every Branch Manager sees every Supervisor/User,
  // and every Supervisor sees every User - regardless of which specific manager created the account.
  const manageableUsersList = useMemo(() => {
    return usersList.filter(u => {
      if (isAdmin) return true;
      if (isFacilityManager) return u.role === 'Facility Member';
      if (isBranchManager) return ['Supervisor', 'User'].includes(u.role);
      if (isSupervisor) return u.role === 'User';
      // Any other role with user-management permission (e.g. CEO) only sees the accounts they created
      return u.createdBy === user?.id;
    });
  }, [usersList, isAdmin, isFacilityManager, isBranchManager, isSupervisor, user?.id]);

  // Update: device/browser login history log (Admin only) - a real report with date/time filtering + clearable history
  const [viewingDeviceInfoUser, setViewingDeviceInfoUser] = useState(null);
  const [deviceLogs, setDeviceLogs] = useState([]);
  const [deviceLogStartDate, setDeviceLogStartDate] = useState('');
  const [deviceLogEndDate, setDeviceLogEndDate] = useState('');

  // Write one login/device entry per session (once per Dashboard mount) into a permanent history log
  useEffect(() => {
    if (!user?.id) return;
    const deviceId = getOrCreateDeviceId();
    const { deviceType, browser, os, userAgent } = parseDeviceInfo();

    addDoc(collection(db, 'deviceLogs'), {
      userId: user.id,
      username: user.username || '',
      role: user.role || '',
      deviceId,
      deviceType,
      browser,
      os,
      userAgent,
      timestamp: serverTimestamp()
    }).catch(() => {});
  }, [user?.id]);

  // Admin-only live listener on the full device login history
  useEffect(() => {
    if (!isAdmin) return;
    const unsubDeviceLogs = onSnapshot(collection(db, 'deviceLogs'), (snapshot) => {
      setDeviceLogs(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return () => unsubDeviceLogs();
  }, [isAdmin]);

  // Apply the date/time range filter chosen by the Admin
  const filteredDeviceLogs = useMemo(() => {
    let logs = [...deviceLogs];

    if (deviceLogStartDate) {
      const start = new Date(deviceLogStartDate).getTime();
      logs = logs.filter(l => {
        const t = l.timestamp?.toDate ? l.timestamp.toDate().getTime() : 0;
        return t >= start;
      });
    }

    if (deviceLogEndDate) {
      const end = new Date(deviceLogEndDate).setHours(23, 59, 59, 999);
      logs = logs.filter(l => {
        const t = l.timestamp?.toDate ? l.timestamp.toDate().getTime() : 0;
        return t <= end;
      });
    }

    return logs.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
  }, [deviceLogs, deviceLogStartDate, deviceLogEndDate]);

  // Group the filtered history by Device ID, keeping only devices shared by 2+ distinct accounts
  const sharedDeviceGroups = useMemo(() => {
    if (!isAdmin) return [];
    const map = {};
    filteredDeviceLogs.forEach(log => {
      if (!log.deviceId || log.deviceId === 'unknown-device') return;
      if (!map[log.deviceId]) map[log.deviceId] = [];
      map[log.deviceId].push(log);
    });
    return Object.entries(map)
      .map(([deviceId, logs]) => ({
        deviceId,
        logs,
        usernames: [...new Set(logs.map(l => l.username))]
      }))
      .filter(g => g.usernames.length > 1)
      .sort((a, b) => b.logs.length - a.logs.length);
  }, [filteredDeviceLogs, isAdmin]);

  const handleClearDeviceHistory = async () => {
    if (!window.confirm('This will permanently delete ALL device login history for every account. Continue?')) return;
    try {
      const snap = await getDocs(collection(db, 'deviceLogs'));
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'deviceLogs', d.id))));
      alert('Device login history cleared.');
    } catch (err) {
      alert('Error clearing device history: ' + err.message);
    }
  };

  const formatLogDateTime = (ts) => {
    if (!ts?.toDate) return '—';
    return ts.toDate().toLocaleString();
  };

  // Active users present in selected CEO branch
  const activeUsersInCeoBranch = useMemo(() => {
    if (!ceoSelectedBranch) return [];
    return currentlyPresentUsers.filter(a => a.branch === ceoSelectedBranch);
  }, [currentlyPresentUsers, ceoSelectedBranch]);

  // Check if current user is present
  const isCurrentUserPresentCurrently = useMemo(() => {
    const todayStr = toLocalYmd();
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
    if (s === 'completed' || s === 'done') return { bg: '#059669', color: '#ffffff' }; // dark green
    if (s === 'completed under testing') return { bg: '#a3e635', color: '#1a2e05' }; // neon/fluorescent green
    if (s === 'delayed') return { bg: '#86efac', color: '#14532d' }; // light green
    if (s === 'not applicable') return { bg: '#94a3b8', color: '#ffffff' }; // gray
    if (s === 'in progress' || s === 'inprogress') return { bg: '#d97706', color: '#ffffff' }; // dark yellow
    if (s === 'pending') return { bg: '#fde68a', color: '#78350f' }; // light yellow
    return { bg: '#e11d48', color: '#ffffff' }; // New (and default)
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
        await Promise.all(selectedReqIds.map(id => deleteWithAudit('requests', id)));
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
        await Promise.all(selectedAttendanceIds.map(id => deleteWithAudit('attendance', id)));
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

  // Admin-only: open the "Force Check-Out" modal for a record that was never checked out
  // (rec.checkOutTime is still null). Pre-fills the time picker with the check-in's own clock time
  // as a reasonable starting guess, which the Admin then adjusts.
  const openForceCheckout = (rec) => {
    if (!isAdmin || rec.checkOutTime) return; // never touches an already-checked-out record
    const checkInDate = rec.checkInTime?.toDate ? rec.checkInTime.toDate() : new Date();
    setForceCheckoutTime(`${String(checkInDate.getHours()).padStart(2, '0')}:${String(checkInDate.getMinutes()).padStart(2, '0')}`);
    setForceCheckoutRec(rec);
  };

  // Confirms the forced check-out. The DATE is always the same calendar day as the original
  // check-in (never editable - this can't be used to fabricate a different day's attendance), built
  // straight from the check-in's own Date object so it's also immune to any timezone drift; only the
  // TIME (hour:minute) the Admin picked is applied on top of it.
  const handleConfirmForceCheckout = async () => {
    if (!isAdmin || !forceCheckoutRec) return;
    if (forceCheckoutRec.checkOutTime) return alert('This record already has a check-out and cannot be edited.');
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(forceCheckoutTime)) return alert('Choose a valid time.');

    const checkInDate = forceCheckoutRec.checkInTime?.toDate ? forceCheckoutRec.checkInTime.toDate() : new Date();
    const [h, m] = forceCheckoutTime.split(':').map(Number);
    const checkOutDate = new Date(checkInDate.getFullYear(), checkInDate.getMonth(), checkInDate.getDate(), h, m, 0);

    if (checkOutDate < checkInDate) {
      return alert('The check-out time cannot be before the check-in time on the same day.');
    }

    try {
      await updateDoc(doc(db, 'attendance', forceCheckoutRec.id), {
        checkOutTime: Timestamp.fromDate(checkOutDate),
        status: 'Completed',
        isManualCheckout: true,
        manualCheckoutBy: currentUserIdentifier,
        manualCheckoutAt: serverTimestamp()
      });
      setForceCheckoutRec(null);
      alert('Check-out recorded.');
    } catch (err) {
      alert('Error recording check-out: ' + err.message);
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
        await Promise.all(selectedCeoIds.map(id => deleteWithAudit('ceo_requests', id)));
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
        await deleteWithAudit('branches', branchId);
      } catch (err) {
        alert('Error deleting branch: ' + err.message);
      }
    }
  };

  // GPS geofence (Admin only): reads the field the Admin is currently editing for a branch,
  // falling back to whatever is already saved on the branch document.
  const getBranchLocationDraft = (branch) => {
    const draft = branchLocationEdits[branch.id] || {};
    return {
      lat: draft.lat !== undefined ? draft.lat : (branch.locationLat != null ? String(branch.locationLat) : ''),
      lng: draft.lng !== undefined ? draft.lng : (branch.locationLng != null ? String(branch.locationLng) : ''),
      radius: draft.radius !== undefined ? draft.radius : (branch.locationRadius != null ? String(branch.locationRadius) : '150')
    };
  };

  const setBranchLocationField = (branchId, field, value) => {
    setBranchLocationEdits(prev => ({
      ...prev,
      [branchId]: { ...getBranchLocationDraft(branches.find(b => b.id === branchId) || {}), ...prev[branchId], [field]: value }
    }));
  };

  const handleUseMyLocationForBranch = async (branchId) => {
    setIsLocatingBranchId(branchId);
    try {
      const position = await getCurrentPositionAsync();
      setBranchLocationField(branchId, 'lat', String(position.coords.latitude));
      setBranchLocationField(branchId, 'lng', String(position.coords.longitude));
    } catch (err) {
      alert("Couldn't get your current location: " + err.message);
    } finally {
      setIsLocatingBranchId(null);
    }
  };

  const handleSaveBranchLocation = async (branch) => {
    if (!isAdmin) return alert("Only Admin can set a branch's location.");
    const draft = getBranchLocationDraft(branch);
    const lat = parseFloat(draft.lat);
    const lng = parseFloat(draft.lng);
    const radius = parseInt(draft.radius, 10);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return alert('Please enter a valid latitude and longitude (or use "Use my current location").');
    }
    if (Number.isNaN(radius) || radius <= 0) {
      return alert('Please enter a valid allowed radius in meters (e.g. 150).');
    }

    try {
      await updateDoc(doc(db, 'branches', branch.id), {
        locationLat: lat,
        locationLng: lng,
        locationRadius: radius
      });
      setBranchLocationEdits(prev => { const next = { ...prev }; delete next[branch.id]; return next; });
      alert(`Location saved for ${branch.name}. Check-In/Check-Out there now requires being within ${radius}m.`);
    } catch (err) {
      alert('Error saving branch location: ' + err.message);
    }
  };

  const handleClearBranchLocation = async (branch) => {
    if (!isAdmin) return alert("Only Admin can clear a branch's location.");
    if (!window.confirm(`Remove the GPS requirement for ${branch.name}? Check-In/Check-Out there will no longer be location-restricted.`)) return;
    try {
      await updateDoc(doc(db, 'branches', branch.id), {
        locationLat: null,
        locationLng: null,
        locationRadius: null
      });
    } catch (err) {
      alert('Error clearing branch location: ' + err.message);
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
        await deleteWithAudit('categories', catId);
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
        await deleteWithAudit('ceo_requests', requestId);
        alert('CEO Request deleted successfully!');
      } catch (err) {
        alert('Error deleting CEO request: ' + err.message);
      }
    }
  };

  // "Buzz": force-pushes an immediate alert about one specific request, on top of whatever automatic
  // notification already fired for it - regardless of the request's current status. Maintenance ->
  // every Facility Manager/Facility Member. CEO request -> whoever is currently checked in at that
  // request's target branch. Admin can Buzz anything; a Branch Manager only a request from their own
  // branch (the button itself is already hidden otherwise - this guard is just defense in depth, the
  // real check happens server-side in the Cloud Function).
  const handleBuzzRequest = async (requestId) => {
    if (!isAdmin && !isBranchManager) return;
    try {
      const buzzMaintenanceRequest = httpsCallable(functions, 'buzzMaintenanceRequest');
      const res = await buzzMaintenanceRequest({ requestId });
      const notified = res?.data?.notified || 0;
      alert(notified > 0 ? `Buzzed ${notified} Facility Manager/Member device(s).` : 'No Facility Manager/Member has notifications enabled yet.');
    } catch (err) {
      alert('Error sending Buzz: ' + (err.message || err));
    }
  };

  const handleBuzzCeoRequest = async (requestId) => {
    if (!isAdmin && !isBranchManager) return;
    try {
      const buzzCeoRequest = httpsCallable(functions, 'buzzCeoRequest');
      const res = await buzzCeoRequest({ requestId });
      const notified = res?.data?.notified || 0;
      alert(notified > 0 ? `Buzzed ${notified} device(s) checked in at this branch.` : 'Nobody is currently checked in at this branch to buzz.');
    } catch (err) {
      alert('Error sending Buzz: ' + (err.message || err));
    }
  };

  // LEAVE REQUEST ACTIONS
  // Only these three roles may approve/reject a leave (a Branch Manager only for their own branches,
  // which leaveRequestsForApproval above already enforces on the list they can see).

  const handleCreateLeaveRequest = async (e) => {
    e.preventDefault();
    if (!leaveStartDate || !leaveEndDate) return alert('Please select a start and end date.');
    if (leaveEndDate < leaveStartDate) return alert('The end date cannot be before the start date.');

    setLoading(true);
    try {
      await addDoc(collection(db, 'leaveRequests'), {
        username: currentUserIdentifier,
        assignedBranches: assignedBranches || [],
        startDate: leaveStartDate,
        endDate: leaveEndDate,
        reason: leaveReason.trim(),
        status: 'Pending',
        createdAt: serverTimestamp(),
        createdById: user?.id || null
      });
      setLeaveStartDate('');
      setLeaveEndDate('');
      setLeaveReason('');
      alert('Leave request submitted! You will be notified once it is reviewed.');
    } catch (err) {
      alert('Error submitting leave request: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLeaveDecision = async (requestId, decision) => {
    try {
      await updateDoc(doc(db, 'leaveRequests', requestId), {
        status: decision,
        reviewedBy: currentUserIdentifier,
        reviewedAt: serverTimestamp()
      });
    } catch (err) {
      alert('Error updating the leave request: ' + err.message);
    }
  };

  const handleDeleteLeaveRequest = async (requestId) => {
    if (!window.confirm('Delete this leave request permanently?')) return;
    try {
      await deleteWithAudit('leaveRequests', requestId);
    } catch (err) {
      alert('Error deleting leave request: ' + err.message);
    }
  };

  // Admin-only: archive / unarchive a leave request (keeps the approval queue clean
  // without deleting the record).
  const handleArchiveLeaveRequest = async (requestId, isArchived) => {
    try {
      await updateDoc(doc(db, 'leaveRequests', requestId), {
        isArchived: !isArchived,
        archivedBy: currentUserIdentifier,
        archivedAt: serverTimestamp()
      });
    } catch (err) {
      alert('Error archiving leave request: ' + err.message);
    }
  };

  // MAINTENANCE ACTIONS
  const handleUpdateStatus = async (req, newStatus) => {
    if (req.status === newStatus) return;

    const currentStatus = req.status || 'New';

    // Only Admin may ever set a request back to (New) - Facility Manager can reverse
    // status any other way (e.g. Completed -> Pending), just not back to New.
    if (newStatus === 'New' && !isAdmin) {
      return alert("Only Admin can set a request back to (New).");
    }

    // The Facility Manager and the Admin must say WHO carries out the task:
    //  - when the request goes "In Progress"
    //  - when it is completed and nobody was assigned yet
    if ((isFacilityManager || isAdmin) && (newStatus === 'In Progress' || (newStatus === 'Completed' && !req.assignedTo))) {
      setAssignTargetStatus(newStatus);
      setSelectedAssigneeId('');
      setAssignModalReq(req);
      return;
    }

    try {
      const updatePayload = {
        status: newStatus,
        ...(newStatus === 'Completed'
          ? { completedAt: serverTimestamp(), completedBy: currentUserIdentifier }
          : (req.completedAt ? { completedAt: null, completedBy: null } : {})) // re-opened: clear the completion
      };

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

  // "Action Taken" box: only the Facility Member this request is assigned to (or Admin) can write it.
  const canEditActionTaken = (req) => isAdmin || (req.assignedTo && req.assignedTo === currentUserIdentifier);
  const getActionTakenValue = (req) => (actionTakenDrafts[req.id] !== undefined ? actionTakenDrafts[req.id] : (req.actionTaken || ''));
  const handleSaveActionTaken = async (req) => {
    try {
      await updateDoc(doc(db, 'requests', req.id), {
        actionTaken: getActionTakenValue(req).trim(),
        actionTakenBy: currentUserIdentifier,
        actionTakenAt: serverTimestamp()
      });
      setActionTakenDrafts(prev => { const next = { ...prev }; delete next[req.id]; return next; });
    } catch (err) {
      alert('Error saving action taken: ' + err.message);
    }
  };

  // "Notes" box: only the Facility Manager (or Admin) can write it.
  const canEditNotes = () => perm('editNotes');
  const getNotesValue = (req) => (notesDrafts[req.id] !== undefined ? notesDrafts[req.id] : (req.notes || ''));
  const handleSaveNotes = async (req) => {
    try {
      await updateDoc(doc(db, 'requests', req.id), {
        notes: getNotesValue(req).trim(),
        notesBy: currentUserIdentifier,
        notesAt: serverTimestamp()
      });
      setNotesDrafts(prev => { const next = { ...prev }; delete next[req.id]; return next; });
    } catch (err) {
      alert('Error saving notes: ' + err.message);
    }
  };

  const handleConfirmAssignment = async () => {
    if (!assignModalReq) return;
    if (!selectedAssigneeId) return alert("Please choose who is in charge of this task!");

    const selectedMember = taskAssignees.find(m => m.id === selectedAssigneeId);
    if (!selectedMember) return alert("Invalid selection.");

    const targetStatus = assignTargetStatus;

    try {
      const payload = {
        status: targetStatus,
        assignedTo: selectedMember.username,
        assignedToId: selectedMember.id,
        assignedToPhone: selectedMember.phone || 'N/A',
        ...(targetStatus === 'Completed'
          // completed straight away: we do not know when the work started, so no "assigned at" is invented
          ? { completedAt: serverTimestamp(), completedBy: currentUserIdentifier }
          : { assignedAt: serverTimestamp(), completedAt: null, completedBy: null })
      };

      await updateDoc(doc(db, 'requests', assignModalReq.id), payload);

      await addDoc(collection(db, 'logs'), {
        type: 'STATUS_CHANGE',
        title: assignModalReq.title || 'Maintenance Request',
        fromStatus: assignModalReq.status || 'New',
        toStatus: targetStatus,
        assignedTo: selectedMember.username,
        performedBy: currentUserIdentifier,
        timestamp: serverTimestamp()
      });

      setAssignModalReq(null);
      setSelectedAssigneeId('');
      alert(targetStatus === 'Completed'
        ? `Request completed by ${selectedMember.username}!`
        : `Request assigned to ${selectedMember.username}!`);
    } catch (err) {
      alert('Error updating the request: ' + err.message);
    }
  };

  const handleDeleteRequest = async (reqId) => {
    if (!isAdmin) return alert("Sorry, this action is exclusive to Admin only.");
    if (window.confirm('Are you sure you want to delete this maintenance request?')) {
      try {
        await deleteWithAudit('requests', reqId);
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
    }
    // A Supervisor can only ever create plain Staff (User) accounts.
    if (isSupervisor) {
      targetRole = 'User';
    }

    // Phone number is required for every new account, EXCEPT an Admin can explicitly
    // opt out of it for a special case (the "Register without a phone number" checkbox).
    const phoneExempt = isAdmin && skipPhoneForAdmin;
    if (!newUserPhone.trim() && !phoneExempt) {
      return alert(
        "Phone number is required." +
        (isAdmin ? ' Check "Register without a phone number" below if you need to skip this just this once.' : '')
      );
    }

    // Whenever a phone number is given, it must be a valid Egyptian mobile number:
    // exactly 11 digits, starting with "01".
    if (newUserPhone.trim() && !isValidEgyptPhone(newUserPhone)) {
      return alert("Please enter a valid phone number: 11 digits, starting with 01 (e.g. 01012345678).");
    }

    // Only an Admin can create another Admin account
    if (targetRole === 'Admin' && !isAdmin) {
      return alert("Only an Admin can create an Admin account.");
    }

    if (isBranchManager && !['Supervisor', 'User'].includes(targetRole)) {
      return alert("Branch Managers are only allowed to create Supervisor or Staff (User) accounts.");
    }

    // Branch Manager must assign branch(es) to every account they create
    if ((isBranchManager || isSupervisor) && newUserBranches.length === 0) {
      return alert("Please assign at least one branch to this account.");
    }

    setLoading(true);
    try {
      // Update: account creation now goes through a Cloud Function, which creates a
      // real Firebase Auth account (password is never stored in Firestore anymore).
      const createUserAccount = httpsCallable(functions, 'createUserAccount');
      await createUserAccount({
        username: newUsername.trim(),
        password: newPassword.trim(),
        phone: newUserPhone.trim() || '',
        role: targetRole,
        assignedBranches: newUserBranches
      });

      setNewUsername('');
      setNewPassword('');
      setNewUserPhone('');
      setSkipPhoneForAdmin(false);
      setNewUserRole(isFacilityManager ? 'Facility Member' : isBranchManager ? 'User' : 'User');
      setNewUserBranches([]);
      alert('User added successfully!');
    } catch (err) {
      alert('Error adding user: ' + (err.message || err));
    } finally {
      setLoading(false);
    }
  };

  // Generates a random temporary password (no look-alike characters like 0/O or 1/l)
  const generateTempPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    if (!canManageUsers) return alert("Permission denied.");
    if (!editingUser) return;

    // Facility Manager / Branch Manager / Supervisor share their team - they can edit any account of the
    // right role, regardless of who created it. Everyone else may only edit accounts they created themselves
    // (Admin always has full permission).
    if (isFacilityManager) {
      if (editingUser.role !== 'Facility Member') return alert("Facility Managers can only edit Facility Members.");
    } else if (isBranchManager) {
      if (!['Supervisor', 'User'].includes(editingUser.role)) return alert("Branch Managers can only edit Supervisor or Staff (User) accounts.");
    } else if (isSupervisor) {
      if (editingUser.role !== 'User') return alert("Supervisors can only edit Staff (User) accounts.");
    } else if (!isAdmin && editingUser.createdBy !== user?.id) {
      return alert("You can only edit accounts that you created yourself.");
    }

    if (isBranchManager && editUserBranches.length === 0) {
      return alert("Please assign at least one branch to this account.");
    }

    // Validate first, so we never half-apply an edit (profile saved but password rejected)
    if (isAdmin && editPassword.trim() && editPassword.trim().length < 6) {
      return alert("The new password must be at least 6 characters.");
    }

    // Whenever a phone number is given, it must be a valid Egyptian mobile number:
    // exactly 11 digits, starting with "01".
    if (editUserPhone.trim() && !isValidEgyptPhone(editUserPhone)) {
      return alert("Please enter a valid phone number: 11 digits, starting with 01 (e.g. 01012345678).");
    }

    try {
      // Note: the username is the account's login identity (linked to its Firebase Auth account
      // and the login lookup), so it is intentionally not editable here.
      const updatePayload = {
        phone: editUserPhone.trim(),
        assignedBranches: editUserBranches
      };

      await updateDoc(doc(db, 'users', editingUser.id), updatePayload);

      // Update: a role change updates the Firebase Auth custom claim too, so it
      // has to go through this Cloud Function instead of a plain Firestore write.
      if (isAdmin && editUserRole !== editingUser.role) {
        const updateUserRole = httpsCallable(functions, 'updateUserRole');
        await updateUserRole({ targetUserId: editingUser.id, newRole: editUserRole });
      }

      // Update: only Admin can set a NEW password for someone else's account, and it
      // now goes through Firebase Auth via this Cloud Function - never stored in Firestore.
      let passwordWasReset = false;
      if (isAdmin && editPassword.trim()) {
        const adminResetPassword = httpsCallable(functions, 'adminResetPassword');
        await adminResetPassword({ targetUserId: editingUser.id, newPassword: editPassword.trim() });
        passwordWasReset = true;
      }

      if (passwordWasReset) {
        const forcedNote = editingUser.id !== user?.id
          ? '\nThey will be asked to choose their own password at their next login.'
          : '';
        alert(`User updated successfully!\n\nNew temporary password for "${editUsername}":\n${editPassword.trim()}\n\nShare it with the user now - it cannot be viewed again later.${forcedNote}`);
      } else {
        alert('User updated successfully!');
      }
      setEditingUser(null);
    } catch (err) {
      alert('Error updating user: ' + (err.message || err));
    }
  };

  // Same permission rules used by the single-delete button, factored out so bulk delete can
  // silently skip any selected user that this account isn't actually allowed to delete.
  const canDeleteUser = (targetUser) => {
    if (!canManageUsers) return false;
    // Facility Manager / Branch Manager / Supervisor share their team: any of them can manage any
    // account of the right role, regardless of who created it.
    if (isFacilityManager) return targetUser.role === 'Facility Member';
    if (isBranchManager) return ['Supervisor', 'User'].includes(targetUser.role);
    if (isSupervisor) return targetUser.role === 'User';
    if (!isAdmin && targetUser.createdBy !== user?.id) return false;
    return true;
  };

  const handleDeleteUser = async (targetUser) => {
    if (!canDeleteUser(targetUser)) {
      if (!canManageUsers) return alert("Permission denied.");
      if (isFacilityManager) return alert("Facility Managers can only delete Facility Members.");
      if (isBranchManager) return alert("Branch Managers can only delete Supervisor or Staff (User) accounts.");
      if (isSupervisor) return alert("Supervisors can only delete Staff (User) accounts.");
      if (!isAdmin && targetUser.createdBy !== user?.id) return alert("You can only delete accounts that you created yourself.");
      return alert("Permission denied.");
    }

    if (window.confirm(`Are you sure you want to delete user "${targetUser.username}"?`)) {
      try {
        // Update: deletes the real Auth account together with the Firestore profile,
        // so a deleted account can never still log in.
        const deleteUserAccount = httpsCallable(functions, 'deleteUserAccount');
        await deleteUserAccount({ targetUserId: targetUser.id });
        alert('User deleted successfully!');
      } catch (err) {
        alert('Error deleting user: ' + (err.message || err));
      }
    }
  };

  // Deletes every currently-selected user (from the checkboxes in the System Users table) in one go,
  // skipping anyone this account isn't allowed to delete or the account's own row.
  const handleBulkDeleteUsers = async () => {
    const targets = manageableUsersList.filter(
      (u) => selectedUserIds.has(u.id) && u.id !== user?.id && canDeleteUser(u)
    );
    if (targets.length === 0) return;

    if (!window.confirm(`Are you sure you want to delete ${targets.length} user(s)? This cannot be undone.`)) return;

    setLoading(true);
    const deleteUserAccount = httpsCallable(functions, 'deleteUserAccount');
    let succeeded = 0;
    const failedNames = [];

    for (const u of targets) {
      try {
        await deleteUserAccount({ targetUserId: u.id });
        succeeded += 1;
      } catch (err) {
        failedNames.push(u.username);
      }
    }

    setLoading(false);
    setSelectedUserIds(new Set());

    if (failedNames.length === 0) {
      alert(`${succeeded} user(s) deleted successfully!`);
    } else {
      alert(`${succeeded} user(s) deleted.\nFailed: ${failedNames.join(', ')}`);
    }
  };

  const handleDeleteFullRecord = async (recordId) => {
    if (!isAdmin) return alert("Exclusive to Admin only.");
    if (window.confirm('Are you sure you want to delete this entire attendance record?')) {
      try {
        await deleteWithAudit('attendance', recordId);
        alert('Record deleted successfully!');
      } catch (err) {
        alert('Error deleting record: ' + err.message);
      }
    }
  };

  // Records a blocked Check-In/Check-Out attempt (denied location, or outside the branch's allowed
  // radius) so Admin/managers can see how often - and by whom - this is happening. Best-effort only:
  // if this write fails for any reason, it must never be the thing that stops the alert the employee
  // already saw from being the only feedback they get.
  const logLocationViolation = async ({ reason, mode, branch, distance, allowedRadius, lat, lng, accuracy }) => {
    try {
      await addDoc(collection(db, 'locationViolations'), {
        username: currentUserIdentifier,
        mode,
        branch: branch || '',
        reason, // 'denied' | 'unavailable' | 'out_of_range'
        distance: distance ?? null,
        allowedRadius: allowedRadius ?? null,
        lat: lat ?? null,
        lng: lng ?? null,
        accuracy: accuracy ?? null,
        createdAt: serverTimestamp()
      });
    } catch (err) {
      console.warn('Could not log location violation:', err.message);
    }
  };

  // CAMERA LOGIC
  const startLiveCamera = async (mode = 'request') => {
    if (mode === 'checkin' && openAttendance) {
      return alert("You are already checked in. Please check out first.");
    }
    if (mode === 'checkout' && !openAttendance) {
      return alert("No active check-in found. Please check in first.");
    }
    // The branch is chosen when CHECKING IN (a new session may be at the same branch or another assigned one).
    // Checking out simply closes the open session, so no branch needs to be selected for it.
    if (mode === 'checkin' && !attendanceBranch) {
      return alert("Please select a branch first.");
    }
    if (
      mode === 'checkin' &&
      !isAdmin && !isFacilityManager &&
      assignedBranches.length > 0 &&
      !assignedBranches.includes(attendanceBranch)
    ) {
      return alert("You can only check in at a branch assigned to you.");
    }

    // GPS geofence: if this branch has a saved location, you must be physically within its
    // allowed radius to check in or out - no exceptions, this is a hard requirement.
    if (mode === 'checkin' || mode === 'checkout') {
      const targetBranchName = mode === 'checkin' ? attendanceBranch : (openAttendance?.branch || '');
      const targetBranch = branches.find(b => b.name === targetBranchName);

      if (targetBranch && targetBranch.locationLat != null && targetBranch.locationLng != null) {
        setIsCheckingLocation(true);
        let position;
        try {
          position = await getCurrentPositionAsync();
        } catch (geoErr) {
          setIsCheckingLocation(false);
          const reason = geoErr.code === 1
            ? 'Location access was denied. Please allow location access for this site and try again.'
            : 'We could not get your current location. Please make sure GPS/Location Services are on and try again.';
          logLocationViolation({
            reason: geoErr.code === 1 ? 'denied' : 'unavailable',
            mode,
            branch: targetBranchName
          });
          return alert(reason);
        }

        const distance = distanceInMeters(
          position.coords.latitude,
          position.coords.longitude,
          targetBranch.locationLat,
          targetBranch.locationLng
        );
        const allowedRadius = targetBranch.locationRadius || 150;
        setIsCheckingLocation(false);

        if (distance > allowedRadius) {
          logLocationViolation({
            reason: 'out_of_range',
            mode,
            branch: targetBranchName,
            distance: Math.round(distance),
            allowedRadius,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
          });
          return alert(
            `You appear to be ~${Math.round(distance)}m away from ${targetBranchName}. ` +
            `You need to be within ${allowedRadius}m of the branch to ${mode === 'checkin' ? 'check in' : 'check out'}.`
          );
        }

        geoRef.current = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy
        };
      } else {
        geoRef.current = null;
      }
    }

    setCameraMode(mode);
    setShowWebcam(true);
    try {
      // Update: use the front (selfie) camera for Check-In / Check-Out, and the back camera for maintenance request photos
      const desiredFacingMode = (mode === 'checkin' || mode === 'checkout') ? 'user' : 'environment';
      const constraints = { video: { facingMode: { exact: desiredFacingMode } } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: desiredFacingMode } });
        } catch (e2) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
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
    const sourceWidth = videoRef.current.videoWidth || 1280;
    const sourceHeight = videoRef.current.videoHeight || 720;

    // Compress before upload: phone cameras capture at 3000-4000px+ which makes multi-MB photos.
    // Scaling the canvas down to a sensible max dimension while drawing (instead of drawing full-size
    // then shrinking) keeps this a single, instant canvas operation - no extra processing time.
    const MAX_DIMENSION = 1600;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sourceWidth * scale);
    canvas.height = Math.round(sourceHeight * scale);
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
    }, 'image/jpeg', 0.75);
  };

  // Opens one attendance selfie. The photo web address is not on the attendance record any more: it is read
  // on demand from a locked document that only HR, Admin and Branch Managers (of that branch) are allowed to open.
  const openAttendancePhoto = async (rec, which) => {
    if (!canViewAttendancePhotos) return;
    try {
      const legacy = which === 'in' ? rec.checkInPhoto : rec.checkOutPhoto;
      if (legacy) { setFullscreenImage(legacy); return; }
      const snap = await getDoc(doc(db, 'attendance', rec.id, 'attendancePhotos', 'photos'));
      const url = snap.exists() ? (which === 'in' ? snap.data().checkInPhoto : snap.data().checkOutPhoto) : null;
      if (url) setFullscreenImage(url);
      else alert('This photo is no longer available (photos are deleted automatically after 60 days).');
    } catch (err) {
      alert('You are not allowed to view this photo.');
    }
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

      const todayStr = toLocalYmd();

      if (mode === 'checkin') {
        const geo = geoRef.current;
        geoRef.current = null;
        // The selfie is NOT stored on the attendance record (which any signed-in account can read). It goes
        // into a separate, locked-down document that only HR, Admin and the branch's Branch Managers can open.
        const branchForRecord = attendanceBranch || (branches[0]?.name || 'General');
        const attRef = doc(collection(db, 'attendance'));
        const batch = writeBatch(db);
        batch.set(attRef, {
          username: currentUserIdentifier,
          branch: branchForRecord,
          dateStr: todayStr,
          checkInTime: serverTimestamp(),
          checkInLat: geo?.lat ?? null,
          checkInLng: geo?.lng ?? null,
          checkInAccuracy: geo?.accuracy ?? null,
          checkOutTime: null,
          photosPrivate: true,
          isArchived: false,
          status: 'Checked In'
        });
        batch.set(doc(db, 'attendance', attRef.id, 'attendancePhotos', 'photos'), {
          attendanceId: attRef.id,
          username: currentUserIdentifier,
          branch: branchForRecord,
          checkInPhoto: photoUrl,
          checkOutPhoto: null,
          createdAt: serverTimestamp()
        });
        await batch.commit();
        alert('Check-In Successful! 🟢');
      } else if (mode === 'checkout') {
        // Close the MOST RECENT open session (the one actually shown on screen).
        // Using a plain .find() here previously picked whichever open session
        // happened to come first in the array, which could be an older stray
        // session at a different branch than the one displayed — leaving the
        // real open session untouched and stuck.
        const openSessions = attendanceRecords.filter(a =>
          a.username === currentUserIdentifier &&
          a.dateStr === todayStr &&
          !a.checkOutTime
        );
        const sessionTime = (a) => (a.checkInTime?.toMillis ? a.checkInTime.toMillis() : 0);
        const activeRecord = openSessions.sort((a, b) => sessionTime(b) - sessionTime(a))[0] || null;

        if (activeRecord) {
          const geo = geoRef.current;
          geoRef.current = null;
          const outBatch = writeBatch(db);
          outBatch.update(doc(db, 'attendance', activeRecord.id), {
            checkOutTime: serverTimestamp(),
            checkOutLat: geo?.lat ?? null,
            checkOutLng: geo?.lng ?? null,
            checkOutAccuracy: geo?.accuracy ?? null,
            status: 'Completed'
          });
          const photoRef = doc(db, 'attendance', activeRecord.id, 'attendancePhotos', 'photos');
          if (activeRecord.photosPrivate) {
            outBatch.update(photoRef, { checkOutPhoto: photoUrl });
          } else {
            // A session opened before selfies moved to the private document: create it now.
            outBatch.set(photoRef, {
              attendanceId: activeRecord.id,
              username: currentUserIdentifier,
              branch: activeRecord.branch,
              checkInPhoto: activeRecord.checkInPhoto || '',
              checkOutPhoto: photoUrl,
              createdAt: serverTimestamp()
            });
          }
          await outBatch.commit();
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

  // FORCE LOGOUT MONITORING + FORCED PASSWORD CHANGE MONITORING
  useEffect(() => {
    if (!user?.id) return;

    const unsubUserSelf = onSnapshot(doc(db, 'users', user.id), (docSnap) => {
      if (!docSnap.exists()) return;
      const data = docSnap.data();

      if (data.forceLogout) {
        updateDoc(doc(db, 'users', user.id), { forceLogout: false });
        alert('You have been forcefully logged out by the Administrator.');
        onLogout();
        return;
      }

      setMustChangePassword(!!data.mustChangePassword);
    });

    return () => unsubUserSelf();
  }, [user?.id, onLogout]);

  // ONLINE PRESENCE HEARTBEAT - marks this account as online, refreshes lastActive, and records device/browser info
  useEffect(() => {
    if (!user?.id) return;

    const sendHeartbeat = () => {
      const deviceId = getOrCreateDeviceId();
      const { deviceType, browser, os, userAgent } = parseDeviceInfo();

      updateDoc(doc(db, 'users', user.id), {
        isOnline: true,
        lastActive: serverTimestamp(),
        lastDeviceId: deviceId,
        lastDeviceType: deviceType,
        lastBrowser: browser,
        lastOS: os,
        lastUserAgent: userAgent
      }).catch(() => {});
    };

    sendHeartbeat(); // immediately when the dashboard opens
    // Update: every heartbeat write is broadcast to every open device (everyone keeps a live "who's online" list),
    // so with N people online the cost grows like N x N. Slowing this down to once every 3 minutes cuts that cost
    // roughly 4x with barely any difference in how fresh the Online/Offline status looks.
    const heartbeatInterval = setInterval(sendHeartbeat, 180000); // every 3 minutes

    return () => clearInterval(heartbeatInterval);
  }, [user?.id]);

  // Helper: determine if a user is currently Online based on lastActive freshness
  const isUserOnline = (u) => {
    if (!u) return false;
    if (u.isOnline === false) return false; // explicitly logged out
    if (!u.lastActive) return false;
    const lastMs = u.lastActive.toDate ? u.lastActive.toDate().getTime() : new Date(u.lastActive).getTime();
    return (nowTick - lastMs) < 240000; // last heartbeat within the last 4 minutes (matches the 3-minute heartbeat, plus a margin)
  };

  // Helper: human-readable "last seen" text for the System Users table's new column.
  const formatLastSeen = (u) => {
    if (!u?.lastActive) return 'Never';
    const d = u.lastActive.toDate ? u.lastActive.toDate() : new Date(u.lastActive);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const handleForceLogout = async (targetUser) => {
    if (!window.confirm(`Are you sure you want to force log out "${targetUser.username}"?`)) return;
    try {
      await updateDoc(doc(db, 'users', targetUser.id), { forceLogout: true });
      alert(`Logout command sent to ${targetUser.username}.`);
    } catch (err) {
      alert('Error performing Force Logout: ' + err.message);
    }
  };

  const handleLogoutClick = async () => {
    if (user?.id) {
      try {
        await updateDoc(doc(db, 'users', user.id), { isOnline: false });
      } catch (err) {
        // Ignore any error here - the important thing is the user can still log out
      }
    }
    onLogout();
  };

  // Update: mandatory password change after first login - now updates the real Firebase Auth password
  const handleForcedPasswordChange = async (e) => {
    e.preventDefault();
    if (!forcedNewPassword.trim() || forcedNewPassword.trim().length < 6) {
      return alert('Please enter a new password of at least 6 characters.');
    }
    if (forcedNewPassword.trim() !== forcedConfirmPassword.trim()) {
      return alert('Password and confirmation do not match.');
    }
    try {
      await updatePassword(auth.currentUser, forcedNewPassword.trim());
      await updateDoc(doc(db, 'users', user.id), { mustChangePassword: false });
      setForcedNewPassword('');
      setForcedConfirmPassword('');
      setMustChangePassword(false);
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        alert('For security, please log out and log back in, then try changing your password again.');
      } else {
        alert('An error occurred while updating the password: ' + err.message);
      }
    }
  };

  // Update: self-service password change - now updates the real Firebase Auth password
  const handleSelfPasswordChange = async (e) => {
    e.preventDefault();
    if (!selfNewPassword.trim() || selfNewPassword.trim().length < 6) {
      return alert('Please enter a new password of at least 6 characters.');
    }
    if (selfNewPassword.trim() !== selfConfirmPassword.trim()) {
      return alert('Password and confirmation do not match.');
    }
    try {
      await updatePassword(auth.currentUser, selfNewPassword.trim());
      alert('Password changed successfully!');
      setSelfNewPassword('');
      setSelfConfirmPassword('');
      setShowSelfPasswordModal(false);
    } catch (err) {
      if (err.code === 'auth/requires-recent-login') {
        alert('For security, please log out and log back in, then try changing your password again.');
      } else {
        alert('An error occurred while updating the password: ' + err.message);
      }
    }
  };

  // Update: server-side scoped queries for "requests" and "attendance".
  // Previously every signed-in account subscribed to the WHOLE collection and the app only hid what it
  // shouldn't show on screen - meaning anyone could read every branch's data by querying Firestore directly
  // from the browser console. These two queries now ask the server for only the documents this account is
  // allowed to see, and the matching Security Rules (see firestore.rules) reject anything wider than that -
  // so the restriction can no longer be bypassed by skipping the app's UI.
  // The role-vs-role sub-filter inside hierarchyFilteredAttendance (e.g. a Supervisor seeing Users but not
  // fellow Supervisors) still happens after this, in memory - Firestore queries cannot depend on a second
  // account's role, only on fields already stored on the document itself (its branch or username).
  const roleLower = (userRole || '').trim().toLowerCase();

  const buildRequestsQuery = () => {
    if (canViewAllRequests) {
      return collection(db, 'requests');
    }
    if (roleLower === 'user' || roleLower === 'staff') {
      return query(collection(db, 'requests'), where('createdBy', '==', currentUserIdentifier));
    }
    if (roleLower === 'admin' || roleLower === 'ceo') {
      return collection(db, 'requests');
    }
    // Supervisor, Branch Manager, Facility Manager, HR, etc.: their own branches, or everything if none are set
    // (matches the app's existing rule in filteredRequests exactly)
    return assignedBranches.length > 0
      ? query(collection(db, 'requests'), where('branch', 'in', assignedBranches.slice(0, 30)))
      : collection(db, 'requests');
  };

  const buildAttendanceQuery = (cutoff) => {
    const cutoffFilter = where('checkInTime', '>=', Timestamp.fromDate(cutoff));
    if (roleLower === 'admin' || roleLower === 'ceo' || roleLower === 'hr') {
      return query(collection(db, 'attendance'), cutoffFilter);
    }
    if (roleLower === 'branch manager' || roleLower === 'supervisor') {
      // matches hierarchyFilteredAttendance: own branches if any are set, otherwise own records only
      return assignedBranches.length > 0
        ? query(collection(db, 'attendance'), where('branch', 'in', assignedBranches.slice(0, 30)), cutoffFilter)
        : query(collection(db, 'attendance'), where('username', '==', currentUserIdentifier), cutoffFilter);
    }
    // User/Staff, Facility Manager, Facility Member and anyone else: their own attendance only
    return query(collection(db, 'attendance'), where('username', '==', currentUserIdentifier), cutoffFilter);
  };

  // FIRESTORE LISTENERS WITH ALPHABETICAL SORTING
  useEffect(() => {
    const unsubReq = onSnapshot(buildRequestsQuery(), (snapshot) => {
      setRequests(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
    }, (err) => console.warn('Could not load requests:', err.message));

    const unsubCeoReq = onSnapshot(collection(db, 'ceo_requests'), (snapshot) => {
      const data = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setCeoRequests(data);
    });

    // Leave requests - same broad-read pattern as ceo_requests above (works for every role today).
    const unsubLeaveReq = onSnapshot(collection(db, 'leaveRequests'), (snapshot) => {
      const data = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setLeaveRequests(data);
    }, (err) => console.warn('Could not load leave requests:', err.message));

    // Fetch and Sort Branches Alphabetically (A-Z)
    const unsubBranches = onSnapshot(collection(db, 'branches'), (snapshot) => {
      // IMPORTANT: keep every field from the branch document (...item.data()), not just name -
      // the GPS lock fields (locationLat/locationLng/locationRadius) live here too, and dropping
      // them meant the app could never see a saved location, so the geofence silently never applied.
      const list = snapshot.docs.map(item => ({ id: item.id, ...item.data(), name: item.data().name || item.data().title || 'Unnamed' }));
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setBranches(list);
    });

    // Fetch and Sort Categories Alphabetically (A-Z)
    const unsubCategories = onSnapshot(collection(db, 'categories'), (snapshot) => {
      const list = snapshot.docs.map(item => ({ id: item.id, name: item.data().name || item.data().title || 'Unnamed' }));
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      setCategories(list);
    });

    // Update: only the last 2 months load into the app - older attendance keeps existing in Firestore
    // (nothing is deleted), it just is not pulled into every device's live listener anymore. This keeps the
    // app fast and cheap to run as attendance history grows. Full-year exports can still be added later if needed.
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    const unsubAttendance = onSnapshot(buildAttendanceQuery(twoMonthsAgo), (snapshot) => {
      setAttendanceRecords(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      setAttendanceLoadError(null);
    }, (err) => {
      console.warn('Could not load attendance:', err.message);
      setAttendanceLoadError(err.message || 'Unknown error');
    });

    // Location Violations: everyone who can view reports sees the full list (mirrors attendance);
    // other roles don't need it, but the listener is cheap and simplest to just always attach.
    const unsubLocationViolations = onSnapshot(collection(db, 'locationViolations'), (snapshot) => {
      setLocationViolations(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
    }, (err) => {
      console.warn('Could not load location violations:', err.message);
    });

    const unsubLogs = onSnapshot(collection(db, 'logs'), (snapshot) => {
      const logsData = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      logsData.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
      setActivityLogs(logsData);
    });

    // Every role now loads the users directory (it is needed to tell Users, Supervisors and Branch Managers apart
    // in the attendance hierarchy - a Supervisor used to get an empty list here, so every record looked like a plain User).
    const unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
      setUsersList(
        snapshot.docs
          .map(item => ({ id: item.id, ...item.data() }))
          .filter(u => !isHiddenAdminUser(u))
      );
    });

    return () => {
      unsubReq(); unsubCeoReq(); unsubLeaveReq(); unsubBranches(); unsubCategories(); unsubAttendance(); unsubLogs(); unsubUsers(); unsubLocationViolations();
    };
  }, [user?.id, roleLower, branchesKey, currentUserIdentifier, canViewAllRequests]);

  // ACTIVITY LOG BELL (header icon): the log is hidden until the bell is clicked.
  // The red badge counts entries made by OTHER people since the bell was last opened
  // (the "last opened" time is remembered per user in this browser).
  const logsSeenKey = `befit_logs_seen_${user?.id || 'anon'}`;
  const [showLogsPanel, setShowLogsPanel] = useState(false);
  const [logsSeenAt, setLogsSeenAt] = useState(() => {
    try { return Number(localStorage.getItem(`befit_logs_seen_${user?.id || 'anon'}`)) || 0; } catch (e) { return 0; }
  });

  const unreadLogsCount = useMemo(() => {
    return activityLogs.filter((l) => {
      const t = l.timestamp?.toMillis ? l.timestamp.toMillis() : 0;
      return t > logsSeenAt && l.performedBy !== currentUserIdentifier;
    }).length;
  }, [activityLogs, logsSeenAt, currentUserIdentifier]);

  const openLogsPanel = () => {
    setShowLogsPanel(true);
    const now = Date.now();
    setLogsSeenAt(now);
    try { localStorage.setItem(logsSeenKey, String(now)); } catch (e) { /* storage unavailable - the badge simply resets on reload */ }
  };

  // ROLE-BASED MAINTENANCE REQUESTS FILTER
  const filteredRequests = useMemo(() => {
    let result = [...requests];

    if (isAdmin && showArchivedOnly) {
      result = result.filter(r => r.isArchived === true);
    } else {
      result = result.filter(r => !r.isArchived);
    }

    if (canViewAllRequests) {
      // sees every branch's requests - no narrowing
    } else if (isStaff) {
      result = result.filter(r => r.createdBy === currentUserIdentifier);
    } else {
      // Update: any account (regardless of role) with assigned branches only sees requests from its own branches
      if (assignedBranches.length > 0) {
        result = result.filter(r => assignedBranches.includes(r.branch));
      }
    }

    if (statusFilter !== 'All') result = result.filter(r => (r.status || 'New') === statusFilter);
    if (branchFilter !== 'All') result = result.filter(r => r.branch === branchFilter);
    if (categoryFilter !== 'All') result = result.filter(r => r.category === categoryFilter);
    if (assigneeFilters.length > 0) result = result.filter(r => assigneeFilters.includes(r.assignedTo || UNASSIGNED_FILTER));

    return result.sort((a, b) => (sortOrder === 'desc' ? (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0) : (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)));
  }, [requests, isStaff, isSupervisor, isBranchManager, isCEO, assignedBranches, currentUserIdentifier, statusFilter, branchFilter, categoryFilter, assigneeFilters, sortOrder, isAdmin, showArchivedOnly, canViewAllRequests]);

  // Options of the "Assigned to" filter: everyone who can be assigned, plus anyone already on a request
  const assigneeFilterOptions = useMemo(() => {
    const names = new Set(taskAssignees.map(u => u.username));
    requests.forEach(r => { if (r.assignedTo) names.add(r.assignedTo); });
    return [
      { value: UNASSIGNED_FILTER, label: '— Unassigned —' },
      ...[...names].filter(Boolean).sort((a, b) => a.localeCompare(b)).map(n => ({ value: n, label: n }))
    ];
  }, [taskAssignees, requests]);

  // the "who did what" maintenance report: Admin, Facility Manager and CEO
  const canSeeMaintReport = perm('maintReport');

  // The report follows the same branch rule as the requests list: an account with assigned branches
  // (e.g. a Facility Manager) only reports on those branches; Admin, CEO and accounts with none see everything.
  const reportUnrestricted = isAdmin || isCEO || assignedBranches.length === 0;
  const maintReportRequests = useMemo(
    () => (reportUnrestricted ? requests : requests.filter(r => assignedBranches.includes(r.branch))),
    [requests, reportUnrestricted, assignedBranches]
  );
  const maintReportBranches = useMemo(
    () => (reportUnrestricted ? branches : branches.filter(b => assignedBranches.includes(b.name))),
    [branches, reportUnrestricted, assignedBranches]
  );

  // ROLE-BASED ATTENDANCE REPORT FILTER
  // Update: map of username -> role, used to enforce hierarchy visibility in Attendance Reports
  const usernameToRole = useMemo(() => {
    const map = {};
    usersList.forEach(u => { map[u.username] = u.role; });
    return map;
  }, [usersList]);

  // Update: base attendance list after applying only the role/branch hierarchy rules (before user/branch/date filters)
  const hierarchyFilteredAttendance = useMemo(() => {
    // The hidden owner account's own check-ins never appear in anyone ELSE's attendance
    // reports/table, even though the account still checks in/out normally itself - but when this
    // account IS the one looking at the screen (viewerIsHiddenAdmin), its own records stay visible
    // to itself here too, instead of only in the separate personal "My Sessions" view.
    let list = attendanceRecords.filter(a => viewerIsHiddenAdmin || !isHiddenAdminUser(a));

    if (isAdmin && showArchivedOnly) {
      list = list.filter(a => a.isArchived === true);
    } else {
      list = list.filter(a => !a.isArchived);
    }

    // Attendance visibility rules (matches the official permission table exactly):
    // Default: nobody sees anyone else's attendance, only their own
    // Branch Manager: sees Users (Staff) & Supervisors in their assigned branches (plus their own record)
    // Supervisor: sees Users (Staff) only in their assigned branches (plus their own record)
    // Admin, HR & CEO: exceptions, see all attendance across all branches
    if (isAdmin || isHR || isCEO) {
      // No filtering - they see all records
    } else if (isBranchManager) {
      if (assignedBranches.length > 0) {
        list = list.filter(a => assignedBranches.includes(a.branch));
      } else {
        list = list.filter(a => a.username === currentUserIdentifier);
      }
      list = list.filter(a => {
        if (a.username === currentUserIdentifier) return true;
        const role = (usernameToRole[a.username] || 'User').trim().toUpperCase();
        return role === 'USER' || role === 'STAFF' || role === 'SUPERVISOR';
      });
    } else if (isSupervisor) {
      if (assignedBranches.length > 0) {
        list = list.filter(a => assignedBranches.includes(a.branch));
      } else {
        list = list.filter(a => a.username === currentUserIdentifier);
      }
      list = list.filter(a => {
        if (a.username === currentUserIdentifier) return true;
        const role = (usernameToRole[a.username] || 'User').trim().toUpperCase();
        return role === 'USER' || role === 'STAFF';
      });
    } else {
      list = list.filter(a => a.username === currentUserIdentifier);
    }

    return list;
  }, [attendanceRecords, isAdmin, isCEO, isHR, isBranchManager, isSupervisor, assignedBranches, currentUserIdentifier, usernameToRole, showArchivedOnly, viewerIsHiddenAdmin]);

  // Same visibility scoping as attendance above, applied to location-violation attempts: a Branch
  // Manager/Supervisor only sees their own branches' staff, everyone else only sees their own attempts,
  // Admin/HR/CEO see everything.
  const hierarchyFilteredLocationViolations = useMemo(() => {
    let list = locationViolations.filter(v => !isHiddenAdminUser({ username: v.username }));

    if (isAdmin || isHR || isCEO) {
      // no filtering
    } else if (isBranchManager) {
      if (assignedBranches.length > 0) {
        list = list.filter(v => assignedBranches.includes(v.branch));
      } else {
        list = list.filter(v => v.username === currentUserIdentifier);
      }
      list = list.filter(v => {
        if (v.username === currentUserIdentifier) return true;
        const role = (usernameToRole[v.username] || 'User').trim().toUpperCase();
        return role === 'USER' || role === 'STAFF' || role === 'SUPERVISOR';
      });
    } else if (isSupervisor) {
      if (assignedBranches.length > 0) {
        list = list.filter(v => assignedBranches.includes(v.branch));
      } else {
        list = list.filter(v => v.username === currentUserIdentifier);
      }
      list = list.filter(v => {
        if (v.username === currentUserIdentifier) return true;
        const role = (usernameToRole[v.username] || 'User').trim().toUpperCase();
        return role === 'USER' || role === 'STAFF';
      });
    } else {
      list = list.filter(v => v.username === currentUserIdentifier);
    }

    return list;
  }, [locationViolations, isAdmin, isCEO, isHR, isBranchManager, isSupervisor, assignedBranches, currentUserIdentifier, usernameToRole]);

  // Update: the "User Filter" dropdown is now derived directly from whoever actually has visible attendance records,
  // so it can never show a name that then yields zero rows (this replaces the old assignedBranches-only guess)
  const visibleReportUsers = useMemo(() => {
    const usernames = [...new Set(hierarchyFilteredAttendance.map(a => a.username))];
    if (currentUserIdentifier && !usernames.includes(currentUserIdentifier)) {
      usernames.push(currentUserIdentifier);
    }
    return usernames
      .map(name => usersList.find(u => u.username === name) || { id: name, username: name })
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  }, [hierarchyFilteredAttendance, usersList, currentUserIdentifier]);

  // Options for the report filters. Admin and HR can pick from EVERY account and EVERY branch, even ones with no
  // attendance yet; Branch Managers and Supervisors only from the people and branches inside their own scope.
  const reportUserOptions = useMemo(() => {
    const source = (isAdmin || isHR) ? usersList : visibleReportUsers;
    const seen = new Set();
    const result = [];
    source.forEach(u => {
      if (!u.username || seen.has(u.username)) return;
      seen.add(u.username);
      result.push({ value: u.username, label: u.username, hint: u.role || '' });
    });
    return result.sort((a, b) => a.label.localeCompare(b.label));
  }, [isAdmin, isHR, usersList, visibleReportUsers]);

  const reportBranchOptions = useMemo(() => {
    const source = (isAdmin || isHR) ? branches : visibleBranchesForUser;
    return source
      .map(b => ({ value: b.name, label: b.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [isAdmin, isHR, branches, visibleBranchesForUser]);

  const filteredAttendanceReports = useMemo(() => {
    let list = [...hierarchyFilteredAttendance];

    if (reportUserFilters.length > 0) list = list.filter(a => reportUserFilters.includes(a.username));
    if (reportBranchFilters.length > 0) list = list.filter(a => reportBranchFilters.includes(a.branch));

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
  }, [hierarchyFilteredAttendance, reportUserFilters, reportBranchFilters, reportStartDate, reportEndDate]);

  // Blocked Check-In/Check-Out attempts (location denied, or outside the branch's allowed radius),
  // filtered with the same Reports tab filters (user, branch, date range) as the attendance table above.
  const filteredLocationViolations = useMemo(() => {
    let list = [...hierarchyFilteredLocationViolations];

    if (reportUserFilters.length > 0) list = list.filter(v => reportUserFilters.includes(v.username));
    if (reportBranchFilters.length > 0) list = list.filter(v => reportBranchFilters.includes(v.branch));

    if (reportStartDate) {
      const start = new Date(reportStartDate).getTime();
      list = list.filter(v => {
        const time = v.createdAt?.toDate ? v.createdAt.toDate().getTime() : 0;
        return time >= start;
      });
    }

    if (reportEndDate) {
      const end = new Date(reportEndDate).setHours(23, 59, 59, 999);
      list = list.filter(v => {
        const time = v.createdAt?.toDate ? v.createdAt.toDate().getTime() : 0;
        return time <= end;
      });
    }

    return list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  }, [hierarchyFilteredLocationViolations, reportUserFilters, reportBranchFilters, reportStartDate, reportEndDate]);

  // Per-employee violation counts (denied vs out-of-range), for the summary table.
  const locationViolationSummary = useMemo(() => {
    const byUser = {};
    filteredLocationViolations.forEach((v) => {
      const key = v.username || 'Unknown';
      if (!byUser[key]) byUser[key] = { username: key, denied: 0, outOfRange: 0, total: 0 };
      if (v.reason === 'out_of_range') byUser[key].outOfRange += 1;
      else byUser[key].denied += 1; // 'denied' and 'unavailable' both count as a refused/failed location
      byUser[key].total += 1;
    });
    return Object.values(byUser).sort((a, b) => b.total - a.total);
  }, [filteredLocationViolations]);

  const pendingCeoRequestsForUser = useMemo(() => {
    let list = [...ceoRequests];
    if (isAdmin && showArchivedOnly) {
      list = list.filter(c => c.isArchived === true);
    } else {
      list = list.filter(c => !c.isArchived);
    }
    return list;
  }, [ceoRequests, isAdmin, showArchivedOnly]);

  // Today's sessions for the current user, newest first. After a check-out the employee can check in
  // again (same branch or another assigned one), so a day can hold several sessions.
  const todaySessions = useMemo(() => {
    const todayStr = toLocalYmd();
    const startedAt = (r) => (r.checkInTime?.toMillis ? r.checkInTime.toMillis() : Date.now());
    return attendanceRecords
      .filter(a => a.username === currentUserIdentifier && a.dateStr === todayStr)
      .sort((a, b) => startedAt(b) - startedAt(a));
  }, [attendanceRecords, currentUserIdentifier]);

  // the session that is still open (checked in, not checked out yet) - decides which button is available
  const openAttendance = todaySessions.find(a => !a.checkOutTime) || null;
  // the most recent session - shown in the status card
  const todayUserAttendance = todaySessions[0] || null;

  // The attendance roster (planned shifts) this account is allowed to read
  const attendancePlans = useAttendancePlans({
    enabled: !isFacilityManager && !isFacilityMember,
    role: userRole,
    userId: user?.id
  });

  // "My Sessions" list in the attendance portal: the employee's own check-ins, today or over the last 7 days
  const [showWeekSessions, setShowWeekSessions] = useState(false);

  const mySessionsList = useMemo(() => {
    const todayStr = toLocalYmd();
    const startedAt = (r) => (r.checkInTime?.toMillis ? r.checkInTime.toMillis() : Date.now());
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return attendanceRecords
      .filter(a => a.username === currentUserIdentifier && !a.isArchived)
      .filter(a => (showWeekSessions ? startedAt(a) >= weekAgo : a.dateStr === todayStr))
      .sort((a, b) => startedAt(b) - startedAt(a));
  }, [attendanceRecords, currentUserIdentifier, showWeekSessions]);

  // ---- Branch in the attendance portal ----
  //  * while a session is open the branch is LOCKED to the one used at check-in (check-out cannot change it)
  //  * with no open session (before the first check-in, or after a check-out) nothing is pre-selected:
  //    the list shows "Select Branch..." and the employee must choose the branch first
  useEffect(() => {
    setAttendanceBranch(openAttendance ? (openAttendance.branch || '') : '');
  }, [openAttendance?.id]);

  // ---- Checkout reminder ----
  const [checkoutReminder, setCheckoutReminder] = useState(null);

  // the employee's newest session that is still open (independent of the date, so a shift that
  // crosses midnight is still found)
  const myOpenSession = useMemo(() => {
    const startedAt = (r) => (r.checkInTime?.toMillis ? r.checkInTime.toMillis() : 0);
    return attendanceRecords
      .filter(a => a.username === currentUserIdentifier && !a.checkOutTime && !a.isArchived && startedAt(a) > 0)
      .sort((a, b) => startedAt(b) - startedAt(a))[0] || null;
  }, [attendanceRecords, currentUserIdentifier]);

  useEffect(() => {
    if (!myOpenSession) {
      setCheckoutReminder(null);
      return;
    }

    const checkInMs = myOpenSession.checkInTime.toMillis();
    const storageKey = `befit_checkout_reminder_${myOpenSession.id}`;

    const checkNow = () => {
      const elapsed = Date.now() - checkInMs;
      if (elapsed < CHECKOUT_REMINDER_AFTER_HOURS * 3600000) return;
      if (elapsed > 24 * 3600000) return; // an old forgotten session - do not nag about it

      let lastReminded = 0;
      try { lastReminded = Number(localStorage.getItem(storageKey)) || 0; } catch (e) { /* ignore */ }
      if (lastReminded) {
        if (!CHECKOUT_REMINDER_REPEAT_MINUTES) return; // single reminder mode
        if (Date.now() - lastReminded < CHECKOUT_REMINDER_REPEAT_MINUTES * 60000) return;
      }
      try { localStorage.setItem(storageKey, String(Date.now())); } catch (e) { /* ignore */ }

      const mins = Math.floor(elapsed / 60000);
      const elapsedText = `${Math.floor(mins / 60)}h ${mins % 60}m`;
      const branchName = myOpenSession.branch || 'your branch';

      setCheckoutReminder({ branch: branchName, elapsedText });

      try { if ('vibrate' in navigator) navigator.vibrate([500, 200, 500, 200, 500, 200, 500]); } catch (e) { /* ignore */ }
      try {
        const sound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        sound.play().catch(() => {});
      } catch (e) { /* ignore */ }
      showLocalNotification("⏰ Don't forget to check out", {
        body: `You have been checked in at ${branchName} for ${elapsedText}. If your shift is over, please check out.`,
        tag: 'checkout-reminder',
        renotify: true,
        requireInteraction: true,
        vibrate: [500, 200, 500, 200, 500, 200, 500]
      });
    };

    checkNow();
    const timer = setInterval(checkNow, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') checkNow(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkNow);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', checkNow);
    };
  }, [myOpenSession?.id]);

  const mySessionsCheckOuts = mySessionsList.filter(s => s.checkOutTime).length;
  const mySessionsTotalMin = mySessionsList.reduce((sum, s) => {
    const a = s.checkInTime?.toMillis ? s.checkInTime.toMillis() : null;
    const b = s.checkOutTime?.toMillis ? s.checkOutTime.toMillis() : null;
    return a != null && b != null && b >= a ? sum + Math.round((b - a) / 60000) : sum;
  }, 0);

  // EXPORT TO EXCEL FUNCTION
  const exportAttendanceToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Attendance Report');

    worksheet.columns = [
      { header: '#', key: 'id', width: 6 },
      { header: 'Employee', key: 'username', width: 22 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Check-In Date/Time', key: 'checkInTime', width: 25 },
      { header: 'Check-Out Date/Time', key: 'checkOutTime', width: 25 },
      { header: 'Status', key: 'status', width: 15 },
    ];

    worksheet.getRow(1).font = { bold: true };

    // A completed shift shorter than 7 hours (check-in -> check-out) gets its WHOLE row coloured red in
    // the export. A session that isn't checked out yet has no duration to judge, so it is left alone.
    const MIN_SHIFT_MS = 7 * 60 * 60 * 1000;
    const RED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    const RED_FONT = { color: { argb: 'FF9C0006' }, bold: true };

    filteredAttendanceReports.forEach((item, index) => {
      const row = worksheet.addRow({
        id: index + 1,
        username: item.username || 'N/A',
        branch: item.branch || 'N/A',
        checkInTime: formatDate(item.checkInTime),
        checkOutTime: formatDate(item.checkOutTime),
        status: item.status || 'N/A',
      });

      const inMs = item.checkInTime?.toMillis ? item.checkInTime.toMillis() : null;
      const outMs = item.checkOutTime?.toMillis ? item.checkOutTime.toMillis() : null;
      if (inMs != null && outMs != null && outMs >= inMs && (outMs - inMs) < MIN_SHIFT_MS) {
        for (let c = 1; c <= worksheet.columns.length; c++) {
          const cell = row.getCell(c);
          cell.fill = RED_FILL;
          cell.font = RED_FONT;
        }
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `Attendance_Report_${toLocalYmd()}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, fileName);
  };

  const exportLocationViolationsToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Location Violations');

    worksheet.columns = [
      { header: '#', key: 'id', width: 6 },
      { header: 'When', key: 'when', width: 22 },
      { header: 'Employee', key: 'username', width: 22 },
      { header: 'Branch', key: 'branch', width: 20 },
      { header: 'Mode', key: 'mode', width: 14 },
      { header: 'Reason', key: 'reason', width: 20 },
      { header: 'Distance (m)', key: 'distance', width: 14 },
      { header: 'Allowed Radius (m)', key: 'allowedRadius', width: 16 },
    ];

    worksheet.getRow(1).font = { bold: true };

    const reasonLabel = { denied: 'Location access denied', unavailable: 'Location unavailable', out_of_range: 'Outside allowed area' };

    filteredLocationViolations.forEach((v, index) => {
      worksheet.addRow({
        id: index + 1,
        when: v.createdAt?.toDate ? v.createdAt.toDate().toLocaleString() : '',
        username: v.username || 'N/A',
        branch: v.branch || 'N/A',
        mode: v.mode === 'checkin' ? 'Check-In' : 'Check-Out',
        reason: reasonLabel[v.reason] || v.reason || '',
        distance: v.distance ?? '',
        allowedRadius: v.allowedRadius ?? '',
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = `Location_Violations_${toLocalYmd()}.xlsx`;
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, fileName);
  };

  // Admin-only housekeeping for the Location Violations log (matches firestore.rules: delete is
  // Admin-only there too).
  const handleDeleteLocationViolation = async (violationId) => {
    if (!isAdmin) return;
    try {
      await deleteWithAudit('locationViolations', violationId);
    } catch (err) {
      alert('Error deleting entry: ' + err.message);
    }
  };

  const handleDeleteAllFilteredViolations = async () => {
    if (!isAdmin) return;
    if (filteredLocationViolations.length === 0) return;
    if (!window.confirm(`Delete all ${filteredLocationViolations.length} location violation entries currently shown (matching your filters)? This cannot be undone.`)) return;
    try {
      await Promise.all(filteredLocationViolations.map(v => deleteWithAudit('locationViolations', v.id)));
    } catch (err) {
      alert('Error deleting entries: ' + err.message);
    }
  };

  // Called from the Branch Checklist when someone flags an item as "not OK": switches to the real
  // Requests tab and pre-fills the actual "Create Maintenance Request" form (title, branch,
  // description) so they finish it there - with a live photo and a category - instead of a
  // bare-bones request being filed silently behind the scenes.
  const handleReportIssueFromChecklist = ({ branch, title: prefTitle, description: prefDescription, checklistRef }) => {
    // Remember which checklist cell this request is for; the cell is marked only when the request is submitted.
    pendingChecklistRef.current = checklistRef ? { ...checklistRef, title: prefTitle || '' } : null;
    setActiveTab('requests');
    setMaintView('list');
    setTitle(prefTitle || '');
    setDescription(prefDescription || '');
    setSelectedBranch(branch || '');
    setSelectedCategory('');
    setImageFile(null);
    setImagePreview(null);
    setNoImageChecked(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const pendingChecklistRef = useRef(null);
  // The link to a checklist cell only lives while the person stays on the request form it opened:
  // leaving the Requests tab drops it, so a later, unrelated request can never get tied to that cell.
  useEffect(() => {
    if (activeTab !== 'requests') pendingChecklistRef.current = null;
  }, [activeTab]);

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

      const createdReq = await addDoc(collection(db, 'requests'), {
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

      // If this request came from the Checklist's "report a problem", NOW (and only now) mark that
      // checklist cell as having a maintenance request. Best-effort: the request itself is already saved.
      const clRef = pendingChecklistRef.current;
      if (clRef && clRef.branch === selectedBranch) {
        try {
          await setDoc(doc(db, 'branchChecklists', clRef.docId), {
            branch: clRef.branch,
            dateStr: clRef.dateStr,
            checks: {
              [`${clRef.slot}__${clRef.itemId}`]: {
                checked: false, issue: true, na: false, notCompleted: false,
                issueNote: clRef.note || '', requestId: createdReq.id,
                by: currentUserIdentifier, at: serverTimestamp()
              }
            },
            lastUpdatedBy: currentUserIdentifier,
            lastUpdatedAt: serverTimestamp()
          }, { merge: true });
        } catch (markErr) { console.warn('Could not mark checklist cell:', markErr); }
      }
      pendingChecklistRef.current = null;

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

  // Update: mandatory screen to change the default password on first login - blocks the rest of the app until completed
  if (mustChangePassword) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4" dir="ltr">
        <div className="bg-white border border-slate-200 rounded-3xl shadow-lg p-8 w-full max-w-sm space-y-5">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-indigo-600 flex items-center justify-center text-2xl">🔑</div>
            <h2 className="text-lg font-bold text-slate-900">You Must Change Your Password</h2>
            <p className="text-xs text-slate-500">
              This is your first login. Please choose a new password before continuing to use the app.
            </p>
          </div>
          <form onSubmit={handleForcedPasswordChange} className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">New Password</label>
              <input 
                type="text" 
                value={forcedNewPassword} 
                onChange={(e) => setForcedNewPassword(e.target.value)} 
                required 
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">Confirm Password</label>
              <input 
                type="text" 
                value={forcedConfirmPassword} 
                onChange={(e) => setForcedConfirmPassword(e.target.value)} 
                required 
                className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs"
              />
            </div>
            <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 rounded-xl text-xs transition-all">
              Update Password &amp; Continue
            </button>
          </form>
        </div>
      </div>
    );
  }

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

            {/* Friendly selfie rules, shown only for attendance photos (inline colors so they always render) */}
            {(cameraMode === 'checkin' || cameraMode === 'checkout') && (
              <div
                className="rounded-2xl p-3 text-left space-y-1.5"
                style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', color: '#78350f' }}
              >
                <p className="text-xs font-black">
                  {cameraMode === 'checkin'
                    ? '📸 Say cheese! Your check-in selfie is on its way'
                    : '🏁 Shift wrapped? Time for the checkout selfie!'}
                </p>
                <p className="text-[11px] font-bold" style={{ color: '#7c2d12' }}>
                  🔒 Privacy notice: this photo can only be viewed by HR, the System Admin and Branch Managers, and only when strictly necessary. It is deleted automatically after 60 days.
                </p>
                <ul className="text-[11px] font-semibold space-y-1">
                  <li>😄 Face front and center, in good light. Shadows, masks and ninja mode stay home!</li>
                  <li>🏋️ Let the branch landmarks photobomb you: the logo, sign, reception or gym floor.</li>
                  <li>
                    📍 {cameraMode === 'checkin'
                      ? <>Prove you're really at <strong>{attendanceBranch || 'your branch'}</strong> - a selfie from the couch doesn't count!</>
                      : <>Prove you're still at <strong>{attendanceBranch || 'your branch'}</strong>, not halfway home!</>}
                  </li>
                </ul>
              </div>
            )}

            <div className="relative bg-black rounded-2xl overflow-hidden aspect-video flex items-center justify-center">
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                className="w-full h-full object-cover" 
                style={(cameraMode === 'checkin' || cameraMode === 'checkout') ? { transform: 'scaleX(-1)' } : undefined}
              />
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
              <h3 className="font-bold text-slate-900 text-sm">
                {assignTargetStatus === 'Completed' ? 'Who did this task? (Completed)' : 'Assign Request (In Progress)'}
              </h3>
              <button onClick={() => setAssignModalReq(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <p className="text-xs text-slate-600">
              {assignTargetStatus === 'Completed'
                ? <>Nobody was assigned to this request. Select the <strong>Facility Member</strong> or <strong>Facility Manager</strong> who carried it out:</>
                : <>Select a <strong>Facility Member</strong> or <strong>Facility Manager</strong> to handle this issue:</>}
            </p>
            <div className="space-y-3">
              <select
                value={selectedAssigneeId}
                onChange={(e) => setSelectedAssigneeId(e.target.value)}
                className="w-full p-3 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
              >
                <option value="" className="bg-white text-slate-900">-- Select who is in charge --</option>
                {taskAssignees.map(m => (
                  <option key={m.id} value={m.id} className="bg-white text-slate-900">
                    {m.username} - {m.role} ({m.phone || 'No Phone'})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setAssignModalReq(null)} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold">Cancel</button>
              <button onClick={handleConfirmAssignment} className="px-4 py-2 bg-amber-500 text-slate-900 font-extrabold rounded-xl text-xs shadow-md">{assignTargetStatus === 'Completed' ? 'Confirm' : 'Confirm & Assign'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Admin-only: force a check-out for someone who forgot. Date is fixed to their own
          check-in day (shown read-only) - only the time is picked. */}
      {forceCheckoutRec && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Force Check-Out</h3>
              <button onClick={() => setForceCheckoutRec(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <p className="text-xs text-slate-600">
              For <strong>{forceCheckoutRec.username}</strong>, who checked in at <strong>{forceCheckoutRec.branch}</strong> and never checked out.
              This only sets a check-out time on the <strong>same day</strong> they checked in ({forceCheckoutRec.checkInTime?.toDate ? forceCheckoutRec.checkInTime.toDate().toLocaleDateString() : ''}) — the date itself cannot be changed.
            </p>
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">Check-out time</label>
              <input
                type="time"
                value={forceCheckoutTime}
                onChange={(e) => setForceCheckoutTime(e.target.value)}
                className="w-full p-3 bg-white text-slate-900 border border-slate-200 rounded-xl text-sm font-bold"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setForceCheckoutRec(null)} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold">Cancel</button>
              <button onClick={handleConfirmForceCheckout} className="px-4 py-2 font-extrabold rounded-xl text-xs shadow-md border-0" style={{ backgroundColor: '#0284c7', color: '#ffffff' }}>Confirm Check-Out</button>
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
          {canSeeTowels && (
            <button
              onClick={() => setActiveTab('towels')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'towels' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              🧺 Towels
            </button>
          )}

          <button 
            onClick={() => setActiveTab('requests')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'requests' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            🛠️ Maintenance
          </button>

          {canSeeAttendance && (
              <button
                onClick={() => setActiveTab('attendance')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'attendance' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
              >
                🕒 Attendance
              </button>
          )}

          {(canSeeSchedule || canSeeCeoServices) && (
            <>

              {canSeeSchedule && (
                <button 
                  onClick={() => setActiveTab('schedule')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'schedule' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                >
                  📅 Schedule
                </button>
              )}

              {canSeeCeoServices && (
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
              )}
            </>
          )}

          {canViewReports && (
            <button 
              onClick={() => setActiveTab('reports')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'reports' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              📊 Reports
            </button>
          )}

          <button
            onClick={() => setActiveTab('integrity')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'integrity' ? 'bg-white text-rose-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            🚩 Report a Concern
          </button>

          {canSeeChecklist && (
            <button
              onClick={() => setActiveTab('checklist')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'checklist' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              ✅ Checklist
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
              onClick={() => setActiveTab('auditLog')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'auditLog' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              🕵️ Audit Log
            </button>
          )}

          {isAdmin && (
            <button
              onClick={() => setActiveTab('permissions')}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === 'permissions' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              🔑 Permissions
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

        <div className="flex items-center gap-2">
          <button
            onClick={openLogsPanel}
            title="Activity notifications"
            className="relative bg-slate-100 hover:bg-indigo-600 hover:text-white border border-slate-300 text-slate-700 rounded-2xl text-base shadow-sm transition-all cursor-pointer flex items-center justify-center"
            style={{ width: 40, height: 40 }}
          >
            🔔
            {unreadLogsCount > 0 && (
              <span
                className="absolute rounded-full text-[10px] font-black flex items-center justify-center"
                style={{ top: -6, right: -6, minWidth: 18, height: 18, padding: '0 4px', backgroundColor: '#e11d48', color: '#ffffff', border: '2px solid #ffffff' }}
              >
                {unreadLogsCount > 99 ? '99+' : unreadLogsCount}
              </span>
            )}
          </button>
          <button 
            onClick={() => setShowSelfPasswordModal(true)} 
            className="bg-slate-100 hover:bg-indigo-600 hover:text-white border border-slate-300 text-slate-700 px-4 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-sm cursor-pointer"
          >
            🔑 Change Password
          </button>
          <button onClick={handleLogoutClick} className="bg-slate-100 hover:bg-rose-600 hover:text-white border border-slate-300 text-slate-700 px-5 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-sm cursor-pointer">
            Logout
          </button>
        </div>
      </header>

      {/* TAB 0: TOWEL MANAGEMENT */}
      {activeTab === 'towels' && canSeeTowels && (
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
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            
            {maintView === 'report' && canSeeMaintReport && (
              <MaintenanceReport
                requests={maintReportRequests}
                usersList={usersList}
                branches={maintReportBranches}
                onBack={() => setMaintView('list')}
              />
            )}

            <div
              className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4"
              style={{ display: maintView === 'report' && canSeeMaintReport ? 'none' : undefined }}
            >
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold">Requests List</h2>
                  {canSeeMaintReport && (
                    <button
                      onClick={() => setMaintView('report')}
                      className="px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-600 hover:text-white"
                    >
                      📊 Who did what
                    </button>
                  )}
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
                
                <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 w-full sm:w-auto">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full sm:w-auto p-2.5 sm:p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="All" className="bg-white text-slate-900">All Statuses</option>
                    <option value="New" className="bg-white text-slate-900">New</option>
                    <option value="Pending" className="bg-white text-slate-900">Pending</option>
                    <option value="In Progress" className="bg-white text-slate-900">In Progress</option>
                    <option value="Not Applicable" className="bg-white text-slate-900">Not Applicable</option>
                    <option value="Delayed" className="bg-white text-slate-900">Delayed</option>
                    <option value="Completed Under Testing" className="bg-white text-slate-900">Completed Under Testing</option>
                    <option value="Completed" className="bg-white text-slate-900">Completed</option>
                  </select>

                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="w-full sm:w-auto p-2.5 sm:p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="All" className="bg-white text-slate-900">All Categories</option>
                    {[...categories].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(c => (
                      <option key={c.id} value={c.name} className="bg-white text-slate-900">{c.name}</option>
                    ))}
                  </select>

                  <select
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    className="w-full sm:w-auto p-2.5 sm:p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="All" className="bg-white text-slate-900">All Branches</option>
                    {branches.map(b => (
                      <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>
                    ))}
                  </select>

                  {!isStaff && (
                    <div className="col-span-2 sm:col-auto" style={{ minWidth: 190 }}>
                      <MultiSelectFilter
                        options={assigneeFilterOptions}
                        selected={assigneeFilters}
                        onChange={setAssigneeFilters}
                        allLabel="All Assignees"
                        noun="people"
                      />
                    </div>
                  )}

                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    className="w-full sm:w-auto p-2.5 sm:p-2 bg-white text-slate-900 border rounded-xl text-xs font-semibold focus:outline-none"
                  >
                    <option value="desc" className="bg-white text-slate-900">Newest First</option>
                    <option value="asc" className="bg-white text-slate-900">Oldest First</option>
                  </select>
                </div>
              </div>

              {isAdmin && filteredRequests.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-100 border rounded-2xl text-xs font-bold">
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
                    <div key={req.id} className="p-4 border rounded-2xl hover:shadow-sm transition bg-white space-y-3">
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
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
                          {req.requestNumber && (
                            <p className="text-[10px] font-mono font-bold text-indigo-600 mb-0.5" title="Request number: branch code · year · month · day · yearly sequence · random">
                              # {req.requestNumber}
                            </p>
                          )}
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

                      <div className="flex flex-wrap items-center gap-2 w-full md:w-auto md:justify-end">
                        {canManageStatus ? (
                          <select
                            value={req.status || 'New'}
                            onChange={(e) => handleUpdateStatus(req, e.target.value)}
                            style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}
                            className="flex-1 min-w-[140px] md:flex-none text-xs font-bold px-3 py-2 md:py-1.5 rounded-xl border-0 cursor-pointer shadow-sm focus:outline-none"
                          >
                            <option value="New" className="bg-white text-slate-900">New</option>
                            <option value="Pending" className="bg-white text-slate-900">Pending</option>
                            <option value="In Progress" className="bg-white text-slate-900">In Progress</option>
                            <option value="Not Applicable" className="bg-white text-slate-900">Not Applicable</option>
                            <option value="Delayed" className="bg-white text-slate-900">Delayed</option>
                            <option value="Completed Under Testing" className="bg-white text-slate-900">Completed Under Testing</option>
                            <option value="Completed" className="bg-white text-slate-900">Completed</option>
                          </select>
                        ) : (
                          <span className="px-3 py-1 text-xs font-bold text-white rounded-xl" style={{ backgroundColor: statusStyle.bg, color: statusStyle.color }}>
                            {req.status || 'New'}
                          </span>
                        )}

                        {/* Admin can Buzz any request; a Branch Manager can only Buzz a request from their own branch */}
                        {(isAdmin || (isBranchManager && assignedBranches.includes(req.branch))) && (
                          <button
                            onClick={() => handleBuzzRequest(req.id)}
                            className="px-2.5 py-2 md:py-1.5 rounded-xl text-xs font-extrabold shadow-sm cursor-pointer border-0"
                            style={{ backgroundColor: '#0284c7', color: '#ffffff' }}
                            title="Alert every Facility Manager and Facility Member about this request, regardless of status"
                          >
                            Buzz 🔔
                          </button>
                        )}

                        {isAdmin && (
                          <>
                            <button
                              onClick={() => handleArchiveReq(req.id, req.isArchived)}
                              className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-2.5 py-2 md:py-1.5 rounded-xl text-xs font-extrabold shadow-sm cursor-pointer"
                              title="Archive Request"
                            >
                              {req.isArchived ? 'Unarchive' : 'Archive 📁'}
                            </button>

                            <button
                              onClick={() => handleDeleteRequest(req.id)}
                              className="bg-rose-600 hover:bg-rose-700 text-white font-black px-3 py-2 md:py-1.5 rounded-xl text-xs shadow-md cursor-pointer border-0"
                              style={{ backgroundColor: '#e11d48', color: '#ffffff' }}
                            >
                              DELETE
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {(req.assignedTo || req.actionTaken || canEditActionTaken(req) || req.notes || canEditNotes()) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-slate-100">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">🔧 Action Taken</label>
                          {canEditActionTaken(req) ? (
                            <div className="space-y-1">
                              <textarea
                                value={getActionTakenValue(req)}
                                onChange={(e) => setActionTakenDrafts(prev => ({ ...prev, [req.id]: e.target.value }))}
                                rows={2}
                                placeholder="Describe what was done to resolve this..."
                                className="w-full p-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                              />
                              {actionTakenDrafts[req.id] !== undefined && actionTakenDrafts[req.id] !== (req.actionTaken || '') && (
                                <button
                                  onClick={() => handleSaveActionTaken(req)}
                                  className="text-[11px] font-black text-indigo-600 hover:text-indigo-800 cursor-pointer"
                                >
                                  💾 Save
                                </button>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-600 italic">{req.actionTaken || 'Nothing recorded yet.'}</p>
                          )}
                        </div>

                        <div>
                          <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">📝 Notes (Facility Manager)</label>
                          {canEditNotes() ? (
                            <div className="space-y-1">
                              <textarea
                                value={getNotesValue(req)}
                                onChange={(e) => setNotesDrafts(prev => ({ ...prev, [req.id]: e.target.value }))}
                                rows={2}
                                placeholder="Manager notes / follow-up..."
                                className="w-full p-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                              />
                              {notesDrafts[req.id] !== undefined && notesDrafts[req.id] !== (req.notes || '') && (
                                <button
                                  onClick={() => handleSaveNotes(req)}
                                  className="text-[11px] font-black text-indigo-600 hover:text-indigo-800 cursor-pointer"
                                >
                                  💾 Save
                                </button>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-600 italic">{req.notes || 'No notes yet.'}</p>
                          )}
                        </div>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* TAB 2: ATTENDANCE */}
      {activeTab === 'attendance' && canSeeAttendance && (
        <div className="space-y-6">
          <div className="max-w-xl mx-auto bg-white border border-slate-200 p-8 rounded-3xl shadow-sm space-y-6 text-center">
            <div className="space-y-2">
              <h2 className="text-2xl font-black text-slate-900">Live Attendance Portal</h2>
              <p className="text-xs text-slate-500">Record your daily Check-In and Check-Out with live photo capture.</p>
            </div>

            {attendanceLoadError && (
              <div className="text-left bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-1">
                <p className="text-xs font-bold text-rose-700">⚠️ Could not load your attendance history.</p>
                <p className="text-[11px] text-rose-600">
                  Your Check-In / Check-Out buttons may not reflect a session that's already open. Please tell Admin
                  and try again shortly. (Error: {attendanceLoadError})
                </p>
              </div>
            )}

            {openAttendance ? (
              <div className="text-left bg-emerald-50 p-4 rounded-2xl border border-emerald-200 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider">You are checked in at</p>
                  <p className="text-base font-black text-slate-900">📍 {openAttendance.branch}</p>
                </div>
                <span className="text-[11px] font-bold text-slate-500 text-right">Check-out closes this session<br />at the same branch</span>
              </div>
            ) : (
              <div className="text-left bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <label className="block text-xs font-bold text-slate-700 mb-1">Select Branch for Attendance</label>
                <select
                  value={attendanceBranch}
                  onChange={(e) => setAttendanceBranch(e.target.value)}
                  className="w-full p-3 bg-white border border-slate-300 rounded-xl text-xs font-bold text-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  <option value="" disabled className="bg-white text-slate-900">Select Branch...</option>
                  {visibleBranchesForUser.map(b => (
                    <option key={b.id} value={b.name} className="bg-white text-slate-900">{b.name}</option>
                  ))}
                </select>
              </div>
            )}

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

            {isCheckingLocation && (
              <div className="flex items-center justify-center gap-2 p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl text-xs font-bold text-indigo-700">
                📍 Confirming your location...
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 pt-4">
              <button
                disabled={loading || isCheckingLocation || !!openAttendance}
                onClick={() => startLiveCamera('checkin')}
                className={`p-6 rounded-2xl font-black text-sm flex flex-col items-center gap-2 shadow-md transition-all ${
                  openAttendance || isCheckingLocation
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95'
                }`}
              >
                <span className="text-3xl">🟢</span>
                <span>CHECK IN</span>
                <span className="text-[10px] font-normal opacity-80">(Requires Live Photo)</span>
              </button>

              <button
                disabled={loading || isCheckingLocation || !openAttendance}
                onClick={() => startLiveCamera('checkout')}
                className={`p-6 rounded-2xl font-black text-sm flex flex-col items-center gap-2 shadow-md transition-all ${
                  !openAttendance || isCheckingLocation
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-rose-600 hover:bg-rose-700 text-white active:scale-95'
                }`}
              >
                <span className="text-3xl">🔴</span>
                <span>CHECK OUT</span>
                <span className="text-[10px] font-normal opacity-80">(Requires Live Photo)</span>
              </button>
            </div>

            <MyScheduleCard plans={attendancePlans} userId={user?.id} />

            {/* My sessions: how many times, when and where */}
            <div className="text-left space-y-3 pt-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-black text-slate-900">My Sessions</h3>
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                  <button
                    type="button"
                    onClick={() => setShowWeekSessions(false)}
                    className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-all ${!showWeekSessions ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowWeekSessions(true)}
                    className={`px-3 py-1 rounded-lg text-[11px] font-bold transition-all ${showWeekSessions ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}
                  >
                    Last 7 days
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-[11px] font-bold">
                <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Check-ins: {mySessionsList.length}</span>
                <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200">Check-outs: {mySessionsCheckOuts}</span>
                {mySessionsTotalMin > 0 && (
                  <span className="px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                    Total time: {Math.floor(mySessionsTotalMin / 60)}h {mySessionsTotalMin % 60}m
                  </span>
                )}
              </div>

              {mySessionsList.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No sessions recorded {showWeekSessions ? 'in the last 7 days' : 'today'}.</p>
              ) : (
                <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: 340 }}>
                  {mySessionsList.map((s) => (
                    <div key={s.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-black text-slate-800">📍 {s.branch}</span>
                        {s.checkOutTime ? (
                          <span className="text-slate-500 font-bold">{formatDuration(s.checkInTime, s.checkOutTime)}</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-black text-[10px]">Still checked in</span>
                        )}
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400 font-semibold">Check-In</span>
                        <span className="text-emerald-700 font-bold">{formatDate(s.checkInTime)}</span>
                      </div>
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-400 font-semibold">Check-Out</span>
                        <span className="text-rose-700 font-bold">{s.checkOutTime ? formatDate(s.checkOutTime) : '--:--'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Leave Requests: submit + (for managers) review */}
          <div className="max-w-xl mx-auto bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">🗓️ Request Leave</h2>
            <form onSubmit={handleCreateLeaveRequest} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">From</label>
                  <input
                    type="date"
                    required
                    value={leaveStartDate}
                    onChange={(e) => setLeaveStartDate(e.target.value)}
                    className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">To</label>
                  <input
                    type="date"
                    required
                    value={leaveEndDate}
                    onChange={(e) => setLeaveEndDate(e.target.value)}
                    className="w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-bold"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Reason (optional)</label>
                <textarea
                  value={leaveReason}
                  onChange={(e) => setLeaveReason(e.target.value)}
                  placeholder="e.g. Family occasion, medical appointment..."
                  rows={2}
                  className="w-full p-2.5 bg-slate-50 text-slate-900 border border-slate-200 rounded-xl text-xs font-semibold"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-black py-2.5 rounded-xl text-sm shadow-md transition cursor-pointer"
              >
                {loading ? 'Submitting...' : 'Submit Leave Request'}
              </button>
            </form>

            {myLeaveRequests.length > 0 && (
              <div className="pt-3 border-t space-y-2">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">My Leave Requests</p>
                {myLeaveRequests.map((r) => {
                  const badge = r.status === 'Approved'
                    ? { bg: '#059669', label: 'Approved' }
                    : r.status === 'Rejected'
                    ? { bg: '#e11d48', label: 'Rejected' }
                    : { bg: '#f59e0b', label: 'Pending' };
                  return (
                    <div key={r.id} className="flex items-center justify-between gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                      <div>
                        <p className="font-bold text-slate-800">{r.startDate} → {r.endDate}</p>
                        {r.reason && <p className="text-slate-500 mt-0.5">{r.reason}</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-black text-white" style={{ backgroundColor: badge.bg }}>
                          {badge.label}
                        </span>
                        {r.status === 'Pending' && (
                          <button
                            onClick={() => handleDeleteLeaveRequest(r.id)}
                            title="Cancel request"
                            className="text-rose-500 hover:text-rose-700 font-bold"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {canViewLeaveQueue && (() => {
            const pendingCount = leaveRequestsForApproval.filter(r => r.status === 'Pending' && !r.isArchived).length;
            const visibleLeaveRequests = isAdmin
              ? leaveRequestsForApproval
                  .filter(r => (showArchivedOnly ? r.isArchived === true : !r.isArchived))
                  .slice()
                  .sort((a, b) => (a.status === 'Pending' ? -1 : 1) - (b.status === 'Pending' ? -1 : 1))
              : canApproveLeave
              ? leaveRequestsForApproval.filter(r => r.status === 'Pending' && !r.isArchived)
              // Supervisor (view only): every non-archived leave of their branches, pending ones first
              : leaveRequestsForApproval
                  .filter(r => !r.isArchived)
                  .slice()
                  .sort((a, b) => (a.status === 'Pending' ? -1 : 1) - (b.status === 'Pending' ? -1 : 1));

            return (
              <div className="max-w-xl mx-auto bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-lg font-black text-slate-900 flex items-center gap-2">
                    📋 {isAdmin ? 'Leave Requests' : canApproveLeave ? 'Leave Requests Awaiting Approval' : 'Branch Leave Requests (view only)'}
                    {pendingCount > 0 && (
                      <span className="bg-rose-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full">
                        {pendingCount}
                      </span>
                    )}
                  </h2>
                  {isAdmin && (
                    <button
                      onClick={() => setShowArchivedOnly(!showArchivedOnly)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-black border transition ${
                        showArchivedOnly ? 'bg-amber-500 text-slate-900 border-amber-600' : 'bg-slate-100 text-slate-700 border-slate-200'
                      }`}
                    >
                      {showArchivedOnly ? '📂 Viewing Archived' : '📁 Show Archived'}
                    </button>
                  )}
                </div>
                {visibleLeaveRequests.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">
                    {showArchivedOnly && isAdmin ? 'No archived leave requests.' : canApproveLeave ? 'No pending leave requests.' : 'No leave requests for your branches.'}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {visibleLeaveRequests.map((r) => {
                      const badge = r.status === 'Approved'
                        ? { bg: '#059669', label: 'Approved' }
                        : r.status === 'Rejected'
                        ? { bg: '#e11d48', label: 'Rejected' }
                        : { bg: '#f59e0b', label: 'Pending' };
                      return (
                        <div key={r.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-black text-slate-800">👤 {r.username}</span>
                            <span className="text-slate-500 font-bold">{r.startDate} → {r.endDate}</span>
                          </div>
                          {r.reason && <p className="text-slate-500">{r.reason}</p>}
                          <div className="flex items-center justify-between gap-2">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-black text-white" style={{ backgroundColor: badge.bg }}>
                              {badge.label}
                            </span>
                            <div className="flex gap-2 justify-end">
                              {r.status === 'Pending' && canApproveLeave && (
                                <>
                                  <button
                                    onClick={() => handleLeaveDecision(r.id, 'Rejected')}
                                    className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-rose-100 text-rose-700 border border-rose-300 hover:bg-rose-200 transition"
                                  >
                                    Reject
                                  </button>
                                  <button
                                    onClick={() => handleLeaveDecision(r.id, 'Approved')}
                                    className="px-3 py-1.5 rounded-xl text-[11px] font-black bg-emerald-100 text-emerald-700 border border-emerald-300 hover:bg-emerald-200 transition"
                                  >
                                    Approve
                                  </button>
                                </>
                              )}
                              {isAdmin && (
                                <>
                                  <button
                                    onClick={() => handleArchiveLeaveRequest(r.id, r.isArchived)}
                                    className="bg-amber-500 hover:bg-amber-600 text-slate-900 px-2.5 py-1.5 rounded-xl text-[11px] font-extrabold shadow-sm cursor-pointer"
                                    title="Archive Request"
                                  >
                                    {r.isArchived ? 'Unarchive' : 'Archive 📁'}
                                  </button>
                                  <button
                                    onClick={() => handleDeleteLeaveRequest(r.id)}
                                    className="bg-rose-600 hover:bg-rose-700 text-white font-black px-3 py-1.5 rounded-xl text-[11px] shadow-md cursor-pointer border-0"
                                  >
                                    DELETE
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* TAB: SCHEDULE (planned shifts + plan vs actual) */}
      {activeTab === 'schedule' && canSeeSchedule && (
        <SchedulePlanner
          user={user}
          usersList={usersList}
          branches={branches}
          attendanceRecords={attendanceRecords}
          plans={attendancePlans}
        />
      )}

      {/* TAB 3: CEO SERVICES */}
      {activeTab === 'ceo_services' && canSeeCeoServices && (
        <div className="space-y-6">
          {(isCEO || isAdmin) && (
            <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm">
              <h2 className="text-md font-bold text-slate-900 mb-4 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#0f172a' }}></span> Overview
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-center">
                  <p className="text-2xl font-black text-emerald-700">{currentlyPresentUsers.length}</p>
                  <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wide mt-1">Present Now</p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
                  <p className="text-2xl font-black text-amber-700">
                    {requests.filter(r => !['Completed', 'False Report'].includes(r.status || 'New') && !r.isArchived).length}
                  </p>
                  <p className="text-[11px] font-bold text-amber-700 uppercase tracking-wide mt-1">Open Maintenance</p>
                </div>
                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 text-center">
                  <p className="text-2xl font-black text-indigo-700">
                    {ceoRequests.filter(r => (r.status || 'Pending') === 'Pending').length}
                  </p>
                  <p className="text-[11px] font-bold text-indigo-700 uppercase tracking-wide mt-1">Pending CEO Requests</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center">
                  <p className="text-2xl font-black text-slate-700">{branches.length}</p>
                  <p className="text-[11px] font-bold text-slate-700 uppercase tracking-wide mt-1">Branches</p>
                </div>
              </div>
            </div>
          )}
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

                      {/* Admin can Buzz any CEO request; a Branch Manager can only Buzz one targeting their own branch */}
                      {(isAdmin || (isBranchManager && assignedBranches.includes(cReq.targetBranch))) && (
                        <button
                          onClick={() => handleBuzzCeoRequest(cReq.id)}
                          className="px-2.5 py-1.5 rounded-xl text-xs font-extrabold shadow-sm border-0"
                          style={{ backgroundColor: '#0284c7', color: '#ffffff' }}
                          title="Alert whoever is checked in at this branch that this request needs an urgent response"
                        >
                          Buzz 🔔
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
        </div>
      )}

      {/* TAB 4: REPORTS */}
      {activeTab === 'reports' && canViewReports && (
        <>
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
              <MultiSelectFilter
                options={reportUserOptions}
                selected={reportUserFilters}
                onChange={setReportUserFilters}
                allLabel="All Users"
                noun="users"
              />
            </div>
            <div>
              <label className="block text-[10px] font-extrabold uppercase text-slate-500 mb-1">Branch Filter</label>
              <MultiSelectFilter
                options={reportBranchOptions}
                selected={reportBranchFilters}
                onChange={setReportBranchFilters}
                allLabel="All Branches"
                noun="branches"
              />
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
                      {(rec.checkInPhoto || (rec.photosPrivate && !rec.photosPurgedAt)) && (
                        canViewAttendancePhotos ? (
                          <button
                            type="button"
                            onClick={() => openAttendancePhoto(rec, 'in')}
                            className="px-2 py-1 rounded text-[10px] font-extrabold border-0 cursor-pointer"
                            style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}
                            title="View check-in photo (only when necessary)"
                          >
                            🖼️ View
                          </button>
                        ) : (
                          <span className="text-slate-300 text-[10px]" title="Only HR, Admin and Branch Managers can view attendance photos">🔒</span>
                        )
                      )}
                    </td>
                    <td className="p-2.5 text-rose-700 font-bold">{formatDate(rec.checkOutTime)}</td>
                    <td className="p-2.5 print:hidden">
                      {rec.checkOutTime && (rec.checkOutPhoto || (rec.photosPrivate && !rec.photosPurgedAt)) && (
                        canViewAttendancePhotos ? (
                          <button
                            type="button"
                            onClick={() => openAttendancePhoto(rec, 'out')}
                            className="px-2 py-1 rounded text-[10px] font-extrabold border-0 cursor-pointer"
                            style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}
                            title="View check-out photo (only when necessary)"
                          >
                            🖼️ View
                          </button>
                        ) : (
                          <span className="text-slate-300 text-[10px]" title="Only HR, Admin and Branch Managers can view attendance photos">🔒</span>
                        )
                      )}
                    </td>
                    <td className="p-2.5"><span className="px-2 py-0.5 rounded font-black text-[9px] uppercase bg-emerald-100 text-emerald-800">{rec.status}</span></td>
                    {isAdmin && (
                      <td className="p-2.5 print:hidden space-x-1">
                        {!rec.checkOutTime && (
                          <button
                            onClick={() => openForceCheckout(rec)}
                            className="px-2 py-1 rounded text-[10px] font-extrabold border-0"
                            style={{ backgroundColor: '#0284c7', color: '#ffffff' }}
                            title="For someone who forgot to check out: sets a check-out time on their own check-in day"
                          >
                            Force Check-Out
                          </button>
                        )}

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

        {/* LOCATION VIOLATIONS: how many times each employee tried to Check-In/Check-Out while
            either refusing to share their location, or while physically outside the branch's
            allowed GPS radius. Uses the same date/user/branch filters as the attendance table above. */}
        <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4 mt-6 print:hidden">
          <div className="flex flex-col md:flex-row justify-between md:items-center gap-3">
            <div>
              <h2 className="text-lg font-black text-slate-900 tracking-tight">LOCATION VIOLATIONS</h2>
              <p className="text-xs text-slate-500">
                Blocked Check-In/Check-Out attempts — location access denied, or the employee was outside the branch's allowed radius.
              </p>
            </div>

            {filteredLocationViolations.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={exportLocationViolationsToExcel}
                  style={{ backgroundColor: '#059669', color: '#ffffff' }}
                  className="hover:opacity-90 active:scale-95 px-3 py-2 rounded-xl text-xs font-black shadow-md transition border-0 cursor-pointer"
                >
                  EXPORT EXCEL
                </button>
                {isAdmin && (
                  <button
                    onClick={handleDeleteAllFilteredViolations}
                    className="bg-rose-600 hover:bg-rose-700 text-white px-3 py-2 rounded-xl text-xs font-black shadow-md transition cursor-pointer"
                  >
                    Delete All ({filteredLocationViolations.length})
                  </button>
                )}
              </div>
            )}
          </div>

          {locationViolationSummary.length === 0 ? (
            <p className="text-sm text-slate-400 italic py-2">No location violations in the selected range. 🎉</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold">
                      <th className="p-2.5">Employee</th>
                      <th className="p-2.5">Denied / Unavailable</th>
                      <th className="p-2.5">Outside Range</th>
                      <th className="p-2.5">Total Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locationViolationSummary.map((row) => (
                      <tr key={row.username} className="border-b border-slate-100">
                        <td className="p-2.5 font-bold text-slate-800">{row.username}</td>
                        <td className="p-2.5">{row.denied}</td>
                        <td className="p-2.5">{row.outOfRange}</td>
                        <td className="p-2.5 font-black text-rose-600">{row.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <details className="pt-2">
                <summary className="text-xs font-bold text-slate-500 cursor-pointer select-none">
                  Show individual attempts ({filteredLocationViolations.length})
                </summary>
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 uppercase font-bold">
                        <th className="p-2">When</th>
                        <th className="p-2">Employee</th>
                        <th className="p-2">Branch</th>
                        <th className="p-2">Mode</th>
                        <th className="p-2">Reason</th>
                        <th className="p-2">Distance</th>
                        {isAdmin && <th className="p-2">Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLocationViolations.map((v) => (
                        <tr key={v.id} className="border-b border-slate-100">
                          <td className="p-2 whitespace-nowrap">
                            {v.createdAt?.toDate ? v.createdAt.toDate().toLocaleString() : '-'}
                          </td>
                          <td className="p-2 font-semibold text-slate-800">{v.username}</td>
                          <td className="p-2">{v.branch || '-'}</td>
                          <td className="p-2 capitalize">{v.mode === 'checkin' ? 'Check-In' : 'Check-Out'}</td>
                          <td className="p-2">
                            {v.reason === 'out_of_range' && <span className="text-amber-700 font-bold">Outside allowed area</span>}
                            {v.reason === 'denied' && <span className="text-rose-600 font-bold">Location access denied</span>}
                            {v.reason === 'unavailable' && <span className="text-slate-500 font-bold">Location unavailable</span>}
                          </td>
                          <td className="p-2">
                            {v.reason === 'out_of_range' ? `~${v.distance}m (limit ${v.allowedRadius}m)` : '-'}
                          </td>
                          {isAdmin && (
                            <td className="p-2">
                              <button
                                onClick={() => handleDeleteLocationViolation(v.id)}
                                className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-bold shadow-sm transition cursor-pointer"
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
              </details>
            </>
          )}
        </div>
        </>
      )}

      {/* TAB: REPORT A CONCERN (integrity / wrongdoing reports) */}
      {activeTab === 'integrity' && (
        <IntegrityReports
          currentUser={liveProfile}
          branchesList={branches}
          usersList={usersList}
          canReview={canReviewIntegrity}
        />
      )}

      {/* TAB: PERMISSIONS (Admin only) */}
      {activeTab === 'permissions' && isAdmin && (
        <PermissionsManager usersList={usersList.filter(u => !isHiddenAdminUser(u))} />
      )}

      {/* TAB: AUDIT LOG (Admin only) */}
      {activeTab === 'auditLog' && isAdmin && (
        <AuditLog isAdmin={isAdmin} />
      )}

      {activeTab === 'checklist' && canSeeChecklist && (
        <BranchChecklist
          currentUser={liveProfile}
          branchesList={visibleBranchesForUser}
          openBranch={openAttendance?.branch || null}
          canSignOff={canSignOffChecklist}
          isAdmin={isAdmin}
          onReportIssue={handleReportIssueFromChecklist}
        />
      )}

      {/* TAB 5: USERS MANAGEMENT */}
      {activeTab === 'users' && canManageUsers && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Supervisors can create plain Staff (User) accounts for their own branches, plus view/edit/delete Users. */}
          {(
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
                <label className="block text-xs font-bold text-slate-600 mb-1">
                  Phone Number {!(isAdmin && skipPhoneForAdmin) && <span className="text-rose-500">*</span>}
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={11}
                  required={!(isAdmin && skipPhoneForAdmin)}
                  disabled={isAdmin && skipPhoneForAdmin}
                  value={newUserPhone}
                  onChange={(e) => setNewUserPhone(e.target.value.replace(/[^0-9]/g, '').slice(0, 11))}
                  placeholder="01012345678"
                  className="w-full p-3 bg-slate-50 border rounded-xl text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <p className="text-[10px] text-slate-400 mt-1">11 digits, starting with 01</p>
                {isAdmin && (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="checkbox"
                      id="skipPhoneForAdmin"
                      checked={skipPhoneForAdmin}
                      onChange={(e) => {
                        setSkipPhoneForAdmin(e.target.checked);
                        if (e.target.checked) setNewUserPhone('');
                      }}
                    />
                    <label htmlFor="skipPhoneForAdmin" className="text-[11px] text-slate-500">
                      Register without a phone number (Admin exception)
                    </label>
                  </div>
                )}
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
                  ) : isSupervisor ? (
                    <option value="User" className="bg-white text-slate-900">User (Staff)</option>
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
                      <option value="HR" className="bg-white text-slate-900">HR</option>
                      <option value="CEO" className="bg-white text-slate-900">CEO</option>
                      <option value="QA" className="bg-white text-slate-900">QA</option>
                      {/* Admin-only: same permissions as a plain User, but reports directly to Admin -
                          never shown to/created by a Branch Manager or Supervisor. */}
                      {isAdmin && <option value="Finance and Administration" className="bg-white text-slate-900">Finance and Administration</option>}
                      {isAdmin && <option value="Admin" className="bg-white text-slate-900">Admin</option>}
                    </>
                  )}
                </select>
              </div>

              {/* Update: assign branches to any account regardless of role - this restricts their visibility across the app to those branches only */}
              <div className="space-y-2 border p-3 rounded-xl bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Assign Branches <span className="font-normal text-slate-400">({newUserBranches.length}/{branches.length})</span>
                  </label>
                  <div className="flex items-center gap-3 text-[11px] font-bold">
                    <button
                      type="button"
                      onClick={() => setNewUserBranches(((isBranchManager || isSupervisor) ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => b.name))}
                      className="text-indigo-600 hover:underline cursor-pointer"
                    >
                      Select all
                    </button>
                    <button type="button" onClick={() => setNewUserBranches([])} className="text-slate-500 hover:underline cursor-pointer">Clear</button>
                  </div>
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {((isBranchManager || isSupervisor) ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => (
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

              <button 
                type="submit" 
                disabled={loading} 
                className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl text-sm shadow-md hover:bg-indigo-700 transition"
              >
                {loading ? 'Creating User...' : 'Add User'}
              </button>
            </form>
          </div>
          )}

          <div className="lg:col-span-2 space-y-4">
            {/* Update: Shared Device Alerts report - filterable by date/time, with per-login history and a Clear History control */}
            {isAdmin && (
              <div className="bg-amber-50 border border-amber-300 p-5 rounded-3xl shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-black text-amber-900 flex items-center gap-2">
                    ⚠️ Shared Device Alerts ({sharedDeviceGroups.length})
                  </h3>
                  <button
                    onClick={handleClearDeviceHistory}
                    className="bg-white hover:bg-rose-600 hover:text-white border border-rose-300 text-rose-600 px-3 py-1.5 rounded-xl text-[11px] font-bold transition-all cursor-pointer"
                  >
                    🗑️ Clear History
                  </button>
                </div>
                <p className="text-[11px] text-amber-800">
                  Accounts that logged in from the exact same browser/device within the selected date range. This may indicate account sharing.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-extrabold uppercase text-amber-700 mb-1">From</label>
                    <input
                      type="date"
                      value={deviceLogStartDate}
                      onChange={(e) => setDeviceLogStartDate(e.target.value)}
                      className="w-full p-2 bg-white border border-amber-200 rounded-xl text-xs font-medium"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-extrabold uppercase text-amber-700 mb-1">To</label>
                    <input
                      type="date"
                      value={deviceLogEndDate}
                      onChange={(e) => setDeviceLogEndDate(e.target.value)}
                      className="w-full p-2 bg-white border border-amber-200 rounded-xl text-xs font-medium"
                    />
                  </div>
                </div>

                {sharedDeviceGroups.length === 0 ? (
                  <p className="text-[11px] text-amber-700 italic">No shared-device activity found for the selected range.</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {sharedDeviceGroups.map(group => (
                      <div key={group.deviceId} className="bg-white border border-amber-200 rounded-2xl p-3 text-xs space-y-2">
                        <p className="font-bold text-slate-700">
                          {group.usernames.join('  •  ')}
                        </p>
                        <p className="text-slate-400 text-[10px]">
                          Device: {group.logs[0]?.deviceType || 'Unknown'} • {group.logs[0]?.browser || 'Unknown'} • {group.logs[0]?.os || 'Unknown'}
                        </p>
                        <div className="border-t border-slate-100 pt-2 space-y-1">
                          {group.logs.slice(0, 8).map(log => (
                            <div key={log.id} className="flex justify-between text-[10px] text-slate-500">
                              <span className="font-semibold text-slate-700">{log.username}</span>
                              <span>{formatLogDateTime(log.timestamp)}</span>
                            </div>
                          ))}
                          {group.logs.length > 8 && (
                            <p className="text-[10px] text-slate-400 italic">+ {group.logs.length - 8} more login(s)</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <h2 className="text-lg font-bold text-slate-900">
                {isFacilityManager ? 'Facility Team Members' : `System Users (${manageableUsersList.length})`}
              </h2>
              {selectedUserIds.size > 0 && (
                <button
                  onClick={handleBulkDeleteUsers}
                  disabled={loading}
                  className="bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-extrabold px-4 py-2 rounded-xl text-xs shadow-md transition cursor-pointer"
                >
                  🗑️ Delete selected ({selectedUserIds.size})
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                    <th className="p-3 w-8">
                      <input
                        type="checkbox"
                        title="Select all"
                        checked={
                          manageableUsersList.filter((u) => u.id !== user?.id && canDeleteUser(u)).length > 0 &&
                          manageableUsersList
                            .filter((u) => u.id !== user?.id && canDeleteUser(u))
                            .every((u) => selectedUserIds.has(u.id))
                        }
                        onChange={(e) => {
                          const deletableIds = manageableUsersList
                            .filter((u) => u.id !== user?.id && canDeleteUser(u))
                            .map((u) => u.id);
                          setSelectedUserIds(e.target.checked ? new Set(deletableIds) : new Set());
                        }}
                        className="w-4 h-4 cursor-pointer"
                      />
                    </th>
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
                    <th
                      className="p-3 cursor-pointer select-none hover:bg-slate-200 transition-colors"
                      onClick={() => handleUserSort('status')}
                    >
                      Status {userSortField === 'status' ? (userSortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th
                      className="p-3 cursor-pointer select-none hover:bg-slate-200 transition-colors"
                      onClick={() => handleUserSort('lastActive')}
                    >
                      Last Seen {userSortField === 'lastActive' ? (userSortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th className="p-3">Assigned Branches</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs font-medium">
                  {[...manageableUsersList]
                    .sort((a, b) => {
                      if (!userSortField) return 0;
                      if (userSortField === 'status') {
                        const aOnline = isUserOnline(a) ? 1 : 0;
                        const bOnline = isUserOnline(b) ? 1 : 0;
                        if (aOnline === bOnline) return 0;
                        return userSortDirection === 'asc' ? (bOnline - aOnline) : (aOnline - bOnline);
                      }
                      if (userSortField === 'lastActive') {
                        const msOf = (u) => u.lastActive ? (u.lastActive.toDate ? u.lastActive.toDate().getTime() : new Date(u.lastActive).getTime()) : 0;
                        const aMs = msOf(a);
                        const bMs = msOf(b);
                        return userSortDirection === 'asc' ? (aMs - bMs) : (bMs - aMs);
                      }
                      const valA = String(a[userSortField] || '').toLowerCase();
                      const valB = String(b[userSortField] || '').toLowerCase();
                      if (valA < valB) return userSortDirection === 'asc' ? -1 : 1;
                      if (valA > valB) return userSortDirection === 'asc' ? 1 : -1;
                      return 0;
                    })
                    .map((u) => {
                      // Facility Managers share one team: any Facility Manager can edit/delete any Facility Member.
                      const canEditThisUser = isAdmin || u.createdBy === user?.id
                        || (isFacilityManager && u.role === 'Facility Member')
                        || (isBranchManager && ['Supervisor', 'User'].includes(u.role))
                        || (isSupervisor && u.role === 'User');
                      const canDeleteThisUser = canDeleteUser(u);
                      const userBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
                      const online = isUserOnline(u);

                      return (
                        <tr key={u.id} className="hover:bg-slate-50">
                          <td className="p-3">
                            {canDeleteThisUser && u.id !== user?.id && (
                              <input
                                type="checkbox"
                                checked={selectedUserIds.has(u.id)}
                                onChange={() => toggleUserSelection(u.id)}
                                className="w-4 h-4 cursor-pointer"
                              />
                            )}
                          </td>
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
                          <td className="p-3 text-slate-600 text-[11px] whitespace-nowrap">
                            {online ? (
                              <span className="text-emerald-600 font-bold">Online now</span>
                            ) : (
                              formatLastSeen(u)
                            )}
                          </td>
                          <td className="p-3 text-slate-600">
                            {userBranches.length > 0 ? userBranches.join(', ') : <span className="text-slate-400 italic">None</span>}
                          </td>
                          <td className="p-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {isAdmin && (
                                <button
                                  onClick={() => setViewingDeviceInfoUser(u)}
                                  title="View login device info"
                                  className="bg-slate-50 hover:bg-slate-700 hover:text-white border border-slate-300 text-slate-600 px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer"
                                >
                                  📱 Device
                                </button>
                              )}

                              {canEditThisUser && u.id !== user?.id && (
                                <button
                                  onClick={() => handleForceLogout(u)}
                                  title={online ? 'Force log this user out now' : 'User is offline now - they will be forced to log in again the next time they open the app'}
                                  className="px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer border-0 whitespace-nowrap"
                                  style={{ backgroundColor: '#d97706', color: '#ffffff' }}
                                >
                                  🔒 Force Logout
                                </button>
                              )}

                              {canEditThisUser && (
                                <button 
                                  onClick={() => {
                                    setEditingUser(u);
                                    setEditUsername(u.username || '');
                                    setEditPassword(isAdmin ? (u.password || '') : '');
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
                branches.map((b) => {
                  const hasGeofence = b.locationLat != null && b.locationLng != null;
                  const draft = getBranchLocationDraft(b);
                  return (
                    <div key={b.id} className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs font-bold text-slate-800 space-y-2">
                      <div className="flex justify-between items-center">
                        <span>🏢 {b.name}</span>
                        <button
                          onClick={() => handleDeleteBranch(b.id)}
                          className="bg-rose-600 text-white hover:bg-rose-700 px-2.5 py-1 rounded-lg transition text-[11px] font-bold"
                        >
                          Delete
                        </button>
                      </div>

                      <div className="pt-2 border-t border-slate-200 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                            📍 Check-In/Out GPS Lock
                          </span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${hasGeofence ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                            {hasGeofence ? `Active (${b.locationRadius}m)` : 'Not set - open to all'}
                          </span>
                        </div>

                        {hasGeofence && (
                          <p className="text-[10px] font-mono text-slate-400 tracking-tight">
                            {decimalToDms(b.locationLat, 'lat')} {decimalToDms(b.locationLng, 'lng')}
                          </p>
                        )}

                        <div className="grid grid-cols-3 gap-1.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder={`Latitude (e.g. 30°01'55.81"N)`}
                            value={draft.lat}
                            onChange={(e) => {
                              // Pasting/typing a DMS coordinate (or a full pair, e.g. copied straight from
                              // Google Maps as `30°01'55.81"N 31°29'54.34"E`) auto-converts to decimal and,
                              // if both lat and lng were in the text, fills both fields in one go.
                              const parsed = parseDmsCoordinates(e.target.value);
                              if (parsed && (parsed.lat != null || parsed.lng != null)) {
                                if (parsed.lat != null) setBranchLocationField(b.id, 'lat', String(parsed.lat));
                                if (parsed.lng != null) setBranchLocationField(b.id, 'lng', String(parsed.lng));
                              } else {
                                setBranchLocationField(b.id, 'lat', e.target.value);
                              }
                            }}
                            className="p-2 bg-white border rounded-lg text-[11px] font-semibold"
                          />
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder={`Longitude (e.g. 31°29'54.34"E)`}
                            value={draft.lng}
                            onChange={(e) => {
                              const parsed = parseDmsCoordinates(e.target.value);
                              if (parsed && (parsed.lat != null || parsed.lng != null)) {
                                if (parsed.lat != null) setBranchLocationField(b.id, 'lat', String(parsed.lat));
                                if (parsed.lng != null) setBranchLocationField(b.id, 'lng', String(parsed.lng));
                              } else {
                                setBranchLocationField(b.id, 'lng', e.target.value);
                              }
                            }}
                            className="p-2 bg-white border rounded-lg text-[11px] font-semibold"
                          />
                          <input
                            type="number"
                            min="10"
                            placeholder="Radius (m)"
                            value={draft.radius}
                            onChange={(e) => setBranchLocationField(b.id, 'radius', e.target.value)}
                            className="p-2 bg-white border rounded-lg text-[11px] font-semibold"
                          />
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleUseMyLocationForBranch(b.id)}
                            disabled={isLocatingBranchId === b.id}
                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-50 cursor-pointer"
                          >
                            {isLocatingBranchId === b.id ? 'Locating...' : '📍 Use my current location'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveBranchLocation(b)}
                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-indigo-600 text-white hover:bg-indigo-700 cursor-pointer"
                          >
                            Save Location
                          </button>
                          {hasGeofence && (
                            <button
                              type="button"
                              onClick={() => handleClearBranchLocation(b)}
                              className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 cursor-pointer"
                            >
                              Remove Lock
                            </button>
                          )}
                        </div>
                        <p className="text-[10px] font-medium text-slate-400 italic normal-case">
                          Tip: stand at the branch itself and tap "Use my current location" for the most accurate setup.
                        </p>
                      </div>
                    </div>
                  );
                })
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
                <label className="block text-xs font-bold text-slate-600 mb-1">Username <span className="font-normal text-slate-400">(cannot be changed)</span></label>
                <input type="text" value={editUsername} readOnly className="w-full p-2.5 bg-slate-100 text-slate-500 border rounded-xl text-xs cursor-not-allowed" />
              </div>
              {isAdmin ? (
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    New Password <span className="font-normal text-slate-400">(leave blank to keep the current password, min 6 characters)</span>
                  </label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={editPassword} 
                      onChange={(e) => setEditPassword(e.target.value)} 
                      placeholder="Only fill this to reset the password"
                      className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs" 
                    />
                    <button
                      type="button"
                      onClick={() => setEditPassword(generateTempPassword())}
                      className="px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-xl text-[11px] font-bold text-slate-700 whitespace-nowrap cursor-pointer"
                    >
                      🎲 Generate
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-slate-400 italic">
                  Password can only be changed by the account owner (via "Change Password") or by an Admin.
                </p>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Phone Number</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={11}
                  value={editUserPhone}
                  onChange={(e) => setEditUserPhone(e.target.value.replace(/[^0-9]/g, '').slice(0, 11))}
                  placeholder="01012345678"
                  className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs font-semibold"
                />
                <p className="text-[10px] text-slate-400 mt-1">11 digits, starting with 01</p>
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
                    <option value="HR" className="bg-white text-slate-900">HR</option>
                    <option value="CEO" className="bg-white text-slate-900">CEO</option>
                    <option value="QA" className="bg-white text-slate-900">QA</option>
                    <option value="Finance and Administration" className="bg-white text-slate-900">Finance and Administration</option>
                    <option value="Admin" className="bg-white text-slate-900">Admin</option>
                  </select>
                </div>
              )}

              {/* Update: assign branches to any account regardless of role - this restricts their visibility across the app to those branches only */}
              <div className="space-y-2 border p-3 rounded-xl bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-xs font-bold text-slate-700">
                    Assign Branches <span className="font-normal text-slate-400">({editUserBranches.length}/{branches.length})</span>
                  </label>
                  <div className="flex items-center gap-3 text-[11px] font-bold">
                    <button
                      type="button"
                      onClick={() => setEditUserBranches(((isBranchManager || isSupervisor) ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => b.name))}
                      className="text-indigo-600 hover:underline cursor-pointer"
                    >
                      Select all
                    </button>
                    <button type="button" onClick={() => setEditUserBranches([])} className="text-slate-500 hover:underline cursor-pointer">Clear</button>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500">If you assign branches here, this account will only see data related to these branches across the app (Attendance, Requests, etc.).</p>
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {((isBranchManager || isSupervisor) ? branches.filter(b => assignedBranches.includes(b.name)) : branches).map(b => (
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

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditingUser(null)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Update: self-service Change Password modal - available to any user to change only their own password */}
      {showSelfPasswordModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">🔑 Change My Password</h3>
              <button onClick={() => { setShowSelfPasswordModal(false); setSelfNewPassword(''); setSelfConfirmPassword(''); }} className="text-slate-400 font-bold">✕</button>
            </div>
            <form onSubmit={handleSelfPasswordChange} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">New Password</label>
                <input 
                  type="text" 
                  value={selfNewPassword} 
                  onChange={(e) => setSelfNewPassword(e.target.value)} 
                  required 
                  className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Confirm New Password</label>
                <input 
                  type="text" 
                  value={selfConfirmPassword} 
                  onChange={(e) => setSelfConfirmPassword(e.target.value)} 
                  required 
                  className="w-full p-2.5 bg-slate-50 border rounded-xl text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setShowSelfPasswordModal(false); setSelfNewPassword(''); setSelfConfirmPassword(''); }} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold">Update Password</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Update: Device/Browser info modal - Admin only */}
      {viewingDeviceInfoUser && isAdmin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-xl p-6 w-full max-w-sm space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">📱 Login Device Info - {viewingDeviceInfoUser.username}</h3>
              <button onClick={() => setViewingDeviceInfoUser(null)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-400 font-semibold">Device Type</span>
                <span className="font-bold text-slate-800">{viewingDeviceInfoUser.lastDeviceType || 'Not recorded yet'}</span>
              </div>
              <div className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-400 font-semibold">Browser</span>
                <span className="font-bold text-slate-800">{viewingDeviceInfoUser.lastBrowser || 'Not recorded yet'}</span>
              </div>
              <div className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-400 font-semibold">Operating System</span>
                <span className="font-bold text-slate-800">{viewingDeviceInfoUser.lastOS || 'Not recorded yet'}</span>
              </div>
              <div className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-400 font-semibold">Device ID</span>
                <span className="font-mono text-[10px] text-slate-600">{viewingDeviceInfoUser.lastDeviceId || 'N/A'}</span>
              </div>
              <div className="flex justify-between border-b border-slate-100 pb-2">
                <span className="text-slate-400 font-semibold">Status</span>
                <span className="font-bold text-slate-800">{isUserOnline(viewingDeviceInfoUser) ? 'Online now' : 'Offline'}</span>
              </div>
              <div>
                <span className="text-slate-400 font-semibold block mb-1">Full User Agent</span>
                <p className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] text-slate-600 break-all">
                  {viewingDeviceInfoUser.lastUserAgent || 'Not recorded yet'}
                </p>
              </div>
              <p className="text-[10px] text-slate-400 italic pt-1">
                Note: browsers do not expose a real hardware serial number. "Device ID" is a unique identifier generated for this browser the first time this account (or any account) logged in on it, and it stays the same on every future visit from that same browser/device.
              </p>
            </div>
          </div>
        </div>
      )}


      {/* Activity log - opened from the bell icon in the header */}
      {showLogsPanel && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-start justify-center p-4"
          style={{ paddingTop: '5rem' }}
          onClick={() => setShowLogsPanel(false)}
        >
          <div
            className="bg-white border border-slate-200 rounded-3xl shadow-xl w-full max-w-2xl p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center gap-3">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <span>🔔</span> Activity Notifications Log
              </h3>
              <div className="flex items-center gap-2">
                {isAdmin && activityLogs.length > 0 && (
                  <button
                    onClick={handleClearAllLogs}
                    className="text-[11px] bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-3 py-1.5 rounded-xl shadow-sm transition cursor-pointer"
                  >
                    Clear All Logs 🗑️
                  </button>
                )}
                <button
                  onClick={() => setShowLogsPanel(false)}
                  title="Close"
                  className="text-slate-400 hover:text-slate-700 font-bold px-2 py-1 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="overflow-y-auto space-y-2 pr-1" style={{ maxHeight: '65vh' }}>
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
        </div>
      )}

      {/* Checkout reminder pop-up (shown after CHECKOUT_REMINDER_AFTER_HOURS without a check-out) */}
      {checkoutReminder && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-3xl shadow-xl w-full max-w-sm p-6 text-center space-y-4">
            <div className="text-5xl">⏰</div>
            <h3 className="text-lg font-black text-slate-900">Don't forget to check out</h3>
            <p className="text-sm text-slate-600">
              You have been checked in at <strong>{checkoutReminder.branch}</strong> for <strong>{checkoutReminder.elapsedText}</strong>.
              If your shift is over, please check out now.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setCheckoutReminder(null)}
                className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl text-xs transition cursor-pointer"
              >
                Later
              </button>
              <button
                onClick={() => { setActiveTab('attendance'); setCheckoutReminder(null); }}
                className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 rounded-xl text-xs shadow-sm transition cursor-pointer"
              >
                Go to Check Out
              </button>
            </div>
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
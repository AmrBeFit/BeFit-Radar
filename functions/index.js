const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth');

initializeApp();
const db = getFirestore();
const auth = getAuth();

// New account types behave like an existing role everywhere EXCEPT account management:
//   Branch Manager+ -> Branch Manager (and may also manage Coaches), QA Manager -> QA (and may also create QA Members),
//   Coach -> User (the app only shows a Coach attendance, maintenance requests and leave requests),
//   Fitness Manager -> User too (check in/out + leave; may also manage Coaches and give a Coach's leave a first (pre-)approval).
const normRoleUpper = (r) => {
  const v = String(r || '').trim().toUpperCase();
  if (v === 'BRANCH MANAGER+') return 'BRANCH MANAGER';
  if (v === 'QA MANAGER') return 'QA';
  if (v === 'COACH') return 'USER';
  if (v === 'FITNESS MANAGER') return 'USER'; // sits between Branch Manager+ and Coach; only account / leave handling differs
  return v;
};

// Per-account permissions (Permissions tab, users/{id}.permissions = { key: true|false }). An explicit true/false on the
// account wins; otherwise the role's default applies. A System Admin is always allowed.
// Order: the account's own setting > the setting of the whole account TYPE (rolePermissions/{role}) > the built-in default.
const rolePermCache = new Map(); // role -> { at, perms }
const withRole = async (profile) => {
  const role = profile && profile.role;
  if (!role) return profile;
  let hit = rolePermCache.get(role);
  if (!hit || Date.now() - hit.at > 15000) {
    const snap = await db.collection('rolePermissions').doc(String(role)).get();
    hit = { at: Date.now(), perms: snap.exists ? (snap.data().permissions || {}) : {} };
    rolePermCache.set(role, hit);
  }
  return { ...profile, rolePermissions: hit.perms };
};
const permAllowed = (profile, key, roleDefault) => {
  if (normRoleUpper(profile?.role) === 'ADMIN') return true;
  const o = profile?.permissions && profile.permissions[key];
  if (typeof o === 'boolean') return o;
  const r = profile?.rolePermissions && profile.rolePermissions[key];
  return typeof r === 'boolean' ? r : !!roleDefault;
};
// Used for permissions that can only be REMOVED from a role that has them (account management).
const permNotRemoved = (profile, key) => {
  const o = profile?.permissions && profile.permissions[key];
  if (typeof o === 'boolean') return o;
  return !(profile?.rolePermissions && profile.rolePermissions[key] === false);
};

// ⚠️ This must match the fake domain used everywhere else in this file and in Login.jsx.
const EMAIL_DOMAIN = 'befit-facility.local';

const usernameToEmail = (username) =>
  `${username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${EMAIL_DOMAIN}`;

// Update: which roles a given caller role is allowed to create, mirroring the app's own rules.
const ALLOWED_ROLES_BY_CREATOR = {
  // "Finance and Administration" is Admin-only to create (not listed under BRANCH MANAGER below) -
  // it has the same permissions as a plain "User" account, it just reports straight to Admin instead
  // of a Branch Manager/Supervisor.
  ADMIN: ['User', 'Supervisor', 'Coach', 'Branch Manager', 'Branch Manager+', 'Fitness Manager', 'Facility Manager', 'Facility Member', 'HR', 'CEO', 'QA', 'QA Manager', 'Admin', 'Finance and Administration'],
  'BRANCH MANAGER': ['User', 'Supervisor'],
  // Branch Manager+ = Branch Manager who can also add / edit / delete Coaches
  'BRANCH MANAGER+': ['User', 'Supervisor', 'Coach', 'Fitness Manager'],
  // Fitness Manager = manages Coaches only
  'FITNESS MANAGER': ['Coach'],
  // QA Manager = QA who can also create QA Members (a plain QA cannot create anyone)
  'QA MANAGER': ['QA'],
  // A Supervisor may create plain User (staff) accounts only - and only for branches the Supervisor
  // is assigned to themselves (enforced in createUserAccount below).
  SUPERVISOR: ['User'],
  'FACILITY MANAGER': ['Facility Member']
};

// Update: Facility Manager / Branch Manager / Supervisor teams are now SHARED - any manager of that
// type can delete any account of the matching role(s), regardless of which specific manager created
// it (this is intentionally separate from ALLOWED_ROLES_BY_CREATOR above, since e.g. a Supervisor may
// delete a User's account without being allowed to create one).
const ALLOWED_DELETE_TARGET_ROLES_BY_ROLE = {
  'FACILITY MANAGER': ['Facility Member'],
  'BRANCH MANAGER': ['User', 'Supervisor'],
  'BRANCH MANAGER+': ['User', 'Supervisor', 'Coach', 'Fitness Manager'],
  'FITNESS MANAGER': ['Coach'],
  'QA MANAGER': ['QA'],
  SUPERVISOR: ['User']
};

// --------------------------------------------------------------
// createUserAccount: replaces the old client-side addDoc(users, {...}).
// Creating a Firebase Auth user from the browser signs the browser in as
// that NEW user immediately, which would kick the admin out of their own
// session - so account creation now has to happen here, server-side.
// --------------------------------------------------------------
exports.createUserAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRole = (request.auth.token.role || '').toUpperCase();
  const { username, password, phone, role, assignedBranches } = request.data || {};

  if (!username?.trim() || !password?.trim() || !role) {
    throw new HttpsError('invalid-argument', 'Username, password and role are required.');
  }

  const allowedRoles = ALLOWED_ROLES_BY_CREATOR[callerRole];
  if (!allowedRoles || !allowedRoles.includes(role)) {
    throw new HttpsError('permission-denied', `Your role is not allowed to create a "${role}" account.`);
  }

  // The System Admin can switch these abilities off for one account in the Permissions tab.
  const accountPermKeyFor = (callerUpper, targetRole) => (
    targetRole === 'Coach' ? 'manageCoaches'
      : targetRole === 'Fitness Manager' ? 'manageFitnessManagers'
      : (targetRole === 'QA' && callerUpper === 'QA MANAGER') ? 'createQAMembers' : '');
  const createPermKey = accountPermKeyFor(callerRole, role);
  if (createPermKey && callerRole !== 'ADMIN') {
    const cSnap = await db.collection('users').doc(request.auth.uid).get();
    if (!permNotRemoved(await withRole(cSnap.data()), createPermKey)) {
      throw new HttpsError('permission-denied', 'The System Admin has switched this ability off for your account.');
    }
  }

  if ((callerRole === 'BRANCH MANAGER' || callerRole === 'BRANCH MANAGER+') && (!Array.isArray(assignedBranches) || assignedBranches.length === 0)) {
    throw new HttpsError('invalid-argument', 'Please assign at least one branch to this account.');
  }

  // A Supervisor must assign at least one branch, and can only hand out branches they are assigned to
  // themselves (checked against their own Firestore profile, not anything the client sends).
  if (callerRole === 'FITNESS MANAGER' && (!Array.isArray(assignedBranches) || assignedBranches.length === 0)) {
    throw new HttpsError('invalid-argument', 'Please assign at least one branch to this account.');
  }
  if (callerRole === 'SUPERVISOR' || callerRole === 'FITNESS MANAGER') {
    if (!Array.isArray(assignedBranches) || assignedBranches.length === 0) {
      throw new HttpsError('invalid-argument', 'Please assign at least one branch to this account.');
    }
    const callerDoc = await db.collection('users').doc(request.auth.uid).get();
    const callerBranches = Array.isArray(callerDoc.data()?.assignedBranches) ? callerDoc.data().assignedBranches : [];
    if (!assignedBranches.every((b) => callerBranches.includes(b))) {
      throw new HttpsError('permission-denied', 'You can only assign branches that you are assigned to yourself.');
    }
  }

  const usernameLower = username.trim().toLowerCase();
  const existingIndex = await db.collection('usernameIndex').doc(usernameLower).get();
  if (existingIndex.exists) {
    throw new HttpsError('already-exists', 'That username is already taken.');
  }

  const email = usernameToEmail(username);

  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password, disabled: false });
  } catch (err) {
    throw new HttpsError('internal', 'Could not create the account: ' + err.message);
  }

  await auth.setCustomUserClaims(userRecord.uid, { role });

  await db.collection('users').doc(userRecord.uid).set({
    username: username.trim(),
    role,
    assignedBranches: Array.isArray(assignedBranches) ? assignedBranches : [],
    createdBy: request.auth.uid,
    createdByUsername: request.auth.token.name || '',
    mustChangePassword: true,
    createdAt: FieldValue.serverTimestamp()
  });

  await db.collection('usernameIndex').doc(usernameLower).set({ email });

  // The phone number lives in a separate, restricted document (userPrivate) - NOT in the
  // users directory that every signed-in account can read.
  await db.collection('userPrivate').doc(userRecord.uid).set({ phone: phone?.trim() || '' });

  return { uid: userRecord.uid };
});

// --------------------------------------------------------------
// adminResetPassword: only Admin can set a NEW password for someone
// else's account (matches the app's "only Admin can change other
// people's passwords" rule). The target is then forced to change it
// again on their next login.
// --------------------------------------------------------------
exports.adminResetPassword = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRole = normRoleUpper(request.auth.token.role);
  if (callerRole !== 'ADMIN') {
    throw new HttpsError('permission-denied', 'Only Admin can reset another account\'s password.');
  }

  const { targetUserId, newPassword } = request.data || {};
  if (!targetUserId || !newPassword?.trim() || newPassword.trim().length < 4) {
    throw new HttpsError('invalid-argument', 'A target user and a password of at least 4 characters are required.');
  }

  try {
    await auth.updateUser(targetUserId, { password: newPassword.trim() });
  } catch (err) {
    throw new HttpsError('internal', 'Could not update the password: ' + err.message);
  }

  const updates = { mustChangePassword: true };
  if (targetUserId !== request.auth.uid) {
    await db.collection('users').doc(targetUserId).update(updates);
  }

  return { success: true };
});

// --------------------------------------------------------------
// updateUserRole: role changes must go through here (not a plain Firestore
// write) because the Auth custom claim that Security Rules rely on has to
// be updated at the same time, or the two would drift out of sync.
// --------------------------------------------------------------
exports.updateUserRole = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRole = normRoleUpper(request.auth.token.role);
  if (callerRole !== 'ADMIN') {
    throw new HttpsError('permission-denied', 'Only Admin can change a user\'s role.');
  }

  const { targetUserId, newRole } = request.data || {};
  if (!targetUserId || !newRole) {
    throw new HttpsError('invalid-argument', 'A target user and a new role are required.');
  }

  await auth.setCustomUserClaims(targetUserId, { role: newRole });
  await db.collection('users').doc(targetUserId).update({ role: newRole });

  return { success: true };
});

// --------------------------------------------------------------
// createAttendancePlans: creates the shifts of the attendance roster (who is planned where, and when).
// It runs on the server so the rules that matter are enforced here and cannot be skipped from the browser:
//   - only Admin, Branch Manager and Supervisor can plan
//   - Admin plans Branch Managers / Supervisors / Users, Branch Manager plans Supervisors / Users,
//     Supervisor plans Users and themselves (their own shift)
//   - Branch Manager and Supervisor only plan people who share a branch with them, and only AT their own branches
//   - one plan covers at most one month, starting no later than 30 days from today
//   - a new shift is skipped if it overlaps another shift of the same person on the same day
// --------------------------------------------------------------
const PLANNABLE_TARGETS = {
  admin: ['branch manager', 'supervisor', 'user', 'staff', 'finance and administration'],
  'branch manager': ['supervisor', 'user', 'staff'],
  supervisor: ['user', 'staff']
};
const HHMM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// A branch's working hours (openTime / closeTime on the branch document, "HH:MM"). A shift has to stay
// inside them. A branch whose closing time is not after its opening time works past midnight, so a
// shift may sit either in [open, midnight] or in [midnight, close].
const hhmmToMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function shiftFitsBranchHours(start, end, open, close) {
  if (!HHMM_PATTERN.test(open || '') || !HHMM_PATTERN.test(close || '')) return true; // no hours set
  const s = hhmmToMin(start); const e = hhmmToMin(end);
  const o = hhmmToMin(open); const c = hhmmToMin(close);
  if (c > o) return s >= o && e <= c;
  return (s >= o && e <= 24 * 60) || e <= c;
}
const DAY_MS = 86400000;

const isRealYmd = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const ymdToUtcMs = (value) => {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

exports.createAttendancePlans = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRole = normRoleUpper(request.auth.token.role).toLowerCase();
  const allowedTargets = PLANNABLE_TARGETS[callerRole];
  if (!allowedTargets) {
    throw new HttpsError('permission-denied', 'Only an Admin, Branch Manager or Supervisor can create the schedule.');
  }

  const { userIds, dates, branch, startTime, endTime } = request.data || {};

  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > 200) {
    throw new HttpsError('invalid-argument', 'Choose between 1 and 200 employees.');
  }
  if (!Array.isArray(dates) || dates.length === 0 || dates.length > 31) {
    throw new HttpsError('invalid-argument', 'Choose between 1 and 31 days.');
  }
  if (typeof branch !== 'string' || !branch.trim()) {
    throw new HttpsError('invalid-argument', 'Choose a branch.');
  }
  if (!HHMM_PATTERN.test(startTime || '') || !HHMM_PATTERN.test(endTime || '') || endTime <= startTime) {
    throw new HttpsError('invalid-argument', 'The end time must be after the start time (both as HH:MM).');
  }
  if (!dates.every(isRealYmd)) {
    throw new HttpsError('invalid-argument', 'One of the dates is not valid.');
  }

  // one-month limit
  const uniqueDates = [...new Set(dates)].sort();
  const firstMs = ymdToUtcMs(uniqueDates[0]);
  const lastMs = ymdToUtcMs(uniqueDates[uniqueDates.length - 1]);
  const todayMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  if (firstMs < todayMs - DAY_MS) {
    throw new HttpsError('invalid-argument', 'You cannot plan days that have already passed.');
  }
  if (lastMs > todayMs + 31 * DAY_MS) {
    throw new HttpsError('invalid-argument', 'You can only plan up to one month ahead.');
  }
  if ((lastMs - firstMs) / DAY_MS > 30) {
    throw new HttpsError('invalid-argument', 'One schedule can cover at most one month.');
  }

  // the planner
  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.exists ? callerSnap.data() : {};
  const callerBranches = Array.isArray(caller.assignedBranches) ? caller.assignedBranches : [];

  const cleanBranch = branch.trim();
  const branchSnap = await db.collection('branches').where('name', '==', cleanBranch).limit(1).get();
  if (branchSnap.empty) throw new HttpsError('invalid-argument', 'That branch does not exist.');

  if (callerRole !== 'admin' && !callerBranches.includes(cleanBranch)) {
    throw new HttpsError('permission-denied', 'You can only plan at branches assigned to you.');
  }

  const branchInfo = branchSnap.docs[0].data();
  if (!shiftFitsBranchHours(startTime, endTime, branchInfo.openTime, branchInfo.closeTime)) {
    throw new HttpsError(
      'invalid-argument',
      `${cleanBranch} works from ${branchInfo.openTime} to ${branchInfo.closeTime}. A shift cannot start before the branch opens or end after it closes.`
    );
  }

  // the people being planned
  const uniqueIds = [...new Set(userIds.filter((id) => typeof id === 'string' && id))];
  const targetSnaps = await db.getAll(...uniqueIds.map((id) => db.collection('users').doc(id)));
  const targets = [];
  const rejected = [];
  targetSnaps.forEach((snap) => {
    if (!snap.exists) { rejected.push(snap.id); return; }
    const t = snap.data();
    const targetBranches = Array.isArray(t.assignedBranches) ? t.assignedBranches : [];
    // A Supervisor may also put THEMSELVES on the schedule (their own shift), on top of planning Users.
    const isSelfPlanBySupervisor = callerRole === 'supervisor' && snap.id === request.auth.uid;
    const roleOk = isSelfPlanBySupervisor || allowedTargets.includes(normRoleUpper(t.role).toLowerCase());
    const sharesBranch = callerRole === 'admin' || targetBranches.some((b) => callerBranches.includes(b));
    if (!roleOk || !sharesBranch) { rejected.push(t.username || snap.id); return; }
    targets.push({ id: snap.id, username: t.username || '', role: t.role || 'User' });
  });
  if (rejected.length > 0) {
    throw new HttpsError('permission-denied', `You are not allowed to plan: ${rejected.join(', ')}.`);
  }

  // existing shifts in the same period, to avoid overlaps
  const existingSnap = await db.collection('attendancePlans')
    .where('date', '>=', uniqueDates[0])
    .where('date', '<=', uniqueDates[uniqueDates.length - 1])
    .get();
  const existingByKey = new Map();
  existingSnap.forEach((d) => {
    const p = d.data();
    const key = `${p.userId}|${p.date}`;
    if (!existingByKey.has(key)) existingByKey.set(key, []);
    existingByKey.get(key).push(p);
  });

  const toCreate = [];
  let skipped = 0;
  targets.forEach((t) => {
    uniqueDates.forEach((date) => {
      const clash = (existingByKey.get(`${t.id}|${date}`) || []).some((p) => p.startTime < endTime && startTime < p.endTime);
      if (clash) { skipped += 1; return; }
      toCreate.push({
        userId: t.id,
        username: t.username,
        userRole: t.role,
        branch: cleanBranch,
        date,
        startTime,
        endTime,
        createdBy: request.auth.uid,
        createdByUsername: caller.username || '',
        createdByRole: caller.role || '',
        createdAt: FieldValue.serverTimestamp()
      });
    });
  });

  for (let i = 0; i < toCreate.length; i += 400) {
    const batch = db.batch();
    toCreate.slice(i, i + 400).forEach((item) => batch.set(db.collection('attendancePlans').doc(), item));
    await batch.commit();
  }

  return { created: toCreate.length, skipped };
});

// --------------------------------------------------------------
// updateTeamBranches: lets a manager change the branches of the people under them, so the roster and the
// attendance rules have branches to work with (older accounts often have none).
//   - Admin: any account, any branches
//   - Branch Manager: Supervisors and Users
//   - Supervisor: Users
//   - a Branch Manager / Supervisor can only use THEIR OWN branches, and can only touch people who share
//     a branch with them, who have no branches yet, or whom they created
//   - branches of the person that are outside the manager's own branches are never removed
// mode "set": the manager's branches for that person become exactly `branches`;  mode "add": `branches` are added
// --------------------------------------------------------------
const TEAM_TARGETS = {
  'branch manager': ['supervisor', 'user', 'staff'],
  'fitness manager': ['user'], // Coaches only (checked against the raw role below)
  supervisor: ['user', 'staff']
};

// pure helpers (kept separate so they are easy to test)
const isInManagerScope = ({ targetBranches, callerBranches, targetCreatedBy, callerUid }) =>
  targetBranches.length === 0 ||
  targetBranches.some((b) => callerBranches.includes(b)) ||
  targetCreatedBy === callerUid;

const mergeTeamBranches = ({ isAdmin, mode, existing, requested, callerBranches }) => {
  const unique = (list) => [...new Set(list)];
  if (isAdmin) return mode === 'add' ? unique([...existing, ...requested]) : unique(requested);
  if (mode === 'add') return unique([...existing, ...requested]);
  const outsideManagerScope = existing.filter((b) => !callerBranches.includes(b));
  return unique([...outsideManagerScope, ...requested]);
};

exports.updateTeamBranches = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRaw = String(request.auth.token.role || '').trim().toLowerCase();
  const callerRole = callerRaw === 'fitness manager' ? 'fitness manager' : normRoleUpper(request.auth.token.role).toLowerCase();
  const isAdmin = callerRole === 'admin';
  const allowedTargets = TEAM_TARGETS[callerRole];
  if (!isAdmin && !allowedTargets) {
    throw new HttpsError('permission-denied', 'Only an Admin, Branch Manager or Supervisor can change team branches.');
  }

  const { targetUserId } = request.data || {};
  const mode = request.data?.mode === 'add' ? 'add' : 'set';
  const requestedRaw = request.data?.branches;
  if (typeof targetUserId !== 'string' || !targetUserId) {
    throw new HttpsError('invalid-argument', 'Choose the person whose branches you want to change.');
  }
  if (!Array.isArray(requestedRaw) || requestedRaw.length > 60 || !requestedRaw.every((b) => typeof b === 'string')) {
    throw new HttpsError('invalid-argument', 'The branches must be a list of branch names.');
  }
  const requested = [...new Set(requestedRaw.map((b) => b.trim()).filter(Boolean))];

  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  const caller = callerSnap.exists ? callerSnap.data() : {};
  const callerBranches = Array.isArray(caller.assignedBranches) ? caller.assignedBranches : [];
  if (!isAdmin && callerBranches.length === 0) {
    throw new HttpsError('permission-denied', 'No branch is assigned to your account yet. Ask an Admin to assign your branches first.');
  }

  const targetRef = db.collection('users').doc(targetUserId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'That account no longer exists.');
  const target = targetSnap.data();
  const existing = Array.isArray(target.assignedBranches) ? target.assignedBranches : [];

  if (!isAdmin) {
    if (targetUserId === request.auth.uid) {
      throw new HttpsError('permission-denied', 'You cannot change your own branches.');
    }
    if (callerRole === 'fitness manager' && String(target.role || '').trim().toLowerCase() !== 'coach') {
      throw new HttpsError('permission-denied', 'A Fitness Manager can only change the branches of Coaches.');
    }
    if (!allowedTargets.includes(normRoleUpper(target.role).toLowerCase())) {
      throw new HttpsError('permission-denied', `You are not allowed to change the branches of a ${target.role || 'this'} account.`);
    }
    if (!isInManagerScope({ targetBranches: existing, callerBranches, targetCreatedBy: target.createdBy, callerUid: request.auth.uid })) {
      throw new HttpsError('permission-denied', 'This person works at branches that are not yours.');
    }
    if (!requested.every((b) => callerBranches.includes(b))) {
      throw new HttpsError('permission-denied', 'You can only use the branches assigned to you.');
    }
  }

  // every branch must really exist
  const branchSnap = await db.collection('branches').get();
  const knownBranches = new Set(branchSnap.docs.map((d) => d.data().name));
  const unknown = requested.filter((b) => !knownBranches.has(b));
  if (unknown.length > 0) {
    throw new HttpsError('invalid-argument', `Unknown branch: ${unknown.join(', ')}.`);
  }

  const merged = mergeTeamBranches({ isAdmin, mode, existing, requested, callerBranches });
  await targetRef.update({ assignedBranches: merged });
  return { assignedBranches: merged };
});

// --------------------------------------------------------------
// deleteUserAccount: deletes both the Auth account and the Firestore
// profile together, so accounts can no longer be "half deleted"
// (Firestore doc removed but the login still technically works, or
// vice versa).
// --------------------------------------------------------------
exports.deleteUserAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerRole = (request.auth.token.role || '').toUpperCase();
  const { targetUserId } = request.data || {};
  if (!targetUserId) throw new HttpsError('invalid-argument', 'A target user is required.');

  const targetDoc = await db.collection('users').doc(targetUserId).get();
  if (!targetDoc.exists) throw new HttpsError('not-found', 'That account no longer exists.');
  const targetData = targetDoc.data();

  const isAdmin = callerRole === 'ADMIN';
  const targetRole = targetData.role || 'User';

  // Shared-team roles (Facility Manager / Branch Manager / Supervisor): may delete ANY account of the
  // matching role(s), regardless of who created it.
  const allowedDeleteTargetRoles = ALLOWED_DELETE_TARGET_ROLES_BY_ROLE[callerRole];
  const canDeleteByRole = !!allowedDeleteTargetRoles && allowedDeleteTargetRoles.includes(targetRole);

  // Fallback for any other role that manages users (e.g. CEO): only accounts they personally created.
  const isCreator = targetData.createdBy === request.auth.uid && Object.keys(ALLOWED_ROLES_BY_CREATOR).includes(callerRole);

  if (!isAdmin && !canDeleteByRole && !isCreator) {
    throw new HttpsError('permission-denied', 'You do not have permission to delete this account.');
  }
  if (!isAdmin) {
    const delKey = targetRole === 'Coach' ? 'manageCoaches' : targetRole === 'Fitness Manager' ? 'manageFitnessManagers' : (targetRole === 'QA' && callerRole === 'QA MANAGER') ? 'createQAMembers' : '';
    if (delKey) {
      const cSnap = await db.collection('users').doc(request.auth.uid).get();
      if (!permNotRemoved(await withRole(cSnap.data()), delKey)) {
        throw new HttpsError('permission-denied', 'The System Admin has switched this ability off for your account.');
      }
    }
  }

  try {
    await auth.deleteUser(targetUserId);
  } catch (err) {
    // If the Auth user is already gone for some reason, still clean up Firestore below.
    console.log('Auth delete warning:', err.message);
  }

  await db.collection('users').doc(targetUserId).delete();
  await db.collection('userPrivate').doc(targetUserId).delete().catch(() => {});

  if (targetData.username) {
    await db.collection('usernameIndex').doc(targetData.username.trim().toLowerCase()).delete().catch(() => {});
  }

  return { success: true };
});

// Shared by every push trigger below: sends the push to a list of FCM tokens and prunes the tokens that
// Firebase says are permanently dead (app uninstalled / token expired) from every user document that
// had them. `usersSnap` is the /users snapshot the caller already fetched, reused for the cleanup pass.
//
// What makes it fast, dependable and accurate:
//  - Urgency: high + a TTL that matches how long the message stays useful (an urgent call expires after
//    10 minutes instead of buzzing a phone that was off for hours; a normal update waits up to a day).
//  - Transient failures (Google busy, rate limit) are retried once; they are NEVER treated as dead tokens.
//    Only "token not registered" / "invalid token" removes a token - previously ANY failure did, which
//    could silently delete a healthy phone's token after one hiccup and stop its notifications for good.
//  - More than 500 devices are sent in chunks (the FCM limit per call).
//  - Every push carries `tab` + `url` so tapping it opens the right screen of the app.
const URGENT_PUSH_TYPES = new Set(['SUMMON', 'REQUEST_BUZZ', 'CEO_REQUEST_BUZZ']);
const SHORT_LIVED_PUSH_TYPES = new Set(['REQUEST_STALE_REMINDER', 'EXPECTED_ABSENCE']);
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
const TRANSIENT_PUSH_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/unknown-error',
]);
const pushTabForType = (type) => {
  if (!type) return 'requests';
  if (type.startsWith('CEO_REQUEST')) return 'ceo_services';
  if (type.startsWith('LEAVE_REQUEST')) return 'attendance';
  if (type === 'EXPECTED_ABSENCE') return 'schedule';
  if (type.startsWith('OUTSOURCE')) return 'outsource';
  if (type === 'DEDUCTION') return 'attendance';
  if (type === 'PAYSLIP') return 'payslip';
  return 'requests';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sendPushAndCleanup = async (usersSnap, tokens, title, body, data) => {
  const allTokens = [...new Set((tokens || []).filter(Boolean))];
  if (allTokens.length === 0) return;

  const type = data && data.type ? String(data.type) : '';
  const isUrgent = URGENT_PUSH_TYPES.has(type);
  const ttlSeconds = isUrgent ? 600 : SHORT_LIVED_PUSH_TYPES.has(type) ? 7200 : 86400;
  const tab = pushTabForType(type);

  // FCM data values must all be strings.
  const payloadData = { tab, url: `/?tab=${tab}`, urgent: isUrgent ? '1' : '0' };
  Object.entries(data || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) payloadData[k] = String(v); });

  // `tag` groups repeated pushes about the same request so the OS re-alerts (vibrates/sounds again)
  // every time instead of silently collapsing them into one.
  const tag = (data && (data.requestId || data.type)) ? String(data.requestId || data.type) : 'befit-eye';
  const baseMessage = {
    notification: { title, body },
    data: payloadData,
    webpush: {
      headers: { Urgency: 'high', TTL: String(ttlSeconds) },
      notification: {
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: isUrgent ? [800, 200, 800, 200, 800, 200, 800] : [500, 200, 500, 200, 500],
      },
      fcmOptions: { link: '/' },
    },
  };

  const sendBatch = async (batchTokens) => {
    try {
      return await getMessaging().sendEachForMulticast({ ...baseMessage, tokens: batchTokens });
    } catch (err) {
      console.error('Error sending push notification:', err);
      return null;
    }
  };

  const dead = new Set();
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < allTokens.length; i += 500) {
    const chunk = allTokens.slice(i, i + 500);
    let response = await sendBatch(chunk);
    if (!response) continue;

    // collect results; retry the transient failures once
    const retryTokens = [];
    response.responses.forEach((r, idx) => {
      if (r.success) { ok += 1; return; }
      const code = r.error && r.error.code;
      if (DEAD_TOKEN_CODES.has(code)) dead.add(chunk[idx]);
      else if (TRANSIENT_PUSH_CODES.has(code)) retryTokens.push(chunk[idx]);
      else failed += 1;
    });
    if (retryTokens.length > 0) {
      await sleep(1500);
      const second = await sendBatch(retryTokens);
      if (second) {
        second.responses.forEach((r, idx) => {
          if (r.success) { ok += 1; return; }
          failed += 1;
          if (DEAD_TOKEN_CODES.has(r.error && r.error.code)) dead.add(retryTokens[idx]);
        });
      } else {
        failed += retryTokens.length;
      }
    }
  }
  console.log(`Push "${type || 'generic'}": ${ok} sent, ${failed} failed, ${dead.size} dead token(s) removed.`);

  if (dead.size > 0) {
    try {
      const batch = db.batch();
      let changed = 0;
      usersSnap.forEach((docSnap) => {
        const u = docSnap.data();
        const tokens2 = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const stillValid = tokens2.filter((t) => !dead.has(t));
        if (stillValid.length !== tokens2.length) {
          batch.update(docSnap.ref, { fcmTokens: stillValid });
          changed += 1;
        }
      });
      if (changed > 0) await batch.commit();
    } catch (err) {
      console.error('Error pruning dead push tokens:', err);
    }
  }
};

// Fires automatically every time a new document is added to the "requests" collection,
// even if every single browser/device is fully closed - this is what makes it a true push notification.
exports.onNewRequestPush = onDocumentCreated('requests/{requestId}', async (event) => {
  const newRequest = event.data.data();
  if (!newRequest) return;

  const isManagement =
    newRequest.createdByRole === 'CEO' ||
    newRequest.role === 'CEO' ||
    newRequest.createdByRole === 'ADMIN' ||
    newRequest.role === 'ADMIN' ||
    newRequest.type === 'SUMMON';

  // For a SUMMON/management request aimed at a specific branch, also notify whoever is
  // currently checked in at that branch (same rule the in-app listener already used).
  let activeUsernamesAtTargetBranch = [];
  if (isManagement && newRequest.targetBranch) {
    const activeAttendanceSnap = await db
      .collection('attendance')
      .where('branch', '==', newRequest.targetBranch)
      .get();

    activeAttendanceSnap.forEach((a) => {
      const rec = a.data();
      const isActive = !rec.checkOutTime && !rec.checkOut;
      if (isActive && rec.username) {
        activeUsernamesAtTargetBranch.push(rec.username);
      }
    });
  }

  // Collect every user account that should be notified, same rules as the in-app listener.
  const usersSnap = await db.collection('users').get();
  const targetUsers = [];

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    const isAdminOrCEO = role === 'ADMIN' || role === 'CEO';
    const isFacilityManager = role === 'FACILITY MANAGER';
    const assignedBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];

    let shouldNotify = false;

    if (isManagement) {
      // CEO/Admin/SUMMON requests: notify every Admin/CEO account, plus anyone
      // currently checked in at the targeted branch (e.g. the branch being summoned).
      shouldNotify = isAdminOrCEO || activeUsernamesAtTargetBranch.includes(u.username);
    } else {
      // Regular maintenance request: notify Admin/CEO always, and the Facility Manager(s)
      // responsible for that branch (or all Facility Managers if none have branches assigned).
      const branchMatches = assignedBranches.length === 0 || assignedBranches.includes(newRequest.branch);
      shouldNotify = isAdminOrCEO || (isFacilityManager && branchMatches);
    }

    if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targetUsers.push(u);
    }
  });

  if (targetUsers.length === 0) return;

  const title = isManagement
    ? (newRequest.type === 'SUMMON' ? '🚨 Urgent Call From Management' : '🔔 New Management Request')
    : '🔧 New Maintenance Request';

  const body = newRequest.title || newRequest.details || `Branch: ${newRequest.branch || newRequest.targetBranch || ''}`;

  await sendPushAndCleanup(
    usersSnap,
    targetUsers.flatMap((u) => u.fcmTokens),
    title,
    body,
    { requestId: event.params.requestId, type: newRequest.type || 'REQUEST' }
  );
});

// Fires whenever an existing maintenance request ("requests" collection) is updated. The creation
// trigger above only tells management/Facility Managers "a new request came in" - it never told
// (a) the specific technician who actually ends up assigned to do the work, or (b) the person who
// originally submitted the request, once it's done. Both of those are arguably the two notifications
// that matter most for maintenance specifically, so this fills both gaps:
exports.onRequestUpdatedPush = onDocumentUpdated('requests/{requestId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;

  const usersSnap = await db.collection('users').get();
  const usersByUsername = {};
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (u.username) usersByUsername[u.username] = u;
  });

  // (a) Someone new was just put in charge of this task - tell THEM directly, not just whoever
  // happens to have the app open. Covers both the assignment modal (handleConfirmAssignment) and
  // reassigning an already-in-progress task to someone else.
  const assigneeChanged = after.assignedTo && after.assignedTo !== before.assignedTo;
  if (assigneeChanged) {
    const assignee = usersByUsername[after.assignedTo];
    if (assignee && Array.isArray(assignee.fcmTokens) && assignee.fcmTokens.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        assignee.fcmTokens,
        '🔧 You were assigned a maintenance task',
        `${after.title || 'Request'} — Branch: ${after.branch || ''}`,
        { requestId: event.params.requestId, type: 'REQUEST_ASSIGNED' }
      );
    }
  }

  // (b) The request just became Completed - tell the person who originally submitted it, so they
  // find out the moment it's fixed instead of having to go check the app themselves.
  const justCompleted = before.status !== 'Completed' && after.status === 'Completed';
  if (justCompleted && after.createdBy) {
    const requester = usersByUsername[after.createdBy];
    if (requester && Array.isArray(requester.fcmTokens) && requester.fcmTokens.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        requester.fcmTokens,
        '✅ Maintenance Request Completed',
        `${after.title || 'Your request'} — Branch: ${after.branch || ''} is now marked Completed.`,
        { requestId: event.params.requestId, type: 'REQUEST_COMPLETED' }
      );
    }
  }

  // (b2) The request was just marked "Not Applicable" - tell the person who submitted it, plus the
  // Supervisors and Branch Managers assigned to that request's branch, so everyone knows it will not
  // be worked on instead of waiting for it. Each person is notified once, even if they match twice.
  const justNotApplicable = before.status !== 'Not Applicable' && after.status === 'Not Applicable';
  if (justNotApplicable) {
    const naTargets = new Map(); // username -> user data
    if (after.createdBy && usersByUsername[after.createdBy]) {
      naTargets.set(after.createdBy, usersByUsername[after.createdBy]);
    }
    usersSnap.forEach((docSnap) => {
      const u = docSnap.data();
      const role = normRoleUpper(u.role);
      if (role !== 'SUPERVISOR' && role !== 'BRANCH MANAGER') return;
      const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      if (after.branch && theirBranches.includes(after.branch) && u.username) {
        naTargets.set(u.username, u);
      }
    });
    const naTokens = [...naTargets.values()]
      .filter((u) => Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0)
      .flatMap((u) => u.fcmTokens);
    if (naTokens.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        naTokens,
        '🚫 Maintenance Request: Not Applicable',
        `${after.title || 'A request'} — Branch: ${after.branch || ''} was marked Not Applicable.`,
        { requestId: event.params.requestId, type: 'REQUEST_NOT_APPLICABLE' }
      );
    }
  }

  // (c) A previously-Completed request was just REOPENED (status moved away from Completed again -
  // e.g. the same problem came back). This is new work nobody was expecting, so re-alert the people
  // who need to act on it: whoever is currently assigned, plus Admin/CEO and the Facility Manager(s)
  // responsible for that branch (same "who should know about this branch's requests" rule the
  // creation trigger already uses).
  const justReopened = before.status === 'Completed' && after.status !== 'Completed';
  if (justReopened) {
    const reopenTargets = [];
    usersSnap.forEach((docSnap) => {
      const u = docSnap.data();
      const role = normRoleUpper(u.role);
      const isAdminOrCEO = role === 'ADMIN' || role === 'CEO';
      const isFacilityManager = role === 'FACILITY MANAGER';
      const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      const branchMatches = theirBranches.length === 0 || theirBranches.includes(after.branch);
      const isCurrentAssignee = after.assignedTo && u.username === after.assignedTo;
      const shouldNotify = isAdminOrCEO || (isFacilityManager && branchMatches) || isCurrentAssignee;
      if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
        reopenTargets.push(u);
      }
    });

    if (reopenTargets.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        reopenTargets.flatMap((u) => u.fcmTokens),
        '♻️ Maintenance Request Reopened',
        `${after.title || 'Request'} — Branch: ${after.branch || ''} was reopened.`,
        { requestId: event.params.requestId, type: 'REQUEST_REOPENED' }
      );
    }
  }
});

// Checks for any maintenance request that has sat at status "New" (nobody has even started looking
// at it) for 24+ hours, and pushes a reminder to Admin/CEO and the Facility Manager(s) for that
// branch. This is a CALLABLE function (triggered from the app itself), not a Cloud Scheduler job -
// no new Google Cloud API/billing dependency. The app calls it once per session for Admin/CEO/
// Facility Manager accounts (see Dashboard.jsx), so the check effectively runs "whenever one of
// them opens the app" instead of on a fixed clock. Each request is only ever escalated ONCE (marked
// with `staleReminderSentAt` the first time), so it can't spam the same request on every call.
exports.checkStaleRequests = onCall(async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const staleSnap = await db
    .collection('requests')
    .where('status', '==', 'New')
    .get();

  const staleRequests = staleSnap.docs.filter((docSnap) => {
    const r = docSnap.data();
    if (r.staleReminderSentAt) return false; // already escalated once - don't repeat
    const createdAt = r.createdAt?.toDate ? r.createdAt.toDate() : null;
    return createdAt && createdAt <= cutoff;
  });

  if (staleRequests.length === 0) return;

  const usersSnap = await db.collection('users').get();

  for (const docSnap of staleRequests) {
    const r = docSnap.data();
    const targets = [];

    usersSnap.forEach((userDocSnap) => {
      const u = userDocSnap.data();
      const role = normRoleUpper(u.role);
      const isAdminOrCEO = role === 'ADMIN' || role === 'CEO';
      const isFacilityManager = role === 'FACILITY MANAGER';
      const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      const branchMatches = theirBranches.length === 0 || theirBranches.includes(r.branch);
      const shouldNotify = isAdminOrCEO || (isFacilityManager && branchMatches);
      if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
        targets.push(u);
      }
    });

    if (targets.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        targets.flatMap((u) => u.fcmTokens),
        '⏰ Unattended Maintenance Request',
        `${r.title || 'Request'} — Branch: ${r.branch || ''} has had no action for over 24 hours.`,
        { requestId: docSnap.id, type: 'REQUEST_STALE_REMINDER' }
      );
    }

    await docSnap.ref.update({ staleReminderSentAt: FieldValue.serverTimestamp() });
  }

  return { checked: staleRequests.length };
});

// How long after a planned shift's start time, with zero check-in at all, before we flag it as a
// likely no-show. Kept short (30 min) on purpose: the point is to give management time to actually
// call the employee or arrange cover BEFORE the whole shift is lost, not to just confirm afterwards
// that someone was absent (the existing "Plan vs Actual" report already does that after the fact).
const EXPECTED_ABSENCE_GRACE_MINUTES = 30;

// Checks today's planned shifts ("attendancePlans" collection, the Schedule tab) for anyone who was
// due to start 30+ minutes ago and still has no attendance record at all (not even a late check-in,
// at ANY branch) - i.e. a likely no-show - and pushes a heads-up to Admin/CEO and the Branch
// Manager(s)/Supervisor(s) responsible for that branch, so they can act while the shift still matters.
// Same pattern as checkStaleRequests above: a plain CALLABLE function the app pings once per session
// for Admin/CEO/Branch Manager/Supervisor accounts (see Dashboard.jsx) - no Cloud Scheduler involved.
// `todayYmd` and `nowMinutes` are passed in from the browser (its own local wall clock), since that's
// the clock the shift times (e.g. "09:00") were planned against, and is simpler/safer than trying to
// reconstruct Egypt local time from the server's UTC clock. Each plan is only ever alerted ONCE
// (marked with `absenceAlertSentAt`), so it won't re-notify every time someone opens the app.
exports.checkExpectedAbsences = onCall(async (request) => {
  const { todayYmd, nowMinutes } = request.data || {};
  if (!todayYmd || typeof nowMinutes !== 'number') {
    throw new HttpsError('invalid-argument', 'todayYmd and nowMinutes are required.');
  }

  const plansSnap = await db
    .collection('attendancePlans')
    .where('date', '==', todayYmd)
    .get();

  if (plansSnap.empty) return { checked: 0 };

  // Anyone with ANY attendance record today (regardless of branch) is not a no-show, even if
  // they're at the wrong branch - that's a different, already-visible problem ("wrong_branch").
  const attendanceSnap = await db
    .collection('attendance')
    .where('dateStr', '==', todayYmd)
    .get();
  const attendedUsernames = new Set();
  attendanceSnap.forEach((docSnap) => {
    const a = docSnap.data();
    if (a.username) attendedUsernames.add(a.username);
  });

  const duePlans = plansSnap.docs.filter((docSnap) => {
    const p = docSnap.data();
    if (p.absenceAlertSentAt) return false; // already alerted once
    if (!p.startTime || !p.username) return false;
    if (attendedUsernames.has(p.username)) return false;
    const [h, m] = p.startTime.split(':').map(Number);
    const startMinutes = h * 60 + m;
    return nowMinutes >= startMinutes + EXPECTED_ABSENCE_GRACE_MINUTES;
  });

  if (duePlans.length === 0) return { checked: 0 };

  const usersSnap = await db.collection('users').get();

  for (const docSnap of duePlans) {
    const p = docSnap.data();
    const targets = [];

    usersSnap.forEach((userDocSnap) => {
      const u = userDocSnap.data();
      const role = normRoleUpper(u.role);
      const isAdminOrCEO = role === 'ADMIN' || role === 'CEO';
      const isBranchLevel = role === 'BRANCH MANAGER' || role === 'SUPERVISOR';
      const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      const branchMatches = theirBranches.includes(p.branch);
      const shouldNotify = isAdminOrCEO || (isBranchLevel && branchMatches);
      if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
        targets.push(u);
      }
    });

    if (targets.length > 0) {
      await sendPushAndCleanup(
        usersSnap,
        targets.flatMap((u) => u.fcmTokens),
        '⚠️ Possible No-Show',
        `${p.username} was due at ${p.branch} at ${p.startTime} and still hasn't checked in.`,
        { planId: docSnap.id, type: 'EXPECTED_ABSENCE' }
      );
    }

    await docSnap.ref.update({ absenceAlertSentAt: FieldValue.serverTimestamp() });
  }

  return { checked: duePlans.length };
});

// Fires automatically every time a new document is added to the "ceo_requests" collection - this is
// the "CEO Services" tab (a CEO/Admin sending something to whoever is currently checked in at a
// branch, e.g. "bring me a coffee" or an urgent summon). Without this trigger, these never pushed at
// all (only the in-app, tab-must-be-open listener caught them), which is the gap being fixed here.
exports.onNewCeoRequestPush = onDocumentCreated('ceo_requests/{requestId}', async (event) => {
  const newCeoRequest = event.data.data();
  if (!newCeoRequest) return;

  // Whoever is currently checked in (no checkOutTime yet) at the targeted branch - these are the
  // people actually being asked to do something, so they must be notified even with the app closed.
  let activeUsernamesAtTargetBranch = [];
  if (newCeoRequest.targetBranch) {
    const activeAttendanceSnap = await db
      .collection('attendance')
      .where('branch', '==', newCeoRequest.targetBranch)
      .get();

    activeAttendanceSnap.forEach((a) => {
      const rec = a.data();
      const isActive = !rec.checkOutTime && !rec.checkOut;
      if (isActive && rec.username) {
        activeUsernamesAtTargetBranch.push(rec.username);
      }
    });
  }

  const usersSnap = await db.collection('users').get();
  const targetUsers = [];

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    const isAdminOrCEO = role === 'ADMIN' || role === 'CEO';
    // Notify every Admin/CEO (so management sees its own request went out), plus whoever is
    // actually present at the targeted branch right now and needs to act on it.
    const shouldNotify = isAdminOrCEO || activeUsernamesAtTargetBranch.includes(u.username);

    if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targetUsers.push(u);
    }
  });

  if (targetUsers.length === 0) return;

  const title = '🚨 CEO Service Request';
  const body = `${newCeoRequest.serviceType || 'Request'}: ${newCeoRequest.itemDetails || ''} — ${newCeoRequest.targetBranch || ''}`;

  await sendPushAndCleanup(
    usersSnap,
    targetUsers.flatMap((u) => u.fcmTokens),
    title,
    body,
    { requestId: event.params.requestId, type: 'CEO_REQUEST' }
  );
});

// Fires when an employee submits a new leave request ("leaveRequests" collection). The app's own
// submit screen tells the employee "You will be notified once it is reviewed" - but until now
// nothing ever pushed anything, for EITHER side: the approver never got told a request came in,
// and the employee never got told it was approved/rejected (see onLeaveRequestReviewedPush below).
// This is the same kind of gap as the CEO requests one above, just in a different collection.
exports.onNewLeaveRequestPush = onDocumentCreated('leaveRequests/{requestId}', async (event) => {
  const newLeaveRequest = event.data.data();
  if (!newLeaveRequest) return;

  const requestBranches = Array.isArray(newLeaveRequest.assignedBranches) ? newLeaveRequest.assignedBranches : [];

  const usersSnap = await db.collection('users').get();
  const targetUsers = [];

  // A Coach's leave first goes to the branch's Fitness Manager(s) for a first (pre-)approval; the Branch Manager
  // is told once that is given (see onLeaveRequestReviewedPush). If the branch has no Fitness Manager, the
  // Branch Manager is told straight away, as before.
  let requesterIsCoach = false;
  const fitnessManagersHere = [];
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (u.username && u.username === newLeaveRequest.username && u.role === 'Coach') requesterIsCoach = true;
    const theirB = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
    if (u.role === 'Fitness Manager' && theirB.some((b) => requestBranches.includes(b))) fitnessManagersHere.push(docSnap.id);
  });
  const holdForFitnessManager = requesterIsCoach && fitnessManagersHere.length > 0;

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    // Only three roles may approve a leave: Admin, HR, and the Branch Manager of that branch.
    const isTopLevelApprover = role === 'ADMIN' || role === 'HR';
    const isBranchLevelApprover = role === 'BRANCH MANAGER' && !holdForFitnessManager;
    const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
    // Mirrors the app's own "who can approve this" rule (leaveRequestsForApproval in Dashboard.jsx):
    // Admin/HR see every request; a Branch Manager only sees one for a branch they're actually
    // assigned to.
    const branchOverlap = theirBranches.some((b) => requestBranches.includes(b));
    const isFitnessManagerHere = holdForFitnessManager && fitnessManagersHere.includes(docSnap.id);
    const shouldNotify = isTopLevelApprover || (isBranchLevelApprover && branchOverlap) || isFitnessManagerHere;

    if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targetUsers.push(u);
    }
  });

  if (targetUsers.length === 0) return;

  const title = '📝 New Leave Request';
  const who = newLeaveRequest.requesterRole ? `${newLeaveRequest.username || 'Someone'} (${newLeaveRequest.requesterRole})` : (newLeaveRequest.username || 'Someone');
  const where = newLeaveRequest.branch ? ` at ${newLeaveRequest.branch}` : '';
  const body = `${who} requested leave${where}: ${newLeaveRequest.startDate || ''} to ${newLeaveRequest.endDate || ''}`;

  await sendPushAndCleanup(
    usersSnap,
    targetUsers.flatMap((u) => u.fcmTokens),
    title,
    body,
    { requestId: event.params.requestId, type: 'LEAVE_REQUEST' }
  );
});

// Fires when a leave request is approved/rejected (handleLeaveDecision in Dashboard.jsx only
// updates the Firestore doc's `status` - it never notified the employee who asked for the leave,
// despite the app promising it would). We only push once, the moment status actually changes away
// from "Pending", so saving the document again later (e.g. archiving it) doesn't re-notify.
exports.onLeaveRequestReviewedPush = onDocumentUpdated('leaveRequests/{requestId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!before || !after) return;

  const statusJustChanged = before.status !== after.status && after.status !== 'Pending';
  if (!statusJustChanged) return;

  if (!after.username) return;

  const usersSnap = await db.collection('users').get();
  const targetUsers = [];

  // First (pre-)approval by a Fitness Manager: tell the requester it is moving on, and the branch's Branch
  // Managers that a decision is now waiting for them.
  if (after.status === 'Pre-approved' || after.status === 'Pre-rejected') {
    const preRejected = after.status === 'Pre-rejected';
    const branchesOfLeave = Array.isArray(after.assignedBranches) ? after.assignedBranches : [];
    const requesterTokens = [];
    const managerTokens = [];
    usersSnap.forEach((docSnap) => {
      const u = docSnap.data();
      if (!Array.isArray(u.fcmTokens) || u.fcmTokens.length === 0) return;
      if (u.username === after.username) requesterTokens.push(...u.fcmTokens);
      const theirB = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      if (normRoleUpper(u.role) === 'BRANCH MANAGER' && theirB.some((b) => branchesOfLeave.includes(b))) managerTokens.push(...u.fcmTokens);
    });
    if (managerTokens.length > 0) {
      await sendPushAndCleanup(usersSnap, managerTokens, '📝 Leave request needs your decision',
        `${after.username}'s leave (${after.startDate || ''} to ${after.endDate || ''}) was ${preRejected ? 'rejected' : 'pre-approved'} by ${after.preReviewedBy || 'the Fitness Manager'}. The final decision is yours.`,
        { requestId: event.params.requestId, type: 'LEAVE_REQUEST' });
    }
    if (requesterTokens.length > 0) {
      await sendPushAndCleanup(usersSnap, requesterTokens, preRejected ? 'ℹ️ Leave request not recommended' : 'ℹ️ Leave request pre-approved',
        `Your leave request (${after.startDate || ''} to ${after.endDate || ''}) was ${preRejected ? 'rejected by the Fitness Manager' : 'pre-approved'}. It now waits for the Branch Manager's final decision.`,
        { requestId: event.params.requestId, type: 'LEAVE_REQUEST_REVIEWED' });
    }
    return;
  }

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (u.username === after.username && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targetUsers.push(u);
    }
  });

  if (targetUsers.length === 0) return;

  const approved = after.status === 'Approved';
  const title = approved ? '✅ Leave Request Approved' : `ℹ️ Leave Request ${after.status}`;
  const body = `Your leave request (${after.startDate || ''} to ${after.endDate || ''}) was ${after.status.toLowerCase()}.`;

  await sendPushAndCleanup(
    usersSnap,
    targetUsers.flatMap((u) => u.fcmTokens),
    title,
    body,
    { requestId: event.params.requestId, type: 'LEAVE_REQUEST_REVIEWED' }
  );
});

// --------------------------------------------------------------
// "Buzz" buttons: a manual override that force-pushes an immediate alert about one specific
// request, on top of whatever automatic notifications already fired for it. Useful when a request
// has been sitting around and someone wants to personally nudge everyone about it right now,
// regardless of its current status. Admin can Buzz any request; a Branch Manager can only Buzz a
// request that belongs to one of their OWN assigned branches (checked against their Firestore user
// doc server-side - the Branch Manager's assignedBranches is not something the client can fake its
// way around here).
// --------------------------------------------------------------

// Admin, or the Branch Manager of the given branch, may Buzz. Throws if neither.
const assertCanBuzzBranch = async (request, branch) => {
  const callerRole = normRoleUpper(request.auth.token.role);
  if (callerRole === 'ADMIN') return;

  if (callerRole === 'BRANCH MANAGER') {
    const callerDoc = await db.collection('users').doc(request.auth.uid).get();
    const callerBranches = Array.isArray(callerDoc.data()?.assignedBranches) ? callerDoc.data().assignedBranches : [];
    if (branch && callerBranches.includes(branch)) return;
    throw new HttpsError('permission-denied', 'You can only Buzz requests from your own branch.');
  }

  throw new HttpsError('permission-denied', 'Only Admin or that branch\'s Branch Manager can use Buzz.');
};

// Buzz on a maintenance request ("requests" collection): pushes to EVERY Facility Manager and
// EVERY Facility Member (not just whoever's assigned, and not filtered by branch) - whoever Buzzed
// is explicitly asking "whoever can act on this, look at it now".
exports.buzzMaintenanceRequest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const { requestId } = request.data || {};
  if (!requestId) throw new HttpsError('invalid-argument', 'A request is required.');

  const reqDoc = await db.collection('requests').doc(requestId).get();
  if (!reqDoc.exists) throw new HttpsError('not-found', 'That maintenance request no longer exists.');
  const r = reqDoc.data();

  await assertCanBuzzBranch(request, r.branch);

  const usersSnap = await db.collection('users').get();
  const targets = [];
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    const isFacilityPerson = role === 'FACILITY MANAGER' || role === 'FACILITY MEMBER';
    if (isFacilityPerson && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targets.push(u);
    }
  });

  if (targets.length === 0) return { notified: 0 };

  await sendPushAndCleanup(
    usersSnap,
    targets.flatMap((u) => u.fcmTokens),
    '🔔 Buzz: Needs Attention',
    `${r.title || 'Maintenance Request'} — Branch: ${r.branch || ''} (Status: ${r.status || 'New'})`,
    { requestId, type: 'REQUEST_BUZZ' }
  );

  return { notified: targets.length };
});

// Buzz on a CEO Service request ("ceo_requests" collection): pushes to whoever is currently checked
// in (no checkOutTime yet) at the request's target branch - these are the people physically there who
// can actually act on it right now - telling them it needs an urgent response.
exports.buzzCeoRequest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const { requestId } = request.data || {};
  if (!requestId) throw new HttpsError('invalid-argument', 'A request is required.');

  const reqDoc = await db.collection('ceo_requests').doc(requestId).get();
  if (!reqDoc.exists) throw new HttpsError('not-found', 'That CEO request no longer exists.');
  const r = reqDoc.data();

  await assertCanBuzzBranch(request, r.targetBranch);

  if (!r.targetBranch) return { notified: 0 };

  const activeAttendanceSnap = await db
    .collection('attendance')
    .where('branch', '==', r.targetBranch)
    .get();

  const activeUsernames = new Set();
  activeAttendanceSnap.forEach((a) => {
    const rec = a.data();
    const isActive = !rec.checkOutTime && !rec.checkOut;
    if (isActive && rec.username) activeUsernames.add(rec.username);
  });

  if (activeUsernames.size === 0) return { notified: 0 };

  const usersSnap = await db.collection('users').get();
  const targets = [];
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (activeUsernames.has(u.username) && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targets.push(u);
    }
  });

  if (targets.length === 0) return { notified: 0 };

  await sendPushAndCleanup(
    usersSnap,
    targets.flatMap((u) => u.fcmTokens),
    '🚨 Buzz: Urgent Response Needed',
    `${r.serviceType || 'CEO Request'}: ${r.itemDetails || ''} — Branch: ${r.targetBranch} needs this handled now.`,
    { requestId, type: 'CEO_REQUEST_BUZZ' }
  );

  return { notified: targets.length };
});

// =====================================================================
// AUDIT LOG + UNDO-DELETE
// -----------------------------------------------------------------
// Every create/update/delete across the collections below is recorded in a single `auditLog`
// collection - who did it, when, and (for update/delete) what the record looked like before the
// change, so a deletion can be reversed later.
//
// CREATE and UPDATE are logged by a Firestore trigger (onDocumentWritten) on each collection -
// this is deliberate: it fires no matter which part of the app wrote the change, so every one of
// the dozens of existing addDoc/updateDoc call sites across Dashboard.jsx is covered automatically,
// with no risk of a spot being missed or forgotten later. The trade-off is that a trigger has no
// request.auth of its own - it only sees the document - so "who did this" is a best-effort guess
// pulled from whichever actor field the document already carries (createdBy, statusUpdatedBy,
// manualCheckoutBy, etc. - this app already stamps one of those on nearly every write).
//
// DELETE is handled differently, on purpose: a deleted document has nothing left to read an actor
// field from, so there is no reliable way to attribute a delete after the fact from a trigger alone.
// Instead, every delete button in the app now calls the deleteRecordWithAudit callable below BEFORE
// the record is removed - it captures a full snapshot and the real signed-in caller, then deletes.
// That snapshot is what undoDelete uses to restore the record exactly as it was.
// =====================================================================

// =====================================================================
// Maintenance request numbers - self-explanatory, 17 digits:
//   BBB  YY  MM  DD  SSSSSS  RR
//   BBB    3-digit branch code (assigned once per branch, first come first served: 001, 002, ...)
//   YY MM DD  the date the request was created (Cairo time)
//   SSSSSS 6-digit running number of maintenance requests within that year (restarts each January)
//   RR     2 random digits at the end
// The running number comes from a counter updated inside a transaction, so two requests created at the
// same moment can never get the same number - the random digits are an extra, not the uniqueness guarantee.
// A Firestore trigger (not the browser) assigns it, so it cannot be skipped or forged from the app; the
// number shows up on the request a second or so after it is submitted.
// =====================================================================
exports.assignRequestNumber = onDocumentCreated('requests/{requestId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data() || {};
  if (data.requestNumber) return;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const fullYear = get('year');
  const yy = fullYear.slice(-2);
  const mm = get('month');
  const dd = get('day');
  const branchName = (data.branch || '').trim();
  const randomDigits = String(require('crypto').randomInt(0, 100)).padStart(2, '0');

  const branchCodesRef = db.collection('counters').doc('branchCodes');
  const yearRef = db.collection('counters').doc(`requests_${fullYear}`);

  await db.runTransaction(async (tx) => {
    const [codesSnap, yearSnap, reqSnap] = await Promise.all([tx.get(branchCodesRef), tx.get(yearRef), tx.get(snap.ref)]);
    if (reqSnap.exists && reqSnap.data().requestNumber) return; // already numbered (retry)

    const codesData = codesSnap.exists ? codesSnap.data() : { codes: {}, next: 1 };
    const codes = codesData.codes || {};
    let branchCode = '000';
    if (branchName) {
      if (codes[branchName]) {
        branchCode = codes[branchName];
      } else {
        const next = codesData.next || Object.keys(codes).length + 1;
        branchCode = String(next).padStart(3, '0');
        tx.set(branchCodesRef, { codes: { ...codes, [branchName]: branchCode }, next: next + 1 });
      }
    }

    const seq = (yearSnap.exists ? yearSnap.data().count || 0 : 0) + 1;
    tx.set(yearRef, { count: seq });

    const requestNumber = `${branchCode}${yy}${mm}${dd}${String(seq).padStart(6, '0')}${randomDigits}`;
    tx.update(snap.ref, { requestNumber });
  });
});


// =====================================================================
// Attendance selfies: deleted automatically 60 days after check-in.
// The photos live in Cloudinary, so deleting needs Cloudinary's API key + secret. They are read from the
// Firestore document appConfig/cloudinary = { apiKey, apiSecret }, which no client can read (the rules have
// no entry for appConfig, so it is denied to everyone; only these functions can). Until that document
// exists this function does nothing and the photos are simply kept.
// There is no scheduler: the app calls this when HR / Admin / a Branch Manager opens it, and the function
// itself only runs a cleanup pass at most once every 12 hours.
// =====================================================================
const CLOUDINARY_CLOUD_NAME = 'gwgnpo4v';
const PHOTO_RETENTION_DAYS = 60;

// ".../image/upload/v1700000000/folder/abc123.jpg" -> "folder/abc123"
const cloudinaryPublicIdFromUrl = (url) => {
  try {
    const m = String(url).match(/\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?([^?]+?)(?:\.[a-zA-Z0-9]+)?(?:\?.*)?$/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) { return null; }
};

const destroyCloudinaryImage = async (publicId, apiKey, apiSecret) => {
  const crypto = require('crypto');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`).digest('hex');
  const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: apiKey, signature });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  // "not found" means it is already gone - that counts as deleted.
  return res.ok && (json.result === 'ok' || json.result === 'not found');
};

exports.purgeOldAttendancePhotos = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const role = normRoleUpper(request.auth.token.role).toLowerCase();
  if (!['admin', 'hr', 'branch manager'].includes(role)) throw new HttpsError('permission-denied', 'Not allowed.');

  const cfgSnap = await db.collection('appConfig').doc('cloudinary').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : null;
  if (!cfg || !cfg.apiKey || !cfg.apiSecret) return { skipped: 'cloudinary-not-configured' };

  // At most one cleanup pass per 12 hours, whoever asks.
  const stateRef = db.collection('counters').doc('photoPurge');
  const now = Date.now();
  const gate = await db.runTransaction(async (tx) => {
    const st = await tx.get(stateRef);
    const last = st.exists && st.data().lastRunMs ? st.data().lastRunMs : 0;
    if (now - last < 12 * 60 * 60 * 1000) return null;
    tx.set(stateRef, { lastRunMs: now }, { merge: true });
    return { cursorMs: st.exists && st.data().cursorMs ? st.data().cursorMs : 0 };
  });
  if (!gate) return { skipped: 'ran-recently' };

  // Walk the attendance records older than the retention period, oldest first, from where the last pass
  // stopped (the cursor), so already-cleaned records are never re-scanned.
  const cutoff = Timestamp.fromMillis(now - PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const old = await db.collection('attendance')
    .where('checkInTime', '>', Timestamp.fromMillis(gate.cursorMs))
    .where('checkInTime', '<', cutoff)
    .orderBy('checkInTime', 'asc').limit(400).get();

  let deleted = 0;
  let failed = 0;
  let cursorMs = gate.cursorMs;
  let stalled = false;
  for (const docSnap of old.docs) {
    const rec = docSnap.data();
    const recMs = rec.checkInTime && rec.checkInTime.toMillis ? rec.checkInTime.toMillis() : null;
    let recordOk = true;

    if (rec.photosPrivate && !rec.photosPurgedAt) {
      const photoRef = docSnap.ref.collection('attendancePhotos').doc('photos');
      const photoSnap = await photoRef.get();
      if (photoSnap.exists) {
        const p = photoSnap.data();
        for (const url of [p.checkInPhoto, p.checkOutPhoto]) {
          if (typeof url !== 'string' || !url.startsWith('http')) continue;
          const publicId = cloudinaryPublicIdFromUrl(url);
          let ok = false;
          if (publicId) {
            try { ok = await destroyCloudinaryImage(publicId, cfg.apiKey, cfg.apiSecret); } catch (e) { ok = false; }
          }
          if (ok) deleted += 1; else { failed += 1; recordOk = false; }
        }
        if (recordOk) await photoRef.delete();
      }
      if (recordOk) await docSnap.ref.update({ photosPurgedAt: FieldValue.serverTimestamp() });
    }

    if (!recordOk) stalled = true;           // retry this record next pass
    if (!stalled && recMs) cursorMs = recMs; // only move the cursor past records that are fully done
  }
  await stateRef.set({ cursorMs }, { merge: true });
  return { deleted, failed };
});

// One-time migration: older attendance records still carry the selfie links on the record itself (readable by
// every signed-in account). Admin-only; moves them into the locked attendancePhotos document and strips them
// from the record. Runs in batches and is safe to run repeatedly until it reports 0 left.
// --------------------------------------------------------------
// migratePhonesToPrivate (Admin only, safe to run more than once):
// moves every account's phone number out of the users directory (readable by every signed-in
// account) into userPrivate/{uid} (readable only by Admin, the account itself and the managers
// who need it), then removes the phone field from the users document.
// --------------------------------------------------------------
exports.migratePhonesToPrivate = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (normRoleUpper(request.auth.token.role).toLowerCase() !== 'admin') throw new HttpsError('permission-denied', 'Admin only.');

  const snap = await db.collection('users').get();
  let moved = 0;
  let batch = db.batch();
  let ops = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (!('phone' in data)) continue;
    batch.set(db.collection('userPrivate').doc(docSnap.id), { phone: String(data.phone || '') }, { merge: true });
    batch.update(docSnap.ref, { phone: FieldValue.delete() });
    moved++;
    ops += 2;
    if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
  }
  if (ops > 0) await batch.commit();
  return { moved };
});

exports.migrateAttendancePhotos = onCall({ timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (normRoleUpper(request.auth.token.role).toLowerCase() !== 'admin') throw new HttpsError('permission-denied', 'Admin only.');

  const snap = await db.collection('attendance').where('checkInPhoto', '>', '').limit(200).get();
  let migrated = 0;
  for (const docSnap of snap.docs) {
    const rec = docSnap.data();
    const photoRef = docSnap.ref.collection('attendancePhotos').doc('photos');
    const existing = await photoRef.get();
    const merged = {
      attendanceId: docSnap.id,
      username: rec.username || '',
      branch: rec.branch || '',
      checkInPhoto: rec.checkInPhoto || (existing.exists ? existing.data().checkInPhoto : '') || '',
      checkOutPhoto: rec.checkOutPhoto || (existing.exists ? existing.data().checkOutPhoto : null) || null,
      createdAt: existing.exists && existing.data().createdAt ? existing.data().createdAt : (rec.checkInTime || FieldValue.serverTimestamp())
    };
    const batch = db.batch();
    batch.set(photoRef, merged);
    batch.update(docSnap.ref, { checkInPhoto: FieldValue.delete(), checkOutPhoto: FieldValue.delete(), photosPrivate: true });
    await batch.commit();
    migrated += 1;
  }
  // Records whose only photo is a check-out one (no check-in photo link).
  const snap2 = await db.collection('attendance').where('checkOutPhoto', '>', '').limit(200).get();
  for (const docSnap of snap2.docs) {
    const rec = docSnap.data();
    const photoRef = docSnap.ref.collection('attendancePhotos').doc('photos');
    const existing = await photoRef.get();
    const batch = db.batch();
    batch.set(photoRef, {
      attendanceId: docSnap.id,
      username: rec.username || '',
      branch: rec.branch || '',
      checkInPhoto: existing.exists ? (existing.data().checkInPhoto || '') : '',
      checkOutPhoto: rec.checkOutPhoto,
      createdAt: existing.exists && existing.data().createdAt ? existing.data().createdAt : (rec.checkInTime || FieldValue.serverTimestamp())
    });
    batch.update(docSnap.ref, { checkOutPhoto: FieldValue.delete(), photosPrivate: true });
    await batch.commit();
    migrated += 1;
  }
  return { migrated };
});


const AUDITED_COLLECTIONS = [
  'requests', 'ceo_requests', 'leaveRequests', 'integrityReports',
  'attendance', 'users', 'locationViolations', 'attendancePlans', 'branches', 'categories',
  'towelTransactions'
];

// Collections a record may be deleted (and later undone) from via deleteRecordWithAudit.
// Deliberately excludes 'users' (account deletion already has its own dedicated, more careful
// flow elsewhere) and 'integrityReports' (deleting one also needs to remove its private/reporter
// subdocument, which this generic helper doesn't know about - that stays on its own path in
// IntegrityReports.jsx, but is still logged to auditLog the same way for visibility/undo).
const DELETABLE_COLLECTIONS = new Set([
  'requests', 'ceo_requests', 'leaveRequests', 'attendance', 'locationViolations', 'branches', 'categories', 'integrityReports',
  'towelTransactions'
]);

// Best-effort guess at who made a create/update, from whichever field the doc already carries.
const guessActorUsername = (data) => {
  if (!data) return 'Unknown';
  return data.statusUpdatedBy || data.manualCheckoutBy || data.assignedBy || data.createdByUsername || data.createdBy || 'Unknown';
};

AUDITED_COLLECTIONS.forEach((collectionName) => {
  const fnName = `audit_${collectionName.replace(/[^a-zA-Z0-9]/g, '_')}`;
  exports[fnName] = onDocumentWritten(`${collectionName}/{docId}`, async (event) => {
    const beforeSnap = event.data.before;
    const afterSnap = event.data.after;
    const before = beforeSnap.exists ? beforeSnap.data() : null;
    const after = afterSnap.exists ? afterSnap.data() : null;

    // Deletions are intentionally NOT logged here (see comment above) - a write that lands here
    // with no "after" is either a delete that went through deleteRecordWithAudit (which already
    // wrote its own, more accurate entry) or one made directly in the Firebase console, which has
    // nothing useful to attribute. Either way, skip it to avoid a second, actor-less duplicate.
    if (!after) return;

    // The system stamping a request number right after creation is not a person's edit - don't log it.
    if (before && collectionName === 'requests') {
      const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length > 0 && changed.every((k) => k === 'requestNumber')) return;
    }
    // Same for the automatic 30-day photo cleanup on attendance records.
    if (before && collectionName === 'attendance') {
      const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length > 0 && changed.every((k) => ['checkInPhoto', 'checkOutPhoto', 'photosPrivate', 'photosPurgedAt'].includes(k))) return;
    }

    await db.collection('auditLog').add({
      action: before ? 'update' : 'create',
      collectionName,
      docId: event.params.docId,
      branch: after.branch || after.targetBranch || null,
      before: before || null,
      after,
      performedByUsername: guessActorUsername(after),
      createdAt: FieldValue.serverTimestamp(),
      restored: false
    });
  });
});

// Admin-only: deletes a record and writes a full before-snapshot to auditLog first, atomically
// enough for this purpose (the snapshot is written, then the delete happens - if the delete step
// somehow failed, worst case is a harmless orphaned audit entry, never a silent unlogged delete).
exports.deleteRecordWithAudit = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const callerRole = normRoleUpper(request.auth.token.role);
  if (callerRole !== 'ADMIN') {
    throw new HttpsError('permission-denied', 'Only Admin can delete records.');
  }

  const { collectionName, docId } = request.data || {};
  if (!collectionName || !docId || !DELETABLE_COLLECTIONS.has(collectionName)) {
    throw new HttpsError('invalid-argument', 'A valid collection and record are required.');
  }

  const ref = db.collection(collectionName).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That record no longer exists.');
  const data = snap.data();

  const callerDoc = await db.collection('users').doc(request.auth.uid).get();
  const callerUsername = callerDoc.data()?.username || request.auth.uid;

  // integrityReports also has a private/reporter subdocument holding the reporter's identity -
  // capture it into the SAME audit entry (as beforePrivate) before removing it, so undoDelete can
  // bring back both documents together. Without this, restoring a deleted integrity report would
  // bring the content back but permanently lose who reported it.
  let beforePrivate = null;
  if (collectionName === 'integrityReports') {
    const privateSnap = await db.collection('integrityReports').doc(docId).collection('private').doc('reporter').get();
    if (privateSnap.exists) beforePrivate = privateSnap.data();
  }

  const auditRef = db.collection('auditLog').doc();
  await auditRef.set({
    action: 'delete',
    collectionName,
    docId,
    branch: data.branch || data.targetBranch || null,
    before: data,
    beforePrivate,
    after: null,
    performedByUsername: callerUsername,
    createdAt: FieldValue.serverTimestamp(),
    restored: false
  });

  if (collectionName === 'integrityReports') {
    await db.collection('integrityReports').doc(docId).collection('private').doc('reporter').delete().catch(() => {});
  }

  await ref.delete();

  return { success: true, auditId: auditRef.id };
});

// Admin-only: undoes ANY audit entry, not just a deletion -
//   - 'delete' -> restores the record from its before-snapshot (and the integrityReports private
//     subdocument alongside it, if this was one of those).
//   - 'update'  -> rolls the record back to exactly what it looked like right before that specific
//     edit. Note for whoever clicks it: if the record has been edited AGAIN since the entry being
//     undone, this overwrites those later edits too - it rewinds to that one point in time, it
//     doesn't selectively revert just one field. The confirm dialog on the client says as much.
//   - 'create'  -> removes the record (undoing its creation). This is itself logged as a fresh
//     'delete' entry with a snapshot of whatever the record looked like at that moment, so even
//     undoing a creation can be undone again afterwards if that turns out to be a mistake too.
exports.undoAuditEntry = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const callerRole = normRoleUpper(request.auth.token.role);
  if (callerRole !== 'ADMIN') {
    throw new HttpsError('permission-denied', 'Only Admin can undo an action.');
  }

  const { auditId } = request.data || {};
  if (!auditId) throw new HttpsError('invalid-argument', 'An audit entry is required.');

  const auditRef = db.collection('auditLog').doc(auditId);
  const auditSnap = await auditRef.get();
  if (!auditSnap.exists) throw new HttpsError('not-found', 'That audit entry no longer exists.');
  const entry = auditSnap.data();

  if (entry.restored) throw new HttpsError('failed-precondition', 'This action was already undone.');

  const callerDoc = await db.collection('users').doc(request.auth.uid).get();
  const callerUsername = callerDoc.data()?.username || request.auth.uid;
  const recordRef = db.collection(entry.collectionName).doc(entry.docId);

  if (entry.action === 'delete') {
    if (!entry.before) throw new HttpsError('failed-precondition', 'No saved copy of this record exists to restore.');
    await recordRef.set(entry.before);
    if (entry.collectionName === 'integrityReports' && entry.beforePrivate) {
      await recordRef.collection('private').doc('reporter').set(entry.beforePrivate);
    }
  } else if (entry.action === 'update') {
    if (!entry.before) throw new HttpsError('failed-precondition', 'No earlier version of this record was saved.');
    await recordRef.set(entry.before);
  } else if (entry.action === 'create') {
    const currentSnap = await recordRef.get();
    if (currentSnap.exists) {
      const currentData = currentSnap.data();
      let beforePrivate = null;
      if (entry.collectionName === 'integrityReports') {
        const privateSnap = await recordRef.collection('private').doc('reporter').get();
        if (privateSnap.exists) beforePrivate = privateSnap.data();
      }
      await db.collection('auditLog').add({
        action: 'delete',
        collectionName: entry.collectionName,
        docId: entry.docId,
        branch: currentData.branch || currentData.targetBranch || null,
        before: currentData,
        beforePrivate,
        after: null,
        performedByUsername: callerUsername,
        createdAt: FieldValue.serverTimestamp(),
        restored: false
      });
      if (entry.collectionName === 'integrityReports') {
        await recordRef.collection('private').doc('reporter').delete().catch(() => {});
      }
    }
    await recordRef.delete();
  } else {
    throw new HttpsError('failed-precondition', 'This type of action cannot be undone.');
  }

  await auditRef.update({
    restored: true,
    restoredAt: FieldValue.serverTimestamp(),
    restoredBy: callerUsername
  });

  return { success: true };
});

/* =====================================================================
   OUTSOURCE MAINTENANCE - an outside maintenance technician who has to be escorted while working at a branch.

   Everything that changes a request goes through the two functions below (the Firestore rules let clients
   only READ outsourceVisits / outsourcePrivate), so the approval rules cannot be bypassed from the browser console:

   - Who may ask: Admin, CEO, QA (Member / Manager), Facility Manager, Branch Manager (and Branch Manager+).
     A Branch Manager only for their own branches.
   - The place comes from the Admin's list (outsourceAreas). A place marked `sensitive` (by default "Women Toilets")
     needs TWO approvals: the Branch Manager AND the Supervisor of that branch (both assigned to it) - OR the
     approval of an Admin, which is enough on its own, anywhere. Whoever approved then chooses the escort: themselves, the other approver, or a User / Supervisor assigned to the branch.
   - Any other place needs ONE approval from a User / Supervisor checked in at that branch, a Branch Manager of
     the branch, or an Admin - and the approver becomes the escort straight away.
   - Nobody approves their own request, except an Admin. Only an Admin can delete a request.
   - The request states how many technicians will enter (1-20); only that number is allowed in. The ID, photo and phone
     are of ONE of them. The escort must confirm the head-count when starting; sensitive places also need the
     two confirmations (area closed / area checked).
   - The national ID number + its photo are stored in outsourcePrivate/{id}, never in the public request document.
   ===================================================================== */
const OS_REQUESTERS = new Set(['ADMIN', 'CEO', 'QA', 'FACILITY MANAGER', 'BRANCH MANAGER']);
const OS_PRESENCE_MAX_MS = 16 * 60 * 60 * 1000;
const OS_MAX_PHOTO_CHARS = 900000; // ~650 KB of JPEG once base64-encoded; the app sends 100-250 KB

const toEnglishDigits = (v) => String(v == null ? '' : v)
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
  .trim();

const osIsPresentAt = (presenceSnap, branch) => {
  if (!presenceSnap || !presenceSnap.exists) return false;
  const d = presenceSnap.data();
  const at = d.attendanceCheckIn && d.attendanceCheckIn.toMillis ? d.attendanceCheckIn.toMillis() : 0;
  return d.branch === branch && at > 0 && Date.now() - at < OS_PRESENCE_MAX_MS;
};

const osPush = async (usersSnap, uids, title, body, type, requestId) => {
  const wanted = new Set(uids.filter(Boolean));
  const tokens = [];
  usersSnap.forEach((docSnap) => {
    if (!wanted.has(docSnap.id)) return;
    const u = docSnap.data();
    if (Array.isArray(u.fcmTokens)) tokens.push(...u.fcmTokens);
  });
  if (tokens.length === 0) return;
  try {
    await sendPushAndCleanup(usersSnap, tokens, title, body, { requestId, type });
  } catch (err) {
    console.warn('Outsource push failed:', err.message);
  }
};

// Everyone who should be kept in the loop about a request: every System Admin, Facility Manager and QA, plus the
// Branch Managers and Supervisors assigned to the request's branch.
const osStakeholders = (usersSnap, branch) => {
  const ids = [];
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    const here = Array.isArray(u.assignedBranches) && u.assignedBranches.includes(branch);
    if (role === 'ADMIN' || role === 'FACILITY MANAGER' || role === 'QA') ids.push(docSnap.id);
    else if ((role === 'BRANCH MANAGER' || role === 'SUPERVISOR') && here) ids.push(docSnap.id);
  });
  return ids;
};

exports.createOutsourceRequest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');

  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  if (!callerSnap.exists) throw new HttpsError('permission-denied', 'Your profile was not found.');
  const caller = await withRole(callerSnap.data());
  const callerRole = normRoleUpper(caller.role);
  if (!permAllowed(caller, 'outsourceRequest', OS_REQUESTERS.has(callerRole) && caller.role !== 'Coach' && caller.role !== 'Fitness Manager')) {
    throw new HttpsError('permission-denied', 'Your account cannot request outsource maintenance.');
  }

  const d = request.data || {};
  const workerName = String(d.workerName || '').trim().replace(/\s+/g, ' ');
  const nationalId = toEnglishDigits(d.nationalId);
  const phone = toEnglishDigits(d.phone);
  const company = String(d.company || '').trim();
  const description = String(d.description || '').trim();
  const typeList = [...new Set((Array.isArray(d.maintenanceTypes) ? d.maintenanceTypes : [d.maintenanceType]).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 10);
  const maintenanceType = typeList.join(', ');
  const branch = String(d.branch || '').trim();
  const areaList = [...new Set((Array.isArray(d.areaNames) ? d.areaNames : [d.area]).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 10);
  const areaName = areaList.join(', ');
  const idPhoto = String(d.idPhoto || '');
  const countMayIncrease = d.countMayIncrease === true;
  const expectedDate = String(d.expectedDate || '').trim();
  const expectedTime = String(d.expectedTime || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate) || Number.isNaN(Date.parse(expectedDate))) {
    throw new HttpsError('invalid-argument', 'Please choose the expected date of the maintenance.');
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(expectedTime)) {
    throw new HttpsError('invalid-argument', 'Please choose the expected time of the maintenance.');
  }
  const todayCairo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (expectedDate < todayCairo) throw new HttpsError('invalid-argument', 'The expected date cannot be in the past.');
  const workerCount = Number(d.workerCount);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 20) {
    throw new HttpsError('invalid-argument', 'Please enter how many technicians will enter (1 to 20).');
  }

  if (workerName.split(' ').filter((w) => w.length >= 2).length < 2 || workerName.length > 80) {
    throw new HttpsError('invalid-argument', 'Please enter the technician\'s full name (at least two names).');
  }
  if (!/^[0-9]{14}$/.test(nationalId)) throw new HttpsError('invalid-argument', 'The national ID must be exactly 14 digits.');
  if (!/^01[0-9]{9}$/.test(phone)) throw new HttpsError('invalid-argument', 'The phone number must be 11 digits and start with 01.');
  if (company.length < 2 || company.length > 100) throw new HttpsError('invalid-argument', 'Please enter the maintenance company name.');
  if (description.length < 3 || description.length > 1000) throw new HttpsError('invalid-argument', 'Please describe the maintenance work.');
  if (!branch) throw new HttpsError('invalid-argument', 'Please choose the branch.');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(idPhoto) || idPhoto.length > OS_MAX_PHOTO_CHARS) {
    throw new HttpsError('invalid-argument', 'Please attach a photo of the national ID (a normal photo, not too large).');
  }

  if (typeList.length === 0) throw new HttpsError('invalid-argument', 'Please choose a type of maintenance from the list.');
  if (areaList.length === 0) throw new HttpsError('invalid-argument', 'Please choose the place of the maintenance from the list.');
  const [branchSnap, catSnaps, areaSnaps] = await Promise.all([
    db.collection('branches').where('name', '==', branch).limit(1).get(),
    Promise.all(typeList.map((t) => db.collection('categories').where('name', '==', t).limit(1).get())),
    Promise.all(areaList.map((a) => db.collection('outsourceAreas').where('name', '==', a).limit(1).get()))
  ]);
  if (branchSnap.empty) throw new HttpsError('invalid-argument', 'That branch does not exist.');
  if (catSnaps.some((x) => x.empty)) throw new HttpsError('invalid-argument', 'Please choose a type of maintenance from the list.');
  if (areaSnaps.some((x) => x.empty)) throw new HttpsError('invalid-argument', 'Please choose the place of the maintenance from the list.');
  const sensitive = areaSnaps.some((x) => x.docs[0].data().sensitive === true); // decided here, never by the browser

  const callerBranches = Array.isArray(caller.assignedBranches) ? caller.assignedBranches : [];
  if (callerRole === 'BRANCH MANAGER' && callerBranches.length > 0 && !callerBranches.includes(branch)) {
    throw new HttpsError('permission-denied', 'You can only request outsource maintenance at your own branches.');
  }

  const ref = db.collection('outsourceVisits').doc();
  const batch = db.batch();
  batch.set(ref, {
    maintenanceType, description, workerName, workerCount, phone, company, branch, area: areaName, sensitive, countMayIncrease, expectedDate, expectedTime,
    required: sensitive ? 2 : 1,
    status: 'Pending',
    approvals: [],
    createdByUid: request.auth.uid,
    createdBy: caller.username || '',
    createdByRole: caller.role || '',
    createdAt: FieldValue.serverTimestamp(),
    history: [{ action: 'Requested', by: caller.username || '', role: caller.role || '', at: Timestamp.now() }]
  });
  batch.set(db.collection('outsourcePrivate').doc(ref.id), {
    nationalId, idPhoto, branch, createdByUid: request.auth.uid, escortUid: '', createdAt: FieldValue.serverTimestamp()
  });
  await batch.commit();

  // Who gets told:
  //  - sensitive place: the Branch Manager(s) and Supervisor(s) of the branch, its Users, Admin, Facility Manager,
  //    Facility Members and QA
  //  - normal place: whoever is checked in at the branch (Users / Supervisors), its Branch Managers and Admins
  try {
    const usersSnap = await db.collection('users').get();
    const presenceSnap = await db.collection('presence').where('branch', '==', branch).get();
    const presentUids = new Set();
    presenceSnap.forEach((p) => { if (osIsPresentAt(p, branch)) presentUids.add(p.id); });
    const targets = [];
    usersSnap.forEach((docSnap) => {
      if (docSnap.id === request.auth.uid) return;
      const u = docSnap.data();
      const role = normRoleUpper(u.role);
      const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
      const here = theirBranches.includes(branch);
      if (sensitive) {
        if (role === 'ADMIN' || role === 'FACILITY MANAGER' || role === 'FACILITY MEMBER' || role === 'QA') targets.push(docSnap.id);
        else if ((role === 'BRANCH MANAGER' || role === 'SUPERVISOR' || role === 'USER' || role === 'STAFF') && here) targets.push(docSnap.id);
      } else if ((role === 'USER' || role === 'STAFF' || role === 'SUPERVISOR') && presentUids.has(docSnap.id)) targets.push(docSnap.id);
      else if (role === 'BRANCH MANAGER' && here) targets.push(docSnap.id);
      else if (role === 'ADMIN') targets.push(docSnap.id);
    });
    // plus every System Admin, Facility Manager, QA and the branch's Branch Managers / Supervisors
    osStakeholders(usersSnap, branch).forEach((uid) => { if (uid !== request.auth.uid) targets.push(uid); });
    await osPush(
      usersSnap, [...new Set(targets)],
      sensitive ? '🧑‍🔧 Outsource maintenance - sensitive place' : '🧑‍🔧 Outsource maintenance request',
      `${maintenanceType} - ${workerCount}${countMayIncrease ? '+ (may increase)' : ''} technician(s), ${company} - ${branch}, ${areaName} - ${expectedDate} ${expectedTime}`,
      'OUTSOURCE_NEW', ref.id
    );
  } catch (err) {
    console.warn('Outsource notification failed:', err.message);
  }

  return { id: ref.id };
});

exports.respondOutsourceRequest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const { id, action, reason, confirmClosed, confirmReopened, confirmCount, escortUid } = request.data || {};
  if (typeof id !== 'string' || !id) throw new HttpsError('invalid-argument', 'A request is required.');
  if (!['approve', 'reject', 'start', 'finish', 'cancel', 'setEscort', 'delete'].includes(action)) throw new HttpsError('invalid-argument', 'Unknown action.');

  const callerUid = request.auth.uid;
  const callerSnap = await db.collection('users').doc(callerUid).get();
  if (!callerSnap.exists) throw new HttpsError('permission-denied', 'Your profile was not found.');
  const caller = await withRole(callerSnap.data());
  const role = normRoleUpper(caller.role);
  const isAdmin = role === 'ADMIN';
  const isBM = role === 'BRANCH MANAGER';
  const isSup = role === 'SUPERVISOR';
  const isUser = role === 'USER' || role === 'STAFF';
  const bucket = isBM ? 'BM' : isSup ? 'SUP' : '';
  const callerBranches = Array.isArray(caller.assignedBranches) ? caller.assignedBranches : [];
  const callerName = caller.username || '';

  // the escort candidate (setEscort) is read before the transaction
  let escortDoc = null;
  if (action === 'setEscort') {
    if (typeof escortUid !== 'string' || !escortUid) throw new HttpsError('invalid-argument', 'Please choose the escort.');
    const eSnap = await db.collection('users').doc(escortUid).get();
    if (!eSnap.exists) throw new HttpsError('not-found', 'That person no longer exists.');
    escortDoc = { id: eSnap.id, ...eSnap.data() };
  }

  const ref = db.collection('outsourceVisits').doc(id);
  const privRef = db.collection('outsourcePrivate').doc(id);
  const result = { notify: null };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That request no longer exists.');
    const g = snap.data();
    const presenceSnap = await tx.get(db.collection('presence').doc(callerUid));
    const present = osIsPresentAt(presenceSnap, g.branch);
    const stamp = { action: '', by: callerName, role: caller.role || '', at: Timestamp.now() };
    const assignedHere = callerBranches.includes(g.branch);

    // Admin only: remove a request completely (any status), together with its locked ID document.
    if (action === 'delete') {
      if (!isAdmin) throw new HttpsError('permission-denied', 'Only an Admin can delete outsource requests.');
      tx.delete(ref);
      tx.delete(privRef);
      return;
    }

    // may this person decide on this request?
    const eligible = () => {
      if (isAdmin) return true;
      if (!permAllowed(caller, 'outsourceApprove', ['Branch Manager', 'Branch Manager+', 'Supervisor', 'User', 'Staff'].includes(caller.role))) return false;
      if (g.sensitive) return (isBM || isSup) && assignedHere;
      if (isBM) return assignedHere;
      if (isSup || isUser) return present;
      return false;
    };

    if (action === 'approve') {
      if (g.status !== 'Pending') throw new HttpsError('failed-precondition', 'This request is no longer waiting for approval.');
      // Nobody approves their own request - except an Admin.
      if (g.createdByUid === callerUid && !isAdmin) throw new HttpsError('permission-denied', 'You cannot approve your own request.');
      if (!eligible()) {
        throw new HttpsError('permission-denied', g.sensitive
          ? `Only the Branch Manager and the Supervisor assigned to ${g.branch} can approve this place.`
          : isBM ? 'You can only approve requests for your own branches.' : `You must be checked in at ${g.branch} to approve this request.`);
      }
      const approvals = Array.isArray(g.approvals) ? g.approvals : [];
      if (approvals.some((a) => a.uid === callerUid)) throw new HttpsError('failed-precondition', 'You already approved this request.');
      if (g.sensitive && approvals.some((a) => a.bucket === bucket)) {
        throw new HttpsError('permission-denied', `The second approval has to come from the ${bucket === 'BM' ? 'Supervisor' : 'Branch Manager'}.`);
      }
      const entry = { uid: callerUid, username: callerName, role: caller.role || '', bucket: bucket || (isAdmin ? 'ADMIN' : 'USER'), at: Timestamp.now() };
      const next = [...approvals, entry];
      const update = { approvals: next, history: FieldValue.arrayUnion({ ...stamp, action: isAdmin ? 'Approved (Admin)' : g.sensitive ? `Approved (${next.length}/${g.required})` : 'Approved' }) };
      // An Admin's approval is enough on its own, even for a sensitive place.
      if (isAdmin || next.length >= (g.required || 1)) {
        update.status = 'Approved';
        update.approvedAt = FieldValue.serverTimestamp();
        if (!g.sensitive) {
          // normal place: the approver is the escort
          update.escortUid = callerUid;
          update.escortUsername = callerName;
          update.escortRole = caller.role || '';
          tx.update(privRef, { escortUid: callerUid });
          result.notify = { kind: 'approved', g, escortUid: callerUid, escortName: callerName };
        } else {
          result.notify = { kind: 'needsEscort', g, approverUids: next.map((a) => a.uid) };
        }
      } else {
        result.notify = { kind: 'needsSecond', g, firstBucket: bucket };
      }
      tx.update(ref, update);
      return;
    }

    if (action === 'setEscort') {
      if (!g.sensitive) throw new HttpsError('failed-precondition', 'The escort of this place is the person who approved it.');
      if (g.status !== 'Approved') throw new HttpsError('failed-precondition', 'The escort can be chosen once both approvals are in and before the work starts.');
      const approvals = Array.isArray(g.approvals) ? g.approvals : [];
      if (!isAdmin && !approvals.some((a) => a.uid === callerUid)) throw new HttpsError('permission-denied', 'Only the Branch Manager / Supervisor / Admin who approved this request can choose the escort.');
      const eRole = normRoleUpper(escortDoc.role);
      const isApprover = approvals.some((a) => a.uid === escortDoc.id) || (isAdmin && escortDoc.id === callerUid);
      const isBranchUser = (eRole === 'USER' || eRole === 'STAFF' || eRole === 'SUPERVISOR' || eRole === 'BRANCH MANAGER') && escortDoc.role !== 'Coach' &&
        Array.isArray(escortDoc.assignedBranches) && escortDoc.assignedBranches.includes(g.branch);
      if (!isApprover && !isBranchUser) throw new HttpsError('permission-denied', 'The escort must be one of the approvers, or a User / Supervisor / Branch Manager of this branch.');
      tx.update(ref, {
        escortUid: escortDoc.id, escortUsername: escortDoc.username || '', escortRole: escortDoc.role || '',
        history: FieldValue.arrayUnion({ ...stamp, action: `Escort: ${escortDoc.username || ''}` })
      });
      tx.update(privRef, { escortUid: escortDoc.id });
      result.notify = { kind: 'escortChosen', g, escortUid: escortDoc.id };
      return;
    }

    if (action === 'reject') {
      if (g.status !== 'Pending' && g.status !== 'Approved') throw new HttpsError('failed-precondition', 'This request can no longer be rejected.');
      if (g.createdByUid === callerUid) throw new HttpsError('permission-denied', 'Cancel your own request instead of rejecting it.');
      if (!isAdmin && !eligible()) throw new HttpsError('permission-denied', 'You are not allowed to decide on this branch\'s requests.');
      tx.update(ref, {
        status: 'Rejected', rejectedBy: callerName, rejectedAt: FieldValue.serverTimestamp(),
        rejectReason: String(reason || '').trim().slice(0, 200),
        history: FieldValue.arrayUnion({ ...stamp, action: 'Rejected' })
      });
      result.notify = { kind: 'rejected', g, by: callerName };
      return;
    }

    if (action === 'cancel') {
      if (g.status !== 'Pending' && g.status !== 'Approved') throw new HttpsError('failed-precondition', 'This request can no longer be cancelled.');
      if (g.createdByUid !== callerUid && !isAdmin) throw new HttpsError('permission-denied', 'Only the person who made the request (or an Admin) can cancel it.');
      tx.update(ref, { status: 'Cancelled', cancelledBy: callerName, cancelledAt: FieldValue.serverTimestamp(), history: FieldValue.arrayUnion({ ...stamp, action: 'Cancelled' }) });
      if (g.status === 'Approved' && g.escortUid) result.notify = { kind: 'cancelled', g, escortUid: g.escortUid };
      return;
    }

    // start / finish: only the escort (or an Admin)
    if (g.escortUid !== callerUid && !isAdmin) throw new HttpsError('permission-denied', 'Only the escort of this visit can do this.');

    if (action === 'start') {
      if (g.status !== 'Approved') throw new HttpsError('failed-precondition', 'The request has to be approved first.');
      if (!g.escortUid) throw new HttpsError('failed-precondition', 'Choose the escort first.');
      if (confirmCount !== true) throw new HttpsError('invalid-argument', `Please confirm that exactly ${g.workerCount || 1} technician(s) are entering.`);
      if (g.sensitive && confirmClosed !== true) throw new HttpsError('invalid-argument', 'Please confirm the area is closed, signposted and empty before the technician enters.');
      tx.update(ref, {
        status: 'In Progress', startedAt: FieldValue.serverTimestamp(), startedBy: callerName,
        ...(g.sensitive ? { closureConfirmedAt: FieldValue.serverTimestamp() } : {}),
        history: FieldValue.arrayUnion({ ...stamp, action: 'Technician arrived - work started' })
      });
      result.notify = { kind: 'started', g, by: callerName };
      return;
    }

    if (action === 'finish') {
      if (g.status !== 'In Progress') throw new HttpsError('failed-precondition', 'The work has not started.');
      if (g.sensitive && confirmReopened !== true) throw new HttpsError('invalid-argument', 'Please confirm the area was checked and the technician has left before reopening it.');
      tx.update(ref, {
        status: 'Completed', finishedAt: FieldValue.serverTimestamp(), finishedBy: callerName,
        ...(g.sensitive ? { reopenedConfirmedAt: FieldValue.serverTimestamp() } : {}),
        history: FieldValue.arrayUnion({ ...stamp, action: 'Work finished - technician left' })
      });
      result.notify = { kind: 'finished', g };
    }
  });

  // notifications (best effort - never fail the action because a push did not go out)
  try {
    const n = result.notify;
    if (n) {
      const usersSnap = await db.collection('users').get();
      const label = `${n.g.maintenanceType} - ${n.g.workerName} (${n.g.company}) - ${n.g.branch}`;
      if (n.kind === 'approved') {
        await osPush(usersSnap, [n.g.createdByUid], '✅ Outsource maintenance approved', `${label}. Escort: ${n.escortName}.`, 'OUTSOURCE_APPROVED', id);
      } else if (n.kind === 'needsEscort') {
        await osPush(usersSnap, [n.g.createdByUid], '✅ Outsource maintenance approved', `${label}. Waiting for the escort to be chosen.`, 'OUTSOURCE_APPROVED', id);
        await osPush(usersSnap, n.approverUids, '🧑‍🔧 Choose the escort', `${label}, ${n.g.area}. Both approvals are in - choose who escorts the technician.`, 'OUTSOURCE_ESCORT', id);
      } else if (n.kind === 'escortChosen') {
        await osPush(usersSnap, [n.escortUid], '🧑‍🔧 You are the escort', `${label}, ${n.g.area}.`, 'OUTSOURCE_ESCORT', id);
        if (n.g.createdByUid !== n.escortUid) await osPush(usersSnap, [n.g.createdByUid], '🛡️ Escort chosen', `${label}.`, 'OUTSOURCE_ESCORT', id);
      } else if (n.kind === 'needsSecond') {
        const wantBucket = n.firstBucket === 'BM' ? 'SUPERVISOR' : 'BRANCH MANAGER';
        const targets = [];
        usersSnap.forEach((docSnap) => {
          if (docSnap.id === callerUid || docSnap.id === n.g.createdByUid) return;
          const u = docSnap.data();
          const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
          if (normRoleUpper(u.role) === wantBucket && theirBranches.includes(n.g.branch)) targets.push(docSnap.id);
        });
        await osPush(usersSnap, targets, '🧑‍🔧 Second approval needed', `${label}, ${n.g.area}. One approval is in; yours is needed.`, 'OUTSOURCE_SECOND', id);
      } else if (n.kind === 'rejected') {
        await osPush(usersSnap, [n.g.createdByUid], '❌ Outsource maintenance rejected', `${label} was rejected by ${n.by}.`, 'OUTSOURCE_REJECTED', id);
      } else if (n.kind === 'cancelled') {
        await osPush(usersSnap, [n.escortUid], 'Outsource visit cancelled', `${label} was cancelled.`, 'OUTSOURCE_CANCELLED', id);
      } else if (n.kind === 'finished') {
        await osPush(usersSnap, [n.g.createdByUid], '✅ Outsource maintenance finished', `${label} - work finished and the technician left.`, 'OUTSOURCE_DONE', id);
      }

      // Keep the managers in the loop: System Admins, Facility Manager, QA and the branch's Branch Managers /
      // Supervisors hear about every step (except the person who just did it and people already told above).
      const stakeText = {
        approved: ['✅ Outsource maintenance approved', `${label}. Escort: ${n.escortName}.`],
        needsEscort: ['✅ Outsource maintenance approved', `${label}. Waiting for the escort to be chosen.`],
        escortChosen: ['🛡️ Escort chosen', `${label}.`],
        rejected: ['❌ Outsource maintenance rejected', `${label} was rejected by ${n.by}.`],
        cancelled: ['Outsource maintenance cancelled', `${label} was cancelled.`],
        started: ['▶️ Technician arrived', `${label} - work started (escort: ${n.by}).`],
        finished: ['✅ Outsource maintenance finished', `${label} - work finished and the technician left.`]
      }[n.kind];
      if (stakeText) {
        const already = new Set([callerUid, n.g.createdByUid, n.escortUid, n.g.escortUid].filter(Boolean));
        if (n.kind === 'started') already.delete(n.g.createdByUid); // the requester was not told about the start yet
        const targets = osStakeholders(usersSnap, n.g.branch).filter((uid) => !already.has(uid));
        await osPush(usersSnap, targets, stakeText[0], stakeText[1], 'OUTSOURCE_UPDATE', id);
      }
    }
  } catch (err) {
    console.warn('Outsource notification failed:', err.message);
  }

  return { ok: true };
});

// --------------------------------------------------------------
// Leave balance (annual allowance of leave days per account, every account except the CEO).
//  - Stored in leaveBalances/{uid} = { balance } - a collection NO browser can read or write (no rule matches it), so
//    the person asking for leave can never see it. Missing document = the default allowance (3 days).
//  - setLeaveBalance          : System Admin or HR change an allowance.
//  - getLeaveBalances         : the numbers (allowance / taken / waiting / remaining) for the approvers and the report:
//                               System Admin + HR see everyone, Branch Manager(+) the people of their branches,
//                               Fitness Manager the Coaches of their branches. Never the caller's own row (except Admin / HR).
//  - createLeaveRequest       : leave requests are now made here so the allowance is enforced on the server: the days
//                               requested (approved + still-open ones + this one) cannot pass the allowance within
//                               any calendar year. Days count per calendar day, weekends included.
// --------------------------------------------------------------
const DEFAULT_LEAVE_BALANCE = 3;
const cairoYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const leaveDaysInYear = (startDate, endDate, year) => {
  const s = Math.max(ymdToUtcMs(startDate), Date.UTC(year, 0, 1));
  const e = Math.min(ymdToUtcMs(endDate), Date.UTC(year, 11, 31));
  return e < s ? 0 : Math.round((e - s) / DAY_MS) + 1;
};
const leaveYearsOf = (startDate, endDate) => {
  const out = [];
  for (let y = Number(startDate.slice(0, 4)); y <= Number(endDate.slice(0, 4)); y += 1) out.push(y);
  return out;
};

exports.setLeaveBalance = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const callerSnapSet = await db.collection('users').doc(request.auth.uid).get();
  const callerProfileSet = callerSnapSet.exists ? await withRole({ ...callerSnapSet.data(), role: callerSnapSet.data().role || request.auth.token.role }) : {};
  if (!permAllowed(callerProfileSet, 'editLeaveBalance', normRoleUpper(callerProfileSet.role) === 'HR')) {
    throw new HttpsError('permission-denied', 'You are not allowed to change a leave balance.');
  }
  const { targetUserId } = request.data || {};
  const balance = Number(request.data?.balance);
  if (typeof targetUserId !== 'string' || !targetUserId) throw new HttpsError('invalid-argument', 'Choose an account.');
  if (!Number.isInteger(balance) || balance < 0 || balance > 365) {
    throw new HttpsError('invalid-argument', 'The leave balance must be a whole number of days from 0 to 365.');
  }
  const targetSnap = await db.collection('users').doc(targetUserId).get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'That account no longer exists.');
  if (normRoleUpper(targetSnap.data().role) === 'CEO') {
    throw new HttpsError('invalid-argument', 'The CEO has no leave balance.');
  }
  await db.collection('leaveBalances').doc(targetUserId).set({
    balance, username: targetSnap.data().username || '', updatedBy: request.auth.token.name || request.auth.uid, updatedAt: FieldValue.serverTimestamp()
  });
  return { balance };
});

exports.getLeaveBalances = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const rawCaller = String(request.auth.token.role || '').trim().toUpperCase();
  const callerRole = normRoleUpper(rawCaller);
  const isFull = callerRole === 'ADMIN' || callerRole === 'HR';
  const isFitness = rawCaller === 'FITNESS MANAGER';
  const callerSnapGet = await db.collection('users').doc(request.auth.uid).get();
  const callerProfileGet = callerSnapGet.exists ? await withRole({ ...callerSnapGet.data(), role: callerSnapGet.data().role || request.auth.token.role }) : {};
  if (!permAllowed(callerProfileGet, 'viewLeaveBalances', callerRole === 'HR' || callerRole === 'BRANCH MANAGER' || isFitness)) {
    throw new HttpsError('permission-denied', 'You are not allowed to see leave balances.');
  }
  const thisYear = Number(cairoYmd().slice(0, 4));
  const year = Number(request.data?.year) || thisYear;
  if (!Number.isInteger(year) || year < 2020 || year > thisYear + 1) throw new HttpsError('invalid-argument', 'Choose a valid year.');
  const wanted = Array.isArray(request.data?.usernames) ? new Set(request.data.usernames.slice(0, 300).map((n) => String(n).trim().toLowerCase())) : null;

  const [usersSnap, balSnap, leaveSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('leaveBalances').get(),
    db.collection('leaveRequests').where('endDate', '>=', `${year}-01-01`).get()
  ]);
  const balances = new Map();
  balSnap.forEach((d) => balances.set(d.id, Number(d.data().balance)));
  const callerDoc = usersSnap.docs.find((d) => d.id === request.auth.uid);
  const callerBranches = callerDoc && Array.isArray(callerDoc.data().assignedBranches) ? callerDoc.data().assignedBranches : [];

  const byUser = new Map(); // username(lower) -> { taken, waiting, leaves[] }
  leaveSnap.forEach((d) => {
    const l = d.data();
    if (!l.username || !l.startDate || !l.endDate || l.startDate > `${year}-12-31` || l.status === 'Rejected') return;
    const days = leaveDaysInYear(l.startDate, l.endDate, year);
    if (days <= 0) return;
    const key = String(l.username).trim().toLowerCase();
    if (!byUser.has(key)) byUser.set(key, { taken: 0, waiting: 0, leaves: [] });
    const rec = byUser.get(key);
    if (l.status === 'Approved') rec.taken += days; else rec.waiting += days;
    rec.leaves.push({ id: d.id, startDate: l.startDate, endDate: l.endDate, status: l.status || 'Pending', days, branch: l.branch || '' });
  });

  const rows = [];
  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = normRoleUpper(u.role);
    if (role === 'CEO' || !u.username) return;
    const key = String(u.username).trim().toLowerCase();
    if (wanted && !wanted.has(key)) return;
    const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
    if (!isFull) {
      if (docSnap.id === request.auth.uid) return;
      if (!theirBranches.some((b) => callerBranches.includes(b))) return;
      if (isFitness && u.role !== 'Coach') return;
    }
    const rec = byUser.get(key) || { taken: 0, waiting: 0, leaves: [] };
    const balance = Number.isFinite(balances.get(docSnap.id)) ? balances.get(docSnap.id) : DEFAULT_LEAVE_BALANCE;
    rows.push({
      userId: docSnap.id, username: u.username, role: u.role || 'User', branches: theirBranches,
      balance, taken: rec.taken, waiting: rec.waiting, remaining: balance - rec.taken,
      leaves: wanted ? [] : rec.leaves.sort((a, b) => a.startDate.localeCompare(b.startDate))
    });
  });
  rows.sort((a, b) => a.username.localeCompare(b.username));
  return { year, defaultBalance: DEFAULT_LEAVE_BALANCE, rows };
});

exports.createLeaveRequest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const d = request.data || {};
  const branch = String(d.branch || '').trim();
  const startDate = String(d.startDate || '').trim();
  const endDate = String(d.endDate || '').trim();
  const reason = String(d.reason || '').trim().slice(0, 500);

  if (!branch) throw new HttpsError('invalid-argument', 'Please choose the branch this leave is for.');
  if (!isRealYmd(startDate) || !isRealYmd(endDate)) throw new HttpsError('invalid-argument', 'Please select a valid start and end date.');
  if (startDate < cairoYmd()) throw new HttpsError('invalid-argument', 'You cannot request leave for a day that has already passed.');
  if (endDate < startDate) throw new HttpsError('invalid-argument', 'The end date cannot be before the start date.');
  if ((ymdToUtcMs(endDate) - ymdToUtcMs(startDate)) / DAY_MS > 90) throw new HttpsError('invalid-argument', 'One leave request can cover at most 90 days.');

  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  if (!callerSnap.exists) throw new HttpsError('permission-denied', 'Your account could not be found.');
  const caller = callerSnap.data();
  const callerBranches = Array.isArray(caller.assignedBranches) ? caller.assignedBranches : [];
  if (callerBranches.length > 0 && !callerBranches.includes(branch)) {
    throw new HttpsError('permission-denied', 'You can only request leave for your own branches.');
  }
  const branchSnap = await db.collection('branches').where('name', '==', branch).limit(1).get();
  if (branchSnap.empty) throw new HttpsError('invalid-argument', 'That branch does not exist.');

  // existing leaves of this person (not rejected): no overlap, and the yearly allowance
  const mineSnap = await db.collection('leaveRequests').where('username', '==', caller.username).get();
  const mine = mineSnap.docs.map((x) => x.data()).filter((l) => l.status !== 'Rejected' && l.startDate && l.endDate);
  if (mine.some((l) => l.startDate <= endDate && startDate <= l.endDate)) {
    throw new HttpsError('failed-precondition', 'You already have a leave request that overlaps these dates.');
  }
  if (normRoleUpper(caller.role) !== 'CEO') {
    const balSnap = await db.collection('leaveBalances').doc(request.auth.uid).get();
    const balance = balSnap.exists && Number.isFinite(Number(balSnap.data().balance)) ? Number(balSnap.data().balance) : DEFAULT_LEAVE_BALANCE;
    for (const year of leaveYearsOf(startDate, endDate)) {
      const already = mine.reduce((sum, l) => sum + leaveDaysInYear(l.startDate, l.endDate, year), 0);
      const now = leaveDaysInYear(startDate, endDate, year);
      if (already + now > balance) {
        throw new HttpsError('failed-precondition', `This request is more than your leave balance for ${year}. Please ask your manager.`);
      }
    }
  }

  const sentRole = String(d.requesterRole || '').trim();
  const requesterRole = normRoleUpper(sentRole) === normRoleUpper(caller.role) ? sentRole : (caller.role || 'User');
  const ref = db.collection('leaveRequests').doc();
  await ref.set({
    username: caller.username,
    branch,
    requesterRole,
    assignedBranches: [branch],
    startDate,
    endDate,
    reason,
    status: 'Pending',
    createdAt: FieldValue.serverTimestamp(),
    createdById: request.auth.uid
  });
  return { id: ref.id };
});


/* =====================================================================
   Salary deductions
   - collection `deductions` has NO Firestore rule: the browser never reads or writes it, everything goes through these three functions.
   - giveDeduction permission (Permissions tab, default: System Admin only) lets an account record a deduction from the salary of someone who
     shares a branch with them (System Admin / HR: anyone). Managers can only deduct from staff-level roles, never from themselves,
     the CEO, the System Admin, HR or another manager.
   - viewDeductions permission (default: HR) sees every deduction. Someone who may give deductions sees those of their branches.
     Everybody sees their OWN deductions.
   - a deduction is either an AMOUNT in EGP or a number of DAYS of salary (chosen by whoever records it).
   - a deduction is never deleted: within 24 HOURS of recording it can be cancelled (by the creator, HR or the System Admin); after that only
     the System Admin can still cancel it. A cancelled deduction stays in the record (status 'Cancelled').
   ===================================================================== */
const DEDUCTION_CATEGORIES = ['Late', 'Absence', 'Violation', 'Damage / loss', 'Other'];
const DEDUCTION_MANAGER_TARGETS = new Set(['Supervisor', 'User', 'Staff', 'Coach', 'Fitness Manager', 'Facility Member', 'QA']);

const loadDeductionCaller = async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const snap = await db.collection('users').doc(request.auth.uid).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Your account could not be found.');
  const profile = await withRole({ ...snap.data(), role: snap.data().role || request.auth.token.role });
  const role = normRoleUpper(profile.role);
  const isFull = role === 'ADMIN' || role === 'HR';
  return {
    uid: request.auth.uid, profile, role, isFull,
    canGive: permAllowed(profile, 'giveDeduction', false),
    canView: permAllowed(profile, 'viewDeductions', role === 'HR'),
    branches: Array.isArray(profile.assignedBranches) ? profile.assignedBranches : []
  };
};

exports.createDeduction = onCall(async (request) => {
  const c = await loadDeductionCaller(request);
  if (!c.canGive) throw new HttpsError('permission-denied', 'You are not allowed to record salary deductions.');
  const d = request.data || {};
  const targetUserId = String(d.targetUserId || '');
  const kind = d.kind === 'days' ? 'days' : 'amount';
  const value = Math.round(Number(d.value) * 100) / 100;
  const reason = String(d.reason || '').trim().slice(0, 500);
  const category = DEDUCTION_CATEGORIES.includes(d.category) ? d.category : 'Other';
  const date = String(d.date || '').trim();
  if (!targetUserId) throw new HttpsError('invalid-argument', 'Please choose the employee.');
  if (kind === 'amount' && (!Number.isFinite(value) || value <= 0 || value > 100000)) throw new HttpsError('invalid-argument', 'Enter a valid amount (more than 0, up to 100000 EGP).');
  if (kind === 'days' && (!Number.isFinite(value) || value <= 0 || value > 31 || Math.round(value * 4) !== value * 4)) throw new HttpsError('invalid-argument', 'Enter a number of days between 0.25 and 31 (steps of a quarter day).');
  if (reason.length < 3) throw new HttpsError('invalid-argument', 'Please write the reason of the deduction.');
  if (!isRealYmd(date) || date > cairoYmd()) throw new HttpsError('invalid-argument', 'Choose the date of the deduction (not in the future).');
  if (targetUserId === c.uid) throw new HttpsError('permission-denied', 'You cannot record a deduction on yourself.');

  const tSnap = await db.collection('users').doc(targetUserId).get();
  if (!tSnap.exists) throw new HttpsError('not-found', 'That employee does not exist.');
  const t = tSnap.data();
  const tRole = normRoleUpper(t.role);
  if (tRole === 'ADMIN' || tRole === 'CEO') throw new HttpsError('permission-denied', 'A deduction cannot be recorded on this account.');
  const tBranches = Array.isArray(t.assignedBranches) ? t.assignedBranches : [];
  if (!c.isFull) {
    if (!DEDUCTION_MANAGER_TARGETS.has(t.role)) throw new HttpsError('permission-denied', 'You cannot record a deduction on this type of account.');
    if (!tBranches.some((b) => c.branches.includes(b))) throw new HttpsError('permission-denied', 'You can only record deductions on staff of your own branches.');
  }

  const ref = await db.collection('deductions').add({
    targetUserId, username: t.username || '', role: t.role || 'User', branches: tBranches,
    kind, value, amount: kind === 'amount' ? value : null, days: kind === 'days' ? value : null, reason, category, date,
    status: 'Active',
    createdById: c.uid, createdBy: c.profile.username || '', createdAt: FieldValue.serverTimestamp()
  });

  try {
    const usersSnap = await db.collection('users').get();
    const tokens = Array.isArray(t.fcmTokens) ? t.fcmTokens : [];
    await sendPushAndCleanup(usersSnap, tokens, '💸 Salary deduction recorded',
      `${kind === 'days' ? `${value} day(s) of salary` : `${value} EGP`} - ${category}: ${reason.slice(0, 100)} (${date})`, { requestId: ref.id, type: 'DEDUCTION' });
  } catch (err) { console.error('deduction push failed', err); }
  return { id: ref.id };
});

exports.getDeductions = onCall(async (request) => {
  const c = await loadDeductionCaller(request);
  const month = String(request.data?.month || '').trim(); // 'YYYY-MM' or '' for everything
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpsError('invalid-argument', 'Choose a valid month.');
  const snap = await db.collection('deductions').orderBy('date', 'desc').limit(1500).get();
  const rows = [];
  snap.forEach((doc) => {
    const x = doc.data();
    if (month && !String(x.date || '').startsWith(month)) return;
    const isMine = x.targetUserId === c.uid;
    const branchMatch = (x.branches || []).some((b) => c.branches.includes(b)) || x.createdById === c.uid;
    const visible = isMine || ((c.canGive || c.canView || c.isFull) && (c.isFull || branchMatch));
    if (!visible) return;
    rows.push({
      id: doc.id, targetUserId: x.targetUserId, username: x.username, role: x.role, branches: x.branches || [],
      kind: x.kind || 'amount', value: x.value != null ? x.value : x.amount, reason: x.reason, category: x.category, date: x.date, status: x.status || 'Active',
      createdBy: x.createdBy, mine: isMine,
      createdAtMs: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0,
      cancelledBy: x.cancelledBy || '',
      canCancel: (x.status || 'Active') === 'Active' && (c.isFull || x.createdById === c.uid) && (c.canGive || c.isFull)
        && (c.role === 'ADMIN' || (!!x.createdAt && x.createdAt.toMillis && Date.now() - x.createdAt.toMillis() <= 24 * 3600 * 1000))
    });
  });

  // people this account may record a deduction on (for the form)
  let employees = [];
  if (c.canGive) {
    const usersSnap = await db.collection('users').get();
    usersSnap.forEach((u) => {
      const v = u.data();
      const r = normRoleUpper(v.role);
      if (!v.username || u.id === c.uid || r === 'ADMIN' || r === 'CEO') return;
      const vb = Array.isArray(v.assignedBranches) ? v.assignedBranches : [];
      if (!c.isFull && (!DEDUCTION_MANAGER_TARGETS.has(v.role) || !vb.some((b) => c.branches.includes(b)))) return;
      employees.push({ id: u.id, username: v.username, role: v.role || 'User', branches: vb });
    });
    employees.sort((a, b) => a.username.localeCompare(b.username));
  }
  return { rows, employees, canGive: c.canGive, canViewAll: c.canView, categories: DEDUCTION_CATEGORIES, isAdmin: c.role === 'ADMIN' };
});

exports.cancelDeduction = onCall(async (request) => {
  const c = await loadDeductionCaller(request);
  const id = String(request.data?.id || '');
  if (!id) throw new HttpsError('invalid-argument', 'A deduction is required.');
  const ref = db.collection('deductions').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That deduction does not exist.');
  const x = snap.data();
  if ((x.status || 'Active') !== 'Active') throw new HttpsError('failed-precondition', 'This deduction is already cancelled.');
  if (!(c.isFull || (x.createdById === c.uid && c.canGive))) throw new HttpsError('permission-denied', 'You cannot cancel this deduction.');
  const created = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
  if (c.role !== 'ADMIN' && (!created || Date.now() - created > 24 * 3600 * 1000)) throw new HttpsError('failed-precondition', 'A deduction cannot be cancelled after 24 hours.');
  await ref.update({ status: 'Cancelled', cancelledBy: c.profile.username || '', cancelledAt: FieldValue.serverTimestamp() });
  return { ok: true };
});


// System Admin only: wipe deduction history (one record, or every cancelled record of a month / of all time).
exports.deleteDeductions = onCall(async (request) => {
  const c = await loadDeductionCaller(request);
  if (c.role !== 'ADMIN') throw new HttpsError('permission-denied', 'Only the System Admin can delete the deduction history.');
  const id = String(request.data?.id || '');
  if (id) {
    const ref = db.collection('deductions').doc(id);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'That deduction does not exist.');
    await ref.delete();
    return { deleted: 1 };
  }
  if (request.data?.cancelledOnly !== true) throw new HttpsError('invalid-argument', 'Choose what to delete.');
  const month = String(request.data?.month || '').trim();
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpsError('invalid-argument', 'Choose a valid month.');
  const snap = await db.collection('deductions').where('status', '==', 'Cancelled').get();
  const docs = snap.docs.filter((d) => !month || String(d.data().date || '').startsWith(month));
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  return { deleted: docs.length };
});


/* =====================================================================
   HR REPORT / PAYROLL
   Everything private lives in collections with NO Firestore rule (the browser can never read them); the screens get their data through
   the callables below, which check the permissions first:
     tab_hrReport   - open the HR Report tab and read the report (default: HR)
     managePayroll  - edit salaries, bank accounts, the deduction rules, bonuses, and release payslips (default: HR)
   System Admin has both always.
   Collections:
     payrollConfig/rules        the deduction rules (grace minutes, tiers, absence, pay-period start day, insurance, tax ...)
     payrollEmployees/{uid}     base salary, allowances, bank details
     payrollAdjustments/{month}_{uid}   bonus / other deduction for one month
     payslips/{month}_{uid}     the payslip as it was when HR released it to the employee (a frozen copy)
   ===================================================================== */
const PAYROLL_EVENTS = ['late', 'leftEarly', 'absent', 'noCheckout', 'wrongBranch'];
const PAYROLL_KINDS = ['days', 'amount', 'perMinute', 'percentDay', 'none'];
const DEFAULT_PAYROLL_CONFIG = {
  periodStartDay: 1,        // 1 = calendar month; 21 = from the 21st of the previous month to the 20th
  daysPerMonth: 30,         // what one "day" of salary is: salary / this number
  dailyRateBasis: 'gross',  // 'gross' = base + allowances, 'base' = base salary only
  lateGraceMinutes: 0,      // arrival up to this many minutes after the planned start is NOT late
  leftEarlyGraceMinutes: 0,
  maxAttendanceDeductionPercent: 100, // the attendance deductions (late / absence ...) never exceed this % of the base salary
  insurancePercent: 0,      // % of the base salary
  taxPercent: 0,            // % of the gross
  rules: [],
  roleRules: {}             // { [account type]: { lateGraceMinutes, leftEarlyGraceMinutes, rules } } - a type with its own set uses it INSTEAD of the default one
};

const payrollPad = (n) => String(n).padStart(2, '0');
const payrollRound = (n) => Math.round((Number(n) || 0) * 100) / 100;

const payrollPeriod = (month, startDay) => {
  const [y, m] = month.split('-').map(Number);
  if (!startDay || startDay <= 1) {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { start: `${y}-${payrollPad(m)}-01`, end: `${y}-${payrollPad(m)}-${payrollPad(last)}` };
  }
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { start: `${py}-${payrollPad(pm)}-${payrollPad(startDay)}`, end: `${y}-${payrollPad(m)}-${payrollPad(startDay - 1)}` };
};

const loadPayrollCaller = async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const snap = await db.collection('users').doc(request.auth.uid).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Your account could not be found.');
  const profile = await withRole({ ...snap.data(), role: snap.data().role || request.auth.token.role });
  const role = normRoleUpper(profile.role);
  return {
    uid: request.auth.uid, profile, role,
    canView: permAllowed(profile, 'tab_hrReport', role === 'HR'),
    canManage: permAllowed(profile, 'managePayroll', role === 'HR')
  };
};
const requirePayrollView = async (request) => {
  const c = await loadPayrollCaller(request);
  if (!c.canView) throw new HttpsError('permission-denied', 'You are not allowed to see the HR report.');
  return c;
};
const requirePayrollManage = async (request) => {
  const c = await loadPayrollCaller(request);
  if (!c.canManage) throw new HttpsError('permission-denied', 'You are not allowed to change payroll data.');
  return c;
};

const readPayrollConfig = async () => {
  const snap = await db.collection('payrollConfig').doc('rules').get();
  return { ...DEFAULT_PAYROLL_CONFIG, ...(snap.exists ? snap.data() : {}) };
};

const cleanPayrollRule = (r, i) => {
  const event = String(r?.event || '');
  const kind = String(r?.kind || '');
  if (!PAYROLL_EVENTS.includes(event)) throw new HttpsError('invalid-argument', `Rule ${i + 1}: unknown situation.`);
  if (!PAYROLL_KINDS.includes(kind)) throw new HttpsError('invalid-argument', `Rule ${i + 1}: unknown deduction type.`);
  const num = (v, label, { min = 0, max = 100000, nullable = false } = {}) => {
    if ((v === null || v === undefined || v === '') && nullable) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpsError('invalid-argument', `Rule ${i + 1}: ${label} is not valid.`);
    return n;
  };
  return {
    id: String(r?.id || `r${i + 1}`).slice(0, 24),
    note: String(r?.note || '').slice(0, 80),
    event,
    minFrom: num(r.minFrom ?? 0, 'minutes from', { max: 1440 }),
    minTo: num(r.minTo, 'minutes to', { max: 1440, nullable: true }),
    occFrom: num(r.occFrom ?? 1, 'occurrence from', { min: 1, max: 100 }),
    occTo: num(r.occTo, 'occurrence to', { min: 1, max: 100, nullable: true }),
    kind,
    value: kind === 'none' ? 0 : num(r.value, 'value', { max: 100000 })
  };
};

exports.getPayrollConfig = onCall(async (request) => {
  const c = await requirePayrollView(request);
  return { config: await readPayrollConfig(), canManage: c.canManage };
});

exports.setPayrollConfig = onCall(async (request) => {
  const c = await requirePayrollManage(request);
  const d = request.data?.config || {};
  const int = (v, label, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpsError('invalid-argument', `${label} must be a whole number from ${min} to ${max}.`); return n; };
  const pct = (v, label) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpsError('invalid-argument', `${label} must be between 0 and 100.`); return n; };
  const rulesIn = Array.isArray(d.rules) ? d.rules : [];
  if (rulesIn.length > 60) throw new HttpsError('invalid-argument', 'Too many rules (60 at most).');
  const config = {
    periodStartDay: int(d.periodStartDay, 'The period start day', 1, 28),
    daysPerMonth: int(d.daysPerMonth, 'Days per month', 20, 31),
    dailyRateBasis: d.dailyRateBasis === 'base' ? 'base' : 'gross',
    lateGraceMinutes: int(d.lateGraceMinutes, 'Late grace minutes', 0, 600),
    leftEarlyGraceMinutes: int(d.leftEarlyGraceMinutes, 'Left-early grace minutes', 0, 600),
    maxAttendanceDeductionPercent: pct(d.maxAttendanceDeductionPercent, 'The deduction cap'),
    insurancePercent: pct(d.insurancePercent, 'Insurance %'),
    taxPercent: pct(d.taxPercent, 'Tax %'),
    rules: rulesIn.map(cleanPayrollRule),
    roleRules: {},
    updatedAt: FieldValue.serverTimestamp(), updatedBy: c.profile.username || ''
  };
  const rrIn = d.roleRules && typeof d.roleRules === 'object' ? d.roleRules : {};
  const roleKeys = Object.keys(rrIn);
  if (roleKeys.length > 30) throw new HttpsError('invalid-argument', 'Too many account types.');
  roleKeys.forEach((role) => {
    const set = rrIn[role] || {};
    if (!role || role.length > 40 || /[\/]/.test(role)) throw new HttpsError('invalid-argument', 'Unknown account type.');
    const list = Array.isArray(set.rules) ? set.rules : [];
    if (list.length > 60) throw new HttpsError('invalid-argument', `Too many rules for ${role} (60 at most).`);
    config.roleRules[role] = {
      lateGraceMinutes: int(set.lateGraceMinutes, `${role}: late grace minutes`, 0, 600),
      leftEarlyGraceMinutes: int(set.leftEarlyGraceMinutes, `${role}: left-early grace minutes`, 0, 600),
      rules: list.map(cleanPayrollRule)
    };
  });
  await db.collection('payrollConfig').doc('rules').set(config);
  return { ok: true };
});

exports.getPayrollEmployees = onCall(async (request) => {
  const c = await requirePayrollView(request);
  const [usersSnap, profSnap] = await Promise.all([db.collection('users').get(), db.collection('payrollEmployees').get()]);
  const profs = new Map();
  profSnap.forEach((p) => profs.set(p.id, p.data()));
  const rows = [];
  usersSnap.forEach((u) => {
    const v = u.data();
    if (!v.username || normRoleUpper(v.role) === 'ADMIN') return;
    const p = profs.get(u.id) || {};
    rows.push({
      userId: u.id, username: v.username, role: v.role || 'User', branches: Array.isArray(v.assignedBranches) ? v.assignedBranches : [],
      baseSalary: Number(p.baseSalary) || 0, allowances: Array.isArray(p.allowances) ? p.allowances : [],
      bankName: p.bankName || '', accountHolder: p.accountHolder || '', accountNumber: p.accountNumber || '', iban: p.iban || '',
      active: p.active !== false, hasProfile: profs.has(u.id)
    });
  });
  rows.sort((a, b) => a.username.localeCompare(b.username));
  return { rows, canManage: c.canManage };
});

exports.setPayrollProfile = onCall(async (request) => {
  const c = await requirePayrollManage(request);
  const d = request.data || {};
  const userId = String(d.userId || '');
  if (!userId) throw new HttpsError('invalid-argument', 'Choose the employee.');
  const uSnap = await db.collection('users').doc(userId).get();
  if (!uSnap.exists || normRoleUpper(uSnap.data().role) === 'ADMIN') throw new HttpsError('not-found', 'That employee does not exist.');
  const base = Number(d.baseSalary);
  if (!Number.isFinite(base) || base < 0 || base > 10000000) throw new HttpsError('invalid-argument', 'The base salary is not valid.');
  const allowancesIn = Array.isArray(d.allowances) ? d.allowances : [];
  if (allowancesIn.length > 15) throw new HttpsError('invalid-argument', 'Too many allowances (15 at most).');
  const allowances = allowancesIn.map((a, i) => {
    const amount = Number(a?.amount);
    const name = String(a?.name || '').trim().slice(0, 40);
    if (!name || !Number.isFinite(amount) || amount < 0 || amount > 10000000) throw new HttpsError('invalid-argument', `Allowance ${i + 1} is not valid.`);
    return { name, amount: payrollRound(amount) };
  });
  const text = (v, n) => String(v || '').trim().slice(0, n);
  await db.collection('payrollEmployees').doc(userId).set({
    baseSalary: payrollRound(base), allowances,
    bankName: text(d.bankName, 60), accountHolder: text(d.accountHolder, 80), accountNumber: text(d.accountNumber, 40), iban: text(d.iban, 40).replace(/\s+/g, ''),
    active: d.active !== false, updatedAt: FieldValue.serverTimestamp(), updatedBy: c.profile.username || ''
  }, { merge: true });
  return { ok: true };
});

exports.setPayrollAdjustment = onCall(async (request) => {
  const c = await requirePayrollManage(request);
  const d = request.data || {};
  const month = String(d.month || '');
  const userId = String(d.userId || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !userId) throw new HttpsError('invalid-argument', 'Choose the month and the employee.');
  const amt = (v, label) => { const n = Number(v || 0); if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new HttpsError('invalid-argument', `${label} is not valid.`); return payrollRound(n); };
  await db.collection('payrollAdjustments').doc(`${month}_${userId}`).set({
    month, userId, bonus: amt(d.bonus, 'The bonus'), bonusNote: String(d.bonusNote || '').trim().slice(0, 100),
    otherDeduction: amt(d.otherDeduction, 'The other deduction'), otherNote: String(d.otherNote || '').trim().slice(0, 100),
    updatedAt: FieldValue.serverTimestamp(), updatedBy: c.profile.username || ''
  });
  return { ok: true };
});

// ---- the calculation -------------------------------------------------------------------------------------------
const cairoWall = (ms) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, h: Number(g('hour')), m: Number(g('minute')) };
};
const minsSincePlanDay = (planYmd, ms) => {
  const w = cairoWall(ms);
  return Math.round((ymdToUtcMs(w.ymd) - ymdToUtcMs(planYmd)) / DAY_MS) * 1440 + w.h * 60 + w.m;
};
const hhmmMinutes = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const hhmmOf = (mins) => `${payrollPad(Math.floor(((mins % 1440) + 1440) % 1440 / 60))}:${payrollPad(((mins % 60) + 60) % 60)}`;
const overlapDays = (aS, aE, bS, bE) => {
  const s = Math.max(ymdToUtcMs(aS), ymdToUtcMs(bS));
  const e = Math.min(ymdToUtcMs(aE), ymdToUtcMs(bE));
  return e < s ? 0 : Math.round((e - s) / DAY_MS) + 1;
};

const ruleDeduction = (rules, event, minutes, occurrence, daily) => {
  const rule = rules.find((r) => r.event === event
    && (event === 'late' || event === 'leftEarly' ? (minutes >= (r.minFrom ?? 0) && (r.minTo == null || minutes <= r.minTo)) : true)
    && occurrence >= (r.occFrom ?? 1) && (r.occTo == null || occurrence <= r.occTo));
  if (!rule) return { amount: 0, rule: null };
  let amount = 0;
  if (rule.kind === 'days') amount = rule.value * daily;
  else if (rule.kind === 'amount') amount = rule.value;
  else if (rule.kind === 'perMinute') amount = rule.value * minutes;
  else if (rule.kind === 'percentDay') amount = (rule.value / 100) * daily;
  return { amount: payrollRound(amount), rule };
};

const computePayrollRows = async (month, onlyUserIds) => {
  const config = await readPayrollConfig();
  const { start, end } = payrollPeriod(month, config.periodStartDay);
  const today = cairoYmd();
  const nowW = cairoWall(Date.now());
  const nowMin = nowW.h * 60 + nowW.m;

  const [usersSnap, profSnap, plansSnap, attSnap, leaveSnap, dedSnap, adjSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('payrollEmployees').get(),
    db.collection('attendancePlans').where('date', '>=', start).where('date', '<=', end).get(),
    db.collection('attendance').where('dateStr', '>=', start).where('dateStr', '<=', end).get(),
    db.collection('leaveRequests').where('endDate', '>=', start).get(),
    db.collection('deductions').where('date', '>=', start).where('date', '<=', end).get(),
    db.collection('payrollAdjustments').where('month', '==', month).get()
  ]);
  const profs = new Map(); profSnap.forEach((p) => profs.set(p.id, p.data()));
  const adjs = new Map(); adjSnap.forEach((a) => adjs.set(a.data().userId, a.data()));
  const key = (s) => String(s || '').trim().toLowerCase();

  const plansBy = new Map();
  plansSnap.forEach((p) => { const x = p.data(); const k = key(x.username); if (!plansBy.has(k)) plansBy.set(k, []); plansBy.get(k).push(x); });
  const sessBy = new Map(); // user|date -> sessions
  attSnap.forEach((a) => {
    const x = a.data(); if (!x.username || !x.checkInTime || !x.checkInTime.toMillis) return;
    const k = `${key(x.username)}|${x.dateStr}`;
    if (!sessBy.has(k)) sessBy.set(k, []);
    sessBy.get(k).push({ branch: x.branch || '', inMs: x.checkInTime.toMillis(), outMs: x.checkOutTime && x.checkOutTime.toMillis ? x.checkOutTime.toMillis() : null });
  });
  sessBy.forEach((list) => list.sort((a, b) => a.inMs - b.inMs));
  const leavesBy = new Map();
  leaveSnap.forEach((l) => {
    const x = l.data();
    if (!x.username || !x.startDate || x.startDate > end || x.status === 'Rejected') return;
    const k = key(x.username); if (!leavesBy.has(k)) leavesBy.set(k, []);
    leavesBy.get(k).push({ startDate: x.startDate, endDate: x.endDate, status: x.status || 'Pending' });
  });
  const dedBy = new Map();
  dedSnap.forEach((dd) => { const x = dd.data(); if ((x.status || 'Active') !== 'Active') return; if (!dedBy.has(x.targetUserId)) dedBy.set(x.targetUserId, []); dedBy.get(x.targetUserId).push({ id: dd.id, ...x }); });

  const rows = [];
  usersSnap.forEach((u) => {
    const v = u.data();
    if (!v.username || normRoleUpper(v.role) === 'ADMIN') return;
    if (onlyUserIds && !onlyUserIds.includes(u.id)) return;
    const p = profs.get(u.id) || {};
    if (p.active === false) return;
    const uk = key(v.username);
    // the rule set of this account type, if it has its own; otherwise the default one
    const ownSet = config.roleRules && config.roleRules[v.role];
    const rulesOf = ownSet ? ownSet.rules : config.rules;
    const lateGrace = ownSet ? ownSet.lateGraceMinutes : config.lateGraceMinutes;
    const earlyGrace = ownSet ? ownSet.leftEarlyGraceMinutes : config.leftEarlyGraceMinutes;
    const base = Number(p.baseSalary) || 0;
    const allowances = Array.isArray(p.allowances) ? p.allowances : [];
    const allowancesTotal = payrollRound(allowances.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const daily = payrollRound(((config.dailyRateBasis === 'base' ? base : base + allowancesTotal)) / config.daysPerMonth);

    const myLeaves = (leavesBy.get(uk) || []);
    const approved = myLeaves.filter((l) => l.status === 'Approved');
    const onLeave = (ymd) => approved.some((l) => ymd >= l.startDate && ymd <= l.endDate);

    const plans = (plansBy.get(uk) || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.startTime).localeCompare(String(b.startTime)));
    const counters = { late: 0, leftEarly: 0, absent: 0, noCheckout: 0, wrongBranch: 0 };
    const days = [];
    const sum = { planned: 0, onTime: 0, lateCount: 0, lateMinutes: 0, leftEarlyCount: 0, leftEarlyMinutes: 0, absentCount: 0, noCheckoutCount: 0, wrongBranchCount: 0, leaveShifts: 0 };
    let attDeduction = 0;

    const incident = (event, minutes) => {
      counters[event] += 1;
      return ruleDeduction(rulesOf, event, minutes, counters[event], daily);
    };

    plans.forEach((pl) => {
      const startMin = hhmmMinutes(pl.startTime);
      const endMin = hhmmMinutes(pl.endTime);
      const sessions = sessBy.get(`${uk}|${pl.date}`) || [];
      const line = { date: pl.date, branch: pl.branch || '', planned: `${pl.startTime || ''}-${pl.endTime || ''}`, arrival: '', departure: '', status: 'On time', lateMin: 0, earlyMin: 0, deduction: 0, note: '' };
      if (pl.date > today || (pl.date === today && sessions.length === 0 && nowMin <= startMin)) { line.status = 'Upcoming'; days.push(line); return; }
      sum.planned += 1;
      if (onLeave(pl.date)) { sum.leaveShifts += 1; line.status = 'Approved leave'; days.push(line); return; }
      if (sessions.length === 0) {
        if (pl.date === today && nowMin <= endMin) { sum.planned -= 1; line.status = 'Not checked in yet'; days.push(line); return; }
        sum.absentCount += 1; line.status = 'Absent';
        const r = incident('absent', 0); line.deduction = r.amount; if (r.rule) line.note = r.rule.note || ''; attDeduction += r.amount; days.push(line); return;
      }
      const here = sessions.filter((s) => s.branch === pl.branch);
      line.arrival = hhmmOf(minsSincePlanDay(pl.date, sessions[0].inMs));
      const lastS = sessions[sessions.length - 1];
      line.departure = lastS.outMs ? hhmmOf(minsSincePlanDay(pl.date, lastS.outMs)) : '';
      if (here.length === 0) {
        sum.wrongBranchCount += 1; line.status = `Wrong branch (${[...new Set(sessions.map((s) => s.branch))].join(', ')})`;
        const r = incident('wrongBranch', 0); line.deduction = r.amount; attDeduction += r.amount; days.push(line); return;
      }
      line.arrival = hhmmOf(minsSincePlanDay(pl.date, here[0].inMs));
      const late = minsSincePlanDay(pl.date, here[0].inMs) - startMin;
      let status = 'On time';
      if (late > lateGrace) {
        sum.lateCount += 1; sum.lateMinutes += late; line.lateMin = late; status = `Late ${late} min`;
        const r = incident('late', late); line.deduction += r.amount; attDeduction += r.amount;
      } else { sum.onTime += 1; }
      if (!lastS.outMs) {
        if (pl.date < today) {
          sum.noCheckoutCount += 1; status += ' · No check-out';
          const r = incident('noCheckout', 0); line.deduction += r.amount; attDeduction += r.amount;
        }
      } else {
        const early = endMin - minsSincePlanDay(pl.date, lastS.outMs);
        if (early > earlyGrace) {
          sum.leftEarlyCount += 1; sum.leftEarlyMinutes += early; line.earlyMin = early; status += ` · Left early ${early} min`;
          const r = incident('leftEarly', early); line.deduction += r.amount; attDeduction += r.amount;
        }
      }
      line.status = status; line.deduction = payrollRound(line.deduction);
      days.push(line);
    });

    const cap = payrollRound(base * (config.maxAttendanceDeductionPercent / 100));
    attDeduction = payrollRound(attDeduction);
    const attDeductionCapped = Math.min(attDeduction, cap);

    const manual = (dedBy.get(u.id) || []).map((x) => ({
      id: x.id, date: x.date, category: x.category, reason: x.reason, kind: x.kind || 'amount', value: x.value != null ? x.value : x.amount,
      amount: payrollRound((x.kind === 'days') ? Number(x.value) * daily : Number(x.value != null ? x.value : x.amount))
    }));
    const manualTotal = payrollRound(manual.reduce((s, x) => s + x.amount, 0));
    const adj = adjs.get(u.id) || {};
    const bonus = payrollRound(adj.bonus || 0);
    const otherDeduction = payrollRound(adj.otherDeduction || 0);
    const gross = payrollRound(base + allowancesTotal + bonus);
    const insurance = payrollRound(base * (config.insurancePercent / 100));
    const tax = payrollRound(gross * (config.taxPercent / 100));
    const totalDeductions = payrollRound(attDeductionCapped + manualTotal + otherDeduction + insurance + tax);
    const net = Math.max(0, payrollRound(gross - totalDeductions));

    const leaveDays = approved.reduce((s, l) => s + overlapDays(l.startDate, l.endDate, start, end), 0);
    const pendingLeaveDays = myLeaves.filter((l) => l.status !== 'Approved').reduce((s, l) => s + overlapDays(l.startDate, l.endDate, start, end), 0);

    rows.push({
      userId: u.id, username: v.username, role: v.role || 'User', branches: Array.isArray(v.assignedBranches) ? v.assignedBranches : [],
      hasSalary: base > 0, base, allowances, allowancesTotal, bonus, bonusNote: adj.bonusNote || '', otherDeduction, otherNote: adj.otherNote || '',
      daily, ...sum, leaveDays, pendingLeaveDays,
      leaves: myLeaves.filter((l) => overlapDays(l.startDate, l.endDate, start, end) > 0),
      attendanceDeduction: attDeduction, attendanceDeductionApplied: attDeductionCapped, capped: attDeduction > attDeductionCapped,
      manualDeductions: manual, manualTotal, insurance, tax, gross, totalDeductions, net,
      bank: { bankName: p.bankName || '', accountHolder: p.accountHolder || '', accountNumber: p.accountNumber || '', iban: p.iban || '' },
      days
    });
  });
  rows.sort((a, b) => a.username.localeCompare(b.username));
  return { month, period: { start, end }, config, rows };
};

exports.computePayroll = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  await requirePayrollView(request);
  const month = String(request.data?.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpsError('invalid-argument', 'Choose a valid month.');
  const result = await computePayrollRows(month, null);
  const rel = await db.collection('payslips').where('month', '==', month).get();
  result.released = rel.docs.map((d) => d.data().userId);
  return result;
});

// Release the payslips of a month to the employees (a frozen copy), or take them back.
exports.releasePayslips = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const c = await requirePayrollManage(request);
  const month = String(request.data?.month || '');
  const unrelease = request.data?.unrelease === true;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpsError('invalid-argument', 'Choose a valid month.');
  const ids = Array.isArray(request.data?.userIds) ? request.data.userIds.map(String).slice(0, 500) : null;
  if (unrelease) {
    const snap = await db.collection('payslips').where('month', '==', month).get();
    const docs = snap.docs.filter((d) => !ids || ids.includes(d.data().userId));
    for (let i = 0; i < docs.length; i += 400) { const b = db.batch(); docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
    return { changed: docs.length };
  }
  const result = await computePayrollRows(month, ids);
  const rows = result.rows.filter((r) => r.hasSalary);
  for (let i = 0; i < rows.length; i += 200) {
    const b = db.batch();
    rows.slice(i, i + 200).forEach((r) => {
      const { bank, ...rest } = r;
      const masked = bank.accountNumber ? `****${String(bank.accountNumber).slice(-4)}` : (bank.iban ? `****${String(bank.iban).slice(-4)}` : '');
      b.set(db.collection('payslips').doc(`${month}_${r.userId}`), {
        month, userId: r.userId, period: result.period, releasedAt: FieldValue.serverTimestamp(), releasedBy: c.profile.username || '',
        payslip: { ...rest, bank: { bankName: bank.bankName, accountHolder: bank.accountHolder, accountMasked: masked } }
      });
    });
    await b.commit();
  }
  try {
    const usersSnap = await db.collection('users').get();
    const tokens = [];
    rows.forEach((r) => { const u = usersSnap.docs.find((x) => x.id === r.userId); if (u && Array.isArray(u.data().fcmTokens)) tokens.push(...u.data().fcmTokens); });
    await sendPushAndCleanup(usersSnap, tokens, '💵 Your payslip is ready', `The payslip of ${month} is available in the My Payslip tab.`, { type: 'PAYSLIP', requestId: month });
  } catch (err) { console.error('payslip push failed', err); }
  return { changed: rows.length };
});

// An employee reads ONLY their own released payslips.
exports.getMyPayslips = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const meSnap = await db.collection('users').doc(request.auth.uid).get();
  if (!meSnap.exists) throw new HttpsError('permission-denied', 'Your account could not be found.');
  if (!permAllowed(await withRole({ ...meSnap.data(), role: meSnap.data().role || request.auth.token.role }), 'tab_payslip', true)) {
    throw new HttpsError('permission-denied', 'The payslip is switched off for your account.');
  }
  const snap = await db.collection('payslips').where('userId', '==', request.auth.uid).get();
  const rows = snap.docs.map((d) => d.data()).sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .map((x) => ({ month: x.month, period: x.period, releasedBy: x.releasedBy || '', payslip: x.payslip }));
  return { rows };
});

/* ----------------------------------------------------------------------------------------------
   whoIsIn - every account that is checked in right now (no check-out yet, today in Cairo), with the phone number.
   Open to any signed-in staff member. Only name, role, branch, check-in time and phone leave the server - never photos.
   ---------------------------------------------------------------------------------------------- */
exports.whoIsIn = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'You must be signed in.');
  const me = await db.collection('users').doc(request.auth.uid).get();
  if (!me.exists) throw new HttpsError('permission-denied', 'Your account could not be found.');
  const profile = await withRole({ ...me.data(), role: me.data().role || request.auth.token.role });
  if (!permAllowed(profile, 'tab_whoIsIn', true)) throw new HttpsError('permission-denied', 'You are not allowed to see this screen.');

  const hiddenName = 'amr shata';
  const viewerIsHidden = String(profile.username || '').trim().toLowerCase() === hiddenName;
  const [attSnap, usersSnap, privSnap] = await Promise.all([
    db.collection('attendance').where('dateStr', '==', cairoYmd()).get(),
    db.collection('users').get(),
    db.collection('userPrivate').get()
  ]);
  const byName = {};
  usersSnap.forEach((u) => {
    const d = u.data();
    const phone = (privSnap.docs.find((p) => p.id === u.id)?.data().phone) || '';
    byName[String(d.username || '').trim().toLowerCase()] = { role: d.role || '', phone: String(phone || '') };
  });
  const rows = [];
  attSnap.forEach((a) => {
    const r = a.data();
    if (r.checkOutTime || r.checkOut) return;
    const k = String(r.username || '').trim().toLowerCase();
    if (!k || (!viewerIsHidden && k === hiddenName)) return;
    const ms = r.checkInTime?.toMillis ? r.checkInTime.toMillis() : Date.now();
    const info = byName[k] || { role: '', phone: '' };
    rows.push({ username: r.username, role: info.role, branch: r.branch || '', phone: info.phone, checkInMs: ms });
  });
  rows.sort((x, y) => x.branch.localeCompare(y.branch) || x.checkInMs - y.checkInMs);
  return { rows };
});

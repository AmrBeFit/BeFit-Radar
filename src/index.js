const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { getAuth } = require('firebase-admin/auth');

initializeApp();
const db = getFirestore();
const auth = getAuth();

// ⚠️ This must match the fake domain used everywhere else in this file and in Login.jsx.
const EMAIL_DOMAIN = 'befit-facility.local';

const usernameToEmail = (username) =>
  `${username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@${EMAIL_DOMAIN}`;

// Update: which roles a given caller role is allowed to create, mirroring the app's own rules.
const ALLOWED_ROLES_BY_CREATOR = {
  ADMIN: ['User', 'Supervisor', 'Branch Manager', 'Facility Manager', 'Facility Member', 'HR', 'CEO', 'QA', 'Admin'],
  'BRANCH MANAGER': ['User', 'Supervisor'],
  'FACILITY MANAGER': ['Facility Member']
};

// Update: Facility Manager / Branch Manager / Supervisor teams are now SHARED - any manager of that
// type can delete any account of the matching role(s), regardless of which specific manager created
// it (this is intentionally separate from ALLOWED_ROLES_BY_CREATOR above, since e.g. a Supervisor may
// delete a User's account without being allowed to create one).
const ALLOWED_DELETE_TARGET_ROLES_BY_ROLE = {
  'FACILITY MANAGER': ['Facility Member'],
  'BRANCH MANAGER': ['User', 'Supervisor'],
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

  if (callerRole === 'BRANCH MANAGER' && (!Array.isArray(assignedBranches) || assignedBranches.length === 0)) {
    throw new HttpsError('invalid-argument', 'Please assign at least one branch to this account.');
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
    phone: phone?.trim() || '',
    role,
    assignedBranches: Array.isArray(assignedBranches) ? assignedBranches : [],
    createdBy: request.auth.uid,
    createdByUsername: request.auth.token.name || '',
    mustChangePassword: true,
    createdAt: FieldValue.serverTimestamp()
  });

  await db.collection('usernameIndex').doc(usernameLower).set({ email });

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

  const callerRole = (request.auth.token.role || '').toUpperCase();
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

  const callerRole = (request.auth.token.role || '').toUpperCase();
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
//     Supervisor plans Users
//   - Branch Manager and Supervisor only plan people who share a branch with them, and only AT their own branches
//   - one plan covers at most one month, starting no later than 30 days from today
//   - a new shift is skipped if it overlaps another shift of the same person on the same day
// --------------------------------------------------------------
const PLANNABLE_TARGETS = {
  admin: ['branch manager', 'supervisor', 'user', 'staff'],
  'branch manager': ['supervisor', 'user', 'staff'],
  supervisor: ['user', 'staff']
};
const HHMM_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
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

  const callerRole = (request.auth.token.role || '').trim().toLowerCase();
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

  // the people being planned
  const uniqueIds = [...new Set(userIds.filter((id) => typeof id === 'string' && id))];
  const targetSnaps = await db.getAll(...uniqueIds.map((id) => db.collection('users').doc(id)));
  const targets = [];
  const rejected = [];
  targetSnaps.forEach((snap) => {
    if (!snap.exists) { rejected.push(snap.id); return; }
    const t = snap.data();
    const targetBranches = Array.isArray(t.assignedBranches) ? t.assignedBranches : [];
    const roleOk = allowedTargets.includes((t.role || '').trim().toLowerCase());
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

  const callerRole = (request.auth.token.role || '').trim().toLowerCase();
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
    if (!allowedTargets.includes((target.role || '').trim().toLowerCase())) {
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

  try {
    await auth.deleteUser(targetUserId);
  } catch (err) {
    // If the Auth user is already gone for some reason, still clean up Firestore below.
    console.log('Auth delete warning:', err.message);
  }

  await db.collection('users').doc(targetUserId).delete();

  if (targetData.username) {
    await db.collection('usernameIndex').doc(targetData.username.trim().toLowerCase()).delete().catch(() => {});
  }

  return { success: true };
});

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
    const role = (u.role || '').trim().toUpperCase();
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

  const allTokens = [...new Set(targetUsers.flatMap((u) => u.fcmTokens))];

  const title = isManagement
    ? (newRequest.type === 'SUMMON' ? '🚨 Urgent Call From Management' : '🔔 New Management Request')
    : '🔧 New Maintenance Request';

  const body = newRequest.title || newRequest.details || `Branch: ${newRequest.branch || newRequest.targetBranch || ''}`;

  const message = {
    notification: { title, body },
    data: {
      requestId: event.params.requestId,
      type: newRequest.type || 'REQUEST'
    },
    tokens: allTokens
  };

  try {
    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`Push sent: ${response.successCount} succeeded, ${response.failureCount} failed.`);

    // Clean up tokens that are no longer valid (uninstalled, expired, etc.)
    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) invalidTokens.push(allTokens[i]);
    });

    if (invalidTokens.length > 0) {
      const batch = db.batch();
      usersSnap.forEach((docSnap) => {
        const u = docSnap.data();
        const tokens = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const stillValid = tokens.filter((t) => !invalidTokens.includes(t));
        if (stillValid.length !== tokens.length) {
          batch.update(docSnap.ref, { fcmTokens: stillValid });
        }
      });
      await batch.commit();
    }
  } catch (err) {
    console.error('Error sending push notification:', err);
  }
});

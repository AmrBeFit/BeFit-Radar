const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
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

// Shared by both push triggers below: sends one multicast push to a list of FCM tokens and
// prunes any token that Firebase reports as no-longer-valid (app uninstalled, token expired, etc.)
// from every user document that had it. `usersSnap` is the full /users snapshot already fetched by
// the caller, reused here just for the cleanup pass so we don't query Firestore a second time.
const sendPushAndCleanup = async (usersSnap, tokens, title, body, data) => {
  const allTokens = [...new Set(tokens)];
  if (allTokens.length === 0) return;

  // "stronger & faster": tell the browser's push service (Chrome/FCM) to treat this as
  // urgent and deliver it immediately instead of batching/delaying it (which otherwise
  // happens routinely on mobile under battery-saver/Doze). TTL=2h means if a phone is
  // offline the push is still waiting when it reconnects, instead of being dropped.
  // `tag` groups repeated pushes about the same request so the OS re-alerts (vibrates/
  // sounds again) every time instead of silently collapsing them into one.
  const tag = (data && (data.requestId || data.type)) ? String(data.requestId || data.type) : 'befit-eye';
  const message = {
    notification: { title, body },
    data,
    tokens: allTokens,
    webpush: {
      headers: {
        Urgency: 'high',
        TTL: '7200',
      },
      notification: {
        tag,
        renotify: true,
        requireInteraction: true,
        vibrate: [500, 200, 500, 200, 500],
      },
      fcmOptions: {
        link: '/',
      },
    },
  };

  try {
    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`Push sent: ${response.successCount} succeeded, ${response.failureCount} failed.`);

    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) invalidTokens.push(allTokens[i]);
    });

    if (invalidTokens.length > 0) {
      const batch = db.batch();
      usersSnap.forEach((docSnap) => {
        const u = docSnap.data();
        const tokens2 = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
        const stillValid = tokens2.filter((t) => !invalidTokens.includes(t));
        if (stillValid.length !== tokens2.length) {
          batch.update(docSnap.ref, { fcmTokens: stillValid });
        }
      });
      await batch.commit();
    }
  } catch (err) {
    console.error('Error sending push notification:', err);
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
      const role = (u.role || '').trim().toUpperCase();
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
      const role = (u.role || '').trim().toUpperCase();
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
      const role = (u.role || '').trim().toUpperCase();
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
    const role = (u.role || '').trim().toUpperCase();
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

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    const role = (u.role || '').trim().toUpperCase();
    const isTopLevelApprover = role === 'ADMIN' || role === 'CEO' || role === 'HR';
    const isBranchLevelApprover = role === 'BRANCH MANAGER' || role === 'SUPERVISOR';
    const theirBranches = Array.isArray(u.assignedBranches) ? u.assignedBranches : [];
    // Mirrors the app's own "who can approve this" rule (leaveRequestsForApproval in Dashboard.jsx):
    // Admin/CEO/HR see every request; a Branch Manager/Supervisor only sees one for a branch they're
    // actually assigned to.
    const branchOverlap = theirBranches.some((b) => requestBranches.includes(b));
    const shouldNotify = isTopLevelApprover || (isBranchLevelApprover && branchOverlap);

    if (shouldNotify && Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
      targetUsers.push(u);
    }
  });

  if (targetUsers.length === 0) return;

  const title = '📝 New Leave Request';
  const body = `${newLeaveRequest.username || 'Someone'} requested leave: ${newLeaveRequest.startDate || ''} to ${newLeaveRequest.endDate || ''}`;

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

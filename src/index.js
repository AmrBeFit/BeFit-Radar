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
  ADMIN: ['User', 'Supervisor', 'Branch Manager', 'Facility Manager', 'Facility Member', 'HR', 'CEO', 'Admin'],
  'BRANCH MANAGER': ['User', 'Supervisor'],
  'FACILITY MANAGER': ['Facility Member']
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
  // Only the roles that are allowed to create accounts may delete the ones they created.
  const isCreator = targetData.createdBy === request.auth.uid && Object.keys(ALLOWED_ROLES_BY_CREATOR).includes(callerRole);
  if (!isAdmin && !isCreator) {
    throw new HttpsError('permission-denied', 'You can only delete accounts that you created yourself.');
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

/* =====================================================================
   Permission catalog - one place that lists every permission an Admin can switch on/off per account.

   How it works
   ------------
   - Every role has a DEFAULT for each permission (the `roles` list below = roles that have it by default).
   - An account's profile (users/{id}) can carry an optional `permissions` map: { [key]: true | false }.
     A boolean there OVERRIDES the role default for that one account; a missing key means "use the role default".
   - Admin always has everything and is not listed.
   - `grantable: false` means the permission can be TAKEN AWAY from a role that has it, but cannot be handed to
     a role that does not, because the server side (Cloud Functions' per-role target rules) would still refuse
     the action - so granting it would only show a button that fails.

   Admin-exclusive items are deliberately NOT here (Settings, Audit Log + Undo, this Permissions tab,
   deleting records, changing integrity-report status, seeing who filed an integrity report,
   editing the checklist item list, archiving).

   Server enforcement: the Firestore rules read the same `permissions` map for the keys flagged
   `server: true` (see hasPerm() in firestore.rules), so those are real guarantees, not just hidden buttons.
   ===================================================================== */

export const PERMISSION_GROUPS = [
  { id: 'tabs', label: 'Tabs / Screens' },
  { id: 'leaves', label: 'Leaves' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'maintenance', label: 'Facility Management' },
  { id: 'integrity', label: 'Integrity Reports' },
  { id: 'users', label: 'Users & Schedule' }
];

const ALL_BUT = (...excluded) => (role) => !excluded.includes(role);

export const PERMISSIONS = [
  // ---- Tabs ----
  { key: 'tab_towels', group: 'tabs', label: 'Towels tab', desc: 'See and use the Towels screen.', def: ALL_BUT('QA'), grantable: true, server: false },
  { key: 'tab_attendance', group: 'tabs', label: 'Attendance tab', desc: 'Check in / out and see attendance.', def: ALL_BUT('QA', 'Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_ceoServices', group: 'tabs', label: 'CEO Services tab', desc: 'See and use CEO service requests.', def: ALL_BUT('QA', 'Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_reports', group: 'tabs', label: 'Reports tab', desc: 'Attendance reports + Excel export.', def: (r) => ['Branch Manager', 'Supervisor', 'HR', 'CEO'].includes(r), grantable: false, server: false },
  { key: 'tab_schedule', group: 'tabs', label: 'Schedule tab', desc: 'See the shift schedule (planning follows the role).', def: (r) => ['CEO', 'HR', 'Branch Manager', 'Supervisor'].includes(r), grantable: false, server: false },
  { key: 'tab_checklist', group: 'tabs', label: 'Checklist tab', desc: 'See the branch checklist.', def: ALL_BUT('Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_users', group: 'tabs', label: 'Users tab', desc: 'Manage accounts (which roles follows the account role).', def: (r) => ['Branch Manager', 'Facility Manager', 'Supervisor'].includes(r), grantable: false, server: false },
  { key: 'facilityPerformance', group: 'maintenance', label: 'Facility team performance', desc: 'Response rate, response speed and average time to finish requests.', def: (r) => ['Facility Member', 'Facility Manager', 'CEO'].includes(r), grantable: true, server: false },
  { key: 'maintReport', group: 'tabs', label: 'Maintenance Report', desc: 'The maintenance report inside the Facility Management tab.', def: (r) => ['Facility Manager', 'CEO'].includes(r), grantable: true, server: false },

  // ---- Leaves ----
  { key: 'approveLeave', group: 'leaves', label: 'Approve / reject leaves', desc: 'Decide leave requests (Branch Managers: own branches only; HR: all).', def: (r) => ['HR', 'Branch Manager'].includes(r), grantable: true, server: true },
  { key: 'viewLeaveQueue', group: 'leaves', label: 'View leave requests (view only)', desc: 'See the leave requests of own branches, without deciding.', def: (r) => ['HR', 'Branch Manager', 'Supervisor'].includes(r), grantable: true, server: false },

  // ---- Checklist ----
  { key: 'checklistDashboard', group: 'checklist', label: 'Checklist branches summary', desc: 'Completion %, best branch, requests / OK / Not Completed per branch.', def: (r) => ['Supervisor', 'Branch Manager', 'HR', 'CEO'].includes(r), grantable: true, server: false },
  { key: 'signOffChecklist', group: 'checklist', label: 'Sign off the checklist', desc: 'Sign the day; after signing only Admin can edit it.', def: (r) => ['Branch Manager', 'Supervisor'].includes(r), grantable: true, server: true },

  // ---- Facility Management (maintenance requests) ----
  { key: 'viewAllRequests', group: 'maintenance', label: 'See ALL maintenance requests', desc: 'Every branch\'s requests, not just own branch / own requests.', def: () => false, grantable: true, server: true },
  { key: 'manageRequestStatus', group: 'maintenance', label: 'Change request status / assign', desc: 'Change status, assign and archive maintenance requests.', def: (r) => r === 'Facility Manager', grantable: true, server: true },
  { key: 'editRequestCategory', group: 'maintenance', label: 'Edit request category', desc: 'Change the category of a maintenance request (when it was filed under the wrong one).', def: (r) => r === 'Facility Manager', grantable: true, server: true },
  { key: 'editNotes', group: 'maintenance', label: 'Edit request notes', desc: 'Write the Notes box on maintenance requests.', def: (r) => r === 'Facility Manager', grantable: true, server: true },

  // ---- Integrity ----
  { key: 'reviewIntegrity', group: 'integrity', label: 'Read integrity reports', desc: 'Read all reports (never who filed them - Admin only).', def: (r) => r === 'HR', grantable: true, server: true }
];

export const PERMISSION_BY_KEY = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));

export const roleDefault = (role, key) => {
  const p = PERMISSION_BY_KEY[key];
  return p ? !!p.def(role || 'User') : false;
};

// Final answer for one account. Admin = always yes.
export const hasPermission = (profile, key) => {
  const role = profile?.role || 'User';
  if (role === 'Admin') return true;
  const p = PERMISSION_BY_KEY[key];
  if (!p) return false;
  const base = !!p.def(role);
  const override = profile?.permissions?.[key];
  if (typeof override !== 'boolean') return base;
  if (override === true && !base && !p.grantable) return false; // cannot be granted, see header
  return override;
};

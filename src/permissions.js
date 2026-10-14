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
  { id: 'outsource', label: 'Outsource Maintenance' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'maintenance', label: 'Facility Management' },
  { id: 'integrity', label: 'Integrity Reports' },
  { id: 'users', label: 'Users & Schedule' }
];

// Role aliases: Branch Manager+ behaves as Branch Manager, QA Manager as QA (a "def" below receives the
// base role first and the stored role second). Coach and Fitness Manager are limited accounts, listed explicitly where needed.
export const baseRole = (role) => (role === 'Branch Manager+' ? 'Branch Manager' : role === 'QA Manager' ? 'QA' : role);

const ALL_BUT = (...excluded) => (role) => !excluded.includes(role);

export const PERMISSIONS = [
  // ---- Tabs ----
  { key: 'tab_towels', group: 'tabs', label: 'Towels tab', desc: 'See and use the Towels screen.', def: ALL_BUT('QA', 'Coach', 'Fitness Manager'), grantable: true, server: false },
  { key: 'tab_attendance', group: 'tabs', label: 'Attendance tab', desc: 'Check in / out and see attendance.', def: ALL_BUT('QA', 'Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_ceoServices', group: 'tabs', label: 'CEO Services tab', desc: 'See and use CEO service requests.', def: ALL_BUT('QA', 'Coach', 'Fitness Manager', 'Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_reports', group: 'tabs', label: 'Reports tab', desc: 'Attendance reports + Excel export.', def: (r) => ['Branch Manager', 'Supervisor', 'HR', 'CEO'].includes(r), grantable: false, server: false },
  { key: 'tab_schedule', group: 'tabs', label: 'Schedule tab', desc: 'See the shift schedule (planning follows the role).', def: (r) => ['CEO', 'HR', 'Branch Manager', 'Supervisor'].includes(r), grantable: false, server: false },
  { key: 'tab_checklist', group: 'tabs', label: 'Checklist tab', desc: 'See the branch checklist.', def: ALL_BUT('Coach', 'Facility Manager', 'Facility Member'), grantable: true, server: false },
  { key: 'tab_outsource', group: 'tabs', label: 'Outsource Maintenance tab', desc: 'Request, approve and escort outside maintenance technicians (what each role may do follows the account role).', def: ALL_BUT('HR', 'Coach', 'Fitness Manager', 'Finance and Administration'), grantable: false, server: false },
  { key: 'tab_users', group: 'tabs', label: 'Users tab', desc: 'Manage accounts (which roles follows the account role).', def: (r, raw) => ['Branch Manager', 'Facility Manager', 'Supervisor'].includes(r) || raw === 'QA Manager' || raw === 'Fitness Manager', grantable: false, server: false },
  { key: 'facilityPerformance', group: 'maintenance', label: 'Facility team performance', desc: 'Response rate, response speed and average time to finish requests.', def: (r) => ['Facility Member', 'Facility Manager', 'CEO'].includes(r), grantable: true, server: false },
  { key: 'maintReport', group: 'tabs', label: 'Maintenance Report', desc: 'The maintenance report inside the Facility Management tab.', def: (r) => ['Facility Manager', 'CEO'].includes(r), grantable: true, server: false },

  // ---- Leaves ----
  { key: 'approveLeave', group: 'leaves', label: 'Approve / reject leaves', desc: 'Decide leave requests (Branch Managers: own branches only; HR: all).', def: (r) => ['HR', 'Branch Manager'].includes(r), grantable: true, server: true },
  { key: 'preApproveLeave', group: 'leaves', label: 'Pre-approve / pre-reject Coach leaves', desc: 'First opinion on a Coach\'s leave at own branches; the Branch Manager gives the final decision.', def: (r, raw) => raw === 'Fitness Manager', grantable: true, server: true },
  { key: 'viewLeaveBalances', group: 'leaves', label: 'See leave balances', desc: 'The remaining balance on each leave request and the leave balances report (own branches; System Admin / HR: everyone). The employee never sees their own balance.', def: (r, raw) => ['HR', 'Branch Manager'].includes(r) || raw === 'Fitness Manager', grantable: true, server: true },
  { key: 'editLeaveBalance', group: 'leaves', label: 'Change leave balances', desc: 'Set the yearly leave balance of an account (default 3 days).', def: (r) => r === 'HR', grantable: true, server: true },
  { key: 'viewLeaveQueue', group: 'leaves', label: 'View leave requests (view only)', desc: 'See the leave requests of own branches, without deciding.', def: (r) => ['HR', 'Branch Manager', 'Supervisor'].includes(r), grantable: true, server: false },

  // ---- Checklist ----
  { key: 'checklistDashboard', group: 'checklist', label: 'Checklist branches summary', desc: 'Completion %, best branch, requests / OK / Not Completed per branch.', def: (r) => ['Supervisor', 'Branch Manager', 'HR', 'CEO'].includes(r), grantable: true, server: false },
  { key: 'tickChecklist', group: 'checklist', label: 'Tick the checklist', desc: 'Mark items on the checklist of the branch the account is checked in at. Without it the checklist is view only.', def: ALL_BUT('Fitness Manager'), grantable: true, server: true },
  { key: 'signOffChecklist', group: 'checklist', label: 'Sign off the checklist', desc: 'Sign the day; after signing only System Admin can edit it.', def: (r) => ['Branch Manager', 'Supervisor'].includes(r), grantable: true, server: true },

  // ---- Outsource Maintenance ----
  { key: 'outsourceRequest', group: 'outsource', label: 'Request outsource maintenance', desc: 'Create a request for an outside technician (needs the Outsource tab).', def: (r, raw) => ['CEO', 'QA', 'Facility Manager', 'Branch Manager'].includes(r) && raw !== 'Coach', grantable: true, server: true },
  { key: 'outsourceApprove', group: 'outsource', label: 'Approve / reject outsource requests', desc: 'Approve or reject requests and become the escort (still limited to the branch / check-in rules of the role).', def: (r) => ['Branch Manager', 'Supervisor', 'User', 'Staff'].includes(r), grantable: true, server: true },

  // ---- Facility Management (maintenance requests) ----
  { key: 'viewAllRequests', group: 'maintenance', label: 'See ALL maintenance requests', desc: 'Every branch\'s requests, not just own branch / own requests.', def: () => false, grantable: true, server: true },
  { key: 'manageRequestStatus', group: 'maintenance', label: 'Change request status / assign', desc: 'Change status, assign and archive maintenance requests.', def: (r) => r === 'Facility Manager', grantable: true, server: true },
  { key: 'editRequestCategory', group: 'maintenance', label: 'Edit request category', desc: 'Change the category of a maintenance request (when it was filed under the wrong one).', def: (r) => r === 'Facility Manager', grantable: true, server: true },
  { key: 'editNotes', group: 'maintenance', label: 'Edit request notes', desc: 'Write the Notes box on maintenance requests.', def: (r) => r === 'Facility Manager', grantable: true, server: true },

  // ---- Accounts (what a manager may create / edit / delete; can only be switched OFF, the Users tab belongs to the role) ----
  { key: 'manageCoaches', group: 'users', label: 'Manage Coaches', desc: 'Create, edit and delete Coach accounts (Branch Manager+ and Fitness Manager). Switch off to take it away.', def: (r, raw) => raw === 'Branch Manager+' || raw === 'Fitness Manager', grantable: false, server: true },
  { key: 'manageFitnessManagers', group: 'users', label: 'Manage Fitness Managers', desc: 'Create, edit and delete Fitness Manager accounts (Branch Manager+). Switch off to take it away.', def: (r, raw) => raw === 'Branch Manager+', grantable: false, server: true },
  { key: 'createQAMembers', group: 'users', label: 'Create QA Members', desc: 'Create, edit and delete QA Member accounts (QA Manager). Switch off to take it away.', def: (r, raw) => raw === 'QA Manager', grantable: false, server: true },

  // ---- Integrity ----
  { key: 'reviewIntegrity', group: 'integrity', label: 'Read integrity reports', desc: 'Read all reports (never who filed them - System Admin only).', def: (r) => r === 'HR', grantable: true, server: true }
];

// What the screens SHOW for a stored role (the stored value never changes, so nothing in the data, the rules
// or the functions is affected): a plain User/Staff account is shown as "Admin", the real Admin as "System Admin",
// and the stored "QA" as "QA Member".
export const roleLabel = (role) => {
  if (role === 'Admin') return 'System Admin';
  if (role === 'User' || role === 'Staff' || !role) return 'Admin';
  if (role === 'QA') return 'QA Member';
  return role;
};

export const PERMISSION_BY_KEY = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]));

export const roleDefault = (role, key) => {
  const p = PERMISSION_BY_KEY[key];
  return p ? !!p.def(baseRole(role || 'User'), role || 'User') : false;
};

// Final answer for one account. Admin = always yes.
export const hasPermission = (profile, key) => {
  const role = profile?.role || 'User';
  if (role === 'Admin') return true;
  const p = PERMISSION_BY_KEY[key];
  if (!p) return false;
  const base = !!p.def(baseRole(role), role);
  const override = profile?.permissions?.[key];
  if (typeof override !== 'boolean') return base;
  if (override === true && !base && !p.grantable) return false; // cannot be granted, see header
  return override;
};

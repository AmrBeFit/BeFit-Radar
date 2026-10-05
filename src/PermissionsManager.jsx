import React, { useState, useMemo, useEffect } from 'react';
import { db } from './firebase';
import { doc, updateDoc, deleteField } from 'firebase/firestore';
import { PERMISSIONS, PERMISSION_GROUPS, roleDefault } from './permissions';

/* =====================================================================
   Permissions - Admin only.
   Pick an account, tick what that account may do. Each permission starts from what the account's ROLE
   gives it; ticking/unticking something different from the role default saves an override on that one
   account (users/{id}.permissions). "Reset to role defaults" clears every override.
   Admin-exclusive features (Settings, Audit Log, Permissions, deleting records, integrity status and
   reporter identity, checklist item list, archiving) are not listed here on purpose.
   ===================================================================== */

export default function PermissionsManager({ usersList = [] }) {
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState({}); // key -> boolean (effective value shown in the checkboxes)
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const accounts = useMemo(
    () => usersList
      .filter((u) => u.role !== 'Admin')
      .filter((u) => !search.trim() || (u.username || '').toLowerCase().includes(search.trim().toLowerCase()) || (u.name || '').toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => (a.username || '').localeCompare(b.username || '')),
    [usersList, search]
  );

  const selected = useMemo(() => usersList.find((u) => u.id === selectedId) || null, [usersList, selectedId]);

  // Effective value for one permission on this account, ignoring the "cannot be granted" guard so the box
  // shows what is stored; non-grantable keys are simply disabled when the role lacks them.
  const effective = (u, key) => {
    const base = roleDefault(u.role, key);
    const o = u.permissions && typeof u.permissions[key] === 'boolean' ? u.permissions[key] : null;
    return o === null ? base : o;
  };

  useEffect(() => {
    if (!selected) { setDraft({}); return; }
    const d = {};
    PERMISSIONS.forEach((p) => { d[p.key] = effective(selected, p.key); });
    setDraft(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, JSON.stringify(selected?.permissions || {}), selected?.role]);

  const overridesFromDraft = () => {
    const out = {};
    PERMISSIONS.forEach((p) => {
      const base = roleDefault(selected.role, p.key);
      if (draft[p.key] !== base) {
        // a grant that the server could not honour is never stored
        if (draft[p.key] === true && !base && !p.grantable) return;
        out[p.key] = draft[p.key];
      }
    });
    return out;
  };

  const dirty = selected
    ? JSON.stringify(overridesFromDraft()) !== JSON.stringify(
        Object.fromEntries(PERMISSIONS.filter((p) => selected.permissions && typeof selected.permissions[p.key] === 'boolean' && selected.permissions[p.key] !== roleDefault(selected.role, p.key)).map((p) => [p.key, selected.permissions[p.key]]))
      )
    : false;

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const overrides = overridesFromDraft();
      await updateDoc(doc(db, 'users', selected.id), {
        permissions: Object.keys(overrides).length ? overrides : deleteField()
      });
      alert('Permissions saved. They apply to this account right away.');
    } catch (err) {
      alert('Could not save: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = async () => {
    if (!selected) return;
    if (!window.confirm(`Reset ${selected.username} to the default permissions of the ${selected.role} role?`)) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', selected.id), { permissions: deleteField() });
    } catch (err) {
      alert('Could not reset: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';
  const customCount = selected && selected.permissions
    ? PERMISSIONS.filter((p) => typeof selected.permissions[p.key] === 'boolean' && selected.permissions[p.key] !== roleDefault(selected.role, p.key)).length
    : 0;

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="border-b pb-4">
        <h2 className="text-lg font-black text-slate-900 tracking-tight">🔑 Permissions</h2>
        <p className="text-xs text-slate-500 max-w-2xl">
          Choose an account and tick what it may do. Everything starts from the account's role; any change you make
          here applies to that one account only. Features that belong to Admin alone (Settings, Audit Log, this tab,
          deleting records, who filed an integrity report...) are not listed.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={label}>Search account</label>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Username..." className={field} />
        </div>
        <div>
          <label className={label}>Account</label>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className={field}>
            <option value="">— Select an account —</option>
            {accounts.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.username} ({u.role}){u.permissions && Object.keys(u.permissions).length ? ' • custom' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!selected ? (
        <p className="text-xs text-slate-400 italic">Select an account to see and change its permissions.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-black text-slate-900">{selected.name || selected.username}</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={{ backgroundColor: '#e0e7ff', color: '#3730a3' }}>{selected.role}</span>
            {customCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                {customCount} custom
              </span>
            )}
          </div>

          {PERMISSION_GROUPS.map((g) => {
            const items = PERMISSIONS.filter((p) => p.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className="border border-slate-200 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-4 py-2 text-[10px] font-extrabold uppercase text-slate-500">{g.label}</div>
                <div className="divide-y divide-slate-100">
                  {items.map((p) => {
                    const base = roleDefault(selected.role, p.key);
                    const locked = !p.grantable && !base; // cannot be handed to a role that lacks it
                    const changed = draft[p.key] !== base;
                    return (
                      <label key={p.key} className={`flex items-start gap-3 px-4 py-3 ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50'}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={!!draft[p.key]}
                          disabled={locked}
                          onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.checked }))}
                        />
                        <span className="min-w-0">
                          <span className="block text-xs font-bold text-slate-900">
                            {p.label}
                            {changed && !locked && (
                              <span className="ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-black" style={{ backgroundColor: '#fef3c7', color: '#92400e' }}>
                                {draft[p.key] ? 'granted' : 'removed'} (role default: {base ? 'yes' : 'no'})
                              </span>
                            )}
                          </span>
                          <span className="block text-[11px] text-slate-500">{p.desc}</span>
                          {locked && (
                            <span className="block text-[10px] text-slate-400 italic">
                              Can only be removed from roles that have it - not given to this role.
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer shadow-sm disabled:opacity-40"
              style={{ backgroundColor: '#4f46e5', color: '#ffffff' }}
            >
              {saving ? 'Saving...' : 'Save permissions'}
            </button>
            <button
              type="button"
              onClick={resetDefaults}
              disabled={saving || customCount === 0}
              className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer disabled:opacity-40"
              style={{ backgroundColor: '#e2e8f0', color: '#334155' }}
            >
              Reset to role defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

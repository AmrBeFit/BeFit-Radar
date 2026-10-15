import React, { useState, useMemo, useEffect } from 'react';
import { db } from './firebase';
import { doc, updateDoc, deleteField, setDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp } from 'firebase/firestore';
import { PERMISSIONS, PERMISSION_GROUPS, roleDefault, roleEffective, roleLabel } from './permissions';

/* =====================================================================
   Permissions - System Admin only.

   Two levels, one screen:
   - an ACCOUNT TYPE (all Supervisors, all Coaches...)  -> rolePermissions/{role}.permissions = { key: true|false }
   - ONE account                                         -> users/{id}.permissions            = { key: true|false }
   Order of precedence: the account's own setting > the setting of its type > the built-in default (permissions.js).
   Changing a type never touches an account that has its own setting for that permission ("custom").
   Reset buttons: one permission, one account, a whole type (back to the built-in default), and
   "clear custom settings of every account of this type" (they follow the type again).
   Admin-exclusive features (Settings, Audit Log, this tab, deleting records, who filed an integrity report,
   checklist item list, archiving) are not listed on purpose.
   ===================================================================== */

const KNOWN_ROLES = [
  'Branch Manager+', 'Branch Manager', 'Fitness Manager', 'Coach', 'Supervisor', 'User', 'HR', 'CEO',
  'Facility Manager', 'Facility Member', 'QA Manager', 'QA', 'Finance and Administration', 'Staff'
];

const chip = (bg, fg) => ({ backgroundColor: bg, color: fg });

export default function PermissionsManager({ usersList = [] }) {
  const [role, setRole] = useState('');
  const [selectedId, setSelectedId] = useState(''); // '' = every account of the type
  const [search, setSearch] = useState('');
  const [roleDocs, setRoleDocs] = useState({}); // role -> { key: boolean }
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => onSnapshot(
    collection(db, 'rolePermissions'),
    (snap) => setRoleDocs(Object.fromEntries(snap.docs.map((d) => [d.id, d.data().permissions || {}]))),
    () => setRoleDocs({})
  ), []);

  const humans = useMemo(() => usersList.filter((u) => u.role !== 'Admin'), [usersList]);
  const roles = useMemo(() => {
    const seen = new Set(humans.map((u) => u.role).filter(Boolean));
    const list = KNOWN_ROLES.filter((r) => seen.has(r) || true);
    seen.forEach((r) => { if (!list.includes(r)) list.push(r); });
    return list;
  }, [humans]);

  const accountsOfRole = useMemo(
    () => humans
      .filter((u) => u.role === role)
      .filter((u) => !search.trim() || (u.username || '').toLowerCase().includes(search.trim().toLowerCase()) || (u.name || '').toLowerCase().includes(search.trim().toLowerCase()))
      .sort((a, b) => (a.username || '').localeCompare(b.username || '')),
    [humans, role, search]
  );
  const allOfRole = useMemo(() => humans.filter((u) => u.role === role), [humans, role]);
  const selected = useMemo(() => humans.find((u) => u.id === selectedId) || null, [humans, selectedId]);
  const roleOver = roleDocs[role] || {};

  // What a checkbox starts from. Type level: the built-in default. Account level: the type's value (type setting or built-in).
  const baseFor = (key) => (selected ? roleEffective(role, key, roleOver) : roleDefault(role, key));
  const storedFor = (key) => {
    if (selected) {
      const o = selected.permissions && selected.permissions[key];
      return typeof o === 'boolean' ? o : baseFor(key);
    }
    return roleEffective(role, key, roleOver);
  };
  const storedKey = JSON.stringify(selected ? (selected.permissions || {}) : roleOver);

  useEffect(() => {
    if (!role) { setDraft({}); return; }
    const d = {};
    PERMISSIONS.forEach((p) => { d[p.key] = storedFor(p.key); });
    setDraft(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, selectedId, storedKey, JSON.stringify(roleOver)]);

  const lockedFor = (p) => !p.grantable && !baseFor(p.key); // cannot be handed over: the server would refuse it

  const overridesFromDraft = () => {
    const out = {};
    PERMISSIONS.forEach((p) => {
      const base = baseFor(p.key);
      if (draft[p.key] !== undefined && draft[p.key] !== base) {
        if (draft[p.key] === true && !base && !p.grantable) return;
        out[p.key] = draft[p.key];
      }
    });
    return out;
  };

  const currentOverrides = () => {
    const src = selected ? (selected.permissions || {}) : roleOver;
    const out = {};
    PERMISSIONS.forEach((p) => { if (typeof src[p.key] === 'boolean' && src[p.key] !== baseFor(p.key)) out[p.key] = src[p.key]; });
    return out;
  };
  const dirty = !!role && JSON.stringify(overridesFromDraft()) !== JSON.stringify(currentOverrides());

  // accounts of the type that keep their own setting for a permission that is being changed at type level
  const keepingOwn = (changedKeys) => allOfRole.filter((u) => u.permissions && changedKeys.some((k) => typeof u.permissions[k] === 'boolean'));

  const save = async () => {
    if (!role) return;
    setSaving(true);
    try {
      const overrides = overridesFromDraft();
      if (selected) {
        await updateDoc(doc(db, 'users', selected.id), { permissions: Object.keys(overrides).length ? overrides : deleteField() });
        alert('Saved for this account only. It applies right away.');
      } else {
        const changed = PERMISSIONS.map((p) => p.key).filter((k) => (overrides[k] ?? roleDefault(role, k)) !== (roleOver[k] ?? roleDefault(role, k)));
        const keep = keepingOwn(changed);
        const msg = `Apply to ALL ${allOfRole.length} accounts of type "${roleLabel(role)}"?`
          + (keep.length ? `\n\n${keep.length} account(s) have their own custom setting for something you changed and will keep it:\n${keep.slice(0, 12).map((u) => '• ' + (u.name || u.username)).join('\n')}${keep.length > 12 ? '\n...' : ''}` : '');
        if (!window.confirm(msg)) { setSaving(false); return; }
        if (Object.keys(overrides).length) {
          await setDoc(doc(db, 'rolePermissions', role), { permissions: overrides, updatedAt: serverTimestamp() });
        } else {
          await deleteDoc(doc(db, 'rolePermissions', role));
        }
        alert('Saved for every account of this type.');
      }
    } catch (err) {
      alert('Could not save: ' + (err.message || err));
    } finally {
      setSaving(false);
    }
  };

  const resetAccount = async () => {
    if (!selected) return;
    if (!window.confirm(`Reset ${selected.username}? It will follow the "${roleLabel(role)}" type settings again.`)) return;
    setSaving(true);
    try { await updateDoc(doc(db, 'users', selected.id), { permissions: deleteField() }); }
    catch (err) { alert('Could not reset: ' + (err.message || err)); }
    finally { setSaving(false); }
  };

  const resetType = async () => {
    if (!window.confirm(`Reset the type "${roleLabel(role)}" to the built-in default permissions?\n\nAccounts with their own custom settings keep them.`)) return;
    setSaving(true);
    try { await deleteDoc(doc(db, 'rolePermissions', role)); }
    catch (err) { alert('Could not reset: ' + (err.message || err)); }
    finally { setSaving(false); }
  };

  const clearAccountsOfType = async () => {
    const custom = allOfRole.filter((u) => u.permissions && Object.keys(u.permissions).length);
    if (!custom.length) return;
    if (!window.confirm(`Remove the custom settings of ${custom.length} account(s) of type "${roleLabel(role)}"? They will all follow the type settings.`)) return;
    setSaving(true);
    try {
      for (let i = 0; i < custom.length; i += 400) {
        const b = writeBatch(db);
        custom.slice(i, i + 400).forEach((u) => b.update(doc(db, 'users', u.id), { permissions: deleteField() }));
        await b.commit();
      }
    } catch (err) { alert('Could not clear: ' + (err.message || err)); }
    finally { setSaving(false); }
  };

  const label = 'block text-[10px] font-extrabold uppercase text-slate-500 mb-1';
  const field = 'w-full p-2.5 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium';
  const typeCustomCount = Object.keys(currentOverridesFor(roleOver, role)).length;
  const customAccounts = allOfRole.filter((u) => u.permissions && Object.keys(u.permissions).length);
  const accountCustomCount = selected ? Object.keys(currentOverrides()).length : 0;

  return (
    <div className="bg-white border border-slate-200 p-6 rounded-3xl shadow-sm space-y-5">
      <div className="border-b pb-4">
        <h2 className="text-lg font-black text-slate-900 tracking-tight">🔑 Permissions</h2>
        <p className="text-xs text-slate-500 max-w-3xl">
          1) Pick an <strong>account type</strong>. 2) Leave "All accounts of this type" to change the type for everyone, or pick one
          account to change only that account. An account with its own setting keeps it when you change its type.
          Every level has a Reset back to the default. Features that belong to System Admin alone (Settings, Audit Log, this tab,
          deleting records, who filed an integrity report...) are not listed.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className={label}>Account type</label>
          <select value={role} onChange={(e) => { setRole(e.target.value); setSelectedId(''); setSearch(''); }} className={field}>
            <option value="">— Select a type —</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)} ({humans.filter((u) => u.role === r).length}){roleDocs[r] && Object.keys(roleDocs[r]).length ? ' • customised' : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Search account</label>
          <input type="text" value={search} disabled={!role} onChange={(e) => setSearch(e.target.value)} placeholder="Username..." className={field} />
        </div>
        <div>
          <label className={label}>Applies to</label>
          <select value={selectedId} disabled={!role} onChange={(e) => setSelectedId(e.target.value)} className={field}>
            <option value="">👥 All accounts of this type ({allOfRole.length})</option>
            {accountsOfRole.map((u) => (
              <option key={u.id} value={u.id}>{u.name || u.username}{u.permissions && Object.keys(u.permissions).length ? ' • custom' : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {!role ? (
        <p className="text-xs text-slate-400 italic">Select an account type to see and change its permissions.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-black text-slate-900">{selected ? (selected.name || selected.username) : `All ${roleLabel(role)} accounts`}</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={chip('#e0e7ff', '#3730a3')}>{roleLabel(role)}</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={selected ? chip('#fce7f3', '#9d174d') : chip('#dcfce7', '#166534')}>
              {selected ? 'ONE ACCOUNT ONLY' : 'THE WHOLE TYPE'}
            </span>
            {!selected && typeCustomCount > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={chip('#fef3c7', '#92400e')}>{typeCustomCount} differ from the built-in default</span>}
            {!selected && customAccounts.length > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={chip('#fef3c7', '#92400e')}>{customAccounts.length} account(s) with their own settings</span>}
            {selected && accountCustomCount > 0 && <span className="px-2 py-0.5 rounded-full text-[10px] font-black" style={chip('#fef3c7', '#92400e')}>{accountCustomCount} custom</span>}
          </div>

          {(() => {
            const granted = PERMISSIONS.filter((p) => draft[p.key] === true && !baseFor(p.key));
            const removed = PERMISSIONS.filter((p) => draft[p.key] === false && baseFor(p.key));
            if (!granted.length && !removed.length) return null;
            return (
              <div className="border border-amber-200 bg-amber-50 rounded-2xl px-4 py-3 text-[11px] space-y-1">
                <p className="font-black text-amber-900 uppercase text-[10px]">
                  Differences from {selected ? `the "${roleLabel(role)}" type settings` : 'the built-in default'}
                </p>
                {granted.length > 0 && <p className="text-emerald-800"><span className="font-black">Granted:</span> {granted.map((p) => p.label).join(' · ')}</p>}
                {removed.length > 0 && <p className="text-rose-800"><span className="font-black">Removed:</span> {removed.map((p) => p.label).join(' · ')}</p>}
              </div>
            );
          })()}

          {PERMISSION_GROUPS.map((g) => {
            const items = PERMISSIONS.filter((p) => p.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className="border border-slate-200 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-4 py-2 text-[10px] font-extrabold uppercase text-slate-500">{g.label}</div>
                <div className="divide-y divide-slate-100">
                  {items.map((p) => {
                    const base = baseFor(p.key);
                    const locked = lockedFor(p);
                    const changed = draft[p.key] !== base;
                    return (
                      <div key={p.key} className={`flex items-start gap-3 px-4 py-3 transition-colors ${locked ? 'opacity-50' : 'hover:bg-slate-50'}`}>
                        <label className={`flex items-start gap-3 flex-1 min-w-0 ${locked ? '' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox" className="mt-0.5" checked={!!draft[p.key]} disabled={locked}
                            onChange={(e) => setDraft((d) => ({ ...d, [p.key]: e.target.checked }))}
                          />
                          <span className="min-w-0">
                            <span className="block text-xs font-bold text-slate-900">
                              {p.label}
                              {p.server && <span className="ml-2 text-[9px] font-black text-indigo-600">🔒 enforced by the server</span>}
                              {changed && !locked && (
                                <span className="ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-black" style={chip('#fef3c7', '#92400e')}>
                                  {draft[p.key] ? 'granted' : 'removed'} ({selected ? 'type' : 'default'}: {base ? 'yes' : 'no'})
                                </span>
                              )}
                            </span>
                            <span className="block text-[11px] text-slate-500">{p.desc}</span>
                            {locked && <span className="block text-[10px] text-slate-400 italic">Can only be removed from types that have it - not given to this one.</span>}
                          </span>
                        </label>
                        {changed && !locked && (
                          <button type="button" title="Back to default" onClick={() => setDraft((d) => ({ ...d, [p.key]: base }))}
                            className="text-[11px] font-black px-2 py-1 rounded-lg border-0 cursor-pointer" style={chip('#e2e8f0', '#334155')}>↺</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={saving || !dirty}
              className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer shadow-sm disabled:opacity-40" style={chip('#4f46e5', '#ffffff')}>
              {saving ? 'Saving...' : selected ? 'Save for this account' : `Save for all ${roleLabel(role)} accounts`}
            </button>
            {dirty && (
              <button type="button" onClick={() => setDraft(() => { const d = {}; PERMISSIONS.forEach((p) => { d[p.key] = storedFor(p.key); }); return d; })}
                className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer" style={chip('#f1f5f9', '#475569')}>Undo my edits</button>
            )}
            {selected ? (
              <button type="button" onClick={resetAccount} disabled={saving || !(selected.permissions && Object.keys(selected.permissions).length)}
                className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer disabled:opacity-40" style={chip('#e2e8f0', '#334155')}>
                Reset this account (follow the type)
              </button>
            ) : (
              <>
                <button type="button" onClick={resetType} disabled={saving || !roleDocs[role] || !Object.keys(roleDocs[role]).length}
                  className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer disabled:opacity-40" style={chip('#e2e8f0', '#334155')}>
                  Reset this type to the built-in default
                </button>
                <button type="button" onClick={clearAccountsOfType} disabled={saving || customAccounts.length === 0}
                  className="px-5 py-2 rounded-xl text-xs font-extrabold border-0 cursor-pointer disabled:opacity-40" style={chip('#fee2e2', '#991b1b')}>
                  Clear custom settings of all accounts of this type ({customAccounts.length})
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// the overrides of a type that really differ from the built-in default
function currentOverridesFor(roleOver, role) {
  const out = {};
  PERMISSIONS.forEach((p) => { if (typeof roleOver[p.key] === 'boolean' && roleOver[p.key] !== roleDefault(role, p.key)) out[p.key] = roleOver[p.key]; });
  return out;
}

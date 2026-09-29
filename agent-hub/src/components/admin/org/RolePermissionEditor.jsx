import { AlertCircle, Check, Loader2, Lock } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { editablePermissionsForRole, permissionsForRole } from '../../../config/orgRoles';
import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * The expanded panel under one Organisation Role: what it may use, and — for an
 * org admin — which of those the organisation switches on or off.
 *
 * Two lists, deliberately not one. The top half is the organisation's to
 * decide (Notebooks, the Studio sections, Approvals, Forms); the bottom half is
 * what the role IS — manage users, the admin pages, the compliance surfaces —
 * and is fixed by the install. Mixing them behind identical toggles would
 * promise control this screen does not have: the server drops anything outside
 * its editable set, so a toggle that silently reverts is worse than a row that
 * never moved. Which half a permission lands in comes from the server
 * (`editablePermissions`), never from a list kept here.
 *
 * Saving is per role and sends the FULL editable choice, not a delta, so two
 * admins editing different roles cannot interleave into a state neither picked.
 */
const RolePermissionEditor = ({ role, mapping, editablePermissions, canEdit, onSaved }) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(null);   // null = untouched, mirrors `mapping`
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const rows = useMemo(
        () => editablePermissionsForRole(role.id, mapping, editablePermissions),
        [role.id, mapping, editablePermissions],
    );
    // Is the top half rendered at all? Decided before the bottom half, because
    // it changes what the bottom half is FOR.
    const editorRows = rows.length > 0 && canEdit;
    // With the editor on screen: only what it cannot change, so nothing is
    // listed twice. Without it: everything the role grants — a viewer who
    // cannot edit still needs the whole answer to "what can a Member do", and
    // showing them the leftovers would under-report the role exactly the way
    // the old hand-written list did.
    const fixed = useMemo(() => {
        const all = permissionsForRole(role.id, mapping);
        if (!editorRows) return all;
        const editable = new Set(editablePermissions || []);
        return all.filter((p) => !editable.has(p.id));
    }, [role.id, mapping, editablePermissions, editorRows]);

    const current = draft ?? rows.filter((r) => r.granted).map((r) => r.id);
    const granted = new Set(current);
    const saved = rows.filter((r) => r.granted).map((r) => r.id);
    const dirty = draft !== null
        && (draft.length !== saved.length || draft.some((id) => !saved.includes(id)));

    const toggle = (id) => {
        setError('');
        setDraft(granted.has(id) ? current.filter((x) => x !== id) : [...current, id]);
    };

    const save = async () => {
        setSaving(true);
        setError('');
        try {
            const res = await authFetch(`${API_BASE}/auth/org-roles/${encodeURIComponent(role.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ permissions: current }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error || t('admin.org_roles_save_failed', 'Could not save this role.'));
            // The server sanitises and returns what it actually stored, so the
            // screen shows the saved truth rather than what was clicked.
            onSaved(role.id, body?.permissions || current);
            setDraft(null);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="px-5 pb-4 pt-0 ml-14 space-y-3">
            {editorRows && (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] overflow-hidden">
                    <div className="px-3 py-2 bg-[var(--bg-tertiary)] flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            {t('admin.org_roles_editable', 'What this role may use')}
                        </span>
                        {dirty && (
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => { setDraft(null); setError(''); }}
                                    disabled={saving}
                                    className="text-[11px] px-2 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
                                >
                                    {t('admin.sec_cancel', 'Cancel')}
                                </button>
                                <button
                                    type="button"
                                    onClick={save}
                                    disabled={saving}
                                    data-testid={`role-save-${role.id}`}
                                    className="text-[11px] font-medium px-2.5 py-1 rounded-md text-white disabled:opacity-50 inline-flex items-center gap-1"
                                    style={{ background: role.color }}
                                >
                                    {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                                    {t('admin.org_roles_save', 'Save')}
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="divide-y divide-[var(--border-subtle)]">
                        {rows.map((p) => {
                            const on = granted.has(p.id);
                            return (
                                <label
                                    key={p.id}
                                    className="px-3 py-2.5 flex items-start gap-3 cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors"
                                >
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => toggle(p.id)}
                                        disabled={saving}
                                        data-testid={`role-perm-${role.id}-${p.id}`}
                                        className="mt-0.5 shrink-0 w-3.5 h-3.5 accent-[var(--accent-primary)] cursor-pointer"
                                        style={{ accentColor: role.color }}
                                    />
                                    <div>
                                        <div className={`text-xs ${on ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                                            {p.label}
                                        </div>
                                        {p.desc && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{p.desc}</div>}
                                    </div>
                                </label>
                            );
                        })}
                    </div>
                    {error && (
                        <div className="px-3 py-2 flex items-start gap-2 text-[11px] border-t border-[var(--border-subtle)]"
                            style={{ color: 'var(--error)' }}>
                            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}
                </div>
            )}

            {(fixed.length > 0 || !editorRows) && (
                <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] overflow-hidden">
                    <div className="px-3 py-2 bg-[var(--bg-tertiary)] flex items-center gap-1.5">
                        <Lock className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                            {editorRows
                                ? t('admin.org_roles_fixed', 'Fixed by this role')
                                : t('admin.org_roles_permissions', 'Permissions')}
                        </span>
                    </div>
                    <div className="divide-y divide-[var(--border-subtle)]">
                        {fixed.length === 0 && (
                            <div className="px-3 py-2.5 text-[11px] text-[var(--text-muted)]">
                                {t('admin.org_roles_none', 'No permissions could be read for this role.')}
                            </div>
                        )}
                        {fixed.map((p) => (
                            <div key={p.id} className="px-3 py-2.5 flex items-start gap-2">
                                <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: role.color }} />
                                <div>
                                    <div className="text-xs font-medium text-[var(--text-primary)]">{p.label}</div>
                                    {p.desc && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{p.desc}</div>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default RolePermissionEditor;

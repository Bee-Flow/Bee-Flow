import { Loader2, Plus, User, UserPlus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { datatablesApi } from './datatablesApi';
import { type DatatableGrant } from './grants';
import useTranslation from '@/hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import type { RequestError, GrantListProps, AvatarProps } from './DatatableSharing.types';

export const CARD = {
    borderRadius: 12,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)',
};

export function GrantList({ table, grants, canEdit, directory, onChanged, onPaywalled }: GrantListProps) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const [granteeType, setGranteeType] = useState('user');
    const [granteeId, setGranteeId] = useState('');
    const [grade, setGrade] = useState('viewer');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const options = granteeType === 'user' ? (directory.users || []) : (directory.groups || []);
    const nameOf = (g: DatatableGrant) => {
        const list = g.granteeType === 'user' ? (directory.users || []) : (directory.groups || []);
        const hit = list.find(x => x.id === g.granteeId);
        return hit?.name || hit?.email || g.granteeId;
    };
    const owner = (directory.users || []).find(u => u.id === table.ownerUserId) || null;

    const add = async () => {
        if (!granteeId) return;
        setBusy(true);
        setError(null);
        try {
            await datatablesApi.addGrant(table.id, { granteeType, granteeId, grade });
            setGranteeId('');
            setAdding(false);
            onChanged();
        } catch (e) {
            if ((e as RequestError).status === 402 || (e as RequestError).code === 'capability_required') onPaywalled();
            else setError((e as Error).message || t('datatables.err_grant_add', 'Could not share the table'));
        } finally {
            setBusy(false);
        }
    };

    const setGrantGrade = async (g: DatatableGrant, nextGrade: string) => {
        if (nextGrade === g.grade) return;
        setError(null);
        try {
            // No PATCH on a grant: re-granting the same principal is how the
            // server updates one (the store upserts on (table, principal)).
            await datatablesApi.addGrant(table.id, { granteeType: g.granteeType, granteeId: g.granteeId, grade: nextGrade });
            onChanged();
        } catch (e) {
            if ((e as RequestError).status === 402 || (e as RequestError).code === 'capability_required') onPaywalled();
            else setError((e as Error).message || t('datatables.err_grant_add', 'Could not share the table'));
        }
    };

    const remove = async (grantId: string) => {
        try {
            await datatablesApi.removeGrant(table.id, grantId);
            onChanged();
        } catch (e) {
            setError((e as Error).message || t('datatables.err_grant_remove', 'Could not remove the share'));
        }
    };

    return (
        <div className="space-y-2">
            <div className="overflow-hidden" style={CARD}>
                {/* The owner is always on the list, so an empty list never
                    reads "Nobody yet" above a row with somebody on it. */}
                <h4 className="flex items-center gap-2 text-sm font-semibold px-4 py-3 m-0 [color:var(--text-primary)]! [border-bottom:1px_solid_var(--border-default)]">
                    <UserPlus className="w-3.5 h-3.5 text-[var(--text-secondary)]" aria-hidden="true" />
                    {t('datatables.grants_title', 'People and teams')}
                    <span className="ml-auto text-[11px] font-medium text-[var(--text-tertiary)]">{t('datatables.grants_caption', 'invited by name')}</span>
                </h4>
                {grants.map(g => (
                    <div key={g.id} className="grid items-center gap-3 px-4 py-3 [grid-template-columns:minmax(0,1fr)_200px_32px] [border-bottom:1px_solid_var(--border-default)]">
                        <span className="flex items-center gap-2.5 min-w-0">
                            <Avatar name={nameOf(g)} group={g.granteeType === 'group'} />
                            <span className="min-w-0">
                                <span className="block text-sm font-medium truncate text-[var(--text-primary)]">{nameOf(g)}</span>
                                <span className="block text-[11px] text-[var(--text-tertiary)]">
                                    {g.granteeType === 'group'
                                        ? t('datatables.grantee_group', 'A group')
                                        : t('datatables.grantee_person', 'A person')}
                                </span>
                            </span>
                        </span>
                        <select
                            value={g.grade}
                            disabled={!canEdit}
                            aria-label={t('datatables.grant_grade_for', 'What {name} may do', { name: nameOf(g) })}
                            onChange={(e) => setGrantGrade(g, e.target.value)}
                            className={SELECT}
                            style={CONTROL}
                        >
                            <option value="viewer">{t('datatables.grade_can_read', 'can read rows')}</option>
                            <option value="editor">{t('datatables.grade_can_write', 'can change rows')}</option>
                        </select>
                        {canEdit ? (
                            <button type="button" onClick={() => remove(g.id)}
                                aria-label={t('datatables.grant_remove', 'Remove {name}', { name: nameOf(g) })}
                                className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!">
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        ) : <span />}
                    </div>
                ))}

                <div className="grid items-center gap-3 px-4 py-3"
                    style={{ gridTemplateColumns: 'minmax(0,1fr) 200px 32px', borderBottom: canEdit ? '1px solid var(--border-default)' : 'none' }}>
                    <span className="flex items-center gap-2.5 min-w-0">
                        <Avatar name={owner?.name || owner?.email || table.ownerUserId || '?'} />
                        <span className="min-w-0">
                            <span className="block text-sm font-medium truncate text-[var(--text-primary)]">
                                {owner?.name || owner?.email || t('datatables.owner_unknown', 'The owner')}
                            </span>
                            <span className="block text-[11px] text-[var(--text-tertiary)]">
                                {t('datatables.owner_row', 'owner')}
                            </span>
                        </span>
                    </span>
                    <span className="text-xs px-2.5 text-[var(--text-tertiary)]">
                        {t('datatables.owner_grade', 'Owner')}
                    </span>
                    <span />
                </div>

                {canEdit && !adding && (
                    <button type="button" onClick={() => setAdding(true)}
                        className="w-full text-left flex items-center gap-2 px-4 py-2.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!">
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('datatables.grant_add_open', 'Add a person or team')}
                    </button>
                )}

                {canEdit && adding && (
                    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                        <select value={granteeType} onChange={(e) => { setGranteeType(e.target.value); setGranteeId(''); }}
                            aria-label={t('datatables.grantee_kind', 'A person or a group')}
                            className={SELECT} style={CONTROL}>
                            <option value="user">{t('datatables.grantee_person', 'A person')}</option>
                            <option value="group">{t('datatables.grantee_group', 'A group')}</option>
                        </select>
                        <select value={granteeId} onChange={(e) => setGranteeId(e.target.value)}
                            aria-label={t('datatables.grantee_who', 'Who to share with')}
                            className={`${SELECT} flex-1 min-w-[10rem]`} style={CONTROL}>
                            <option value="">{granteeType === 'user' ? t('datatables.pick_person', 'Pick someone…') : t('datatables.pick_group', 'Pick a group…')}</option>
                            {options.map(o => <option key={o.id} value={o.id}>{o.name || o.email || o.id}</option>)}
                        </select>
                        <select value={grade} onChange={(e) => setGrade(e.target.value)}
                            aria-label={t('datatables.grantee_grade', 'What they may do')}
                            className={SELECT} style={CONTROL}>
                            <option value="viewer">{t('datatables.grade_can_read', 'can read rows')}</option>
                            <option value="editor">{t('datatables.grade_can_write', 'can change rows')}</option>
                        </select>
                        <button type="button" onClick={add} disabled={busy || !granteeId}
                            className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {t('datatables.share_button', 'Share')}
                        </button>
                        <button type="button" onClick={() => { setAdding(false); setGranteeId(''); }}
                            className="px-3 py-1.5 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [border-color:var(--border-default)] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!">
                            {t('datatables.cancel', 'Cancel')}
                        </button>
                    </div>
                )}
            </div>

            <p aria-live="polite">
                {error && <span className="text-xs text-[var(--warning)]">{error}</span>}
            </p>
        </div>
    );
}

const SELECT = 'px-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';

const CONTROL = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};

function Avatar({ name, group = false }: AvatarProps) {
    const initials = String(name || '?').trim().split(/\s+/).slice(0, 2)
        .map(w => w[0]).join('').toUpperCase() || '?';
    return (
        <span className="grid place-items-center shrink-0 text-[11px] font-bold w-[28px] h-[28px] [border-radius:8px] [background:var(--bg-tertiary)] [color:var(--text-secondary)]!"
            aria-hidden="true">
            {group ? <Users className="w-3.5 h-3.5" /> : (initials.length ? initials : <User className="w-3.5 h-3.5" />)}
        </span>
    );
}

import { Loader2, Lock, Plus, User, Users, X } from 'lucide-react';
import React, { useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DashCard from '../../../../shared/dashboard/DashCard';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import useConfirm from '../../../../shared/useConfirm';
import { useOrgDirectory } from '../../AppStudio/rbac/useAppRoles';

/**
 * Who can FILL THE FORM IN — the form's audience (PUT /forms/:id/audience).
 *
 * Two answers, one fieldset: "only the people and groups you choose" (the
 * default for a new form: nobody until the owner adds someone) or "everyone
 * in the organisation". Never anyone outside it: the organisation is the
 * outer wall on the server whatever is chosen here, so this card does not
 * offer a third option it could not keep.
 *
 * The list below the first answer is the same shape as the answers table's
 * sharing card underneath it (a 28px tile, a name, a ×, an add row): a
 * person or a group from the organisation directory. Widening — from a
 * list to the whole organisation — asks first, naming what changes; taking
 * someone off is one click.
 */
const CARD = { border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--bg-card)' };
const SELECT = 'px-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const CONTROL = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' };

export default function FormAudienceCard({ form, canEdit, onChanged }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const directory = useOrgDirectory(canEdit);
    const { confirm, confirmDialog } = useConfirm();
    const initial = form?.audience || { mode: 'restricted', groups: [], users: [] };
    const [audience, setAudience] = useState({ mode: initial.mode || 'restricted', groups: initial.groups || [], users: initial.users || [] });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [adding, setAdding] = useState(false);
    const [granteeType, setGranteeType] = useState('user');
    const [granteeId, setGranteeId] = useState('');

    const users = directory.users || [];
    const groups = directory.groups || [];
    const nameOf = (type, id) => {
        const hit = (type === 'user' ? users : groups).find(x => x.id === id);
        return hit?.name || hit?.email || id;
    };

    const write = async (next) => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.setFormAudience(form.automationId, { audience: next.mode, sharedGroups: next.groups, sharedUserIds: next.users });
            const saved = res?.audience || next;
            setAudience({ mode: saved.mode || next.mode, groups: saved.groups || next.groups, users: saved.users || next.users });
            if (onChanged) onChanged();
        } catch (e) {
            setError(e?.message || t('forms.share.audience_failed', 'Could not change who can fill in the form.'));
        } finally {
            setBusy(false);
        }
    };

    const choose = async (mode) => {
        if (!canEdit || busy || mode === audience.mode) return;
        if (mode === 'org') {
            const ok = await confirm({
                title: t('forms.share.audience_widen_title', 'Open the form to the whole organisation?'),
                description: t('forms.share.audience_widen_body', 'Every signed-in colleague with the link can then fill it in. The people and groups listed stay listed, for when you narrow it again.'),
                confirmLabel: t('forms.share.audience_widen_confirm', 'Open to everyone'),
                cancelLabel: t('forms.share.audience_widen_cancel', 'Keep the list'),
            });
            if (!ok) return;
        }
        await write({ ...audience, mode });
    };

    const add = async () => {
        if (!granteeId) return;
        const next = granteeType === 'user'
            ? { ...audience, users: audience.users.includes(granteeId) ? audience.users : [...audience.users, granteeId] }
            : { ...audience, groups: audience.groups.includes(granteeId) ? audience.groups : [...audience.groups, granteeId] };
        await write(next);
        setAdding(false);
        setGranteeId('');
    };
    const remove = (type, id) => write(type === 'user'
        ? { ...audience, users: audience.users.filter(x => x !== id) }
        : { ...audience, groups: audience.groups.filter(x => x !== id) });

    const rows = [
        ...audience.groups.map(id => ({ type: 'group', id })),
        ...audience.users.map(id => ({ type: 'user', id })),
    ];
    const options = granteeType === 'user' ? users.filter(u => !audience.users.includes(u.id)) : groups.filter(g => !audience.groups.includes(g.id));
    const restricted = audience.mode === 'restricted';

    return (
        <DashCard title={t('forms.share.audience_title', 'Who can fill it in')} testId="form-audience">
            <fieldset disabled={!canEdit || busy} className="space-y-2">
                <legend className="sr-only">{t('forms.share.audience_title', 'Who can fill it in')}</legend>
                <div className="overflow-hidden" style={CARD}>
                    <AudienceRow
                        icon={<Lock className="w-4 h-4" aria-hidden="true" />}
                        title={t('forms.share.audience_restricted', 'Only the people and groups you choose')}
                        description={t('forms.share.audience_restricted_desc', 'Colleagues you list below, and the members of the groups you list. Nobody else in the organisation — and never anyone outside it.')}
                        checked={restricted}
                        onSelect={() => choose('restricted')}
                        disabled={!canEdit || busy}
                        testId="form-audience-restricted"
                    />
                    <AudienceRow
                        icon={<Users className="w-4 h-4" aria-hidden="true" />}
                        title={t('forms.share.audience_org', 'Everyone in the organisation')}
                        description={t('forms.share.audience_org_desc', 'Every signed-in colleague with the link. Never anyone outside the organisation.')}
                        checked={!restricted}
                        onSelect={() => choose('org')}
                        disabled={!canEdit || busy}
                        testId="form-audience-org"
                        last
                    />
                </div>
            </fieldset>

            {restricted && (
                <div className="mt-3 overflow-hidden" style={CARD} data-testid="form-audience-list">
                    {rows.length === 0 && (
                        <p className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-default)' }}>
                            {t('forms.share.audience_empty', 'Nobody yet — only you can open the form. Add the people or groups it is for.')}
                        </p>
                    )}
                    {rows.map(r => (
                        <div key={`${r.type}:${r.id}`} className="grid items-center gap-3 px-4 py-2.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 32px', borderBottom: '1px solid var(--border-default)' }} data-testid="form-audience-row">
                            <span className="flex items-center gap-2.5 min-w-0">
                                <Avatar name={nameOf(r.type, r.id)} group={r.type === 'group'} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{nameOf(r.type, r.id)}</span>
                                    <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                        {r.type === 'group' ? t('forms.share.audience_group', 'A group — every member') : t('forms.share.audience_person', 'A person')}
                                    </span>
                                </span>
                            </span>
                            {canEdit ? (
                                <button type="button" onClick={() => remove(r.type, r.id)} disabled={busy}
                                    aria-label={t('forms.share.audience_remove', 'Remove {name}', { name: nameOf(r.type, r.id) })}
                                    className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2"
                                    style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            ) : <span />}
                        </div>
                    ))}
                    {canEdit && !adding && (
                        <button type="button" onClick={() => setAdding(true)} disabled={busy}
                            className="w-full text-left flex items-center gap-2 px-4 py-2.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                            style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }} data-testid="form-audience-add-open">
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('forms.share.audience_add', 'Add a person or group')}
                        </button>
                    )}
                    {canEdit && adding && (
                        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                            <select value={granteeType} onChange={(e) => { setGranteeType(e.target.value); setGranteeId(''); }}
                                aria-label={t('forms.share.audience_kind', 'A person or a group')} className={SELECT} style={CONTROL}>
                                <option value="user">{t('forms.share.audience_person', 'A person')}</option>
                                <option value="group">{t('forms.share.audience_group_short', 'A group')}</option>
                            </select>
                            <select value={granteeId} onChange={(e) => setGranteeId(e.target.value)}
                                aria-label={t('forms.share.audience_who', 'Who')} className={`${SELECT} flex-1 min-w-[10rem]`} style={CONTROL} data-testid="form-audience-pick">
                                <option value="">{granteeType === 'user' ? t('forms.share.audience_pick_person', 'Pick someone…') : t('forms.share.audience_pick_group', 'Pick a group…')}</option>
                                {options.map(o => <option key={o.id} value={o.id}>{o.name || o.email || o.id}</option>)}
                            </select>
                            <button type="button" onClick={add} disabled={busy || !granteeId}
                                className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }} data-testid="form-audience-add">
                                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                                {t('forms.share.audience_add_confirm', 'Add')}
                            </button>
                            <button type="button" onClick={() => { setAdding(false); setGranteeId(''); }}
                                className="px-3 py-1.5 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                                {t('forms.new.cancel', 'Cancel')}
                            </button>
                        </div>
                    )}
                </div>
            )}
            <p aria-live="polite" className="mt-2">
                {error && <span role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</span>}
            </p>
            {confirmDialog}
        </DashCard>
    );
}

/** Initials in a 28px tile — the answers-table sharing card's tile, same recipe. */
function Avatar({ name, group = false }) {
    const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    return (
        <span className="grid place-items-center shrink-0 text-[11px] font-bold" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }} aria-hidden="true">
            {group ? <Users className="w-3.5 h-3.5" /> : (initials.length ? initials : <User className="w-3.5 h-3.5" />)}
        </span>
    );
}

function AudienceRow({ icon, title, description, checked, onSelect, disabled = false, testId, last = false }) {
    return (
        <label className={`flex items-start gap-3 px-4 py-3 ${disabled ? 'cursor-default' : 'cursor-pointer'}`} style={{ borderBottom: last ? 'none' : '1px solid var(--border-default)' }} data-testid={testId}>
            <input type="radio" name="form-audience" checked={checked} onChange={onSelect} disabled={disabled} className="mt-1 shrink-0" />
            <span className="mt-0.5 shrink-0" style={{ color: checked ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>{icon}</span>
            <span className="min-w-0">
                <span className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
                <span className="block text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{description}</span>
            </span>
        </label>
    );
}

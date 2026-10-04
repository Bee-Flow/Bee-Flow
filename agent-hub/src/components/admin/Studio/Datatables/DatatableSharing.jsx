import { Building2, Eye, Loader2, Lock, Plus, ShieldAlert, ShieldCheck, User, UserPlus, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { audienceOf, describeAccess, joinNames, GROUPS, ORG, PRIVATE } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { readGrants } from './grants';
import useTranslation from '../../../../hooks/useTranslation';
import ConfirmDialog from '../../../shared/ConfirmDialog';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { useOrgDirectory } from '../AppStudio/rbac/useAppRoles';

/**
 * Who can read this table, and — SEPARATELY — who can change it
 * (Datatables artboard 1f, "Tab · Delen").
 *
 * The separation is the whole design. On the server an empty `shared_groups`
 * on a published table means the ENTIRE ORGANISATION (auth/audience.js), so if
 * one setting governed both, "share this with the company" would silently mean
 * "let the company delete rows". Reading is the audience; writing is either an
 * explicit invitation list or a deliberate second choice to open it to that
 * same audience. The consequence sentence below always states both, and never
 * softens the loud combination.
 *
 * ── THE ARTBOARD'S LIST, OVER THE TWO-AXIS MODEL ────────────────────
 * 1f draws one list of rows with a role dropdown each: "Everyone in the
 * organisation → may read", "Team Finance → may read and change", the owner.
 * That reading is adopted for the SHAPE — a card of rows, a 28px tile, a
 * subtitle, the invite affordance at the foot — but not for the CONTROL. A
 * single "no access / read / read and change" dropdown on the organisation
 * row would collapse the two axes back into one: it cannot express
 * "published to everyone, writable only by the people I invited", which is
 * the default this whole section exists to protect, and the two rows of the
 * dropdown that DO map onto it ({org, grants} and {org, audience}) would hide
 * the write decision inside a menu instead of asking for it. So the audience
 * stays three real radios in one fieldset (one choice, three mutually
 * exclusive answers — `aria-pressed` buttons announced a single setting as
 * three independent toggles), and the write axis stays its own labelled tick.
 *
 * Sharing is also the licence boundary — reading and writing rows on a table
 * you already hold a grade on stays free, so a lapsed licence can never turn a
 * nightly automation into a hole in the org's data. A 402 here therefore reads
 * as "this is the paid part", not as a failure.
 *
 * WIDENING ASKS, NARROWING DOES NOT. Going private → groups, private →
 * organisation, groups → organisation, or turning on write-by-audience each
 * hand real people access they did not have a second ago, so each goes through
 * a confirmation that names WHO and WHAT. Taking access away stays one click:
 * making "stop sharing this" slower than starting to share it is backwards.
 */
export default function DatatableSharing({ table, canEdit, onChanged }) {
    // A PERSONAL table has no audience to describe. The server refuses every
    // descriptor for one (`personal_table_not_shareable`), so rendering the
    // controls would offer a choice that cannot be made — and, worse, would
    // suggest the rows could become visible to a colleague. State the rule
    // instead, and say "this account": on a self-hosted install the built-in
    // `admin` login is routinely shared between several human operators, so
    // "only you" would be a promise the product cannot keep.
    if (table?.scopeKind === 'user') return <PersonalNotice />;
    return <OrgSharing table={table} canEdit={canEdit} onChanged={onChanged} />;
}

const CARD = {
    borderRadius: 12,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)',
};

function PersonalNotice() {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-4 flex items-start gap-3" style={CARD}>
            <Lock className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <div className="min-w-0">
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t('datatables.share_personal_title', 'This table cannot be shared')}
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('datatables.share_personal_body', 'It belongs to this account alone. Nobody else can read or change its rows — not colleagues, not administrators — and there is no setting that would change that. To share data with the rest of your organisation, make an organisation table.')}
                </p>
            </div>
        </div>
    );
}

function OrgSharing({ table, canEdit, onChanged }) {
    const { t } = useTranslation();
    const directory = useOrgDirectory(true);
    const [grants, setGrants] = useState([]);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [paywalled, setPaywalled] = useState(false);
    // "Specific groups" picked, but no group chosen yet. Local only — see
    // chooseAudience for why this cannot be a request.
    const [audienceDraft, setAudienceDraft] = useState(null);
    const [confirm, setConfirm] = useState(null);

    const groupNames = useMemo(
        () => new Map((directory.groups || []).map(g => [g.id, g.name || g.id])),
        [directory.groups],
    );
    // `audience` is what the SERVER holds; `shownAudience` is what the radio
    // shows, which may be one step ahead of it while a group is being picked.
    const audience = audienceOf(table);
    const shownAudience = audienceDraft || audience;
    const access = describeAccess(table, groupNames);

    // The draft is spent the moment the table itself moves.
    useEffect(() => { setAudienceDraft(null); }, [audience, table.id]);

    const loadGrants = useCallback(async () => {
        try {
            const b = await datatablesApi.listGrants(table.id);
            setGrants(readGrants(b?.grants));
        } catch (e) {
            setError(e.message || t('datatables.err_grants', 'Could not load who this is shared with'));
        }
    }, [table.id, t]);

    useEffect(() => { loadGrants(); }, [loadGrants]);

    const patchSharing = useCallback(async (descriptor) => {
        setBusy(true);
        setError(null);
        setPaywalled(false);
        try {
            await datatablesApi.setSharing(table.id, descriptor);
            // Anything but a groups descriptor settles the question the draft
            // was holding open, so the table's own state is the truth again.
            if (descriptor.audience && descriptor.audience !== GROUPS) setAudienceDraft(null);
            onChanged?.();
        } catch (e) {
            if (e.status === 402 || e.code === 'capability_required') setPaywalled(true);
            else setError(e.message || t('datatables.err_sharing', 'Could not update sharing'));
        } finally {
            setBusy(false);
        }
    }, [table.id, onChanged, t]);

    /** Hold the descriptor until the person has read who gains access. */
    const askThenPatch = (question, descriptor) => setConfirm({ question, descriptor });

    const namesOf = (ids) => joinNames((ids || []).map(g => groupNames.get(g) || g));
    // Say the write half too when it is on, because then "can read" is the
    // smaller half of what is being handed over.
    const andWrite = table.writeMode === 'audience'
        ? t('datatables.and_write', ', and to add, change and delete them')
        : '';

    const chooseAudience = (next) => {
        if (next === shownAudience) return;
        // Only the draft was ahead of the table — drop it, send nothing.
        if (next === audience) return setAudienceDraft(null);

        if (next === PRIVATE) return patchSharing({ audience: 'private' });
        if (next === ORG) {
            return askThenPatch(
                t('datatables.confirm_org', 'Everyone in your organisation will be able to read every row of “{name}”{write}.', { name: table.name, write: andWrite }),
                { audience: 'organisation' },
            );
        }
        // GROUPS sends NOTHING. Publishing on the click would hand the table to
        // the whole organisation (an empty sharedGroups on a published table
        // means everyone) — the exact opposite of the option's own label. The
        // first ticked group is what shares it.
        return setAudienceDraft(GROUPS);
    };

    const toggleGroup = (id) => {
        const current = new Set(table.sharedGroups || []);
        const adding = !current.has(id);
        if (adding) current.add(id); else current.delete(id);
        const next = [...current];
        // An empty list on a PUBLISHED table means the whole organisation, so
        // clearing the last group would silently widen the audience instead of
        // narrowing it. Unpublish instead — the honest reading of "no groups".
        if (!next.length) return patchSharing({ audience: 'private' });

        const descriptor = { audience: 'groups', sharedGroups: next };
        // Leaving PRIVATE is the widening. Coming DOWN from the whole
        // organisation to a group list is a narrowing and must not nag.
        if (adding && audience === PRIVATE) {
            return askThenPatch(
                t('datatables.confirm_groups', 'Members of {groups} will be able to read every row of “{name}”{write}.', { groups: namesOf(next), name: table.name, write: andWrite }),
                descriptor,
            );
        }
        return patchSharing(descriptor);
    };

    const setWriteMode = (openToAudience) => {
        if (!openToAudience) return patchSharing({ writeMode: 'grants' });
        return askThenPatch(
            t('datatables.confirm_write', '{who} will be able to add, change and delete rows, not just read them.', { who: access.readers }),
            { writeMode: 'audience' },
        );
    };

    return (
        <div className="space-y-4">
          {/* Ronde 2 (2c): the audience on the left, the people on the right,
              one card each — and no separate banner. What the two settings
              mean together is ONE line at the foot of the audience card. */}
          <div className="grid gap-3 md:grid-cols-2 items-start">
            <div className="overflow-hidden" style={CARD}>
                <h4 className="flex items-center gap-2 text-sm font-semibold px-4 pt-3 pb-1 m-0" style={{ color: 'var(--text-primary)' }}>
                    <Eye className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    {t('datatables.share_read_title', 'Who can read the rows')}
                </h4>
                {/* Real radios in a fieldset, not three aria-pressed buttons: this
                    is ONE choice among three mutually exclusive answers, and
                    aria-pressed announces each as an independent toggle — so a
                    screen reader read a single setting out as "Private, pressed.
                    Entire organisation, not pressed." */}
                <fieldset disabled={!canEdit || busy}>
                    <legend className="sr-only">{t('datatables.share_legend', 'Who can read this table')}</legend>
                    <AudienceRow
                        icon={<Lock className="w-3.5 h-3.5" aria-hidden="true" />}
                        title={t('datatables.share_private', 'Private')}
                        description={t('datatables.share_private_desc', 'Only you and the people you invite.')}
                        checked={shownAudience === PRIVATE} onSelect={() => chooseAudience(PRIVATE)}
                    />
                    <AudienceRow
                        icon={<Building2 className="w-3.5 h-3.5" aria-hidden="true" />}
                        title={t('datatables.share_org', 'Entire organisation')}
                        description={t('datatables.share_org_desc', 'Everyone can read; only invited people can edit.')}
                        checked={shownAudience === ORG} onSelect={() => chooseAudience(ORG)}
                    />
                    <AudienceRow
                        icon={<Users className="w-3.5 h-3.5" aria-hidden="true" />}
                        title={t('datatables.share_groups', 'Specific groups')}
                        description={t('datatables.share_groups_desc', 'Only members of the groups you pick.')}
                        checked={shownAudience === GROUPS} onSelect={() => chooseAudience(GROUPS)}
                        last={shownAudience !== GROUPS && audience === PRIVATE}
                    />

                    {shownAudience === GROUPS && (
                        <div className="px-4 py-3 space-y-1.5"
                            style={{ borderBottom: audience === PRIVATE ? 'none' : '1px solid var(--border-default)', background: 'var(--bg-secondary)' }}>
                            {audienceDraft === GROUPS && (
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {t('datatables.share_groups_pending', 'Nothing has changed yet — picking a group is what shares the table.')}
                                </p>
                            )}
                            {directory.isLoading && <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('datatables.loading_groups', 'Loading groups…')}</p>}
                            {!directory.available && !directory.isLoading && (
                                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('datatables.share_no_directory', 'You cannot see the organisation’s group list, so the groups are shown by id.')}
                                </p>
                            )}
                            {(directory.groups || []).map(g => (
                                <label key={g.id} className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        disabled={!canEdit || busy}
                                        checked={(table.sharedGroups || []).includes(g.id)}
                                        onChange={() => toggleGroup(g.id)}
                                    />
                                    <span style={{ color: 'var(--text-primary)' }}>{g.name || g.id}</span>
                                    {/* Only when the directory actually answers it —
                                        an invented "0 people" beside a group is worse
                                        than no number at all. */}
                                    {Number.isFinite(g.memberCount) && (
                                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                            {t('datatables.group_members', '{n} people', { n: g.memberCount })}
                                        </span>
                                    )}
                                </label>
                            ))}
                        </div>
                    )}

                    {audience !== PRIVATE && (
                        <label className="flex items-start gap-2.5 px-4 py-3 text-sm">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                disabled={!canEdit || busy}
                                checked={table.writeMode === 'audience'}
                                onChange={(e) => setWriteMode(e.target.checked)}
                            />
                            <span>
                                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                    {t('datatables.share_write_toggle', 'Let everyone who can read it change it too')}
                                </span>
                                <span className="block text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    {t('datatables.share_write_help', 'Off by default. With this off, only the people you invite below can add, change or delete rows.')}
                                </span>
                            </span>
                        </label>
                    )}
                </fieldset>
                <ConsequenceLine t={t} access={access} />
            </div>

            <GrantList
                table={table}
                grants={grants}
                canEdit={canEdit}
                directory={directory}
                onChanged={loadGrants}
                onPaywalled={() => setPaywalled(true)}
            />
          </div>

            {/* aria-live: both of these appear after a click that moves no
                focus, so without it the only feedback is visual. */}
            <div aria-live="polite">
                {paywalled && (
                    <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                        {t('datatables.share_paywalled', 'Sharing a datatable with colleagues is part of a paid plan. Your own tables, and every table already shared with you, keep working exactly as they do now.')}
                    </p>
                )}
                {error && <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }}>{error}</p>}
            </div>

            <ConfirmDialog
                open={!!confirm}
                title={t('datatables.share_confirm_title', 'Give more people access?')}
                description={confirm?.question}
                confirmLabel={t('datatables.share_confirm_yes', 'Share it')}
                cancelLabel={t('datatables.share_confirm_no', 'Leave it as it is')}
                onConfirm={async () => { await patchSharing(confirm.descriptor); setConfirm(null); }}
                onCancel={() => setConfirm(null)}
            />
        </div>
    );
}

/** One row of the audience card: a real radio, a tile, a title and a sentence. */
function AudienceRow({ icon, title, description, checked, onSelect, last = false }) {
    return (
        <label
            className="w-full flex items-center gap-3 px-4 py-3 cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-2px]"
            style={{
                borderBottom: last ? 'none' : '1px solid var(--border-default)',
                background: checked ? 'var(--bg-secondary)' : 'transparent',
                outlineColor: 'var(--accent-primary)',
            }}
        >
            <input
                type="radio"
                name="datatable-audience"
                className="shrink-0"
                checked={checked}
                onChange={onSelect}
            />
            <span className="grid place-items-center shrink-0"
                style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                aria-hidden="true">
                {icon}
            </span>
            <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
                <span className="block text-xs" style={{ color: 'var(--text-tertiary)' }}>{description}</span>
            </span>
        </label>
    );
}

/**
 * Says what the two settings TOGETHER mean, in one sentence each — the foot
 * of the audience card (2c has no second banner), warning-tinted only when
 * the setting is the widest there is.
 */
function ConsequenceLine({ t, access }) {
    const Icon = access.broad ? ShieldAlert : ShieldCheck;
    return (
        <div className="px-4 py-2.5 flex items-start gap-2"
            style={{
                borderTop: '1px solid var(--border-default)',
                background: access.broad ? 'color-mix(in srgb, var(--warning) 8%, transparent)' : 'var(--bg-secondary)',
            }} data-testid="sharing-consequence">
            <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: access.broad ? 'var(--warning)' : 'var(--text-tertiary)' }} aria-hidden="true" />
            <div className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
                <p><strong>{access.readers}</strong> {t('datatables.can_read_every_row', 'can read every row.')}</p>
                <p>{t('datatables.rows_changed_by', 'Rows can be added, changed and deleted by')} <strong>{access.writers}</strong>.</p>
                {access.broad && (
                    <p>{t('datatables.widest_setting', 'That is the widest setting there is: anyone in your organisation can delete every row, and any automation they run can too.')}</p>
                )}
            </div>
        </div>
    );
}

/**
 * The people and teams invited by name — the artboard's row list, with the
 * owner at the foot of it.
 *
 * The owner row is not a control: ownership is not a grade you can hand over
 * from here, and a dropdown that looked like one would be a promise the API
 * does not keep.
 */
function GrantList({ table, grants, canEdit, directory, onChanged, onPaywalled }) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState(false);
    const [granteeType, setGranteeType] = useState('user');
    const [granteeId, setGranteeId] = useState('');
    const [grade, setGrade] = useState('viewer');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const options = granteeType === 'user' ? (directory.users || []) : (directory.groups || []);
    const nameOf = (g) => {
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
            if (e.status === 402 || e.code === 'capability_required') onPaywalled();
            else setError(e.message || t('datatables.err_grant_add', 'Could not share the table'));
        } finally {
            setBusy(false);
        }
    };

    const setGrantGrade = async (g, nextGrade) => {
        if (nextGrade === g.grade) return;
        setError(null);
        try {
            // No PATCH on a grant: re-granting the same principal is how the
            // server updates one (the store upserts on (table, principal)).
            await datatablesApi.addGrant(table.id, { granteeType: g.granteeType, granteeId: g.granteeId, grade: nextGrade });
            onChanged();
        } catch (e) {
            if (e.status === 402 || e.code === 'capability_required') onPaywalled();
            else setError(e.message || t('datatables.err_grant_add', 'Could not share the table'));
        }
    };

    const remove = async (grantId) => {
        try {
            await datatablesApi.removeGrant(table.id, grantId);
            onChanged();
        } catch (e) {
            setError(e.message || t('datatables.err_grant_remove', 'Could not remove the share'));
        }
    };

    return (
        <div className="space-y-2">
            <div className="overflow-hidden" style={CARD}>
                {/* The owner is always on the list, so an empty list never
                    reads "Nobody yet" above a row with somebody on it. */}
                <h4 className="flex items-center gap-2 text-sm font-semibold px-4 py-3 m-0" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-default)' }}>
                    <UserPlus className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
                    {t('datatables.grants_title', 'People and teams')}
                    <span className="ml-auto text-[11px] font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('datatables.grants_caption', 'invited by name')}</span>
                </h4>
                {grants.map(g => (
                    <div key={g.id} className="grid items-center gap-3 px-4 py-3"
                        style={{ gridTemplateColumns: 'minmax(0,1fr) 200px 32px', borderBottom: '1px solid var(--border-default)' }}>
                        <span className="flex items-center gap-2.5 min-w-0">
                            <Avatar name={nameOf(g)} group={g.granteeType === 'group'} />
                            <span className="min-w-0">
                                <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{nameOf(g)}</span>
                                <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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
                                className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2"
                                style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
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
                            <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                {owner?.name || owner?.email || t('datatables.owner_unknown', 'The owner')}
                            </span>
                            <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                {t('datatables.owner_row', 'owner')}
                            </span>
                        </span>
                    </span>
                    <span className="text-xs px-2.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t('datatables.owner_grade', 'Owner')}
                    </span>
                    <span />
                </div>

                {canEdit && !adding && (
                    <button type="button" onClick={() => setAdding(true)}
                        className="w-full text-left flex items-center gap-2 px-4 py-2.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
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
                            className="px-3 py-1.5 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                            {t('datatables.cancel', 'Cancel')}
                        </button>
                    </div>
                )}
            </div>

            <p aria-live="polite">
                {error && <span className="text-xs" style={{ color: 'var(--warning)' }}>{error}</span>}
            </p>
        </div>
    );
}

const SELECT = 'px-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1';
const CONTROL = {
    background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
};

/** Initials in a 28px tile — a person or a team, never a fetched photo. */
function Avatar({ name, group = false }) {
    const initials = String(name || '?').trim().split(/\s+/).slice(0, 2)
        .map(w => w[0]).join('').toUpperCase() || '?';
    return (
        <span className="grid place-items-center shrink-0 text-[11px] font-bold"
            style={{
                width: 28, height: 28, borderRadius: 8,
                background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
            }}
            aria-hidden="true">
            {group ? <Users className="w-3.5 h-3.5" /> : (initials.length ? initials : <User className="w-3.5 h-3.5" />)}
        </span>
    );
}

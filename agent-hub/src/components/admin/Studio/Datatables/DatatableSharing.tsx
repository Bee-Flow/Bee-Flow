import { Building2, Eye, Lock, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { audienceOf, describeAccess, joinNames, GROUPS, ORG, PRIVATE } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { readGrants, type DatatableGrant } from './grants';
import useTranslation from '../../../../hooks/useTranslation';
import ConfirmDialog from '../../../shared/ConfirmDialog';
import { useOrgDirectory, type DirectoryEntry } from '../AppStudio/rbac/useAppRoles';
import type { DtTable } from './rowBrowser/rowBrowserModel';
import type { Body } from './datatablesApi.types';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { SharedTable, Principal, RequestError, DatatableSharingProps, OrgSharingProps, AudienceRowProps, ConsequenceLineProps } from './DatatableSharing.types';
import { CARD, GrantList } from './GrantList';

export default function DatatableSharing({ table, canEdit, onChanged }: DatatableSharingProps) {
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

function PersonalNotice() {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-4 flex items-start gap-3" style={CARD}>
            <Lock className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                    {t('datatables.share_personal_title', 'This table cannot be shared')}
                </p>
                <p className="text-sm mt-1 text-[var(--text-secondary)]">
                    {t('datatables.share_personal_body', 'It belongs to this account alone. Nobody else can read or change its rows — not colleagues, not administrators — and there is no setting that would change that. To share data with the rest of your organisation, make an organisation table.')}
                </p>
            </div>
        </div>
    );
}

function OrgSharing({ table, canEdit, onChanged }: OrgSharingProps) {
    const { t } = useTranslation();
    const directory = useOrgDirectory(true);
    const [grants, setGrants] = useState<DatatableGrant[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [paywalled, setPaywalled] = useState(false);
    // "Specific groups" picked, but no group chosen yet. Local only — see
    // chooseAudience for why this cannot be a request.
    const [audienceDraft, setAudienceDraft] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<{ question: string; descriptor: { audience?: string; sharedGroups?: string[]; writeMode?: string; }; } | null>(null);

    const groupNames = useMemo(
        () => new Map((directory.groups || []).map(g => [g.id, g.name || g.id])),
        [directory.groups],
    );
    // `audience` is what the SERVER holds; `shownAudience` is what the radio
    // shows, which may be one step ahead of it while a group is being picked.
    const audience = audienceOf(table);
    const shownAudience = audienceDraft || audience;
    const access = describeAccess(table, groupNames, t);

    // The draft is spent the moment the table itself moves.
    useEffect(() => { setAudienceDraft(null); }, [audience, table.id]);

    const loadGrants = useCallback(async () => {
        try {
            const b = await datatablesApi.listGrants(table.id);
            setGrants(readGrants(b?.grants));
        } catch (e) {
            setError((e as Error).message || t('datatables.err_grants', 'Could not load who this is shared with'));
        }
    }, [table.id, t]);

    useEffect(() => { loadGrants(); }, [loadGrants]);

    const patchSharing = useCallback(async (descriptor: Body) => {
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
            if ((e as RequestError).status === 402 || (e as RequestError).code === 'capability_required') setPaywalled(true);
            else setError((e as Error).message || t('datatables.err_sharing', 'Could not update sharing'));
        } finally {
            setBusy(false);
        }
    }, [table.id, onChanged, t]);

    /** Hold the descriptor until the person has read who gains access. */
    const askThenPatch = (question: string, descriptor: { audience?: string; sharedGroups?: string[]; writeMode?: string }) => setConfirm({ question, descriptor });

    const namesOf = (ids: string[]) => joinNames((ids || []).map(g => groupNames.get(g) || g), t);
    // Say the write half too when it is on, because then "can read" is the
    // smaller half of what is being handed over.
    const andWrite = table.writeMode === 'audience'
        ? t('datatables.and_write', ', and to add, change and delete them')
        : '';

    const chooseAudience = (next: string) => {
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

    const toggleGroup = (id: string) => {
        const current = new Set<string>(table.sharedGroups || []);
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

    const setWriteMode = (openToAudience: boolean) => {
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
                <h4 className="flex items-center gap-2 text-sm font-semibold px-4 pt-3 pb-1 m-0 text-[var(--text-primary)]">
                    <Eye className="w-3.5 h-3.5 text-[var(--text-secondary)]" aria-hidden="true" />
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
                                <p className="text-xs text-[var(--text-secondary)]">
                                    {t('datatables.share_groups_pending', 'Nothing has changed yet — picking a group is what shares the table.')}
                                </p>
                            )}
                            {directory.isLoading && <p className="text-xs text-[var(--text-tertiary)]">{t('datatables.loading_groups', 'Loading groups…')}</p>}
                            {!directory.available && !directory.isLoading && (
                                <p className="text-xs text-[var(--text-tertiary)]">
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
                                    <span className="text-[var(--text-primary)]">{g.name || g.id}</span>
                                    {/* Only when the directory actually answers it —
                                        an invented "0 people" beside a group is worse
                                        than no number at all. */}
                                    {Number.isFinite(g.memberCount) && (
                                        <span className="text-[11px] text-[var(--text-tertiary)]">
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
                                <span className="font-medium text-[var(--text-primary)]">
                                    {t('datatables.share_write_toggle', 'Let everyone who can read it change it too')}
                                </span>
                                <span className="block text-xs text-[var(--text-secondary)]">
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
                    <p className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                        {t('datatables.share_paywalled', 'Sharing a datatable with colleagues is part of a paid plan. Your own tables, and every table already shared with you, keep working exactly as they do now.')}
                    </p>
                )}
                {error && <p className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning)]">{error}</p>}
            </div>

            <ConfirmDialog
                open={!!confirm}
                title={t('datatables.share_confirm_title', 'Give more people access?')}
                description={confirm?.question}
                confirmLabel={t('datatables.share_confirm_yes', 'Share it')}
                cancelLabel={t('datatables.share_confirm_no', 'Leave it as it is')}
                onConfirm={async () => { if (confirm) await patchSharing(confirm.descriptor); setConfirm(null); }}
                onCancel={() => setConfirm(null)}
            />
        </div>
    );
}

function AudienceRow({ icon, title, description, checked, onSelect, last = false }: AudienceRowProps) {
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
            <span className="grid place-items-center shrink-0 w-[28px] h-[28px] [border-radius:8px] [background:var(--bg-tertiary)] [color:var(--text-secondary)]"
                aria-hidden="true">
                {icon}
            </span>
            <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-[var(--text-primary)]">{title}</span>
                <span className="block text-xs text-[var(--text-tertiary)]">{description}</span>
            </span>
        </label>
    );
}

function ConsequenceLine({ t, access }: ConsequenceLineProps) {
    const Icon = access.broad ? ShieldAlert : ShieldCheck;
    return (
        <div className="px-4 py-2.5 flex items-start gap-2"
            style={{
                borderTop: '1px solid var(--border-default)',
                background: access.broad ? 'color-mix(in srgb, var(--warning) 8%, transparent)' : 'var(--bg-secondary)',
            }} data-testid="sharing-consequence">
            <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: access.broad ? 'var(--warning)' : 'var(--text-tertiary)' }} aria-hidden="true" />
            <div className="text-xs space-y-1 text-[var(--text-secondary)]">
                <p><strong>{access.readers}</strong> {t('datatables.can_read_every_row', 'can read every row.')}</p>
                <p>{t('datatables.rows_changed_by', 'Rows can be added, changed and deleted by')} <strong>{access.writers}</strong>.</p>
                {access.broad && (
                    <p>{t('datatables.widest_setting', 'That is the widest setting there is: anyone in your organisation can delete every row, and any automation they run can too.')}</p>
                )}
            </div>
        </div>
    );
}


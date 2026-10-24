import { Check, LayoutGrid, Lock, Search, Users } from 'lucide-react';
import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { AudienceKind, DirectoryGroup, DirectoryUser, RoleOption, ScreenPlan } from './accessScreenTypes';

const AUDIENCES = ['private', 'organisation', 'groups'] as const;

interface AccessControlsCardProps {
    plan: ScreenPlan;
    setPlan: Dispatch<SetStateAction<ScreenPlan>>;
    audienceKind: AudienceKind | null;
    chosenGroups: string[];
    setAudience: (kind: AudienceKind, groupIds?: string[]) => void;
    toggleGroup: (id: string) => void;
    setGroupRole: (groupId: string, roleKey: string) => void;
    setMemberRole: (userId: string, roleKey: string) => void;
    meansOf: (roleKey: string | undefined) => string;
    roleOptions: RoleOption[];
    roles: { key: string }[];
    groups: DirectoryGroup[];
    users: DirectoryUser[];
    available: boolean;
    members: { userId?: string; roleKey?: string }[];
    shownPeople: DirectoryUser[];
    peopleQuery: string;
    setPeopleQuery: (query: string) => void;
    isLoading: boolean;
    t: TranslateFn;
}

export default function AccessControlsCard({
    plan, setPlan, audienceKind, chosenGroups, setAudience, toggleGroup, setGroupRole, setMemberRole, meansOf, roleOptions,
    roles, groups, users, available, members, shownPeople, peopleQuery, setPeopleQuery, isLoading, t,
}: AccessControlsCardProps) {
    // Or set it
    return (
        <section className="rounded-xl p-3 space-y-3 [border:1px_solid_var(--border-default)] [background:var(--bg-card)]">
            <div>
                <span className="block text-[11px] font-medium mb-1.5 text-[var(--text-secondary)]">{t('playbooks.access.audience', 'Who can open the app')}</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('playbooks.access.audience', 'Who can open the app')}>
                    {AUDIENCES.map((kind) => (
                        <button
                            key={kind}
                            type="button"
                            role="radio"
                            aria-checked={audienceKind === kind}
                            onClick={() => setAudience(kind, kind === 'groups' ? chosenGroups : [])}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11px] font-medium"
                            style={{ border: `1px solid ${audienceKind === kind ? 'var(--type-ai)' : 'var(--border-default)'}`, color: audienceKind === kind ? 'var(--type-ai)' : 'var(--text-secondary)', background: audienceKind === kind ? 'color-mix(in srgb, var(--type-ai) 10%, transparent)' : 'transparent' }}
                            data-testid={`playbook-access-audience-${kind}`}
                        >
                            {kind === 'private' ? <Lock className="w-3 h-3" aria-hidden="true" /> : <Users className="w-3 h-3" aria-hidden="true" />}
                            {kind === 'private'
                                ? t('playbooks.access.private', 'Only me')
                                : kind === 'organisation'
                                    ? t('playbooks.access.organisation', 'The whole organisation')
                                    : t('playbooks.access.groups', 'Chosen groups')}
                        </button>
                    ))}
                </div>
                {audienceKind === 'groups' && (
                    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="playbook-access-groups">
                        {available && groups.length ? groups.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                onClick={() => toggleGroup(g.id)}
                                aria-pressed={chosenGroups.includes(g.id)}
                                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px]"
                                style={{ border: `1px solid ${chosenGroups.includes(g.id) ? 'var(--kind-playbook)' : 'var(--border-default)'}`, color: 'var(--text-primary)' }}
                            >
                                {chosenGroups.includes(g.id) && <Check className="w-3 h-3 [color:var(--kind-playbook)]" aria-hidden="true" />}
                                {g.name}
                            </button>
                        )) : <span className="text-[11px] text-[var(--text-secondary)]">{t('playbooks.access.no_groups', 'No groups you can see here — ask in a sentence above instead.')}</span>}
                    </div>
                )}
            </div>

            {/* The Nextcloud app menu. Only for a published app — the
                endpoint answers 409 not_published otherwise — and off
                unless the person ticks it (owner, 2026-09-16). The
                ICON is instance-wide; the audience above still decides
                who may open it. */}
            {audienceKind && audienceKind !== 'private' && (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 [border:1px_solid_var(--border-default)] [background:var(--bg-primary)]">
                    <input
                        type="checkbox"
                        checked={!!plan.nextcloudMenu}
                        onChange={(e) => setPlan((p) => ({ ...p, nextcloudMenu: e.target.checked, empty: false }))}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--kind-playbook)]"
                        data-testid="playbook-access-nc-menu"
                    />
                    <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
                            <LayoutGrid className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            {t('playbooks.access.nc_menu', 'Show in the Nextcloud app menu')}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-[var(--text-tertiary)]">
                            {t('playbooks.access.nc_menu_desc', 'Puts the app in the top bar of your organisation\u2019s Nextcloud, on its own page. Everyone there sees the icon; only the audience above can open it.')}
                        </span>
                    </span>
                </label>
            )}

            {/* A role only means something for a group that can open
                the app at all, so the list follows the audience above
                instead of showing every group in the organisation. */}
            {(roles.length > 0 || plan.roles.length > 0) && available && groups.length > 0 && (() => {
                const relevant = audienceKind === 'groups'
                    ? groups.filter((g) => chosenGroups.includes(g.id))
                    : audienceKind === 'organisation' ? groups : [];
                if (!relevant.length) return null;
                return (
                    <div>
                        <span className="block text-[11px] font-medium mb-1.5 text-[var(--text-secondary)]">{t('playbooks.access.group_roles', 'What a group may do')}</span>
                        <ul className="space-y-1" data-testid="playbook-access-group-roles">
                            {relevant.map((g) => (
                                <li key={g.id} className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-[var(--text-primary)]">{g.name}</span>
                                        {plan.byGroup[g.id] && (
                                            <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{meansOf(plan.byGroup[g.id])}</span>
                                        )}
                                    </span>
                                    <select
                                        value={plan.byGroup[g.id] || ''}
                                        onChange={(e) => setGroupRole(g.id, e.target.value)}
                                        className="h-7 rounded-lg px-2 text-[11px] shrink-0 [background:var(--bg-primary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!"
                                        aria-label={t('playbooks.access.role_for', 'Role for {name}', { name: g.name })}
                                    >
                                        <option value="">{t('playbooks.access.role_none_words', 'No access')}</option>
                                        {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                                    </select>
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            })()}

            {available && users.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t('playbooks.access.people', 'A role for one person')}</span>
                        {/* Every person in the organisation, each with
                            an empty dropdown, is a wall — not a choice.
                            Who already holds a role shows; the rest are
                            searched for. */}
                        <span className="ml-auto relative">
                            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                            <input
                                value={peopleQuery}
                                onChange={(e) => setPeopleQuery(e.target.value)}
                                className="h-7 w-[160px] rounded-lg pl-7 pr-2 text-[11px] [background:var(--bg-primary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!"
                                placeholder={t('playbooks.access.people_search', 'Find someone…')}
                                aria-label={t('playbooks.access.people_search', 'Find someone…')}
                                data-testid="playbook-access-people-search"
                            />
                        </span>
                    </div>
                    <ul className="space-y-1 max-h-[200px] overflow-y-auto" data-testid="playbook-access-people">
                        {shownPeople.map((u) => {
                            const mine = plan.members.find((m) => m.userId === u.id);
                            const already = members.find((m) => m.userId === u.id);
                            const roleKey = mine ? mine.roleKey : '';
                            return (
                                <li key={u.id} className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate text-[var(--text-primary)]">{u.name || u.email}</span>
                                        <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
                                            {roleKey
                                                ? meansOf(roleKey)
                                                : already
                                                    ? t('playbooks.access.already', 'has "{role}" today', { role: meansOf(already.roleKey) })
                                                    : u.email || ''}
                                        </span>
                                    </span>
                                    <select
                                        value={roleKey}
                                        onChange={(e) => setMemberRole(u.id, e.target.value)}
                                        className="h-7 rounded-lg px-2 text-[11px] shrink-0 [background:var(--bg-primary)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]!"
                                        aria-label={t('playbooks.access.role_for', 'Role for {name}', { name: u.name || u.email })}
                                    >
                                        <option value="">{t('playbooks.access.role_none_words', 'No access')}</option>
                                        {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                                    </select>
                                </li>
                            );
                        })}
                        {!shownPeople.length && (
                            <li className="text-[11px] text-[var(--text-tertiary)]">{t('playbooks.access.people_none', 'Nobody by that name.')}</li>
                        )}
                    </ul>
                </div>
            )}
            {isLoading && <p className="text-[11px] text-[var(--text-secondary)]">{t('playbooks.access.loading', 'Reading the app\'s roles…')}</p>}
        </section>
    );
}

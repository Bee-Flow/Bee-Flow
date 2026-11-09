import { Lock, Sparkles } from 'lucide-react';
import React, { useMemo, useState, useCallback } from 'react';
import { getIntegrationIcon } from '@/config/integrationIcons';
import { useTranslation } from '@/hooks/useTranslation';
import { ACCESS_KIND_SECTIONS } from './access/accessTypes';
import type { AccessCapability } from './access/accessTypes';
import { AccessStatus, CapabilityGroup, CapabilityRow } from './access/AccessParts';
import GrantScopeList from './access/GrantScopeList';
import { EVERYONE, useGroupAccess } from './access/useGroupAccess';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';
import Toggle from '@/components/shared/Toggle';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';

/**
 * GroupAccessMatrix — the org "Access & Permissions" surface.
 *
 * Scope-based (NOT a wide grid) so it stays usable for orgs with many groups
 * (20+): pick a scope on the left ("All members" or a group — searchable), then
 * toggle that scope's capabilities on the right. Grant-only: a checked toggle
 * GRANTS; there is no per-group "disable". Effective access = All-members grants
 * ∪ the user's groups' grants, capped by the plan/license ceiling (locked rows
 * are outside the ceiling). A group inherits anything granted to All members.
 *
 * `orgId` prop (optional): super-admin Beheerdashboard view → org-scoped
 * endpoints; without it → the caller's own org via the /me endpoints.
 */

interface GroupAccessMatrixProps {
    orgId?: string | null;
    kinds?: string[] | null;
    hideLocked?: boolean;
    heading?: string;
    subtitle?: React.ReactNode;
    hideHeading?: boolean;
}

// `hideHeading`: for a caller whose page already titles the matrix (Settings →
// Organisation → Integrations, whose h2 and selected tab name it). The intro
// line and the save status stay.
export default function GroupAccessMatrix({ orgId: orgIdProp = null, kinds = null, hideLocked = false, heading, subtitle, hideHeading = false }: GroupAccessMatrixProps) {
    const { t } = useTranslation();
    const { loading, data, message, everyone, groupGrants, ceiling, groups, betaReadOnly, toggle: toggleIn } = useGroupAccess(orgIdProp);
    const [scope, setScope] = useState(EVERYONE);
    const [groupQuery, setGroupQuery] = useState('');
    const isEveryoneScope = scope === EVERYONE;
    const toggle = (cap: AccessCapability) => toggleIn(scope, cap);

    // Count of capabilities granted for a scope (for the sidebar badges).
    const grantCount = useCallback((scopeId: string) => {
        if (scopeId === EVERYONE) return everyone.size;
        const own = (groupGrants[scopeId] || new Set()).size;
        return own; // own grants; inherited-from-everyone shown separately
    }, [everyone, groupGrants]);

    const filteredGroups = useMemo(() => {
        const q = groupQuery.trim().toLowerCase();
        return q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
    }, [groups, groupQuery]);

    const capabilitiesByKind = useMemo(() => {
        const map: Record<string, AccessCapability[]> = { core: [], beta: [], integration: [] };
        for (const c of (data?.capabilities || [])) (map[c.kind] || (map[c.kind] = [])).push(c);
        for (const k of Object.keys(map)) map[k].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
        return map;
    }, [data]);

    if (loading) return <div className="p-6"><Spinner size="sm" /></div>;
    if (!data || !data.orgId) {
        return <p className={ALERT_INFO}>{t('admin_org.access_matrix_no_org', 'Your account is not bound to an organisation, so there is nothing to manage here.')}</p>;
    }

    const activeGroup = isEveryoneScope ? null : groups.find(g => g.id === scope);

    // One capability in the current scope: on, inherited from All members, or outside the ceiling.
    const renderCapability = (cap: AccessCapability) => {
        const locked = !ceiling.has(cap.id);
        const ro = betaReadOnly(cap);
        const inherited = !isEveryoneScope && (everyone.has(cap.id) || !!ro);
        const checked = isEveryoneScope ? (ro ? true : everyone.has(cap.id)) : (inherited || (groupGrants[scope] || new Set()).has(cap.id));
        // Granted to all → a group inherits it and cannot un-inherit it here.
        const readOnly = isEveryoneScope ? !!ro : inherited;
        const icon = cap.kind === 'integration' ? getIntegrationIcon(cap.id) : <Sparkles className="h-4 w-4" />;
        return (
            <CapabilityRow
                key={cap.id}
                cap={cap}
                icon={icon}
                locked={locked}
                onActivate={locked || readOnly ? undefined : () => toggle(cap)}
                note={inherited ? <p className="m-0 text-xs text-[var(--info-ink)]">{t('admin_org.access_matrix_granted_all', 'Granted to all members')}</p> : undefined}
                trailing={locked
                    ? <Lock className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
                    : <Toggle size="sm" checked={checked} disabled={readOnly} ariaLabel={cap.name} onChange={() => toggle(cap)} />}
            />
        );
    };

    const sections = ACCESS_KIND_SECTIONS
        .filter(s => !kinds || kinds.includes(s.kind))
        .map(section => ({ section, caps: (capabilitiesByKind[section.kind] || []).filter(c => !hideLocked || ceiling.has(c.id)) }))
        .filter(x => x.caps.length > 0);

    // The save status sits next to the heading, or next to the intro line
    // when the heading is hidden.
    const status = <AccessStatus message={message} />;
    const intro = subtitle || (
        <>
            {t('admin_org.access_matrix_pick', 'Pick')} <strong>{t('admin_org.access_matrix_all_members', 'All members')}</strong> {t('admin_org.access_matrix_or_a', 'or a')} <strong>{t('admin_org.access_matrix_group', 'group')}</strong>{t('admin_org.access_matrix_intro_a', ", then grant the features and integrations it should have. A user gets a capability if it's granted to All members")}{' '}
            <em>{t('admin_org.access_matrix_or', 'or')}</em> {t('admin_org.access_matrix_intro_b', 'any group they belong to. Locked items (')}<Lock className="-mt-0.5 inline h-3 w-3" aria-hidden="true" />{t('admin_org.access_matrix_intro_c', ") are outside your organisation's access.")}
        </>
    );

    return (
        <section className="flex flex-col gap-5">
            {hideHeading ? (
                <div className="flex items-start justify-between gap-3">
                    <p className="m-0 max-w-[760px] text-xs text-[var(--text-secondary)]">{intro}</p>
                    {status}
                </div>
            ) : (
                <SectionHeader title={heading || t('admin_org.access_matrix_heading', 'Access & Permissions')} description={intro} status={status} />
            )}

            <div className="flex flex-col gap-6 md:flex-row">
                <GrantScopeList
                    everyoneId={EVERYONE}
                    scope={scope}
                    onSelect={setScope}
                    groups={groups}
                    filteredGroups={filteredGroups}
                    query={groupQuery}
                    onQuery={setGroupQuery}
                    grantCount={grantCount}
                />

                <div className="flex min-w-0 flex-1 flex-col gap-5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{isEveryoneScope ? t('admin_org.access_matrix_all_members', 'All members') : activeGroup?.name}</h3>
                        {!isEveryoneScope ? <span className="text-xs text-[var(--text-tertiary)]">{t('admin_org.access_matrix_stack', 'grants stack on top of All members')}</span> : null}
                        {data.betaGoverned ? <span className="ml-auto text-xs text-[var(--text-tertiary)]">{t('admin_org.access_matrix_beta_follow', 'Beta features follow your subscription')}</span> : null}
                    </div>
                    {sections.length === 0 ? (
                        <p className={ALERT_INFO}>
                            {kinds && kinds.length === 1 && kinds[0] === 'integration'
                                ? t('admin_org.access_matrix_no_integrations', "Your subscription doesn't include any integrations yet.")
                                : t('admin_org.access_matrix_nothing', 'Nothing to grant here yet.')}
                        </p>
                    ) : sections.map(({ section, caps }) => (
                        <CapabilityGroup key={section.kind} section={section}>{caps.map(renderCapability)}</CapabilityGroup>
                    ))}
                </div>
            </div>
        </section>
    );
}

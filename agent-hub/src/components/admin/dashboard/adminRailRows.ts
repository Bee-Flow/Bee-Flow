// The rows of the admin dashboard's rail, as one list. Every tab the viewer may
// open is one row, except the Organisation tab: each of its sections the viewer
// gets (organisation/orgSections decides which, the one list) is a row of its
// own, last in the rail group the section names, linking to
// admin/organisation/<section>. A row's id is its path under admin/.

import { Building2, Server } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { activeOrgSection, orgAzureSection, visibleOrgSections, type OrgFactsUser, type OrgHubSection } from '@/components/admin/organisation/orgSections';
import { useOrgSectionFacts } from '@/components/admin/organisation/useOrgSectionFacts';
import type { AdminRailSectionView } from './AdminRail';
import { adminSectionScope, buildAdminRailSections, type AdminRailSection, type AdminTab } from './adminTabs';
import type { AdminOrgChoice } from './useAdminOrg';
import { effectiveAdminOrgOf } from './useEffectiveAdminOrgId';

const ORG_TAB = 'organisation';

/** An Organisation section as the rail shows it; `serverWide` carries the whole-server mark. */
export interface OrgRailSection extends OrgHubSection {
    serverWide: boolean;
}

type RailTab = AdminTab & { serverWide?: boolean };

/**
 * The Organisation sections this viewer gets, for the organisation the
 * dashboard works on (the scope bar's choice for a platform admin, the home
 * organisation for anyone else); none when the tab is not theirs.
 */
export function useOrgRailSections(user: (OrgFactsUser & Readonly<Record<string, unknown>>) | null, choice: AdminOrgChoice, enabled: boolean): OrgRailSection[] {
    const facts = useOrgSectionFacts(user, effectiveAdminOrgOf(choice, user).orgId, enabled);
    if (!enabled) return [];
    // The Azure services setup is server-wide (the scope data in adminTabs says so).
    const azureServerWide = orgAzureSection(facts) === 'config' && adminSectionScope(ORG_TAB, 'azure', 'config') === 'instance';
    return visibleOrgSections(facts).map(s => ({ ...s, serverWide: s.id === 'azure' && azureServerWide }));
}

/** The tabs as rail rows: the Organisation tab gives way to its sections, appended so each comes last in its group. */
function railTabsOf(tabs: readonly AdminTab[], orgSections: readonly OrgRailSection[]): RailTab[] {
    const org = tabs.find(tab => tab.id === ORG_TAB);
    if (!org) return [...tabs];
    const rows = orgSections.map(s => ({
        ...org, id: `${ORG_TAB}/${s.id}`, labelKey: s.labelKey, labelFallback: undefined, icon: s.icon, group: s.group, serverWide: s.serverWide,
    }));
    return [...tabs.filter(tab => tab !== org), ...rows];
}

/** The row the URL opens: the tab, or for the Organisation tab the section it shows. */
export function activeRailRow(activeTab: string, section: string | undefined, orgSections: readonly OrgRailSection[]): string {
    return activeTab === ORG_TAB ? `${ORG_TAB}/${activeOrgSection(orgSections, section)}` : activeTab;
}

/** The label of a row, if the rail has it. */
export function railRowLabel(sections: readonly AdminRailSectionView[], id: string): string | undefined {
    return sections.flatMap(s => s.groups).flatMap(g => g.tabs).find(row => row.id === id)?.label;
}

interface AdminRailViewInput {
    /** The tabs the viewer may open. */
    tabs: readonly AdminTab[];
    orgSections: readonly OrgRailSection[];
    isPlatformAdmin: boolean;
    choice: AdminOrgChoice;
    t: TranslateFn;
}

/** The rail as it is drawn: its blocks, their groups and rows. */
export function adminRailView({ tabs, orgSections, isPlatformAdmin, choice, t }: AdminRailViewInput): AdminRailSectionView[] {
    return buildAdminRailSections(railTabsOf(tabs, orgSections), isPlatformAdmin).map(section => railSectionView(section, choice, t));
}

/**
 * One block of the rail as it is drawn. The organisation block is headed
 * "Organisations" with the current choice under it for a platform admin, and by
 * the organisation's name for anyone else. The whole-server block is one flat
 * list: its tabs' sub-headings would repeat the ones of the block above.
 */
function railSectionView(section: AdminRailSection<RailTab>, choice: AdminOrgChoice, t: TranslateFn): AdminRailSectionView {
    const rows = (tabs: readonly RailTab[]) => tabs.map(tab => ({ id: tab.id, label: t(tab.labelKey, tab.labelFallback), icon: tab.icon, serverWide: !!tab.serverWide }));
    if (section.id === 'instance') {
        return {
            id: 'instance',
            label: t('admin.scope_instance', 'Whole server'),
            icon: Server,
            groups: [{ id: 'instance', label: '', tabs: rows(section.groups.flatMap(group => group.tabs)) }],
        };
    }
    const groups = section.groups.map(group => ({ id: group.id, label: t(group.labelKey, group.labelFallback), tabs: rows(group.tabs) }));
    if (choice.isPlatformAdmin) {
        const subtitle = choice.orgId ? (choice.orgName ?? choice.orgId) : t('admin.scope_all_orgs', 'All organisations');
        return { id: 'org', label: t('admin.rail_group_orgs', 'Organisations'), subtitle, icon: Building2, groups };
    }
    return { id: 'org', label: choice.homeOrganization?.name ?? t('admin.scope_org', 'Your organisation'), icon: Building2, groups };
}

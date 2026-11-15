// The rows of the admin dashboard's rail, as one list. Every tab the viewer may
// open is one row, except where a tab declares sections that are rows of the
// rail themselves (AdminTab.railRows, by SECTION scope rather than tab scope):
//   row    a top-level row in the group and block it names; a tab whose
//          declared rows are all of this kind gives way to them (the
//          Organisation tab: each section the viewer gets, organisation/
//          orgSections deciding which, is a row of its own);
//   child  indented under the tab's own row while that tab is open; the tab's
//          own address opens its first child.
// A tab with a railGate (AdminTab) draws its own row only when the gate opens.
// Inside a group the rows follow ADMIN_RAIL_ORDER (adminTabs). A row's id is
// its path under admin/: `tab` or `tab/section`.

import { Building2, Server } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { openOrgSection, visibleOrgSections, type OrgFactsUser, type OrgHubSection, type OrgSectionFacts } from '@/components/admin/organisation/orgSections';
import { useOrgSectionFacts } from '@/components/admin/organisation/useOrgSectionFacts';
import { resolveAgentSection } from '@/components/agents/agentSections';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { isHomeOrgAdmin } from '@/utils/adminAccess';
import type { AdminRailRowView, AdminRailSectionView } from './AdminRail';
import type { AdminRailBlock, AdminRailGateContext, AdminRailRowDef } from './adminRailRowDef';
import { ADMIN_TABS, buildAdminRailSections, type AdminRailSection, type AdminTab } from './adminTabs';
import type { AdminOrgChoice } from './useAdminOrg';
import { effectiveAdminOrgOf } from './useEffectiveAdminOrgId';
import { useHasNextcloudInstances } from './useServerNextcloudFacts';

const ORG_TAB = 'organisation';

/** What the Organisation tab's rows read: the sections this viewer gets, and the facts behind them. */
interface OrgRailRows {
    sections: OrgHubSection[];
    facts: OrgSectionFacts | null;
}

/** The section rows of every tab that has them, as this viewer gets them (tab id to rows). */
export type VisibleRailRows = Readonly<Record<string, readonly AdminRailRowDef[]>>;

type RailTab = AdminTab & {
    block?: AdminRailBlock;
    serverWide?: boolean;
    children?: AdminRailRowView[];
};

/**
 * The Organisation sections this viewer gets, for the organisation the
 * dashboard works on (the scope bar's choice for a platform admin, the home
 * organisation for anyone else); none when the tab is not theirs.
 */
function useOrgRailSections(user: (OrgFactsUser & Readonly<Record<string, unknown>>) | null, choice: AdminOrgChoice, enabled: boolean): OrgRailRows {
    const facts = useOrgSectionFacts(user, effectiveAdminOrgOf(choice, user).orgId, enabled);
    if (!enabled) return { sections: [], facts: null };
    return { sections: visibleOrgSections(facts), facts };
}

/** The Organisation sections as rail rows of the organisation block. */
function orgSectionRows(sections: readonly OrgHubSection[]): AdminRailRowDef[] {
    return sections.map(s => ({
        section: s.id, labelKey: s.labelKey, labelFallback: s.labelFallback, descriptionKey: s.descriptionKey,
        descriptionFallback: s.descriptionFallback, icon: s.icon, group: s.group, block: 'org', kind: 'row',
    }));
}

/** What the row gates read, besides the Organisation tab's facts. */
export type RailGateViewer = Omit<AdminRailGateContext, 'orgFacts'>;

interface VisibleRailRowsInput {
    org: OrgRailRows;
    viewer: RailGateViewer;
}

/**
 * The rows each tab with sections shows this viewer: the Organisation tab's
 * are its section rules' answer (the one list, organisation/orgSections), any
 * other tab's the rows it declares whose gate opens.
 */
export function visibleRailRows(tabs: readonly AdminTab[], { org, viewer }: VisibleRailRowsInput): VisibleRailRows {
    const ctx: AdminRailGateContext = { ...viewer, orgFacts: org.facts };
    const out: Record<string, readonly AdminRailRowDef[]> = {};
    for (const tab of tabs) {
        if (!tab.railRows) continue;
        out[tab.id] = tab.id === ORG_TAB ? orgSectionRows(org.sections) : tab.railRows.filter(row => !row.gate || row.gate(ctx));
    }
    return out;
}

/** The tabs whose own row the rail draws: every tab, except one whose railGate stays shut. */
export function railShownTabs<T extends AdminTab>(tabs: readonly T[], viewer: RailGateViewer): T[] {
    const ctx: AdminRailGateContext = { ...viewer, orgFacts: null };
    return tabs.filter(tab => !tab.railGate || tab.railGate(ctx));
}

/** A tab whose declared rows are all top-level rows has no row of its own. */
function givesWay(tab: AdminTab): boolean {
    return !!tab.railRows?.length && tab.railRows.every(row => row.kind === 'row');
}

function sectionRow(tab: AdminTab, row: AdminRailRowDef): RailTab {
    return {
        ...tab, id: `${tab.id}/${row.section}`, labelKey: row.labelKey, labelFallback: row.labelFallback, icon: row.icon,
        group: row.group, block: row.block, serverWide: !!row.serverWide, escapesChrome: !!row.escapesChrome,
    };
}

/** The tabs as rail rows: tab rows first (with their children), the section rows after them so each comes last in its group. */
function railTabsOf(tabs: readonly AdminTab[], rows: VisibleRailRows, t: TranslateFn): RailTab[] {
    const own: RailTab[] = [];
    const sections: RailTab[] = [];
    for (const tab of tabs) {
        const visible = Object.hasOwn(rows, tab.id) ? rows[tab.id] : [];
        sections.push(...visible.filter(row => row.kind === 'row').map(row => sectionRow(tab, row)));
        if (givesWay(tab)) continue;
        const children = visible.filter(row => row.kind === 'child').map(row => rowView(sectionRow(tab, row), t));
        own.push(children.length ? { ...tab, children } : tab);
    }
    return [...own, ...sections];
}

/**
 * The section a request opens among a tab's top-level rows: the requested one
 * when it is there, else the first. An Organisation section that exists opens as
 * itself even when this viewer does not get it (or not yet: its availability is
 * being read): the tab says why on that address, and no other row is marked.
 */
function openSectionOf(tabId: string, ids: readonly string[], requested: string | undefined): string {
    if (tabId === ORG_TAB) return openOrgSection(ids.map(id => ({ id })), requested).id;
    return requested && ids.includes(requested) ? requested : (ids[0] ?? '');
}

/**
 * The row the URL opens: the tab; for a tab that gave way to its rows the
 * section it shows (the first one without a section; an Organisation section
 * the viewer does not get is still its own row id, which the rail then does
 * not mark); for a tab with child
 * rows the child the section names, else its first child (the page the tab's
 * own address opens), else the tab's own row.
 */
export function activeRailRow(activeTab: string, section: string | undefined, rows: VisibleRailRows, tabs: readonly AdminTab[] = ADMIN_TABS): string {
    const visible = Object.hasOwn(rows, activeTab) ? rows[activeTab] : null;
    const tab = tabs.find(candidate => candidate.id === activeTab);
    if (!visible || !tab) return activeTab;
    if (!givesWay(tab)) {
        const named = visible.find(row => row.section === section) ?? visible.find(row => row.kind === 'child');
        return named ? `${activeTab}/${named.section}` : activeTab;
    }
    const tops = visible.filter(row => row.kind === 'row').map(row => row.section);
    return `${activeTab}/${openSectionOf(activeTab, tops, section)}`;
}

/** The label of a row, if the rail has it (a child row included). */
export function railRowLabel(sections: readonly AdminRailSectionView[], id: string): string | undefined {
    const rows = sections.flatMap(s => s.groups).flatMap(g => g.tabs);
    return [...rows, ...rows.flatMap(row => row.children ?? [])].find(row => row.id === id)?.label;
}

/** What names a row: a tab's own fields, or those of one of its declared section rows. */
type RowNaming = Pick<AdminRailRowDef, 'labelKey' | 'labelFallback' | 'descriptionKey' | 'descriptionFallback'>;

/** The definition behind a row id (`tab` or `tab/section`), whether or not the rail draws the row. */
function rowNamingOf(id: string, tabs: readonly AdminTab[]): RowNaming | undefined {
    const [tabId, section] = id.split('/');
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return undefined;
    return (section ? tab.railRows?.find(row => row.section === section) : undefined) ?? tab;
}

/** The page header of a row: its label and its description (if any), as the rail names it. */
export interface AdminRowHeading {
    label: string;
    description?: string;
}

/**
 * The page header of row `id`. The label is the one the rail draws; a row the
 * rail leaves out (a section this viewer does not get, a gated tab) is named by
 * its definition, and an unknown one by `fallback`.
 */
export function adminRowHeading(sections: readonly AdminRailSectionView[], id: string, t: TranslateFn, fallback: string, tabs: readonly AdminTab[] = ADMIN_TABS): AdminRowHeading {
    const naming = rowNamingOf(id, tabs);
    const label = railRowLabel(sections, id) ?? (naming ? t(naming.labelKey, naming.labelFallback) : fallback);
    const description = naming?.descriptionKey ? t(naming.descriptionKey, naming.descriptionFallback) : undefined;
    return description ? { label, description } : { label };
}

interface AdminRailViewInput {
    /** The tabs the viewer may open. */
    tabs: readonly AdminTab[];
    rows: VisibleRailRows;
    isPlatformAdmin: boolean;
    choice: AdminOrgChoice;
    t: TranslateFn;
}

/** The rail as it is drawn: its blocks, their groups and rows. */
export function adminRailView({ tabs, rows, isPlatformAdmin, choice, t }: AdminRailViewInput): AdminRailSectionView[] {
    return buildAdminRailSections(railTabsOf(tabs, rows, t), isPlatformAdmin).map(section => railSectionView(section, choice, t));
}

function rowView(tab: RailTab, t: TranslateFn): AdminRailRowView {
    return {
        id: tab.id, label: t(tab.labelKey, tab.labelFallback), icon: tab.icon, serverWide: !!tab.serverWide,
        escapesChrome: !!tab.escapesChrome, ...(tab.children?.length ? { children: tab.children } : {}),
    };
}

/**
 * One block of the rail as it is drawn. The organisation block is headed
 * "Organisations" with the current choice under it for a platform admin, and by
 * the organisation's name for anyone else. The whole-server block has the same
 * group headings, except over a group of one row, where a heading would only
 * repeat the row.
 */
function railSectionView(section: AdminRailSection<RailTab>, choice: AdminOrgChoice, t: TranslateFn): AdminRailSectionView {
    const rows = (tabs: readonly RailTab[]) => tabs.map(tab => rowView(tab, t));
    if (section.id === 'instance') {
        return {
            id: 'instance',
            label: t('admin.scope_instance', 'Whole server'),
            icon: Server,
            groups: section.groups.map(group => ({
                id: group.id,
                label: group.tabs.length > 1 ? t(group.labelKey, group.labelFallback) : '',
                tabs: rows(group.tabs),
            })),
        };
    }
    const groups = section.groups.map(group => ({ id: group.id, label: t(group.labelKey, group.labelFallback), tabs: rows(group.tabs) }));
    if (choice.isPlatformAdmin) {
        const subtitle = choice.orgId ? (choice.orgName ?? choice.orgId) : t('admin.scope_all_orgs', 'All organisations');
        return { id: 'org', label: t('admin.rail_group_orgs', 'Organisations'), subtitle, icon: Building2, groups };
    }
    return { id: 'org', label: choice.homeOrganization?.name ?? t('admin.scope_org', 'Your organisation'), icon: Building2, groups };
}

interface AdminRailInput {
    user: (OrgFactsUser & Readonly<Record<string, unknown>>) | null;
    choice: AdminOrgChoice;
    /** The tabs the viewer may open. */
    tabs: readonly AdminTab[];
    isPlatformAdmin: boolean;
    activeTab: string;
    /** The section the (resolved) address names. */
    section: string;
    t: TranslateFn;
}

interface AdminRailState {
    sections: AdminRailSectionView[];
    activeRow: string;
    /** The current row's label (the narrow top bar, the page header); the tab's own name, else the dashboard's. */
    currentLabel: string;
    /** The current row's description, the line under the page header; none when the row has none. */
    currentDescription?: string;
}

/** The rail of the dashboard for this viewer and address: its blocks, the current row and its label. */
export function useAdminRail({ user, choice, tabs, isPlatformAdmin, activeTab, section, t }: AdminRailInput): AdminRailState {
    const org = useOrgRailSections(user, choice, tabs.some(tab => tab.id === ORG_TAB));
    const { hasFeature, hasTier } = useLicenseContext();
    const hasNextcloudInstances = useHasNextcloudInstances(isPlatformAdmin && tabs.some(tab => tab.id === 'nextcloud-instances'));
    const viewer: RailGateViewer = {
        isPlatformAdmin,
        isHomeOrgAdmin: isHomeOrgAdmin(user),
        agentSections: resolveAgentSection(user ? { ...user, isAdmin: user.isAdmin ?? undefined, role: user.role ?? undefined } : null, '').visible,
        hasFeature: (feature) => !!hasFeature(feature),
        hasTier: (tier) => !!hasTier(tier),
        hasNextcloudInstances,
    };
    const rows = visibleRailRows(tabs, { org, viewer });
    const sections = adminRailView({ tabs: railShownTabs(tabs, viewer), rows, isPlatformAdmin, choice, t });
    const activeRow = activeRailRow(activeTab, section, rows);
    const heading = adminRowHeading(sections, activeRow, t, t('admin.dashboard_title'));
    return { sections, activeRow, currentLabel: heading.label, currentDescription: heading.description };
}

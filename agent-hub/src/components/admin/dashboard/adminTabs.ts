// The tabs of the global admin dashboard (/app/admin/<tab>/<seg2>/<seg3>):
// which exist, who may open them, and how the rail groups them. Pure data and
// functions, so the gating can be tested without rendering a single panel.

import {
    Activity, BadgeCheck, BarChart3, Bot, Building, Building2, Cloud, CreditCard, Globe, KeyRound, Languages, LifeBuoy,
    Newspaper, Package, Palette, Plug, Scale, Shield, Sparkles, Tag, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TIER_RANK } from '@/components/licensing/licenseTiers';
import { ORG_HUB_SECTIONS } from '@/components/admin/organisation/orgSections';
import { BARE_TAB_FALLBACKS, resolveAdminPath, type AdminPath, type ResolvedAdminPath } from './adminPathAliases';
import type { AdminRailBlock, AdminRailGateContext, AdminRailRowDef } from './adminRailRowDef';
import {
    AGENT_RAIL_ROWS, AI_CONFIG_RAIL_ROWS, APPEARANCE_RAIL_ROWS, LICENSE_RAIL_ROWS, MONITORING_RAIL_ROWS,
    PLATFORM_SERVICES_RAIL_ROWS, SECURITY_RAIL_ROWS, SUBSCRIPTIONS_RAIL_ROWS,
} from './adminTabRows';

export type AdminTabGroupId = 'organisation' | 'ai' | 'identity' | 'security' | 'connections' | 'platform' | 'operations' | 'website';

/**
 * Whose data a section is about:
 *   instance  the whole server, every organisation on it;
 *   org       one organisation (the viewer's own);
 *   mixed     depends on the viewer (a platform admin sees every organisation,
 *             anyone else their own) or combines both kinds of settings;
 *   user      the viewer's own account.
 */
export type AdminScope = 'instance' | 'org' | 'mixed' | 'user';

export interface AdminTab {
    id: string;
    labelKey: string;
    labelFallback?: string;
    /** The line under the page header (AdminPage) on the tab's own row, when it has one. */
    descriptionKey?: string;
    descriptionFallback?: string;
    icon: LucideIcon;
    group: AdminTabGroupId;
    perm: string[];
    /** The scope of the whole tab; `sections` overrides it for the sub-sections that differ. `null`: the panel picks its own organisation, so no single scope fits. */
    scope: AdminScope | null;
    /** Sub-section (the second URL segment) to the scope where it differs from `scope`; `section/part` names a part inside a sub-section. */
    sections?: Readonly<Record<string, AdminScope>>;
    /**
     * Sub-sections whose organisation view reads a route only an organisation
     * admin of their home organisation passes (a platform admin always does):
     * hidden from anyone else who opens the tab, rather than shown empty.
     */
    orgAdminSections?: readonly string[];
    superAdminOnly?: boolean;
    minTier?: string;
    /** A licence capability the tab needs (the entitlement snapshot's `can`), where the plan is not the rule. */
    capability?: string;
    cloudOnly?: boolean;
    selfHostedOnly?: boolean;
    /** Sections that are rows of the rail (AdminRailRowDef); a row id is `tab/section`. */
    railRows?: readonly AdminRailRowDef[];
    /**
     * The tab's own row is drawn only when this answers true (the tab still
     * opens on its address): a row about something the server does not have yet.
     */
    railGate?: (ctx: AdminRailGateContext) => boolean;
    /** The tab leaves the dashboard chrome and renders full screen (Product website). */
    escapesChrome?: boolean;
}

/** The rail's groups, in rail order, each with the eyebrow above it. */
export const ADMIN_TAB_GROUPS: readonly { id: AdminTabGroupId; labelKey: string; labelFallback: string }[] = [
    { id: 'organisation', labelKey: 'admin_nav.group_workspace', labelFallback: 'Workspace' },
    { id: 'ai', labelKey: 'admin_nav.group_ai', labelFallback: 'AI & agents' },
    // The whole server's organisations, roles, sign-in providers and guardrail console.
    { id: 'identity', labelKey: 'admin_nav.group_identity', labelFallback: 'Identity & access' },
    { id: 'security', labelKey: 'admin_nav.group_security', labelFallback: 'Security & access' },
    { id: 'connections', labelKey: 'admin_nav.group_connections', labelFallback: 'Connections' },
    { id: 'platform', labelKey: 'admin_nav.group_platform', labelFallback: 'Platform' },
    { id: 'operations', labelKey: 'admin_nav.group_operations', labelFallback: 'Operations' },
    { id: 'website', labelKey: 'admin_nav.group_website', labelFallback: 'Website' },
];

/**
 * The rail's rows in the order the target tree draws them inside a group (a
 * row's id is its path under admin/); a row not listed comes after these, in
 * ADMIN_TABS order. ADMIN_TABS's own order stays the fallback-tab order.
 */
export const ADMIN_RAIL_ORDER: readonly string[] = [
    // The organisation block.
    'organisation/info', 'organisation/license', 'people', 'organisation/projects', 'organisation/academy', 'monitoring',
    'agents/chat', 'organisation/knowledge-bases', 'organisation/models', 'organisation/conversations', 'organisation/memory', 'organisation/meeting-notes', 'organisation/cowork',
    'organisation/auth', 'access', 'security/guardrails', 'organisation/encryption', 'organisation/mcp-access', 'compliance',
    'organisation/integrations', 'organisation/mcp', 'organisation/nextcloud-sync', 'organisation/azure', 'organisation/github-sync', 'organisation/integration-cache',
    // The whole-server block.
    'ai-config', 'agents/system', 'organisations', 'roles', 'security/sso', 'security/guardrail-library',
    'integrations', 'mcp-servers', 'nextcloud-instances', 'licenses', 'modules', 'appearance', 'languages',
    'support', 'subscriptions', 'product-website', 'website-analytics', 'release-notes',
];

// Tab definitions — each tab requires its page-level permission
// 'agents' tab accepts admin_agents (catch-all) OR any granular admin_agents_* permission
//
// The ORDER of this list decides the fallback tab (the first one a user may
// open), so it is the order the dashboard has always had; the rail groups
// the tabs by `group` and keeps this order inside a group.
//
// minTier: 'enterprise' marks a tab as part of the paid admin surface. The
// Community tier only exposes AI Config, Security, Integrations, Server
// licence and Languages — every other tab carries minTier and stays hidden
// until the install reaches Enterprise. canOpenAdminTab reads the REAL
// resolved tier (LicenseContext.hasTier has no super-admin elevation), so a
// Community install hides these from its own operator too. Subscriptions is
// already cloudOnly, so it never surfaces on a self-hosted Community install
// and intentionally carries no minTier (keeps the cloud operator console
// reachable regardless of the operator org's own tier).
// Security's sub-sections: the operator ones are the whole server. Guardrails
// mixes both: the pattern library, the sensitive-term libraries, the PII and DLP
// profiles, the presets and the Direct chat binding are server-wide; only the
// per-organisation shield is the viewer's own organisation.
const SECURITY_SCOPES: Readonly<Record<string, AdminScope>> = {
    sso: 'instance',
    // The per-organisation shield follows the chosen organisation; the console is the whole server.
    guardrails: 'org',
    'guardrail-library': 'instance',
};

// People: the list follows the chosen organisation (a platform admin with none
// chosen sees every organisation's); its invitations and roles are the organisation's own.
const PEOPLE_SCOPES: Readonly<Record<string, AdminScope>> = {
    invitations: 'org',
    'org-roles': 'org',
};

// Access: Grants and the organisation's access menu follow the dashboard's organisation;
// the read-only summary of the server licence under Ceiling's Whole-server divider is server-wide.
const ACCESS_SCOPES: Readonly<Record<string, AdminScope>> = {
    'ceiling/server': 'instance',
};

// The Organisation tab's sections, each a top-level row of the organisation
// block. Which of them a viewer gets, and the Azure row's form, is the one list
// of section rules in organisation/orgSections (dashboard/adminRailRows reads it).
const ORGANISATION_RAIL_ROWS: readonly AdminRailRowDef[] = ORG_HUB_SECTIONS.map(s => ({
    section: s.id, labelKey: s.labelKey, labelFallback: s.labelFallback, descriptionKey: s.descriptionKey,
    descriptionFallback: s.descriptionFallback, icon: s.icon, group: s.group, block: 'org', kind: 'row',
}));

/**
 * Sections whose data does not follow the dashboard's organisation picker, keyed
 * by tab id or `tab/section/part`: 'home' always shows the viewer's own
 * organisation (Compliance resolves the home organisation on the server,
 * routes/compliance/shared.js), 'all' always lists every organisation.
 */
const FIXED_ORG_VIEWS: Readonly<Record<string, FixedOrgView>> = {
    compliance: 'home',
};

/** How a section that does not follow the organisation picker chooses its organisation. */
export type FixedOrgView = 'home' | 'all';

/** The fixed organisation view of a tab, a section or a part, most specific first; null when it follows the picker. */
export function fixedOrgViewOf(tabId: string, section?: string, part?: string): FixedOrgView | null {
    const keys = [section && part ? `${tabId}/${section}/${part}` : '', section ? `${tabId}/${section}` : '', tabId].filter(Boolean);
    for (const key of keys) {
        if (Object.hasOwn(FIXED_ORG_VIEWS, key)) return FIXED_ORG_VIEWS[key];
    }
    return null;
}

export const ADMIN_TABS: readonly AdminTab[] = [
    // Agents: its sections are rows (the organisation's agents, the server's system agents).
    { id: 'agents', labelKey: 'admin_nav.agents', labelFallback: 'Agents', icon: Bot, group: 'ai', perm: ['admin_agents', 'admin_agents_chat', 'admin_agents_system'], scope: 'mixed', sections: { system: 'instance' }, superAdminOnly: false, minTier: 'enterprise', railRows: AGENT_RAIL_ROWS },
    // The organisation's own settings, opened by whoever administers an organisation
    // (org_admin, or an organisation-admin role; dashboard/useAdminTabAccess). Placed after
    // Agents so the fallback tab stays Agents. Each section is a row in its own group, and every
    // one is the organisation the dashboard works on (the Google Maps key is Platform services').
    { id: 'organisation', labelKey: 'settings.organisation', labelFallback: 'Organisation', icon: Building2, group: 'organisation', perm: ['org_admin'], scope: 'mixed', superAdminOnly: false, railRows: ORGANISATION_RAIL_ROWS },
    // People: the organisation's users, invitations, groups and roles (the old Security > Users).
    { id: 'people', labelKey: 'admin_nav.people', labelFallback: 'People', descriptionKey: 'admin_nav.people_desc', descriptionFallback: "The organisation's members, invitations, groups and roles.", icon: Users, group: 'organisation', perm: ['admin_security', 'org_admin', 'manage_users'], scope: 'mixed', sections: PEOPLE_SCOPES, superAdminOnly: false },
    { id: 'ai-config', labelKey: 'admin_nav.ai_config', labelFallback: 'AI configuration', icon: Sparkles, group: 'ai', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true, railRows: AI_CONFIG_RAIL_ROWS },
    // Security: the Privacy Shield, the sign-in providers and the guardrail console, each a row.
    { id: 'security', labelKey: 'admin.tab_security', icon: Shield, group: 'security', perm: ['admin_security'], scope: 'mixed', sections: SECURITY_SCOPES, superAdminOnly: false, railRows: SECURITY_RAIL_ROWS },
    { id: 'integrations', labelKey: 'admin_nav.platform_services', labelFallback: 'Platform services', icon: Plug, group: 'connections', perm: ['admin_security'], scope: 'instance', superAdminOnly: true, railRows: PLATFORM_SERVICES_RAIL_ROWS },
    // Access & Permissions: grant features and integrations to all members or per
    // group, within the plan/licence ceiling. Org admins manage their own org; a
    // platform admin works on the organisation chosen in the dashboard.
    { id: 'access', labelKey: 'admin_nav.access', labelFallback: 'Access', descriptionKey: 'admin_nav.access_desc', descriptionFallback: "Which features and integrations members and groups get, within what the organisation's plan allows.", icon: KeyRound, group: 'security', perm: ['admin_security', 'org_admin', 'manage_users'], scope: 'mixed', sections: ACCESS_SCOPES, superAdminOnly: false },
    // No minTier: Overview is open to every admin of the tab, the other pages need the
    // `advanced_usage_monitoring` capability (monitoring/monitoring.constants.ts). An
    // organisation admin by role gets the tab through `org_admin`, like Access.
    // Feedback: a platform admin reads every organisation's, an organisation admin their home
    // organisation's (server routes/feedback.js `/org`, which refuses anyone else).
    { id: 'monitoring', labelKey: 'admin_nav.monitoring', labelFallback: 'Usage & monitoring', icon: Activity, group: 'organisation', perm: ['admin_monitoring', 'org_admin'], scope: 'mixed', orgAdminSections: ['feedback'], superAdminOnly: false, railRows: MONITORING_RAIL_ROWS },
    // Compliance Hub, on cloud and self-hosted (Enterprise).
    { id: 'compliance', labelKey: 'admin.tab_compliance', descriptionKey: 'admin_nav.compliance_desc', descriptionFallback: "The organisation's privacy and security checks, records and reports.", icon: Scale, group: 'security', perm: ['admin_compliance'], scope: 'org', superAdminOnly: false, capability: 'compliance_hub_gdpr' },
    // The customer-support inbox, for every super-admin (or `admin_support`), cloud and self-hosted.
    { id: 'support', labelKey: 'admin_nav.support_inbox', labelFallback: 'Support inbox', descriptionKey: 'admin_nav.support_desc', descriptionFallback: 'Questions and requests from customers, in one inbox.', icon: LifeBuoy, group: 'operations', perm: ['admin_support'], scope: 'instance', superAdminOnly: true, minTier: 'enterprise' },
    // Subscriptions are a Bee Flow Cloud feature; self-hosted installs use licence keys. Its sections are child rows.
    { id: 'subscriptions', labelKey: 'admin.tab_subscriptions', descriptionKey: 'admin_nav.subscriptions_desc', descriptionFallback: 'The plans organisations can subscribe to, and their subscriptions.', icon: CreditCard, group: 'operations', perm: ['admin_subscriptions'], scope: 'instance', superAdminOnly: true, cloudOnly: true, railRows: SUBSCRIPTIONS_RAIL_ROWS },
    // The server-wide licence and the global feature switches, on any deployment mode.
    { id: 'licenses', labelKey: 'admin_nav.licence_features', labelFallback: 'Licence & features', icon: BadgeCheck, group: 'platform', perm: ['all'], scope: 'instance', superAdminOnly: true, railRows: LICENSE_RAIL_ROWS },
    // Optional server modules, install-wide; gated like the server licence.
    { id: 'modules', labelKey: 'admin.tab_modules', labelFallback: 'Modules', descriptionKey: 'admin_nav.modules_desc', descriptionFallback: 'Optional modules for this server, and the marketplace to add more.', icon: Package, group: 'platform', perm: ['all'], scope: 'instance', superAdminOnly: true },
    { id: 'appearance', labelKey: 'admin.tab_appearance', icon: Palette, group: 'platform', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true, minTier: 'enterprise', railRows: APPEARANCE_RAIL_ROWS },
    { id: 'languages', labelKey: 'admin.tab_languages', descriptionKey: 'admin_nav.languages_desc', descriptionFallback: 'The languages of the interface, and their texts.', icon: Languages, group: 'platform', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true },
    // The whole server's organisations, roles and permission catalogue, MCP servers and Nextcloud instances
    // (its row only once some organisation is bound to a Nextcloud or came in through the connector).
    { id: 'organisations', labelKey: 'admin_nav.organisations', labelFallback: 'Organisations', descriptionKey: 'admin_nav.organisations_desc', descriptionFallback: 'Every organisation on this server.', icon: Building, group: 'identity', perm: ['admin_security'], scope: 'instance', superAdminOnly: true },
    { id: 'roles', labelKey: 'admin_nav.roles', labelFallback: 'Roles & permissions', descriptionKey: 'admin_nav.roles_desc', descriptionFallback: 'The roles of this server, and the permissions they grant.', icon: Tag, group: 'identity', perm: ['admin_security'], scope: 'instance', superAdminOnly: true },
    { id: 'mcp-servers', labelKey: 'admin_nav.mcp_servers', labelFallback: 'MCP servers', descriptionKey: 'admin_nav.mcp_servers_desc', descriptionFallback: 'MCP servers installed for every organisation, and what organisations may add themselves.', icon: Plug, group: 'connections', perm: ['admin_security'], scope: 'instance', superAdminOnly: true },
    { id: 'nextcloud-instances', labelKey: 'admin_nav.nextcloud_instances', labelFallback: 'Nextcloud instances', descriptionKey: 'admin_nav.nextcloud_instances_desc', descriptionFallback: 'The Nextclouds connected to this server, and how their connectors are doing.', icon: Cloud, group: 'connections', perm: ['admin_security'], scope: 'instance', superAdminOnly: true, railGate: (c) => c.hasNextcloudInstances !== false },
    // The Website CMS surface (product website builder, analytics, release notes): cloud,
    // Enterprise, super-admin. The builder leaves the dashboard chrome.
    { id: 'product-website', labelKey: 'admin.tab_product_website', icon: Globe, group: 'website', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true, minTier: 'enterprise', cloudOnly: true, escapesChrome: true },
    { id: 'website-analytics', labelKey: 'admin.tab_website_analytics', labelFallback: 'Website Analytics', descriptionKey: 'admin_nav.website_analytics_desc', descriptionFallback: 'Visits to the product website, in totals.', icon: BarChart3, group: 'website', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true, minTier: 'enterprise', cloudOnly: true },
    { id: 'release-notes', labelKey: 'admin.tab_release_notes', labelFallback: 'Release Notes', descriptionKey: 'admin_nav.release_notes_desc', descriptionFallback: 'Write and publish the release notes of each version.', icon: Newspaper, group: 'website', perm: ['admin_ai_config'], scope: 'instance', superAdminOnly: true, minTier: 'enterprise', cloudOnly: true },
];

export interface AdminAccess {
    isCloud: boolean;
    isSelfHosted: boolean;
    /** The REAL resolved tier, already normalised. */
    tier: string;
    /** A server-wide licence is active. */
    serverOverride: boolean;
    isSuperAdmin: boolean;
    hasPermission: (perm: string) => boolean;
    /** Does the entitlement snapshot grant this capability? Absent: capability-gated tabs are not offered. */
    hasCapability?: (capability: string) => boolean;
}

/** A tab flagged for the super-admin, or about the whole server, is for the platform admin whatever permissions the viewer holds. */
function isForPlatformAdmin(tab: AdminTab): boolean {
    return !!tab.superAdminOnly || tab.scope === 'instance';
}

/** The tab names a licence capability the viewer's entitlements do not grant. */
function lacksCapability(tab: AdminTab, access: AdminAccess): boolean {
    return !!tab.capability && !access.hasCapability?.(tab.capability);
}

/** May this user open this tab? An unknown tab is not refused here (the content just renders nothing). */
export function canOpenAdminTab(tab: AdminTab | undefined, access: AdminAccess): boolean {
    if (!tab) return true;
    if (tab.cloudOnly && !access.isCloud) return false;
    // Tier gate — paid admin surfaces are hidden below their minTier. Uses
    // the REAL resolved tier (TIER_RANK[tier]) rather than hasTier(), which
    // is equivalent here but keeps the intent explicit: a Community install
    // exposes only AI Config / Security / Integrations / Server licence /
    // Languages, even to its own super-admin. tier is already normalised
    // (LEGACY_TIER_ALIAS applied at fetch); default rank 0 = community.
    if (tab.minTier && (TIER_RANK[access.tier] ?? 0) < (TIER_RANK[tab.minTier] ?? Infinity)) return false;
    // Server-wide licence active → no per-org subscriptions to manage.
    if (lacksCapability(tab, access)) return false;
    if (tab.id === 'subscriptions' && access.serverOverride) return false;
    if (tab.selfHostedOnly && !access.isSelfHosted) return false;
    if (!access.isSuperAdmin && isForPlatformAdmin(tab)) return false;
    return tab.perm.some((p) => access.hasPermission(p));
}

/** The scope of a tab, of one of its sub-sections when that differs, or of a part inside a sub-section. */
export function adminScopeOf(tab: AdminTab, section?: string, part?: string): AdminScope | null {
    const own = (key: string) => (tab.sections && Object.hasOwn(tab.sections, key) ? tab.sections[key] : undefined);
    const partScope = section && part ? own(`${section}/${part}`) : undefined;
    return partScope ?? (section ? own(section) : undefined) ?? tab.scope;
}

/** The scope of a section of a tab by the tab's id; a panel reports the section it really renders with this. */
export function adminSectionScope(tabId: string, section?: string, part?: string): AdminScope | null {
    const tab = ADMIN_TABS.find(t => t.id === tabId);
    return tab ? adminScopeOf(tab, section, part) : null;
}

/** May this viewer see a section (or a part of one)? A server-wide one is for the platform admin only. */
export function isAdminSectionVisible(tabId: string, isPlatformAdmin: boolean, section?: string, part?: string): boolean {
    return isPlatformAdmin || adminSectionScope(tabId, section, part) !== 'instance';
}

/** The viewer's two admin standings, as the section rules read them (utils/adminAccess). */
export interface AdminSectionViewer {
    isPlatformAdmin: boolean;
    /** An organisation admin of their home organisation (utils/adminAccess isHomeOrgAdmin). */
    isHomeOrgAdmin: boolean;
}

/**
 * May this viewer see a section (or a part of one)? As isAdminSectionVisible,
 * and a section the tab lists in `orgAdminSections` also needs an organisation
 * admin of the home organisation, unless the viewer is a platform admin.
 */
export function isAdminSectionVisibleTo(tabId: string, viewer: AdminSectionViewer, section?: string, part?: string): boolean {
    if (viewer.isPlatformAdmin) return true;
    if (!isAdminSectionVisible(tabId, false, section, part)) return false;
    const needsOrgAdmin = !!section && !!ADMIN_TABS.find(t => t.id === tabId)?.orgAdminSections?.includes(section);
    return !needsOrgAdmin || viewer.isHomeOrgAdmin;
}

export interface ShownScopeInput {
    tab: AdminTab | undefined;
    /** A panel's own report of the section it renders. */
    override: AdminScope | null;
    /** The section the URL names; the panel's override wins over it. */
    section?: string;
    /** The viewer has an organisation of their own. */
    hasHomeOrg: boolean;
}

/**
 * The scope the dashboard strip shows, or null for no strip. An organisation
 * scope needs a home organisation: without one the data is not any organisation's.
 */
export function shownAdminScope({ tab, override, section, hasHomeOrg }: ShownScopeInput): AdminScope | null {
    if (!tab) return null;
    const scope = override ?? adminScopeOf(tab, section);
    if (scope === 'org' && !hasHomeOrg) return null;
    return scope;
}

export interface ResolvedAdminTab {
    activeTab: string;
    agentSection: string;
    /** The address after the aliases (adminPathAliases): what every part of the dashboard reads. */
    path: ResolvedAdminPath;
    /** The first tab this user may open, in ADMIN_TABS order. */
    firstAllowedTab: AdminTab | undefined;
    /** False: the address names a tab this viewer may not open, and the dashboard says so (no silent swap). */
    isTabAllowed: boolean;
}

/** A tab named without a section opens its fallback (BARE_TAB_FALLBACKS) when that one is allowed. */
function bareTabFallback(tab: AdminTab | undefined, path: ResolvedAdminPath, allowed: (tab: AdminTab | undefined) => boolean): AdminTab | undefined {
    if (!tab || path.seg2 || !Object.hasOwn(BARE_TAB_FALLBACKS, tab.id)) return tab;
    const fallback = ADMIN_TABS.find(candidate => candidate.id === BARE_TAB_FALLBACKS[tab.id]);
    return fallback && allowed(fallback) ? fallback : tab;
}

/**
 * Which tab the URL opens, after the old addresses are mapped onto the new ones
 * (ADMIN_PATH_ALIASES). A tab that exists opens as itself, allowed or not: a
 * refused one is the denied page, not another tab under the requested address.
 * No tab, or a name no tab has, opens the first tab this viewer may open.
 */
export function resolveAdminTab(adminPath: AdminPath, allowed: (tab: AdminTab | undefined) => boolean): ResolvedAdminTab {
    const resolved = resolveAdminPath(adminPath);
    const firstAllowedTab = ADMIN_TABS.find(tab => allowed(tab));
    const requested = bareTabFallback(ADMIN_TABS.find(tab => tab.id === resolved.seg1), resolved, allowed);
    const path = requested ? { ...resolved, seg1: requested.id } : { seg1: firstAllowedTab?.id ?? resolved.seg1, seg2: '', seg3: '' };
    const isTabAllowed = requested ? allowed(requested) : !!firstAllowedTab;
    return { activeTab: path.seg1, agentSection: path.seg1 === 'agents' ? path.seg2 : '', path, firstAllowedTab, isTabAllowed };
}

/** The two top-level groups of the rail: the viewer's organisation, and the whole server (platform admin only). */
export interface AdminRailSection<T extends AdminTab = AdminTab> {
    id: AdminRailBlock;
    groups: { id: AdminTabGroupId; labelKey: string; labelFallback: string; tabs: T[] }[];
}

/** The block of a rail row: its own when it is a section row, else by the tab's scope (instance is the whole server). */
export function adminRailBlockOf(tab: AdminTab & { block?: AdminRailBlock }): AdminRailBlock {
    return tab.block ?? (tab.scope === 'instance' ? 'instance' : 'org');
}

/**
 * Splits the rows a viewer gets into the rail's two top-level groups: a
 * section row by the block it names, a tab by its scope (instance tabs are the
 * whole server, everything else, org, mixed, user, or a panel that picks its
 * own organisation, is the viewer's organisation). The whole-server group is
 * left out for anyone but a platform admin. Empty groups are left out.
 */
export function buildAdminRailSections<T extends AdminTab & { block?: AdminRailBlock }>(tabs: readonly T[], isPlatformAdmin: boolean): AdminRailSection<T>[] {
    const sections: AdminRailSection<T>[] = [
        { id: 'org', groups: groupAdminTabs(tabs.filter(tab => adminRailBlockOf(tab) === 'org')) },
    ];
    if (isPlatformAdmin) sections.push({ id: 'instance', groups: groupAdminTabs(tabs.filter(tab => adminRailBlockOf(tab) === 'instance')) });
    return sections.filter(section => section.groups.length > 0);
}

/** A row's place in ADMIN_RAIL_ORDER; an unlisted row after every listed one. */
function railRank(id: string): number {
    const at = ADMIN_RAIL_ORDER.indexOf(id);
    return at === -1 ? ADMIN_RAIL_ORDER.length : at;
}

/** The tabs a user may open, grouped in rail order (ADMIN_RAIL_ORDER inside a group); empty groups are left out. */
export function groupAdminTabs<T extends AdminTab>(tabs: readonly T[]) {
    return ADMIN_TAB_GROUPS
        .map(group => ({ ...group, tabs: tabs.filter(tab => tab.group === group.id).sort((a, b) => railRank(a.id) - railRank(b.id)) }))
        .filter(group => group.tabs.length > 0);
}

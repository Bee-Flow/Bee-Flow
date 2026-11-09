// The tabs of the global admin dashboard (/app/admin/<tab>/<seg2>/<seg3>):
// which exist, who may open them, and how the rail groups them. Pure data and
// functions, so the gating can be tested without rendering a single panel.

import {
    Activity, BadgeCheck, BarChart3, Bot, CreditCard, Globe, KeyRound, Languages, LifeBuoy,
    Newspaper, Package, Palette, Plug, Scale, Shield, Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TIER_RANK } from '@/components/licensing/LicenseContext';

export type AdminTabGroupId = 'ai' | 'security' | 'platform' | 'operations' | 'website';

export interface AdminTab {
    id: string;
    labelKey: string;
    labelFallback?: string;
    icon: LucideIcon;
    group: AdminTabGroupId;
    perm: string[];
    superAdminOnly?: boolean;
    minTier?: string;
    cloudOnly?: boolean;
    selfHostedOnly?: boolean;
}

/** The rail's groups, in rail order, each with the eyebrow above it. */
export const ADMIN_TAB_GROUPS: readonly { id: AdminTabGroupId; labelKey: string; labelFallback: string }[] = [
    { id: 'ai', labelKey: 'admin.nav_group_ai', labelFallback: 'AI & agents' },
    { id: 'security', labelKey: 'admin.nav_group_security', labelFallback: 'Security & access' },
    { id: 'platform', labelKey: 'admin.nav_group_platform', labelFallback: 'Platform' },
    { id: 'operations', labelKey: 'admin.nav_group_operations', labelFallback: 'Operations' },
    { id: 'website', labelKey: 'admin.nav_group_website', labelFallback: 'Website' },
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
export const ADMIN_TABS: readonly AdminTab[] = [
    { id: 'agents', labelKey: 'admin.tab_agents', icon: Bot, group: 'ai', perm: ['admin_agents', 'admin_agents_chat', 'admin_agents_system'], superAdminOnly: false, minTier: 'enterprise' },
    { id: 'ai-config', labelKey: 'admin.tab_ai_config', icon: Sparkles, group: 'ai', perm: ['admin_ai_config'], superAdminOnly: true },
    { id: 'security', labelKey: 'admin.tab_security', icon: Shield, group: 'security', perm: ['admin_security'], superAdminOnly: false },
    { id: 'integrations', labelKey: 'admin.tab_integrations', icon: Plug, group: 'platform', perm: ['admin_security'], superAdminOnly: true },
    // Access & Permissions — grant features/integrations to All members or
    // per group, within the plan/license ceiling. Available to org-admins
    // too (they manage their own org); super-admins get an org picker.
    { id: 'access', labelKey: 'admin.tab_access', labelFallback: 'Access', icon: KeyRound, group: 'security', perm: ['admin_security', 'org_admin', 'manage_users'], superAdminOnly: false },
    { id: 'monitoring', labelKey: 'admin.tab_monitoring', icon: Activity, group: 'operations', perm: ['admin_monitoring'], superAdminOnly: false, minTier: 'enterprise' },
    // Compliance Hub — available on cloud AND self-hosted (Enterprise):
    // self-hosted GDPR customers are exactly who the hub serves. Also
    // reachable from Settings → Organisation for org-admins/DPOs.
    { id: 'compliance', labelKey: 'admin.tab_compliance', icon: Scale, group: 'security', perm: ['admin_compliance'], superAdminOnly: false, minTier: 'enterprise' },
    // Bee Flow customer-support inbox. Visible to any super-admin (or a
    // user with the `admin_support` permission), on cloud and self-hosted
    // alike — outbound email + AI reply are best-effort and degrade
    // gracefully if SMTP / KB aren't configured.
    { id: 'support', labelKey: 'admin.tab_support', labelFallback: 'Support', icon: LifeBuoy, group: 'operations', perm: ['admin_support'], superAdminOnly: true, minTier: 'enterprise' },
    // Subscriptions are a Bee Flow Cloud feature. Self-hosted installs
    // manage paid access via license keys (Settings → License & Usage).
    { id: 'subscriptions', labelKey: 'admin.tab_subscriptions', icon: CreditCard, group: 'operations', perm: ['admin_subscriptions'], superAdminOnly: true, cloudOnly: true },
    // Server-wide licence governs every org/user on this install.
    // Available to super-admins on any deployment mode — a single-tenant
    // operator applies one licence for the whole server.
    { id: 'licenses', labelKey: 'admin.tab_server_license', labelFallback: 'Server licence', icon: BadgeCheck, group: 'operations', perm: ['all'], superAdminOnly: true },
    // Optional server modules — import/remove feature modules install-wide.
    // Mirrors the Server-licence gating: global super-admin, any deployment.
    { id: 'modules', labelKey: 'admin.tab_modules', labelFallback: 'Modules', icon: Package, group: 'platform', perm: ['all'], superAdminOnly: true },
    { id: 'appearance', labelKey: 'admin.tab_appearance', icon: Palette, group: 'platform', perm: ['admin_ai_config'], superAdminOnly: true, minTier: 'enterprise' },
    { id: 'languages', labelKey: 'admin.tab_languages', icon: Languages, group: 'platform', perm: ['admin_ai_config'], superAdminOnly: true },
    // Product website builder — a Bee Flow Cloud marketing surface. On a
    // self-hosted install the public site is disabled (root goes straight
    // to /app), so the editor tab is hidden too.
    { id: 'product-website', labelKey: 'admin.tab_product_website', icon: Globe, group: 'website', perm: ['admin_ai_config'], superAdminOnly: true, minTier: 'enterprise', cloudOnly: true },
    // Website analytics — self-hosted usage tracking for the CMS site.
    // Gated identically to product-website so it only surfaces when the
    // Website CMS product is active (super-admin, Enterprise, cloud).
    { id: 'website-analytics', labelKey: 'admin.tab_website_analytics', labelFallback: 'Website Analytics', icon: BarChart3, group: 'website', perm: ['admin_ai_config'], superAdminOnly: true, minTier: 'enterprise', cloudOnly: true },
    // Release notes review queue. Same gating as the two tabs above — it is
    // part of the Website CMS surface, and it is where machine-drafted
    // changelog copy is approved before a customer ever sees it.
    { id: 'release-notes', labelKey: 'admin.tab_release_notes', labelFallback: 'Release Notes', icon: Newspaper, group: 'website', perm: ['admin_ai_config'], superAdminOnly: true, minTier: 'enterprise', cloudOnly: true },
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
    if (tab.id === 'subscriptions' && access.serverOverride) return false;
    if (tab.selfHostedOnly && !access.isSelfHosted) return false;
    if (tab.superAdminOnly && !access.isSuperAdmin) return false;
    return tab.perm.some((p) => access.hasPermission(p));
}

// Direct paths like /admin/chat map to the agents tab with that section.
const AGENT_SECTION_IDS = ['chat', 'system'];

export interface ResolvedAdminTab {
    activeTab: string;
    agentSection: string;
    /** The first tab this user may open, in ADMIN_TABS order. */
    firstAllowedTab: AdminTab | undefined;
    isTabAllowed: boolean;
}

/** Which tab the URL opens: the requested one when allowed, else the first allowed one. */
export function resolveAdminTab(adminPath: { seg1?: string; seg2?: string }, allowed: (tab: AdminTab | undefined) => boolean): ResolvedAdminTab {
    let requestedTab = adminPath.seg1 || 'agents';
    let agentSection = adminPath.seg2 || '';
    // If seg1 is an agent section (e.g. /admin/chat), remap to agents tab
    if (AGENT_SECTION_IDS.includes(requestedTab)) {
        agentSection = requestedTab;
        requestedTab = 'agents';
    }
    const firstAllowedTab = ADMIN_TABS.find(tab => allowed(tab));
    const isRequestedAllowed = allowed(ADMIN_TABS.find(tab => tab.id === requestedTab));
    const activeTab = isRequestedAllowed ? requestedTab : (firstAllowedTab?.id || requestedTab);
    return { activeTab, agentSection, firstAllowedTab, isTabAllowed: allowed(ADMIN_TABS.find(tab => tab.id === activeTab)) };
}

/** The tabs a user may open, grouped in rail order; empty groups are left out. */
export function groupAdminTabs(tabs: readonly AdminTab[]) {
    return ADMIN_TAB_GROUPS
        .map(group => ({ ...group, tabs: tabs.filter(tab => tab.group === group.id) }))
        .filter(group => group.tabs.length > 0);
}

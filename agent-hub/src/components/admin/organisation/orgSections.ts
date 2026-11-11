// The sections of the admin dashboard's Organisation tab and who sees which:
// pure, so every rule can be tested without rendering a panel. The rules are the
// ones the Settings > Organisation menu had (its rows moved here); the ids are
// the old Settings URL segments (authedApp/settingsRoutes SETTINGS_ORG_ID_TO_URL),
// so an old address maps onto a section by name. Each section is a row of the
// dashboard rail itself, in the rail group `group` names (dashboard/adminRailRows).

import {
    Brain, Cloud, CreditCard, DatabaseZap, FileText, FolderGit2, GraduationCap, Info, KeyRound, Link2,
    Lock, Plug, RefreshCw, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdminTabGroupId } from '@/components/admin/dashboard/adminTabs';
import { isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';

/** The rail groups the sections sit in (adminTabs ADMIN_TAB_GROUPS). */
type OrgRailGroupId = Extract<AdminTabGroupId, 'organisation' | 'ai' | 'security' | 'connections'>;

export interface OrgHubSection {
    id: string;
    labelKey: string;
    icon: LucideIcon;
    /** The rail group the section's row sits in. */
    group: OrgRailGroupId;
}

/** Every section in nav order (the order inside its rail group); the labels are the Settings rows'. */
export const ORG_HUB_SECTIONS: readonly OrgHubSection[] = [
    { id: 'info', labelKey: 'settings.org_info', icon: Info, group: 'organisation' },
    { id: 'auth', labelKey: 'settings.signin_method', icon: KeyRound, group: 'organisation' },
    { id: 'license', labelKey: 'settings.license_usage', icon: CreditCard, group: 'organisation' },
    { id: 'academy', labelKey: 'settings.academy', icon: GraduationCap, group: 'organisation' },
    { id: 'encryption', labelKey: 'settings.encryption', icon: Lock, group: 'security' },
    { id: 'ai-context', labelKey: 'settings.ai_context', icon: Brain, group: 'ai' },
    { id: 'integration-cache', labelKey: 'settings.integration_cache', icon: DatabaseZap, group: 'ai' },
    { id: 'meeting-templates', labelKey: 'settings.meeting_templates', icon: FileText, group: 'ai' },
    { id: 'integrations', labelKey: 'settings.integrations', icon: Link2, group: 'connections' },
    { id: 'mcp', labelKey: 'mcp_library.nav', icon: Plug, group: 'connections' },
    { id: 'mcp-access', labelKey: 'mcp_access.nav', icon: ShieldCheck, group: 'connections' },
    { id: 'github-sync', labelKey: 'settings.github_sync', icon: FolderGit2, group: 'connections' },
    { id: 'nextcloud-sync', labelKey: 'settings.nextcloud_sync', icon: Cloud, group: 'connections' },
    { id: 'azure', labelKey: 'settings.azure_config', icon: Cloud, group: 'connections' },
];

/** The Azure section of an organisation admin who is not the platform admin: the organisation's own group sync. */
const GROUP_SYNC_SECTION: OrgHubSection = { id: 'azure', labelKey: 'azure.group_sync_nav', icon: RefreshCw, group: 'connections' };

/** The user fields the standing facts read. */
export interface OrgFactsUser {
    permissions?: string[] | null;
    isAdmin?: boolean | null;
    role?: string | null;
    orgRole?: string | null;
    provider?: string | null;
    ncOrg?: { instanceId?: string | null } | null;
    featureFlags?: { deploymentMode?: string } | null;
}

/** What the viewer's account says about their standing; Settings (useSettingsAccess) reads the same. */
export interface OrgStandingFacts {
    /** Administers an organisation: `all` / `org_admin`, or an organisation-admin role. */
    canSeeOrg: boolean;
    canManageUsers: boolean;
    isSelfHosted: boolean;
    /** Signed in through the Nextcloud connector: identity is Nextcloud's. */
    isNcConnectorUser: boolean;
    /** The home organisation is bound to a Nextcloud. */
    isNcOrg: boolean;
    /** Nextcloud sections: an NC-bound organisation, or someone who manages every organisation. */
    showNcSync: boolean;
    /** The platform admin exactly as the server tests it (utils/adminAccess); the `all` permission is not it. */
    isPlatformAdmin: boolean;
}

/** The permission half of the standing: who administers an organisation, who manages its users. */
function permissionStanding(user: OrgFactsUser | null | undefined) {
    const perms = user?.permissions || [];
    const all = perms.includes('all');
    const orgAdminRole = isOrgAdminRole(user?.orgRole);
    return {
        canSeeOrg: all || perms.includes('org_admin') || orgAdminRole,
        canManageUsers: all || perms.includes('manage_users') || orgAdminRole,
        // Super-admins (perms 'all' or role 'admin') manage every org in the
        // deployment, so they see NC-related sections even if their own session
        // isn't tied to an NC-bound org; org-admins only when their own org is.
        managesEveryOrg: all || user?.role === 'admin',
    };
}

export function orgStandingFactsOf(user: OrgFactsUser | null | undefined): OrgStandingFacts {
    const { canSeeOrg, canManageUsers, managesEveryOrg } = permissionStanding(user);
    const isNcOrg = !!user?.ncOrg?.instanceId;
    return {
        canSeeOrg,
        canManageUsers,
        isSelfHosted: user?.featureFlags?.deploymentMode === 'self-hosted',
        isNcConnectorUser: user?.provider === 'nextcloud_connector',
        isNcOrg,
        showNcSync: isNcOrg || managesEveryOrg,
        isPlatformAdmin: isPlatformAdmin(user),
    };
}

/** Everything the section rules read: the standing plus the plan and connection facts. */
export interface OrgSectionFacts extends Omit<OrgStandingFacts, 'canManageUsers'> {
    canUseLearning: boolean;
    githubConnected: boolean;
    /** The organisation's sign-in method is stored (it locks once saved). */
    orgAuthLocked: boolean;
    entitlementsLoading: boolean;
    /** The plan snapshot failed or is degraded: rows that hide on it fail open. */
    entitlementsUnknown: boolean;
    inCeiling?: (id: string) => boolean;
}

/** The Meeting Templates rule: the meeting_notes licence in the organisation's plan ceiling, not yet known while it loads. */
function meetingNotesInPlan(f: OrgSectionFacts): boolean {
    return !f.entitlementsLoading && (f.entitlementsUnknown || !!f.inCeiling?.('meeting_notes'));
}

/**
 * The rule of each section that does not simply follow canSeeOrg. Azure is
 * answered by orgAzureSection.
 */
const SECTION_RULES: Readonly<Record<string, (f: OrgSectionFacts) => boolean>> = {
    // Self-hosted: licensing is governed server-wide (Admin → Server licence).
    license: (f) => !f.isSelfHosted,
    // NC-bound orgs delegate sign-in to Nextcloud entirely. Once the method is
    // locked, cloud only shows a "locked" notice; self-hosted keeps the
    // Allowed Domains editor on the same page, which stays editable.
    auth: (f) => !(f.isNcOrg || f.isNcConnectorUser) && !(f.orgAuthLocked && !f.isSelfHosted),
    // The Academy overview needs the Learning Center in the plan.
    academy: (f) => f.canUseLearning,
    // Meeting Templates (and the Meet / Teams panels) is behind the
    // meeting_notes licence on the server: the plan ceiling, not this admin's grants.
    'meeting-templates': meetingNotesInPlan,
    'nextcloud-sync': (f) => f.showNcSync,
    // Only once a GitHub account is connected in Settings → Connections.
    'github-sync': (f) => f.githubConnected,
};

/**
 * The Azure section on a self-hosted install: the instance-wide Azure services
 * setup for the platform admin (its API takes one), the organisation's own Azure
 * AD group sync for an organisation admin; none on cloud.
 */
export function orgAzureSection(f: OrgSectionFacts): 'config' | 'group-sync' | null {
    if (!f.isSelfHosted) return null;
    if (f.isPlatformAdmin) return 'config';
    return f.canSeeOrg ? 'group-sync' : null;
}

/** May this viewer see the section? Everything needs canSeeOrg (or the platform admin). */
export function isOrgSectionVisible(id: string, f: OrgSectionFacts): boolean {
    if (!f.canSeeOrg && !f.isPlatformAdmin) return false;
    if (id === 'azure') return orgAzureSection(f) !== null;
    const rule = Object.hasOwn(SECTION_RULES, id) ? SECTION_RULES[id] : null;
    return rule ? rule(f) : ORG_HUB_SECTIONS.some(s => s.id === id);
}

/** The sections this viewer gets, in nav order, with the Azure row in its viewer's form. */
export function visibleOrgSections(f: OrgSectionFacts): OrgHubSection[] {
    return ORG_HUB_SECTIONS
        .filter(s => isOrgSectionVisible(s.id, f))
        .map(s => (s.id === 'azure' && orgAzureSection(f) === 'group-sync' ? GROUP_SYNC_SECTION : s));
}

/** The section a request for `requested` opens: that one when this viewer has it, else the first one (none: ''). */
export function activeOrgSection(sections: readonly Pick<OrgHubSection, 'id'>[], requested: string | undefined): string {
    return sections.some(s => s.id === requested) ? requested as string : (sections[0]?.id ?? '');
}

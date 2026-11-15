// The sections of the admin dashboard's Organisation tab and who sees which:
// pure, so every rule can be tested without rendering a panel. The rules read
// the viewer's standing and what the CHOSEN organisation has (its integration
// availability, orgAvailabilityFactsOf), never the viewer's own session; most ids
// are the old Settings URL segments (authedApp/settingsRoutes SETTINGS_ORG_ID_TO_URL),
// and the renamed ones are ORG_SECTION_ALIASES (dashboard/adminPathAliases). Each
// section is a row of the dashboard rail itself, in the rail group `group` names
// (dashboard/adminRailRows).

import {
    BookOpen, Brain, Cloud, CreditCard, DatabaseZap, FileText, FolderGit2, FolderKanban, GraduationCap, Info, KeyRound,
    Layers, Link2, Lock, MessagesSquare, Plug, RefreshCw, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdminTabGroupId } from '@/components/admin/dashboard/adminTabs';
import { orgSectionAlias } from '@/components/admin/dashboard/adminPathAliases';
import type { IntegrationFamily, OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';
import { familyAvailable, type AvailabilityRead } from '@/utils/integrationAvailability';

/** The rail groups the sections sit in (adminTabs ADMIN_TAB_GROUPS). */
type OrgRailGroupId = Extract<AdminTabGroupId, 'organisation' | 'ai' | 'security' | 'connections'>;

export interface OrgHubSection {
    id: string;
    labelKey: string;
    labelFallback?: string;
    icon: LucideIcon;
    /** The rail group the section's row sits in. */
    group: OrgRailGroupId;
}

/**
 * Every section in nav order (the order inside its rail group is the rail's,
 * dashboard/adminTabs ADMIN_RAIL_ORDER). The old ids (ai-context,
 * meeting-templates, the Settings tab ids) are ORG_SECTION_ALIASES.
 */
export const ORG_HUB_SECTIONS: readonly OrgHubSection[] = [
    { id: 'info', labelKey: 'admin_nav.org_info', labelFallback: 'Organisation info', icon: Info, group: 'organisation' },
    { id: 'license', labelKey: 'admin_nav.license_usage', labelFallback: 'Licence & usage', icon: CreditCard, group: 'organisation' },
    { id: 'projects', labelKey: 'admin_nav.projects', labelFallback: 'Projects', icon: FolderKanban, group: 'organisation' },
    { id: 'academy', labelKey: 'admin_nav.learning_center', labelFallback: 'Learning Center', icon: GraduationCap, group: 'organisation' },
    { id: 'knowledge-bases', labelKey: 'admin_nav.knowledge_bases', labelFallback: 'Knowledge bases', icon: BookOpen, group: 'ai' },
    { id: 'models', labelKey: 'admin_nav.models', labelFallback: 'Models', icon: Layers, group: 'ai' },
    { id: 'conversations', labelKey: 'admin_nav.conversations', labelFallback: 'Conversations', icon: MessagesSquare, group: 'ai' },
    { id: 'memory', labelKey: 'admin_nav.memory', labelFallback: 'Memory', icon: Brain, group: 'ai' },
    { id: 'meeting-notes', labelKey: 'admin_nav.meeting_notes', labelFallback: 'Meeting notes', icon: FileText, group: 'ai' },
    { id: 'auth', labelKey: 'org_signin.nav', icon: KeyRound, group: 'security' },
    { id: 'encryption', labelKey: 'admin_nav.encryption', labelFallback: 'Encryption', icon: Lock, group: 'security' },
    { id: 'mcp-access', labelKey: 'admin_nav.mcp_client_access', labelFallback: 'MCP client access', icon: ShieldCheck, group: 'security' },
    { id: 'integrations', labelKey: 'admin_nav.integration_status', labelFallback: 'Integration status', icon: Link2, group: 'connections' },
    { id: 'mcp', labelKey: 'admin_nav.mcp_servers', labelFallback: 'MCP servers', icon: Plug, group: 'connections' },
    { id: 'nextcloud-sync', labelKey: 'admin_nav.nextcloud', labelFallback: 'Nextcloud', icon: Cloud, group: 'connections' },
    { id: 'azure', labelKey: 'admin_nav.microsoft_365', labelFallback: 'Microsoft 365', icon: RefreshCw, group: 'connections' },
    { id: 'github-sync', labelKey: 'admin_nav.github_sync', labelFallback: 'GitHub sync', icon: FolderGit2, group: 'connections' },
    { id: 'integration-cache', labelKey: 'admin_nav.answer_cache', labelFallback: 'Automation answer cache', icon: DatabaseZap, group: 'connections' },
];

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
    /** Manages the organisation's knowledge bases: `all` or `manage_knowledge` (the old /app/org-settings gate). */
    canManageKnowledge: boolean;
}

/** The permission half of the standing: who administers an organisation, who manages its users. */
function permissionStanding(user: OrgFactsUser | null | undefined) {
    const perms = user?.permissions || [];
    const all = perms.includes('all');
    const orgAdminRole = isOrgAdminRole(user?.orgRole);
    return {
        canSeeOrg: all || perms.includes('org_admin') || orgAdminRole,
        canManageUsers: all || perms.includes('manage_users') || orgAdminRole,
        canManageKnowledge: all || perms.includes('manage_knowledge'),
        // Super-admins (perms 'all' or role 'admin') manage every org in the
        // deployment, so they see NC-related sections even if their own session
        // isn't tied to an NC-bound org; org-admins only when their own org is.
        managesEveryOrg: all || user?.role === 'admin',
    };
}

export function orgStandingFactsOf(user: OrgFactsUser | null | undefined): OrgStandingFacts {
    const { canSeeOrg, canManageUsers, canManageKnowledge, managesEveryOrg } = permissionStanding(user);
    const isNcOrg = !!user?.ncOrg?.instanceId;
    return {
        canSeeOrg,
        canManageUsers,
        canManageKnowledge,
        isSelfHosted: user?.featureFlags?.deploymentMode === 'self-hosted',
        isNcConnectorUser: user?.provider === 'nextcloud_connector',
        isNcOrg,
        showNcSync: isNcOrg || managesEveryOrg,
        isPlatformAdmin: isPlatformAdmin(user),
    };
}

/**
 * What the CHOSEN organisation has, from its integration availability
 * (api/queries/orgIntegrationAvailability), never the viewer's own session: a
 * platform admin looking at another organisation gets that organisation's
 * rows. Read by orgAvailabilityFactsOf with the fail policy of
 * utils/integrationAvailability.
 */
export interface OrgAvailabilityFacts {
    /** The organisation is bound to a Nextcloud. */
    ncBound: boolean;
    /**
     * The Nextcloud row applies: a bound organisation, or the platform admin's
     * home organisation while pairing is offered. The pairing half opens to an
     * organisation admin once the section carries the "Connect a Nextcloud"
     * pairing of its own (a later wave); today the page is the sync panel.
     */
    ncSectionAvailable: boolean;
    /** The organisation can sync agent configuration with GitHub (the family is available, or a sync is already set up). */
    githubAvailable: boolean;
    /** Microsoft 365 applies: Microsoft is set up on the server, and the organisation has a directory connected or is the viewer's own. */
    microsoft365: boolean;
    meetingNotes: boolean;
    mcp: boolean;
    projects: boolean;
    learningCenter: boolean;
    automations: boolean;
    /**
     * The availability is still being read (set by useOrgSectionFacts): a
     * section hidden only for want of an answer may yet open, so the tab waits
     * instead of showing another section in its place.
     */
    availabilityPending?: boolean;
}

/** Everything the section rules read: the viewer's standing plus what the chosen organisation has. */
export interface OrgSectionFacts extends Omit<OrgStandingFacts, 'canManageUsers' | 'isNcOrg' | 'showNcSync'>, OrgAvailabilityFacts {}

interface AvailabilityFactsInput {
    /** The availability query of the chosen organisation (a react-query result fits). */
    read: AvailabilityRead | null | undefined;
    /** The fail policy's viewer: a platform admin fails open, anyone else closed. */
    platformAdmin: boolean;
    /** The chosen organisation is the viewer's home organisation (the answer's own flag wins once there). */
    homeOrg: boolean;
    /** The viewer's session says their home organisation is bound to a Nextcloud: the fallback while there is no answer. */
    sessionNcBound: boolean;
}

/** The answer is there and has the shape the rules read. */
function knownAnswer(read: AvailabilityRead | null | undefined): OrgIntegrationAvailability | null {
    const data = read?.data;
    return !read?.isError && data && typeof data === 'object' && data.families && data.nextcloud ? data : null;
}

/** Microsoft 365 applies to the organisation: set up on the server, and a directory connected or the viewer's own organisation. */
function microsoft365Of(answer: OrgIntegrationAvailability, ownOrg: boolean): boolean {
    return !!answer.families.microsoft?.serverConfigured && (!!answer.microsoft?.directoryConnected || ownOrg);
}

/**
 * The chosen organisation's facts. Without an answer (loading, failed, no
 * organisation chosen) the Nextcloud binding falls back to the viewer's session
 * for their home organisation, the Nextcloud row is offered to a platform admin,
 * and every family follows the fail policy.
 */
export function orgAvailabilityFactsOf({ read, platformAdmin, homeOrg, sessionNcBound }: AvailabilityFactsInput): OrgAvailabilityFacts {
    const viewer = { platformAdmin };
    const has = (family: IntegrationFamily) => familyAvailable(read, family, viewer).available;
    const answer = knownAnswer(read);
    const ownOrg = answer ? answer.homeOrg : homeOrg;
    const ncBound = answer ? !!answer.nextcloud.bound : homeOrg && sessionNcBound;
    const ncSectionAvailable = answer
        ? ncBound || (platformAdmin && ownOrg && !!answer.nextcloud.pairingAvailable)
        : platformAdmin || ncBound;
    return {
        ncBound,
        ncSectionAvailable,
        githubAvailable: has('github') || !!answer?.github?.syncConfigured,
        microsoft365: answer ? microsoft365Of(answer, ownOrg) : platformAdmin,
        meetingNotes: has('meetingNotes'),
        mcp: has('mcp'),
        projects: has('projects'),
        learningCenter: has('learningCenter'),
        automations: has('automations'),
    };
}

/**
 * The rule of each section that does not simply follow canSeeOrg, on the chosen
 * organisation's facts.
 */
const SECTION_RULES: Readonly<Record<string, (f: OrgSectionFacts) => boolean>> = {
    // Self-hosted: licensing is governed server-wide (Licence & features).
    license: (f) => !f.isSelfHosted,
    // An NC-bound organisation delegates sign-in to Nextcloud entirely. Everyone
    // else keeps the row: the preferred sign-in method never locks.
    auth: (f) => !f.ncBound,
    // The AI in team chats and real-time co-editing act inside projects only.
    projects: (f) => f.projects,
    // The Learning Center overview needs the Learning Center for this organisation.
    academy: (f) => f.learningCenter,
    // The system knowledge bases: whoever manages the organisation's knowledge (or the platform admin).
    'knowledge-bases': (f) => f.isPlatformAdmin || f.canManageKnowledge,
    // Storing answers between runs is about the organisation's automations.
    'integration-cache': (f) => f.automations,
    // Meeting notes (summary templates, Meet and Teams): the meeting_notes licence,
    // module and feature flag for this organisation, not this admin's grants.
    'meeting-notes': (f) => f.meetingNotes,
    mcp: (f) => f.mcp,
    'nextcloud-sync': (f) => f.ncSectionAvailable,
    // Entra ID group sync: the organisation's own Microsoft 365 (the instance-wide
    // Azure services form is no longer a row: AI configuration holds those settings).
    azure: (f) => f.microsoft365,
    // The organisation's agent-config repository: the panel's own not-connected
    // state covers the actions that need a personal GitHub token.
    'github-sync': (f) => f.githubAvailable,
};

/** May this viewer see the section? Everything needs canSeeOrg (or the platform admin). */
export function isOrgSectionVisible(id: string, f: OrgSectionFacts): boolean {
    if (!f.canSeeOrg && !f.isPlatformAdmin) return false;
    const rule = Object.hasOwn(SECTION_RULES, id) ? SECTION_RULES[id] : null;
    return rule ? rule(f) : ORG_HUB_SECTIONS.some(s => s.id === id);
}

/** The sections this viewer gets, in nav order. */
export function visibleOrgSections(f: OrgSectionFacts): OrgHubSection[] {
    return ORG_HUB_SECTIONS.filter(s => isOrgSectionVisible(s.id, f));
}

/**
 * The tab should wait before it opens a section: the availability is still
 * being read and the requested section, which exists, is not (yet) this
 * viewer's.
 */
export function awaitingOrgSection(f: OrgSectionFacts, requested: string | undefined): boolean {
    const id = orgSectionAlias(requested);
    return !!f.availabilityPending && !!id && ORG_HUB_SECTIONS.some(s => s.id === id) && !isOrgSectionVisible(id, f);
}

/**
 * The section a request for `requested` opens: that one (by its current id,
 * ORG_SECTION_ALIASES) when this viewer has it, else the first one (none: '').
 */
export function activeOrgSection(sections: readonly Pick<OrgHubSection, 'id'>[], requested: string | undefined): string {
    const id = orgSectionAlias(requested);
    return sections.some(s => s.id === id) ? id as string : (sections[0]?.id ?? '');
}

// The sections of the admin dashboard's Organisation tab and who sees which:
// pure, so every rule can be tested without rendering a panel. The rules read
// the viewer's standing and what the CHOSEN organisation has (its integration
// availability, orgAvailabilityFacts), never the viewer's own session; most ids
// are the old Settings URL segments (authedApp/settingsRoutes SETTINGS_ORG_ID_TO_URL),
// and the renamed ones are ORG_SECTION_ALIASES (dashboard/adminPathAliases). Each
// section is a row of the dashboard rail itself, in the rail group `group` names
// (dashboard/adminRailRows).

import {
    BookOpen, Brain, Cloud, CreditCard, DatabaseZap, FileText, FolderGit2, FolderKanban, GraduationCap, Info, Layers,
    Link2, Lock, LogIn, MessagesSquare, Plug, RefreshCw, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdminTabGroupId } from '@/components/admin/dashboard/adminTabs';
import { orgSectionAlias } from '@/components/admin/dashboard/adminPathAliases';
import type { IntegrationFamily, UnavailableReason } from '@/api/queries/orgIntegrationAvailability';
import { isOrgAdminRole, isPlatformAdmin } from '@/utils/adminAccess';
import type { OrgAvailabilityFacts } from './orgAvailabilityFacts';

/** The rail groups the sections sit in (adminTabs ADMIN_TAB_GROUPS). */
type OrgRailGroupId = Extract<AdminTabGroupId, 'organisation' | 'ai' | 'security' | 'connections'>;

export interface OrgHubSection {
    id: string;
    labelKey: string;
    labelFallback?: string;
    /** The line under the page header (dashboard/AdminPage). */
    descriptionKey?: string;
    descriptionFallback?: string;
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
    {
        id: 'info', labelKey: 'admin_nav.org_info', labelFallback: 'Organisation info',
        descriptionKey: 'admin_nav.org_info_desc', descriptionFallback: "The organisation's name, contact details and defaults.",
        icon: Info, group: 'organisation',
    },
    {
        id: 'license', labelKey: 'admin_nav.license_usage', labelFallback: 'Licence & usage',
        descriptionKey: 'admin_nav.license_usage_desc', descriptionFallback: "The organisation's plan, seats and what it uses of them.",
        icon: CreditCard, group: 'organisation',
    },
    {
        id: 'projects', labelKey: 'admin_nav.projects', labelFallback: 'Projects',
        descriptionKey: 'admin_nav.projects_desc', descriptionFallback: 'How the AI takes part in team chats, and editing together in real time.',
        icon: FolderKanban, group: 'organisation',
    },
    {
        id: 'academy', labelKey: 'admin_nav.learning_center', labelFallback: 'Learning Center',
        descriptionKey: 'admin_nav.learning_center_desc', descriptionFallback: "Courses and required training for the organisation's members.",
        icon: GraduationCap, group: 'organisation',
    },
    {
        id: 'knowledge-bases', labelKey: 'admin_nav.knowledge_bases', labelFallback: 'Knowledge bases',
        descriptionKey: 'admin_nav.knowledge_bases_desc', descriptionFallback: 'The built-in knowledge bases the organisation can switch on.',
        icon: BookOpen, group: 'ai',
    },
    {
        id: 'models', labelKey: 'admin_nav.models', labelFallback: 'Models',
        descriptionKey: 'admin_nav.org_models_desc', descriptionFallback: "The organisation's own model tiers, next to the tiers of the whole server.",
        icon: Layers, group: 'ai',
    },
    {
        id: 'conversations', labelKey: 'admin_nav.conversations', labelFallback: 'Conversations',
        descriptionKey: 'admin_nav.conversations_desc', descriptionFallback: 'How the AI handles long conversations: keep everything, or summarise older messages.',
        icon: MessagesSquare, group: 'ai',
    },
    {
        id: 'memory', labelKey: 'admin_nav.memory', labelFallback: 'Memory',
        descriptionKey: 'admin_nav.memory_desc', descriptionFallback: 'What the AI may remember about people between conversations.',
        icon: Brain, group: 'ai',
    },
    {
        id: 'meeting-notes', labelKey: 'admin_nav.meeting_notes', labelFallback: 'Meeting notes',
        descriptionKey: 'admin_nav.meeting_notes_desc', descriptionFallback: 'Summary templates, and the meeting services the notes come from.',
        icon: FileText, group: 'ai',
    },
    {
        id: 'auth', labelKey: 'org_signin.nav',
        // The sign-in page's own introduction (the panel draws no header): it says the choice is a preference.
        descriptionKey: 'org_signin.subtitle',
        descriptionFallback: 'How you would like members of this organisation to sign in. It is a preference: the other sign-in methods of this server keep working, and you can change it at any time.',
        icon: LogIn, group: 'security',
    },
    {
        id: 'encryption', labelKey: 'admin_nav.encryption', labelFallback: 'Encryption',
        descriptionKey: 'admin_nav.encryption_desc', descriptionFallback: "How the organisation's data is encrypted, and who holds the keys.",
        icon: Lock, group: 'security',
    },
    {
        id: 'mcp-access', labelKey: 'admin_nav.mcp_client_access', labelFallback: 'MCP client access',
        descriptionKey: 'admin_nav.mcp_client_access_desc', descriptionFallback: "Which outside AI clients may reach the organisation's data through MCP.",
        icon: ShieldCheck, group: 'security',
    },
    {
        id: 'integrations', labelKey: 'admin_nav.integration_status', labelFallback: 'Integration status',
        descriptionKey: 'admin_nav.integration_status_desc', descriptionFallback: 'Which integrations the organisation has, and the settings all its members share.',
        icon: Link2, group: 'connections',
    },
    {
        id: 'mcp', labelKey: 'admin_nav.mcp_servers', labelFallback: 'MCP servers',
        descriptionKey: 'admin_nav.org_mcp_servers_desc', descriptionFallback: "The MCP servers the organisation's agents and chats can use.",
        icon: Plug, group: 'connections',
    },
    {
        id: 'nextcloud-sync', labelKey: 'admin_nav.nextcloud', labelFallback: 'Nextcloud',
        descriptionKey: 'admin_nav.nextcloud_desc', descriptionFallback: "The organisation's Nextcloud: its connection, users and apps.",
        icon: Cloud, group: 'connections',
    },
    {
        id: 'azure', labelKey: 'admin_nav.microsoft_365', labelFallback: 'Microsoft 365',
        descriptionKey: 'admin_nav.microsoft_365_desc', descriptionFallback: "The organisation's Microsoft 365: the groups synced from its directory, and the setup of Teams meeting notes.",
        icon: RefreshCw, group: 'connections',
    },
    {
        id: 'github-sync', labelKey: 'admin_nav.github_sync', labelFallback: 'GitHub sync',
        descriptionKey: 'admin_nav.github_sync_desc', descriptionFallback: "Keep the organisation's agent configuration in a GitHub repository.",
        icon: FolderGit2, group: 'connections',
    },
    {
        id: 'integration-cache', labelKey: 'admin_nav.answer_cache', labelFallback: 'Automations',
        descriptionKey: 'admin_nav.answer_cache_desc', descriptionFallback: 'Reuse answers from outside services between automation runs.',
        icon: DatabaseZap, group: 'connections',
    },
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

/** Everything the section rules read: the viewer's standing plus what the chosen organisation has. */
export interface OrgSectionFacts extends Omit<OrgStandingFacts, 'canManageUsers' | 'isNcOrg' | 'showNcSync'>, OrgAvailabilityFacts {}

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

/** What a request for an Organisation section opens: the section, and whether this viewer gets it. */
export interface OrgSectionRequest {
    id: string;
    available: boolean;
}

/**
 * The section a request opens. A section that exists (by its current id,
 * ORG_SECTION_ALIASES) opens as itself, available or not: one this viewer does
 * not get is the unavailable notice on its own address, never another section
 * in its place. No section, or a name no section has, opens the first one this
 * viewer gets (none: '').
 */
export function openOrgSection(sections: readonly Pick<OrgHubSection, 'id'>[], requested: string | undefined): OrgSectionRequest {
    const id = orgSectionAlias(requested);
    if (id && ORG_HUB_SECTIONS.some(s => s.id === id)) return { id, available: sections.some(s => s.id === id) };
    const first = sections[0]?.id ?? '';
    return { id: first, available: !!first };
}

/** Why an Organisation section is not there for this viewer: an availability reason, or one of the section's own. */
export type OrgSectionUnavailableReason = UnavailableReason | 'self_hosted_licence' | 'nextcloud_sign_in' | 'no_permission' | 'unknown';

/** The availability family behind a section, where one decides it. */
const SECTION_FAMILIES: Readonly<Record<string, IntegrationFamily>> = {
    projects: 'projects',
    academy: 'learningCenter',
    'meeting-notes': 'meetingNotes',
    mcp: 'mcp',
    'integration-cache': 'automations',
    'github-sync': 'github',
    azure: 'microsoft',
};

/** Why section `id` is not visible on these facts (read only for a section isOrgSectionVisible refuses). */
export function orgSectionUnavailableReason(id: string, f: OrgSectionFacts): OrgSectionUnavailableReason {
    if (!f.canSeeOrg && !f.isPlatformAdmin) return 'no_permission';
    if (id === 'license') return 'self_hosted_licence';
    if (id === 'auth') return 'nextcloud_sign_in';
    if (id === 'knowledge-bases') return 'no_permission';
    if (id === 'nextcloud-sync') return 'not_bound';
    const family = Object.hasOwn(SECTION_FAMILIES, id) ? SECTION_FAMILIES[id] : null;
    return (family && f.familyReasons?.[family]) || 'unknown';
}

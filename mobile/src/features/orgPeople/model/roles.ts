/**
 * The organisation roles and what they grant — the port of the web's
 * agent-hub/src/config/orgRoles.js (ORG_ROLES, PERMISSION_CATALOG,
 * permissionsForRole, editablePermissionsForRole), pinned by
 * roles.lockstep.test.ts.
 *
 * WHAT a role grants is never decided here: it comes from GET /auth/org-roles.
 * This file only orders the ids and says them to a person. The English copy is
 * the web's; every word reaches the screen through `t()` (see `roleCopy` and
 * `permissionCopy`), so a translated catalogue replaces it.
 */

import type { TranslateFn } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

import type { OrgRolePermissions } from './types';

/** ORG_ROLES order on the web: most privileged first. */
export const ORG_ROLE_IDS = ['org_admin', 'dpo', 'isms_auditor', 'agent_admin', 'agent_editor', 'member'] as const;

/** The option the web lists first in every role picker: no org role. */
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- the role value 'user' (no org role) that every role picker lists first, not a username
export const PLAIN_USER_ROLE = 'user';

const ROLE_COPY: Record<string, readonly [string, string]> = {
    org_admin: [
        'Organisation Admin',
        'Full organisation control — manage users, groups, permissions, Privacy Shield settings, and all agent capabilities.',
    ],
    dpo: [
        'Data Protection Officer',
        'Compliance oversight — access the Compliance Center and Usage & Monitoring without full organisation admin rights.',
    ],
    isms_auditor: [
        'ISMS Internal Auditor',
        'Independent internal auditor (ISO 27001 clause 9.2) — reviews compliance evidence and records audit findings without operational admin rights.',
    ],
    agent_admin: ['Agent Admin', 'Create and manage all agents — both published and in-progress drafts.'],
    agent_editor: [
        'Agent Editor',
        'Create agents and edit published ones, but cannot modify unpublished drafts from others.',
    ],
    member: [
        'Member',
        'Basic access. Can use datatables that have been shared with them, but cannot create or change any.',
    ],
};

/** PERMISSION_CATALOG on the web, in its order: id → [label, description]. */
const PERMISSION_COPY: Record<string, readonly [string, string]> = {
    all: ['Full Access', 'Every permission on the platform'],
    manage_agents: ['Agents', 'Create, edit, delete and publish agents'],
    manage_skills: ['Skills', 'Create, edit, delete and share the reusable abilities agents call'],
    manage_knowledge: ['Knowledge', 'Create, edit, delete and ingest the knowledge bases the AI searches'],
    use_meeting_notes: ['Meeting Notes', 'Record and read meeting transcripts, speakers and actions'],
    use_automations: ['Automations', 'Build and run the multi-step routines in the Automations builder'],
    use_datatables: [
        'Use Datatables',
        'Read and write rows in tables shared with them — a new table is private to its creator until it is shared',
    ],
    manage_datatables: ['Manage Datatables', 'Create, change, share and delete the tables routines read and write'],
    use_webpages: ['Webpages', 'Design and publish public webpages'],
    manage_apps: ['Build Apps', 'Build internal apps in App Studio and publish them to the organisation'],
    use_apps: ['Use Apps', 'Open the internal apps published to them'],
    use_solutions: ['Solutions', 'Bundle routines, apps and webpages into one installable Solution'],
    use_approvals: ['Approvals', 'See the approvals waiting on them and the decisions they were part of'],
    use_forms: ['Forms', 'See the forms published in the organisation and their public links'],
    use_notebooks: ['Notebooks', 'Create, edit and delete personal notebooks'],
    manage_users: ['Manage Users', 'Add, remove, and assign roles to organisation members'],
    page_settings: ['Edit Organisation Settings', 'Change branding, legal details, and configuration'],
    admin_security: ['Privacy Shield', 'Configure data redaction, guardrails, users and SSO'],
    admin_compliance: ['Compliance Center', 'Run and review GDPR / AI Act compliance checks and settings'],
    admin_monitoring: ['Usage & Monitoring', 'View organisation usage and activity monitoring'],
    admin_subscriptions: ['Subscriptions', 'Manage the organisation subscription and plan'],
    admin_ai_config: ['AI Config', 'Choose and configure the models the organisation may use'],
    admin_components: ['Components', 'Open the component builder'],
    manage_components: ['Manage Components', 'Create and edit workflow components'],
    support_inbox: ['Support Inbox', 'Connect a support mailbox and triage, reply to and resolve tickets'],
    modify_n8n_workflows: [
        'Modify n8n Workflows',
        'Let AI create, edit, delete, activate and execute n8n workflows on their behalf',
    ],
    use_n8n_tools: ['Use n8n Tools', 'Run n8n webhook workflows and inspect workflow definitions via AI'],
    admin_agents: ['All Agents', 'Reach every agent type in the admin surface'],
    admin_agents_chat: ['Agent Configuration', 'Configure an individual agent'],
    admin_agents_system: ['System Agents', 'Configure the built-in system agents'],
    admin_agents_pipeline: ['Pipeline', 'Configure the processing pipeline'],
    page_chat: ['Chat', 'Use the chat interface'],
};

export const PERMISSION_IDS = Object.keys(PERMISSION_COPY);

/** Role ids are also permission ids in the mapping: a marker, not a capability. */
const ROLE_MARKERS = new Set<string>(ORG_ROLE_IDS);

export interface RoleCopy {
    name: string;
    description: string;
}

export interface PermissionCopy {
    id: string;
    label: string;
    description: string;
}

export function roleCopy(id: string, t: TranslateFn): RoleCopy {
    if (id === PLAIN_USER_ROLE) {
        return { name: t('admin.org_role_user', 'User'), description: '' };
    }
    const copy = ROLE_COPY[id];
    if (!copy) return { name: humanise(id), description: '' };
    return {
        name: t(`mobile.orgPeople.role_${id}`, copy[0]),
        description: t(`mobile.orgPeople.role_${id}_desc`, copy[1]),
    };
}

export function permissionCopy(id: string, t: TranslateFn): PermissionCopy {
    const copy = PERMISSION_COPY[id];
    if (!copy) return { id, label: humanise(id), description: '' };
    return {
        id,
        label: t(`mobile.orgPeople.perm_${id}`, copy[0]),
        description: t(`mobile.orgPeople.perm_${id}_desc`, copy[1]),
    };
}

/** Known ids in `order` first, the rest after in their own order. */
function inOrder(ids: readonly string[], order: readonly string[]): string[] {
    const known = order.filter((id) => ids.includes(id));
    return [...known, ...ids.filter((id) => !order.includes(id))];
}

/** The roles to list: the server's mapping, in the web's order. */
export function orderedRoleIds(roles: readonly OrgRolePermissions[]): string[] {
    const ids = roles.map((r) => r.id);
    return inOrder(ids.length > 0 ? ids : [...ORG_ROLE_IDS], ORG_ROLE_IDS);
}

/** A picker's options: "User" first, then every org role (the web's select). */
export function roleOptions(roles: readonly OrgRolePermissions[]): string[] {
    return [PLAIN_USER_ROLE, ...orderedRoleIds(roles)];
}

function grantedBy(roleId: string, mapping: readonly OrgRolePermissions[]): string[] {
    return mapping.find((r) => r.id === roleId)?.permissions ?? [];
}

/** Everything a role grants, catalogue order, unknown ids kept at the end. */
export function permissionsForRole(roleId: string, mapping: readonly OrgRolePermissions[]): string[] {
    const granted = grantedBy(roleId, mapping).filter((id) => !ROLE_MARKERS.has(id));
    return inOrder([...new Set(granted)], PERMISSION_IDS);
}

/** The switches the organisation owns for this role, with their current state. */
export function editableRows(
    roleId: string,
    mapping: readonly OrgRolePermissions[],
    editable: readonly string[],
): { id: string; granted: boolean }[] {
    const granted = new Set(grantedBy(roleId, mapping));
    return inOrder(editable, PERMISSION_IDS).map((id) => ({ id, granted: granted.has(id) }));
}

/** What the role grants that the editor cannot change (or everything, with no editor). */
export function fixedPermissions(
    roleId: string,
    mapping: readonly OrgRolePermissions[],
    editable: readonly string[],
    withEditor: boolean,
): string[] {
    const all = permissionsForRole(roleId, mapping);
    return withEditor ? all.filter((id) => !editable.includes(id)) : all;
}

/** How many non-system members hold a role (the web's per-role count). */
export function holdersOf(roleId: string, members: readonly { orgRole?: string; isSystem?: boolean }[]): number {
    return members.filter((m) => m.orgRole === roleId && !m.isSystem).length;
}

/** Splice a saved role back into the mapping: the server answers only the editable half. */
export function withSavedRole(
    mapping: readonly OrgRolePermissions[],
    roleId: string,
    editable: readonly string[],
    saved: readonly string[],
): OrgRolePermissions[] {
    return mapping.map((r) =>
        r.id === roleId
            ? { id: r.id, permissions: [...r.permissions.filter((p) => !editable.includes(p)), ...saved] }
            : r,
    );
}

/** Same members, ignoring order. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * A role whose grant is worth a second look before it lands: organisation
 * admin (everything) and agent admin (every agent, drafts included).
 */
export function isAdminRole(id: string): boolean {
    return id.endsWith('_admin');
}

/** "1 member" / "N members": the one way this feature counts people. */
export function memberCountLabel(count: number, t: TranslateFn): string {
    return count === 1
        ? t('mobile.orgPeople.one_member', '1 member')
        : t('mobile.orgPeople.n_members', '{count} members', { count });
}

/** A role as a picker option: its name and what it is for. */
export function roleChoice(id: string, t: TranslateFn): { id: string; label: string; description: string } {
    const copy = roleCopy(id, t);
    return { id, label: copy.name, description: copy.description };
}

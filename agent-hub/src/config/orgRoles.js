/**
 * Shared Organisation Role definitions
 *
 * Single source of truth for orgRole IDs, labels, descriptions, and colors.
 * Used by both UserManagement.jsx and OrgUsersPanel.jsx.
 *
 * WHAT A ROLE GRANTS IS NOT DEFINED HERE. Each entry used to carry a
 * hand-written `permissions` list of {label, desc} prose, and it had drifted
 * badly from server/config/orgRoles.json — the Organisation Admin was credited
 * with five permissions out of twenty-odd, and no Studio section was mentioned
 * at all. The Roles screen now reads the real mapping from GET /auth/org-roles
 * and renders it through PERMISSION_CATALOG below, so the one page that answers
 * "who in my organisation can use this" cannot answer it wrongly again.
 */

/**
 * Permission id → how to say it to a person. Mirrors SYSTEM_PERMISSIONS in
 * server/auth/permissions.js; a permission missing here still renders (the
 * screen falls back to a title-cased id), it just reads less warmly.
 *
 * COPY ONLY. Adding an entry grants nothing — the grant lives in
 * server/config/orgRoles.json, which is what the resolver reads.
 */
export const PERMISSION_CATALOG = {
    all: { label: 'Full Access', desc: 'Every permission on the platform' },

    // ── Studio ──
    manage_agents: { label: 'Agents', desc: 'Create, edit, delete and publish agents' },
    manage_skills: { label: 'Skills', desc: 'Create, edit, delete and share the reusable abilities agents call' },
    manage_knowledge: { label: 'Knowledge', desc: 'Create, edit, delete and ingest the knowledge bases the AI searches' },
    use_meeting_notes: { label: 'Meeting Notes', desc: 'Record and read meeting transcripts, speakers and actions' },
    use_automations: { label: 'Automations', desc: 'Build and run the multi-step routines in the Automations builder' },
    use_datatables: { label: 'Use Datatables', desc: 'Read and write rows in tables shared with them — a new table is private to its creator until it is shared' },
    manage_datatables: { label: 'Manage Datatables', desc: 'Create, change, share and delete the tables routines read and write' },
    use_webpages: { label: 'Webpages', desc: 'Design and publish public webpages' },
    manage_apps: { label: 'Build Apps', desc: 'Build internal apps in App Studio and publish them to the organisation' },
    use_apps: { label: 'Use Apps', desc: 'Open the internal apps published to them' },
    use_solutions: { label: 'Solutions', desc: 'Bundle routines, apps and webpages into one installable Solution' },
    use_approvals: { label: 'Approvals', desc: 'See the approvals waiting on them and the decisions they were part of' },
    use_forms: { label: 'Forms', desc: 'See the forms published in the organisation and their public links' },
    use_notebooks: { label: 'Notebooks', desc: 'Create, edit and delete personal notebooks' },

    // ── Organisation ──
    manage_users: { label: 'Manage Users', desc: 'Add, remove, and assign roles to organisation members' },
    page_settings: { label: 'Edit Organisation Settings', desc: 'Change branding, legal details, and configuration' },
    admin_security: { label: 'Privacy Shield', desc: 'Configure data redaction, guardrails, users and SSO' },
    admin_compliance: { label: 'Compliance Center', desc: 'Run and review GDPR / AI Act compliance checks and settings' },
    admin_monitoring: { label: 'Usage & Monitoring', desc: 'View organisation usage and activity monitoring' },
    admin_subscriptions: { label: 'Subscriptions', desc: 'Manage the organisation subscription and plan' },
    admin_ai_config: { label: 'AI Config', desc: 'Choose and configure the models the organisation may use' },
    admin_components: { label: 'Components', desc: 'Open the component builder' },
    manage_components: { label: 'Manage Components', desc: 'Create and edit workflow components' },
    support_inbox: { label: 'Support Inbox', desc: 'Connect a support mailbox and triage, reply to and resolve tickets' },
    modify_n8n_workflows: { label: 'Modify n8n Workflows', desc: 'Let AI create, edit, delete, activate and execute n8n workflows on their behalf' },
    use_n8n_tools: { label: 'Use n8n Tools', desc: 'Run n8n webhook workflows and inspect workflow definitions via AI' },

    // ── Admin pages ──
    admin_agents: { label: 'All Agents', desc: 'Reach every agent type in the admin surface' },
    admin_agents_chat: { label: 'Agent Configuration', desc: 'Configure an individual agent' },
    admin_agents_system: { label: 'System Agents', desc: 'Configure the built-in system agents' },
    admin_agents_pipeline: { label: 'Pipeline', desc: 'Configure the processing pipeline' },
    page_chat: { label: 'Chat', desc: 'Use the chat interface' },
};

/**
 * The role ids themselves are also permission ids in the mapping (an org_admin
 * carries 'org_admin'). They are a marker the server checks, not something to
 * show a person as a capability — the row already says which role it is.
 */
const ROLE_MARKER_IDS = new Set(['org_admin', 'dpo', 'isms_auditor', 'agent_admin', 'agent_editor', 'member']);

/** "use_meeting_notes" → "Use Meeting Notes", for an id we have no copy for. */
const prettify = (id) => String(id).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** One catalog entry, with a fallback for an id we have no copy for. */
const describe = (id) => ({
    id,
    label: PERMISSION_CATALOG[id]?.label || prettify(id),
    desc: PERMISSION_CATALOG[id]?.desc || '',
});

/**
 * What to show for one role, given the mapping from GET /auth/org-roles.
 * Returns `[{ id, label, desc }]` in PERMISSION_CATALOG order, so every role
 * lists its capabilities in the same sequence and two roles can be compared by
 * reading down the page. Unknown ids keep their place at the end rather than
 * being dropped: a permission the frontend has no copy for is still a
 * permission the role grants, and hiding it is how the old list went wrong.
 */
export function permissionsForRole(roleId, mapping) {
    const ids = (mapping || []).find((r) => r.id === roleId)?.permissions || [];
    const granted = new Set(ids.filter((id) => !ROLE_MARKER_IDS.has(id)));
    const known = Object.keys(PERMISSION_CATALOG).filter((id) => granted.has(id));
    const unknown = [...granted].filter((id) => !PERMISSION_CATALOG[id]);
    return [...known, ...unknown].map(describe);
}

/**
 * The rows of the role editor: every permission the ORGANISATION may switch on
 * or off for this role, each with whether it currently is.
 *
 * `editable` comes from the server (GET /auth/org-roles → editablePermissions)
 * rather than from a list here, so the screen can never offer a toggle the PUT
 * would silently drop. Ordered by PERMISSION_CATALOG like the chips above, so
 * the editor reads in the same sequence as the summary it edits.
 */
export function editablePermissionsForRole(roleId, mapping, editable) {
    const allowed = Array.isArray(editable) ? editable : [];
    if (allowed.length === 0) return [];
    const granted = new Set((mapping || []).find((r) => r.id === roleId)?.permissions || []);
    const inCatalog = Object.keys(PERMISSION_CATALOG).filter((id) => allowed.includes(id));
    const rest = allowed.filter((id) => !PERMISSION_CATALOG[id]);
    return [...inCatalog, ...rest].map((id) => ({ ...describe(id), granted: granted.has(id) }));
}

export const ORG_ROLES = [
    {
        id: 'org_admin',
        label: 'Organisation Admin',
        name: 'Organisation Admin',
        description: 'Full organisation control — manage users, groups, permissions, Privacy Shield settings, and all agent capabilities.',
        color: '#8b5cf6',
    },
    {
        id: 'dpo',
        label: 'Data Protection Officer',
        name: 'Data Protection Officer',
        description: 'Compliance oversight — access the Compliance Center and Usage & Monitoring without full organisation admin rights.',
        color: '#3b82f6',
    },
    {
        id: 'isms_auditor',
        label: 'ISMS Internal Auditor',
        name: 'ISMS Internal Auditor',
        description: 'Independent internal auditor (ISO 27001 clause 9.2) — reviews compliance evidence and records audit findings without operational admin rights.',
        color: '#0ea5e9',
    },
    {
        id: 'agent_admin',
        label: 'Agent Admin',
        name: 'Agent Admin',
        description: 'Create and manage all agents — both published and in-progress drafts.',
        color: '#f59e0b',
    },
    {
        id: 'agent_editor',
        label: 'Agent Editor',
        name: 'Agent Editor',
        description: 'Create agents and edit published ones, but cannot modify unpublished drafts from others.',
        color: '#10b981',
    },
    {
        id: 'member',
        label: 'Member',
        name: 'Member',
        description: 'Basic access. Can use datatables that have been shared with them, but cannot create or change any.',
        color: '#6b7280',
    },
];

/**
 * Helper for permission checks — returns true if a permission array includes
 * 'all' (full admin) or the specific permission ID.
 */
export const hasPermissionCheck = (permissions, permId) => {
    if (!Array.isArray(permissions)) return false;
    return permissions.includes('all') || permissions.includes(permId);
};

/**
 * Org roles that have agent management capabilities.
 * Used for gating access to agent-related UI in org settings.
 */
export const AGENT_MANAGEMENT_ROLES = ['org_admin', 'agent_admin', 'agent_editor'];

/**
 * Org roles that have user management capabilities.
 */
export const USER_MANAGEMENT_ROLES = ['org_admin'];

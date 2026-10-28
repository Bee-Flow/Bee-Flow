// @typecheck
/**
 * Permissions — the catalogue: canonical org/system role ids, the permission
 * ids and their discovery list (SYSTEM_PERMISSIONS), the capability grants that
 * imply a permission, and the shipped org role → permissions mapping
 * (config/orgRoles.json, memoised in this module).
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const path = require('path');
const fs = require('fs');
const { dep } = require('./permissionsDeps');
/** @type {typeof import('../stores/userStore')} */
const userStore = dep('userStore');
const log = require('../telemetry/log');

// ── Canonical role + permission identifiers ──────────────────────────────────
// String literals for these IDs are scattered across the codebase. New code
// should import from here; old call sites are migrated opportunistically.
// `LEGACY` aliases retain backwards-compat with rows that pre-date the
// 'admin' → 'org_admin' rename (matches the runtime normaliser at
// getUserPermissions ~ line 296).
const OrgRoles = Object.freeze({
    ORG_ADMIN: 'org_admin',
    DPO: 'dpo',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    MEMBER: 'member',
    // Legacy: pre-rename org admins. Always compare with ORG_ADMIN_VARIANTS,
    // never against this constant alone.
    LEGACY_ADMIN: 'admin',
});

const ORG_ADMIN_VARIANTS = Object.freeze([OrgRoles.ORG_ADMIN, OrgRoles.LEGACY_ADMIN]);

function isOrgAdminRole(orgRole) {
    return ORG_ADMIN_VARIANTS.includes(orgRole);
}

// System role values on users.role. 'admin' is the super-admin / platform
// root; 'user' is the default.
const SystemRoles = Object.freeze({
    SUPER_ADMIN: 'admin',
    USER: 'user',
});

// Canonical permission IDs. Keys match the entries declared in
// SYSTEM_PERMISSIONS below — adding a permission means appending it both
// to SYSTEM_PERMISSIONS (for the discovery API) and this constants map
// (for typesafe references from route code).
const Permissions = Object.freeze({
    ALL: 'all',
    PAGE_CHAT: 'page_chat',
    PAGE_SETTINGS: 'page_settings',
    ADMIN_AGENTS: 'admin_agents',
    ADMIN_AGENTS_CHAT: 'admin_agents_chat',
    ADMIN_AGENTS_SYSTEM: 'admin_agents_system',
    ADMIN_AGENTS_PIPELINE: 'admin_agents_pipeline',
    ADMIN_COMPONENTS: 'admin_components',
    ADMIN_AI_CONFIG: 'admin_ai_config',
    ADMIN_SECURITY: 'admin_security',
    ADMIN_MONITORING: 'admin_monitoring',
    ADMIN_COMPLIANCE: 'admin_compliance',
    ADMIN_SUBSCRIPTIONS: 'admin_subscriptions',
    ADMIN_SUPPORT: 'admin_support',
    MANAGE_USERS: 'manage_users',
    MANAGE_AGENTS: 'manage_agents',
    MANAGE_SKILLS: 'manage_skills',
    MANAGE_COMPONENTS: 'manage_components',
    MANAGE_KNOWLEDGE: 'manage_knowledge',
    MANAGE_APPS: 'manage_apps',
    // Org-level: read the WHOLE organisation's automation runs (Studio →
    // Runs & log, scope=org). Automations themselves stay user-private —
    // this grants a read of the run LOG, not access to anyone's automation.
    MANAGE_AUTOMATIONS: 'manage_automations',
    // Org-level: tenant customer-support inbox (Studio → Support). Distinct
    // from the super-admin ADMIN_SUPPORT (Bee Flow's own company inbox).
    SUPPORT_INBOX: 'support_inbox',
    USE_NOTEBOOKS: 'use_notebooks',
    USE_DATATABLES: 'use_datatables',
    MANAGE_DATATABLES: 'manage_datatables',
    USE_N8N_TOOLS: 'use_n8n_tools',
    MODIFY_N8N_WORKFLOWS: 'modify_n8n_workflows',
    // Org-role marker permissions (granted automatically by the matching
    // orgRole; useful when code wants to test "does this user behave as an
    // org_admin/agent_admin?" without coupling to the orgRole column).
    ORG_ADMIN: 'org_admin',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    DPO: 'dpo',
});

// System-wide permission definitions
const SYSTEM_PERMISSIONS = [
    // ── Super ──
    { id: 'all', name: 'Full Access', description: 'Grants all permissions', group: 'super' },

    // ── Pages (non-admin) ──
    { id: 'page_chat', name: 'Chat', description: 'Access the chat interface', group: 'pages' },
    { id: 'page_settings', name: 'Settings', description: 'Access user settings page', group: 'pages' },

    // ── Admin Pages ──
    { id: 'admin_agents', name: 'All Agents', description: 'Admin: Access to all agent types', group: 'admin' },
    { id: 'admin_agents_chat', name: 'Agent', description: 'Admin: Agent configuration', group: 'admin' },
    { id: 'admin_agents_system', name: 'System Agents', description: 'Admin: System agent configuration', group: 'admin' },
    { id: 'admin_agents_pipeline', name: 'Pipeline', description: 'Admin: Pipeline configuration', group: 'admin' },
    { id: 'admin_components', name: 'Components', description: 'Admin: Component builder', group: 'admin' },
    { id: 'admin_ai_config', name: 'AI Config', description: 'Admin: AI model configuration', group: 'admin' },
    { id: 'admin_security', name: 'Security', description: 'Admin: Users, SSO, guardrails', group: 'admin' },
    { id: 'admin_monitoring', name: 'Monitoring', description: 'Admin: Usage & cost monitoring', group: 'admin' },
    { id: 'admin_compliance', name: 'Compliance', description: 'Admin: GDPR & AI Act monitoring, DSR, ROPA, audit reports', group: 'admin' },
    { id: 'admin_subscriptions', name: 'Subscriptions', description: 'Admin: Subscription management', group: 'admin' },
    { id: 'admin_support', name: 'Customer Support', description: 'Admin: Bee Flow customer-support inbox (triage, reply, resolve)', group: 'admin' },

    // ── Actions ──
    { id: 'manage_users', name: 'Manage Users', description: 'Create, edit, and delete users', group: 'actions' },
    { id: 'manage_agents', name: 'Manage Agents', description: 'Create, edit, delete, and publish agents', group: 'actions' },
    { id: 'manage_skills', name: 'Manage Skills', description: 'Create, edit, delete, and share skills', group: 'actions' },
    { id: 'manage_components', name: 'Manage Components', description: 'Create and edit workflow components', group: 'actions' },
    { id: 'manage_knowledge', name: 'Manage Knowledge', description: 'Create, edit, delete, and ingest knowledge bases', group: 'actions' },
    { id: 'manage_apps', name: 'Manage Apps', description: 'Create and publish apps', group: 'actions' },
    { id: 'manage_automations', name: 'Manage Automations', description: "Org: see every automation's runs in the organisation's run log (Studio → Runs & log). Does not grant access to the automations themselves — those stay private to their owner.", group: 'actions' },
    { id: 'support_inbox', name: 'Support Inbox', description: 'Org: connect a support mailbox and triage, reply to, and resolve customer tickets in the Studio Support tab', group: 'actions' },
    { id: 'use_notebooks', name: 'Use Notebooks', description: 'Create, edit, and delete personal notebooks', group: 'actions' },
    { id: 'use_datatables', name: 'Use Datatables', description: 'Read and write rows in datatables shared with you, and run automation steps that use them', group: 'actions' },
    { id: 'manage_datatables', name: 'Manage Datatables', description: 'Create, change, share and delete datatables', group: 'actions' },

    // ── Studio ──
    // One permission per Studio section, so an organisation can decide from its
    // Roles screen who gets which part of the builder rather than the licence
    // alone deciding for everyone. They sit BESIDE the licence and capability
    // gates, never instead of them: an Enterprise licence says the feature
    // exists here, the role says who in the organisation may reach it.
    //
    // Agents, Skills, Knowledge and Datatables already had one (manage_agents /
    // manage_skills / manage_knowledge / use_datatables) and are not repeated.
    //
    // `use_webpages` is REVIVED rather than replaced. It was deprecated when
    // webpages moved to a per-org beta flag, but that flag answers "is this
    // organisation in the programme", which is not the same question as
    // "which of its people may publish a public page" — and the id has been in
    // the registry (and in existing role configs) the whole time.
    { id: 'use_webpages', name: 'Use Webpages', description: 'Design and publish public webpages in Studio', group: 'studio' },
    { id: 'use_automations', name: 'Use Automations', description: 'Build and run multi-step automations in the Automations builder', group: 'studio' },
    { id: 'use_approvals', name: 'Use Approvals', description: 'See the approvals waiting on you and the decisions you were part of', group: 'studio' },
    { id: 'use_apps', name: 'Use Apps', description: 'Open the internal apps published to you', group: 'studio' },
    { id: 'use_forms', name: 'Use Forms', description: 'See the forms published in the organisation and their public links', group: 'studio' },
    { id: 'use_solutions', name: 'Use Solutions', description: 'Bundle automations, apps and webpages into installable Solutions', group: 'studio' },
    { id: 'use_meeting_notes', name: 'Use Meeting Notes', description: 'Record and read meeting transcripts, speakers and actions', group: 'studio' },

    // ── n8n Integration ──
    { id: 'use_n8n_tools', name: 'Use n8n Tools', description: 'Run n8n webhook workflows and inspect workflow definitions via AI', group: 'actions' },
    { id: 'modify_n8n_workflows', name: 'Modify n8n Workflows', description: 'Allow AI to create, edit, delete, activate, and execute n8n workflows on behalf of the user', group: 'actions' },
];

/**
 * Capability grants that carry a UI permission with them.
 *
 * A group-scoped beta (betaFeatures.js `groupScoped`) is meant to be rolled
 * out per group from the Access matrix. Its Studio section is ALSO gated on a
 * role permission (studioApps.jsx, mobile studio registry), and the default
 * `member` role does not carry that permission — so a group grant alone left
 * the members it was meant for staring at a hidden section. Granting the
 * capability to a group therefore grants the matching permission to that
 * group's members.
 *
 * The org-wide "All members" grant of the same beta implies it too (see
 * orgWideGrantImpliedPermissions below): an admin who switched Meeting Notes
 * on for everyone was otherwise left with members who still could not see it.
 *
 * Every key MUST be a group-scoped beta (betaFeatures.js `groupScoped`): the
 * org-wide variant reads the org's everyone-list (org_beta_everyone), which
 * only exists for those.
 */
const GROUP_GRANT_IMPLIED_PERMISSIONS = Object.freeze({
    meeting_notes: Object.freeze(['use_meeting_notes']),
});

/**
 * The permissions the org's "All members" grants imply for one member.
 *
 * PRECEDENCE, most specific first:
 *   1. a GROUP grant of the capability always implies its permission (the
 *      admin named that group; see the loop in getUserPermissions);
 *   2. the org's Roles screen, once it has stored a choice for the member's
 *      role: that stored list is the org's full answer for the role, so an
 *      unticked use_meeting_notes there WITHDRAWS it even while "All members"
 *      is on. That is how an org keeps Meeting Notes for one group only;
 *   3. the "All members" grant fills the permission in for a role the org
 *      never edited (this function);
 *   4. the shipped default (config/orgRoles.json).
 * GET /org-roles shows rule 3 for unedited roles (orgRoleImpliedFill), so the
 * Roles screen ticks the box members actually get and saving the role keeps
 * it unless the admin unticks it.
 *
 * "All members" means the org's everyone-list holds the capability, or the
 * org never chose (null = every group-scoped beta for everyone, exactly as
 * buildOrgGrant in core/entitlements reads it). The licence and the org's
 * access menu are NOT checked here: like every role permission this is only
 * the "may this person" layer, and the capability gate stays in force on both
 * the server routes and the Studio row. A read failure implies nothing.
 *
 * @param {string|null|undefined} orgId
 * @returns {Promise<string[]>}
 */
async function orgWideGrantImpliedPermissions(orgId) {
    if (!orgId || typeof userStore.getOrgBetaEveryone !== 'function') return [];
    let everyone;
    try { everyone = await userStore.getOrgBetaEveryone(orgId); } catch (_) { return []; }
    const out = [];
    for (const [capId, perms] of Object.entries(GROUP_GRANT_IMPLIED_PERMISSIONS)) {
        if (everyone == null || (Array.isArray(everyone) && everyone.includes(capId))) out.push(...perms);
    }
    return out;
}

/**
 * Rule 3 above applied to a whole role mapping, for the Roles screen: every
 * role the org has no stored choice for gains the org-wide implied
 * permissions. Pure.
 *
 * @param {Record<string, string[]>} mapping   resolveOrgRolePermissions output
 * @param {Record<string, string[]>} overrides getOrgRoleOverrides output
 * @param {string[]} implied                   orgWideGrantImpliedPermissions output
 * @returns {Record<string, string[]>}
 */
function orgRoleImpliedFill(mapping, overrides, implied) {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [role, perms] of Object.entries(mapping || {})) {
        const edited = !!overrides && Object.prototype.hasOwnProperty.call(overrides, role);
        out[role] = edited ? [...(perms || [])] : [...new Set([...(perms || []), ...(implied || [])])];
    }
    return out;
}

// ── Load org role → permissions mapping from config file ──
let _orgRolePermissions = null;
function getOrgRolePermissions() {
    if (_orgRolePermissions) return _orgRolePermissions;
    try {
        const configPath = path.join(__dirname, '..', 'config', 'orgRoles.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        // Transform { role: { permissions: [...] } } → { role: [...] }
        _orgRolePermissions = {};
        for (const [role, def] of Object.entries(config)) {
            _orgRolePermissions[role] = def.permissions || [];
        }
        return _orgRolePermissions;
    } catch (err) {
        log.error('[Auth] Failed to load orgRoles.json, using empty fallback:', err.message);
        return {};
    }
}

module.exports = {
    OrgRoles,
    ORG_ADMIN_VARIANTS,
    isOrgAdminRole,
    SystemRoles,
    Permissions,
    SYSTEM_PERMISSIONS,
    GROUP_GRANT_IMPLIED_PERMISSIONS,
    orgWideGrantImpliedPermissions,
    orgRoleImpliedFill,
    getOrgRolePermissions,
};

/**
 * AI Config — external integration settings: the org-level n8n connection,
 * workflows, diagnostics and permissions, Agent Search defaults, and the
 * MCP server marketplace + live registry browse.
 */

const express = require('express');
const log = require('../../../telemetry/log');

const router = express.Router();
const configStore = require('../../../stores/configStore');
const { requireAuth, requireSuperAdmin } = require('../../../auth/permissions');
const { orgScope } = require('../../../auth/orgScope');
const { validate } = require('../../../core/http/validate');
const { z, worded, bodyOf, queryOf, closedObject, choice } = require('../../../core/http/schemaParts');
const { isAdminUser } = require('./shared');

// ── What these routes accept ─────────────────────────────────────────
// Closed bodies. What they close: `include_citations: "false"` switched
// citations ON (only the boolean false counted); a misspelled `mode` or
// detail level quietly became the default; a workflow list sent as one
// object stored that object where a list belongs. The values keep their clamps in the
// handlers; the schema only refuses what the handler would have dropped.
const aText = (message, max) => worded(message).max(max, message);
const count = z.union([z.number(), z.string()], { invalid_type_error: 'A count is a number.' });
const DETAIL = choice(['basic', 'detailed', 'highly_detailed'], 'detail_level is basic, detailed or highly_detailed.');
const SearchDefaultsBody = bodyOf({
    mode: choice(['web', 'web_fast', 'kb', 'auto'], 'mode is web, web_fast, kb or auto.').optional(),
    include_citations: z.boolean({ invalid_type_error: 'include_citations is true or false.' }).optional(),
    web: closedObject({
        max_results: count.optional(), fetch_top_n: count.optional(), max_tokens_markdown: count.optional(), detail_level: DETAIL.optional(),
    }, 'web').optional(),
    web_fast: closedObject({
        max_results: count.optional(), max_tokens_markdown: count.optional(), detail_level: DETAIL.optional(),
    }, 'web_fast').optional(),
}, 'The Agent Search defaults');
const N8nConfigBody = bodyOf({
    n8nUrl: aText('n8nUrl is the address of your n8n.', 2000).nullish(),
    apiKey: aText('apiKey is text.', 4000).nullish(),
}, 'The n8n connection');
const N8nWorkflowsBody = bodyOf({
    workflows: z.array(z.record(z.unknown()), { invalid_type_error: 'workflows is a list of workflow settings.' }).nullish(),
}, 'The n8n workflows');
const N8nPermissionBody = bodyOf({
    permission: aText('permission is the name of an n8n permission.', 100).optional(),
    groupId: aText('groupId is required', 200).optional(),
    action: aText("action must be 'add' or 'remove'", 20).optional(),
}, 'An n8n permission');
const TRANSPORT = choice(['stdio', 'http'], 'transport is stdio or http.');
const mcpShape = {
    name: aText('name is text.', 200).optional(),
    command: aText('command is text.', 2000).nullish(),
    args: z.array(z.unknown(), { invalid_type_error: 'args is a list.' }).nullish(),
    required_credentials: z.array(z.unknown(), { invalid_type_error: 'required_credentials is a list.' }).nullish(),
    transport: TRANSPORT.optional(),
    url: aText('url is the address of the server.', 2000).nullish(),
    category: aText('category is text.', 200).nullish(),
    description: aText('description is text.', 5000).nullish(),
    icon: aText('icon is text.', 2000).nullish(),
};
const McpServerBody = bodyOf({ ...mcpShape, source: aText('source is text.', 40).optional() }, 'An MCP server');
const McpUpdateBody = bodyOf({ ...mcpShape, enabled: z.boolean({ invalid_type_error: 'enabled is true or false.' }).optional() }, 'An MCP server');
const McpTestBody = bodyOf({
    command: mcpShape.command, args: mcpShape.args, transport: TRANSPORT.optional(), url: mcpShape.url,
}, 'An MCP server test');
const McpCredentialBody = bodyOf({
    serverId: aText('serverId and credKey are required', 200),
    credKey: aText('serverId and credKey are required', 200),
    value: aText('value is text.', 10_000).nullish(),
}, 'An MCP credential');
const RegistryQuery = queryOf({
    q: aText('q is text.', 1000).optional(),
    cursor: aText('cursor is the value the previous page handed back.', 1000).optional(),
    verifiedOnly: choice(['0', '1', 'true', 'false'], 'verifiedOnly is 1 or 0.').optional(),
}, 'The MCP registry search');

// ─── n8n Integration Config (Org-Level) ───────────────────────

const { listActiveWebhookWorkflows, fetchWorkflowById } = require('../../../integrations/n8nTools');

// Helper: get org ID from session; super admins without an org fall back to '__system__'
//
// `strict`, because this id is the KEY the n8n url and api key are stored
// under: a read that merely failed would look like "no org" and quietly send a
// tenant's connection into the shared '__system__' scope.
async function getOrgId(req) {
    const { orgId, isSuperAdmin } = await orgScope(req, { strict: true });
    if (!orgId && isSuperAdmin) return '__system__';
    return orgId;
}

// Helper: check if user is org admin
async function requireOrgAdminForN8n(req, res, next) {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { orgId, homeOrgId, isSuperAdmin } = await orgScope(req, { strict: true });
    // Super admins (global) can always manage n8n config; fall back to '__system__' scope if not in any org
    if (isSuperAdmin) {
        req.orgId = orgId || '__system__';
        return next();
    }
    // The HOME org, never the one a group grants: an org-admin role belongs to
    // the account's own org, and honouring it elsewhere would hand a member
    // admin rights in an org that never made them one.
    if (!homeOrgId) return res.status(403).json({ error: 'No organization' });
    const userStore = require('../../../stores/userStore');
    const user = await userStore.getUser(userId);
    if (user?.orgRole !== 'admin' && user?.orgRole !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    req.orgId = homeOrgId;
    next();
}

// GET /ai/n8n/config — get org's n8n connection config
router.get('/n8n/config', requireAuth, async (req, res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.json({ configured: false });

    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const hasApiKey = !!(await configStore.getSecret(`n8n_api_key_org_${orgId}`));
    const workflowsConfig = await configStore.getConfig(`n8n_workflows_org_${orgId}`);

    const workflows = workflowsConfig
        ? (typeof workflowsConfig === 'string' ? JSON.parse(workflowsConfig) : workflowsConfig)
        : [];

    res.json({
        configured: !!(n8nUrl && hasApiKey),
        n8nUrl: n8nUrl || '',
        hasApiKey,
        workflows,
    });
});

// ─── Agent Search Defaults ─────────────────────────────────────

router.get('/agent-search/defaults', requireAuth, async (req, res) => {
    try {
        const stored = await configStore.getConfig('agent_search_defaults');
        // Support new per-mode format OR migrate old flat format
        const defaults = stored && stored.web ? stored : {
            mode: stored?.mode || 'web',
            include_citations: stored?.include_citations !== false,
            web: {
                max_results: stored?.max_results || 5,
                fetch_top_n: stored?.fetch_top_n || 3,
                max_tokens_markdown: stored?.max_tokens_markdown || 2000,
                detail_level: 'detailed',
            },
            web_fast: {
                max_results: 10,
                max_tokens_markdown: 1500,
                detail_level: 'detailed',
            },
        };
        res.json(defaults);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch Agent Search defaults' });
    }
});

// Installation-wide: every agent's search reads these. It used to take
// requireAuth only, so any signed-in user could rewrite them for everyone.
router.put('/agent-search/defaults', requireAuth, validate({ body: SearchDefaultsBody }), async (req, res) => {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    try {
        const { mode, include_citations, web, web_fast } = req.body;
        await configStore.setConfig('agent_search_defaults', {
            mode: ['web', 'web_fast', 'kb', 'auto'].includes(mode) ? mode : 'web',
            include_citations: include_citations !== false,
            web: {
                max_results: Math.min(Math.max(parseInt(web?.max_results) || 5, 1), 10),
                fetch_top_n: Math.min(Math.max(parseInt(web?.fetch_top_n) || 3, 1), 5),
                max_tokens_markdown: Math.min(Math.max(parseInt(web?.max_tokens_markdown) || 2000, 500), 5000),
                detail_level: ['basic', 'detailed', 'highly_detailed'].includes(web?.detail_level) ? web.detail_level : 'detailed',
            },
            web_fast: {
                max_results: Math.min(Math.max(parseInt(web_fast?.max_results) || 10, 1), 20),
                max_tokens_markdown: Math.min(Math.max(parseInt(web_fast?.max_tokens_markdown) || 1500, 500), 5000),
                detail_level: ['basic', 'detailed', 'highly_detailed'].includes(web_fast?.detail_level) ? web_fast.detail_level : 'detailed',
            },
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save Agent Search defaults' });
    }
});

// PUT /ai/n8n/config — save org's n8n URL + API key (org admin only)
router.put('/n8n/config', requireOrgAdminForN8n, validate({ body: N8nConfigBody }), async (req, res) => {
    const { n8nUrl, apiKey } = req.body;
    const orgId = req.orgId;

    if (n8nUrl !== undefined) {
        await configStore.setConfig(`n8n_url_org_${orgId}`, n8nUrl || null);
    }
    if (apiKey) {
        await configStore.setSecret(`n8n_api_key_org_${orgId}`, apiKey);
    }

    res.json({ success: true });
});

// GET /ai/n8n/workflows — live-fetch active webhook workflows from n8n
router.get('/n8n/workflows', requireOrgAdminForN8n, async (req, res) => {
    const orgId = req.orgId;
    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

    if (!n8nUrl || !apiKey) {
        return res.status(400).json({ error: 'n8n URL and API key must be configured first' });
    }

    const workflows = await listActiveWebhookWorkflows(n8nUrl, apiKey);
    res.json({ workflows });
});

// PUT /ai/n8n/workflows — save selected workflows + input/output config (org admin only)
router.put('/n8n/workflows', requireOrgAdminForN8n, validate({ body: N8nWorkflowsBody }), async (req, res) => {
    const { workflows } = req.body;
    const orgId = req.orgId;

    await configStore.setConfig(`n8n_workflows_org_${orgId}`, workflows || []);
    res.json({ success: true });
});

// GET /ai/n8n/workflow/:workflowId — fetch a single workflow's full definition from n8n
router.get('/n8n/workflow/:workflowId', requireOrgAdminForN8n, async (req, res) => {
    const orgId = req.orgId;
    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

    if (!n8nUrl || !apiKey) {
        return res.status(400).json({ error: 'n8n URL and API key must be configured first' });
    }

    const workflow = await fetchWorkflowById(n8nUrl, apiKey, req.params.workflowId);
    res.json({ workflow });
});

// POST /ai/n8n/test — verify that the stored creds can reach n8n and count workflows.
// Accepts optional { n8nUrl, apiKey } to test unsaved values from the config form.
router.post('/n8n/test', requireOrgAdminForN8n, validate({ body: N8nConfigBody }), async (req, res) => {
    const { n8nFetch } = require('../../../integrations/n8nHttp');
    try {
        const orgId = req.orgId;
        const n8nUrl = (req.body?.n8nUrl) || (await configStore.getConfig(`n8n_url_org_${orgId}`));
        const apiKey = (req.body?.apiKey) || (await configStore.getSecret(`n8n_api_key_org_${orgId}`));

        if (!n8nUrl || !apiKey) {
            return res.status(400).json({ ok: false, error: 'URL and API key required' });
        }
        const base = n8nUrl.replace(/\/+$/, '');
        const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;
        // Certificate policy lives in integrations/n8nHttp.js. This route used to
        // disable verification unconditionally, which made the "Test connection"
        // button the one place that would talk to any certificate at all.

        const r = await n8nFetch(`${apiBase}/workflows?limit=1`, {
            headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            return res.json({ ok: false, status: r.status, error: text.slice(0, 200) || `HTTP ${r.status}` });
        }
        // Optional workflow count (active webhooks) — cheap, same endpoint with active=true
        let activeWebhookCount = null;
        try {
            const r2 = await n8nFetch(`${apiBase}/workflows?active=true&limit=250`, {
                headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(10000),
            });
            if (r2.ok) {
                const data = await r2.json();
                const arr = data.data || data;
                activeWebhookCount = Array.isArray(arr) ? arr.length : null;
            }
        } catch (_) { /* non-fatal */ }

        res.json({ ok: true, activeWebhookCount });
    } catch (err) {
        res.json({ ok: false, error: err.message });
    }
});

const N8N_PERMISSION_IDS = ['use_n8n_tools', 'modify_n8n_workflows'];

// GET /ai/n8n/diagnostics — self-service access check for the current user.
// Returns the full trace of how n8n tool injection would go: which of the three
// gates (user-level, org-level, permission) pass or fail, plus the concrete
// list of tools the LLM will see. Any authenticated user can call this for
// themselves — it only exposes their own state.
router.get('/n8n/diagnostics', requireAuth, async (req, res) => {
    const userStore = require('../../../stores/userStore');
    const { getIntegrationTools } = require('../../../core/integrations/integrationTools');
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const user = await userStore.getUser(userId);
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const rawOrgId = user?.organizationId || null;
    const organizationId = rawOrgId || (isSuperAdmin ? '__system__' : null);

    // 1. n8n configured for the user's org?
    let n8nConfigured = false;
    if (organizationId) {
        const url = await configStore.getConfig(`n8n_url_org_${organizationId}`);
        const key = await configStore.getSecret(`n8n_api_key_org_${organizationId}`);
        n8nConfigured = !!(url && key);
    }

    // 2. Org-level integration gating.
    let orgEnabledIntegrations = null;
    let orgGateSource = 'all_enabled';
    if (rawOrgId) {
        const org = await userStore.getOrganization(rawOrgId);
        if (org?.enabledIntegrations) {
            orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            orgGateSource = 'org_override';
        } else {
            const globalDefaults = await configStore.getConfig('default_org_integrations');
            if (globalDefaults) {
                orgEnabledIntegrations = typeof globalDefaults === 'string'
                    ? JSON.parse(globalDefaults) : globalDefaults;
                orgGateSource = 'global_default';
            }
        }
    }
    const orgGatePasses = !orgEnabledIntegrations || orgEnabledIntegrations.includes('n8n');

    // 3. User-level integration gating.
    const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);
    let userGateReason, userGatePasses;
    if (!userEnabledApps) {
        userGateReason = 'no_saved_list'; userGatePasses = true;
    } else if (userEnabledApps.includes('n8n')) {
        userGateReason = 'in_saved_list'; userGatePasses = true;
    } else {
        // 'n8n' is in AUTO_ENABLED_APPS so this is true for legacy users with
        // stale lists. Explicitly signal that in the reason.
        userGateReason = 'auto_enabled'; userGatePasses = true;
    }

    // 4. Permission state.
    const { hasPermission } = require('../../../auth/permissions');
    const canModify = await hasPermission(userId, 'modify_n8n_workflows', req.session);
    const canUseExplicit = await hasPermission(userId, 'use_n8n_tools', req.session);

    // 5. The real list — ask the registration pipeline what it would hand the LLM.
    let toolsThatWillBeInjected = [];
    try {
        const { tools } = await getIntegrationTools({
            userId, session: req.session, isAdmin: !!req.session.isAdmin, agentConfig: null,
        });
        toolsThatWillBeInjected = (tools || [])
            .map(t => t.function?.name)
            .filter(n => n && (n.startsWith('n8n_workflow_') || n.startsWith('n8n_execution_') || n.startsWith('n8n_run_')));
    } catch (_) { /* non-fatal — if integrationTools throws we still return the gate trace */ }

    const blockingReason =
        !organizationId ? 'no_organization' :
        !n8nConfigured ? 'n8n_not_configured' :
        !orgGatePasses ? 'org_disabled' :
        !userGatePasses ? 'user_disabled' :
        toolsThatWillBeInjected.length === 0 ? 'unknown' :
        null;

    res.json({
        ok: !blockingReason,
        blockingReason,
        user: {
            id: user?.id,
            orgRole: user?.orgRole || null,
            organizationId,
        },
        org: {
            id: organizationId,
            n8nConfigured,
            enabledIntegrationsIncludesN8n: orgGatePasses,
            source: orgGateSource,
        },
        userLevel: {
            passes: userGatePasses,
            reason: userGateReason,
            savedList: userEnabledApps || null,
        },
        permissions: {
            modify_n8n_workflows: canModify,
            use_n8n_tools: canUseExplicit, // informational — now implicit
        },
        toolsThatWillBeInjected,
    });
});

// POST /ai/n8n/enable-for-org — one-click convenience: ensure 'n8n' is in the
// organisation's enabledIntegrations list. Idempotent — safe to call repeatedly.
// Nothing else is needed: use_n8n_tools is now implicit for all members.
router.post('/n8n/enable-for-org', requireOrgAdminForN8n, async (req, res) => {
    const userStore = require('../../../stores/userStore');
    const orgId = req.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organisation' });

    const org = await userStore.getOrganization(orgId);
    let current = org?.enabledIntegrations;
    if (typeof current === 'string') {
        try { current = JSON.parse(current); } catch (_) { current = null; }
    }
    // If the org has never customised its enabledIntegrations, null means
    // "all enabled" — n8n is already implicit. Leave it alone to preserve
    // that semantics.
    if (!current) {
        return res.json({ success: true, changed: false, enabledIntegrations: null, note: 'Organisation uses the default integration set; n8n is already enabled.' });
    }
    if (current.includes('n8n')) {
        return res.json({ success: true, changed: false, enabledIntegrations: current });
    }
    const next = [...current, 'n8n'];
    await userStore.updateOrganization(orgId, { enabledIntegrations: next });
    res.json({ success: true, changed: true, enabledIntegrations: next });
});

// Count how many users are actually members of each group right now. `groups.userCount`
// is a stale denormalised column (never updated when users move between groups), so we
// recompute it live for anything the admin UI displays.
async function computeGroupUserCounts(groupIds, orgId) {
    const userStore = require('../../../stores/userStore');
    const allUsers = await userStore.getAllUsers();
    // Users: filter to the caller's org so super-admins don't see cross-org counts.
    // If orgId is null (super-admin without an org), fall back to counting everyone.
    const scoped = orgId
        ? allUsers.filter(u => !u.organizationId || u.organizationId === orgId)
        : allUsers;
    const counts = Object.fromEntries(groupIds.map(id => [id, 0]));
    for (const u of scoped) {
        let ug = u.groups;
        if (typeof ug === 'string') { try { ug = JSON.parse(ug); } catch (_) { ug = []; } }
        if (!Array.isArray(ug)) continue;
        for (const gid of ug) if (gid in counts) counts[gid]++;
    }
    return counts;
}

// GET /ai/n8n/permissions — return which groups hold each n8n permission, plus the list
// of all groups the admin can grant TO (org-scoped only; global groups are deliberately
// excluded from the picker to avoid cross-org leaks).
router.get('/n8n/permissions', requireOrgAdminForN8n, async (req, res) => {
    const orgId = req.orgId;
    const userStore = require('../../../stores/userStore');
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const allGroups = await userStore.getAllGroups();

    // Org-scope rule:
    //   - Org admins see + manage groups where organizationId === their own org.
    //   - Super admins additionally see global groups (null organizationId) since
    //     they're the only ones allowed to touch those.
    const visibleGroups = (allGroups || []).filter(g =>
        g.organizationId === orgId || (isSuperAdmin && !g.organizationId)
    );

    const counts = await computeGroupUserCounts(visibleGroups.map(g => g.id), orgId);
    const holdingGroups = (permId) => visibleGroups
        .filter(g => Array.isArray(g.permissions) && g.permissions.includes(permId))
        .map(g => ({ id: g.id, name: g.name, userCount: counts[g.id] ?? 0 }));

    res.json({
        use_n8n_tools: holdingGroups('use_n8n_tools'),
        modify_n8n_workflows: holdingGroups('modify_n8n_workflows'),
        availableGroups: visibleGroups.map(g => ({
            id: g.id,
            name: g.name,
            userCount: counts[g.id] ?? 0,
            isGlobal: !g.organizationId,
        })),
        // Org admins always have both permissions regardless of group membership.
        // Enforced in permissions.js via orgRoles.json → org_admin perms, with
        // legacy orgRole='admin' normalised to 'org_admin' at resolution time.
        orgAdminAlways: true,
        editUrl: '/settings/organisation/users',
    });
});

// PUT /ai/n8n/permissions — grant or revoke an n8n permission for a specific group.
// Body: { permission: 'use_n8n_tools' | 'modify_n8n_workflows', groupId, action: 'add' | 'remove' }
router.put('/n8n/permissions', requireOrgAdminForN8n, validate({ body: N8nPermissionBody }), async (req, res) => {
    const { permission, groupId, action } = req.body || {};
    if (!N8N_PERMISSION_IDS.includes(permission)) {
        return res.status(400).json({ error: `permission must be one of: ${N8N_PERMISSION_IDS.join(', ')}` });
    }
    if (!groupId) return res.status(400).json({ error: 'groupId is required' });
    if (!['add', 'remove'].includes(action)) {
        return res.status(400).json({ error: "action must be 'add' or 'remove'" });
    }

    const userStore = require('../../../stores/userStore');
    const { invalidateAllPermissionCaches } = require('../../../auth/permissions');
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const allGroups = await userStore.getAllGroups();
    const group = (allGroups || []).find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Org-scope guard. A group with no organizationId is GLOBAL — granting a
    // permission to it would grant that permission to users in OTHER orgs too,
    // which an org admin must never be able to do. Only super-admins may edit
    // global groups.
    const orgId = req.orgId;
    if (!group.organizationId) {
        if (!isSuperAdmin) {
            return res.status(403).json({
                error: 'This is a global group shared across organisations. Only a system administrator can change its permissions.',
            });
        }
    } else if (group.organizationId !== orgId) {
        return res.status(403).json({ error: 'Cannot modify groups in another organisation' });
    }

    const current = Array.isArray(group.permissions) ? [...group.permissions] : [];
    let next;
    if (action === 'add') {
        next = current.includes(permission) ? current : [...current, permission];
    } else {
        next = current.filter(p => p !== permission);
    }

    await userStore.updateGroup(groupId, { permissions: next });
    // Cached permission sets must be invalidated so the new grant takes effect immediately.
    // Without Redis, this clears the in-process Map; WITH Redis it also wipes keys for
    // every logged-in user in the fleet.
    await invalidateAllPermissionCaches();

    res.json({ success: true, groupId, permission, action, permissions: next });
});

// ─── MCP Server Management ──────────────────────────────────────

const mcpManager = require('../../../core/mcpManager');
const crypto = require('crypto');

// MCP Server Marketplace is an Enterprise feature (it was moved out of the
// Community licence — see server/license/tiers.js). Gate every /mcp-servers*
// route below with the licence middleware. Community sessions get a 403
// `feature_locked`; super-admins bypass via the resolver's super-admin path.
//
// ── AND THE WRITE ROUTES CARRY AN ADMIN GATE ────────────────────────
// The comments on these routes said "(admin)" long before any of them checked.
// requireAuth plus a licence feature is not an admin gate: on an Enterprise
// licence that is every signed-in user, and on self-hosted the licence is the
// installation's, not the person's.
//
// What a definition here can do is why it matters. core/mcpManager.js spawns a
// stdio server as a child process, and an `npx`-based command is a package
// downloaded and executed at that moment. Defining one is therefore closer to
// "run this program on the server" than to "save a setting", and the write
// routes are now gated accordingly. Reading the list stays on the licence gate:
// seeing which servers exist is what the picker needs.
//
// requireSuperAdmin, not requireAdmin: an MCP definition is instance-wide, not
// org-scoped, so an org admin in one tenant would otherwise be configuring code
// execution for every tenant on the box.
//
// Defined ONCE here, immediately above the routes that reference it — do NOT
// redeclare `requireMcp` elsewhere. The crash this fixes was the routes using
// `requireMcp` while its definition/import were never added (a half-applied
// edit), which aborts module load with `ReferenceError: requireMcp is not
// defined` and crash-loops the whole server.
const { requireFeature } = require('../../../license/middleware');
const requireMcp = requireFeature('mcp_marketplace');

// GET /ai/mcp-servers — list all configured MCP servers (admin)
router.get('/mcp-servers', requireAuth, requireMcp, async (req, res) => {
    const servers = await mcpManager.getServersSummary();
    res.json({ servers });
});

// POST /ai/mcp-servers — add a new MCP server definition (admin)
router.post('/mcp-servers', requireAuth, requireSuperAdmin, requireMcp, validate({ body: McpServerBody }), async (req, res) => {
    const { name, command, args = [], required_credentials = [], transport = 'stdio', url, category, description, icon, source = 'manual' } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'name is required' });
    }
    if (transport === 'stdio' && !command) {
        return res.status(400).json({ error: 'command is required for stdio servers' });
    }
    if (transport === 'http' && !url) {
        return res.status(400).json({ error: 'url is required for HTTP servers' });
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || crypto.randomUUID().slice(0, 8);
    const server = await mcpManager.addServer({ id, name, command, args, required_credentials, transport, url, category, description, icon, source });
    res.json({ success: true, server });
});

// POST /ai/mcp-servers/test — test an MCP server command
router.post('/mcp-servers/test', requireAuth, requireSuperAdmin, requireMcp, validate({ body: McpTestBody }), async (req, res) => {
    const { command, args = [], transport = 'stdio', url } = req.body;
    if (transport === 'stdio' && !command) return res.status(400).json({ error: 'command is required for stdio' });
    if (transport === 'http' && !url) return res.status(400).json({ error: 'url is required for HTTP' });
    const result = await mcpManager.testCommand(command, args, {}, transport, url);
    res.json(result);
});

// PUT /ai/mcp-servers/:id — update an MCP server config (admin)
router.put('/mcp-servers/:id', requireAuth, requireSuperAdmin, requireMcp, validate({ body: McpUpdateBody }), async (req, res) => {
    const { id } = req.params;
    const { name, command, args, required_credentials, enabled, transport, url, category, description, icon } = req.body;
    const mcpStore = require('../../../stores/mcpStore');
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (command !== undefined) updates.command = command;
    if (args !== undefined) updates.args = args;
    if (required_credentials !== undefined) updates.required_credentials = required_credentials;
    if (enabled !== undefined) updates.enabled = enabled;
    if (transport !== undefined) updates.transport = transport;
    if (url !== undefined) updates.url = url;
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (icon !== undefined) updates.icon = icon;
    await mcpStore.updateServer(id, updates);
    res.json({ success: true });
});

// DELETE /ai/mcp-servers/:id — remove an MCP server (admin)
router.delete('/mcp-servers/:id', requireAuth, requireSuperAdmin, requireMcp, async (req, res) => {
    const { id } = req.params;
    await mcpManager.removeServer(id);
    res.json({ success: true });
});

// POST /ai/mcp-servers/:id/refresh — re-discover tools from a server
router.post('/mcp-servers/:id/refresh', requireAuth, requireSuperAdmin, requireMcp, async (req, res) => {
    const { id } = req.params;
    const tools = await mcpManager.refreshServerTools(id);
    res.json({ success: true, tools });
});

// GET /ai/mcp-servers/user-credentials — get MCP servers needing user credentials
router.get('/mcp-servers/user-credentials', requireAuth, requireMcp, async (req, res) => {
    const userId = req.session.user.id;
    const servers = await mcpManager.getServersForUser(userId);
    res.json({ servers });
});

// POST /ai/mcp-servers/user-credentials — save a user's credential for an MCP server
//
// NOT admin-gated, and that is the right call: this writes the CALLER'S OWN
// credential for a server an admin already defined (`req.session.user.id` is the
// only subject it can touch). The admin gate above is about who may define what
// gets executed; this is about who may supply their own key to it.
router.post('/mcp-servers/user-credentials', requireAuth, requireMcp, validate({ body: McpCredentialBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { serverId, credKey, value } = req.body;
    if (!serverId || !credKey) {
        return res.status(400).json({ error: 'serverId and credKey are required' });
    }
    await mcpManager.saveUserCredential(userId, serverId, credKey, value);
    res.json({ success: true });
});

// ─── Live MCP Registry browse ───────────────────────────────────────
// Proxies the OFFICIAL, open MCP registry (registry.modelcontextprotocol.io)
// so the marketplace's "Browse all" tab can surface thousands of servers with
// no API key and no third-party SaaS dependency. Results are mapped to our
// install shape server-side and cached briefly to spare the upstream.
const mcpRegistry = require('../../../integrations/mcpRegistryClient');
const { createTtlCache } = require('../../../utils/ttlCache');
const mcpRegistryCache = createTtlCache({ ttlMs: 5 * 60 * 1000, max: 200 });

// GET /ai/mcp-registry/search?q=&cursor=&verifiedOnly=1
router.get('/mcp-registry/search', requireAuth, requireMcp, validate({ query: RegistryQuery }), async (req, res) => {
    try {
        const q = (req.query.q || '').toString().slice(0, 200).trim();
        const cursor = (req.query.cursor || '').toString();
        // Default to verified-only (active + latest) as a supply-chain guardrail.
        const verifiedOnly = req.query.verifiedOnly !== '0' && req.query.verifiedOnly !== 'false';

        const cacheKey = `official|${verifiedOnly ? 'v' : 'all'}|${q}|${cursor}`;
        const cached = mcpRegistryCache.get(cacheKey);
        if (cached) return res.json(cached);

        const { servers, nextCursor } = await mcpRegistry.searchOfficial({ q, cursor });
        const mapped = servers
            .filter(e => !verifiedOnly || mcpRegistry.isActiveLatest(e))
            .map(e => mcpRegistry.registryEntryToInstallConfig(e))
            .filter(Boolean);

        const payload = { servers: mapped, nextCursor, source: 'official' };
        mcpRegistryCache.set(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        log.error('[MCP] Registry search error:', err);
        res.status(502).json({ error: 'mcp_registry_unavailable', detail: err.message });
    }
});

module.exports = router;

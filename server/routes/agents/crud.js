const express = require('express');
const agentStore = require('../../stores/agentStore');
require('../../core/agentRuntime');
require('../../core/aiAgent');
const { normalizeTierModel } = require('../../core/llm/modelResolver');
require('../../stores/configStore');
const { requirePermission, OrgRoles, SystemRoles, requireActiveOrgForMutations } = require('../../auth');
require('../../stores/memoryStore');
const { resolveUserOrgIds, canSeePublished, resolveUserGroups, assertUserCanUseOrg, validateSharedGroupsForOrg } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');

const userStore = require('../../stores/userStore');
require('../../stores/usageStore');
const { checkResourceLimits } = require('../../core/entitlements/limits');
require('../../core/http/sseHelpers');
// Pure, and deliberately not reached through the store facade: the delete
// refusal must redact with the same function the Used-by tab does, and a
// faked facade must not be able to switch that off. See ./usage.js.
const { redactForeign } = require('../../stores/agent/agentUsage');
const { assertAgentToolsWrite, managedPayloadOfAgent } = require('../../stores/agent/agentCrud');

const { validate } = require('../../core/http/validate');
const { makeAgentAccess } = require('../../agents/agentAccess');

const router = express.Router();

// The request schemas live in ./crudSchemas.js, the persona write in
// ./agentPersonaWrite.js and the agent save (PUT /:id) in ./agentUpdate.js.
const { CategoryBody, CategoryPatch, DeleteCategoryQuery, TransferBody, ToolParamsBody, AgentUpdateBody } = require('./crudSchemas');
const { verifyHandoffAutomation, resolvePersonaWrite } = require('./agentPersonaWrite');
const { makeUpdateAgentHandler } = require('./agentUpdate');

// Block all writes when the caller's org is suspended/archived. Reads are
// unaffected so customers can still export their data. Super-admins exempt.
router.use(requireActiveOrgForMutations());

// ============ Agent CRUD ============

// List all agents for current user
router.get('/', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agents = await agentStore.getAgents(userId);
    res.json(agents);
});

// ============ Agent Categories ============

// List categories for user's org
router.get('/categories', async (req, res) => {
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const categories = await agentStore.getAgentCategories(orgId);
    res.json(categories);
});

// BFSF-272: category mutations are org-scoped. resolveUserOrgIds returns null
// only for super-admins (skip the check); org categories require membership;
// org-less (global) categories are manageable only by org-less requesters —
// mirrors who can create them.
async function canManageCategory(req, category) {
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds === null) return true; // super-admin
    if (category.organization_id) return orgIds.has(category.organization_id);
    return orgIds.size === 0;
}

// Create a new category. Idempotent on a case-insensitive duplicate: returns
// the EXISTING row with `existing: true` so clients select it instead of
// stacking "Sales" next to "sales" (BFSF-272).
router.post('/categories', requirePermission('manage_agents'), validate({ body: CategoryBody }), async (req, res) => {
    const { name, icon, color } = req.body;
    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds !== null && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const existing = await agentStore.findAgentCategoryByName(orgId, name);
    if (existing) return res.json({ ...existing, existing: true });
    const category = await agentStore.createAgentCategory(orgId, name, icon, color);
    res.json(category);
});

// Rename/update a category (BFSF-272 — there was no way to fix a typo'd
// category short of raw SQL). Duplicate names 409 with the conflicting row so
// the client can offer a merge instead.
router.patch('/categories/:id', requirePermission('manage_agents'), validate({ body: CategoryPatch }), async (req, res) => {
    const category = await agentStore.getAgentCategory(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (!(await canManageCategory(req, category))) {
        return res.status(404).json({ error: 'Category not found' }); // don't leak cross-org ids
    }
    const { name, icon, color } = req.body;
    if (name !== undefined && name.toLowerCase() !== category.name.toLowerCase()) {
        const clash = await agentStore.findAgentCategoryByName(category.organization_id, name);
        if (clash && clash.id !== category.id) {
            return res.status(409).json({ error: `A category named "${clash.name}" already exists`, code: 'name_taken', conflict: clash });
        }
    }
    const updated = await agentStore.updateAgentCategory(req.params.id, { name, icon, color });
    res.json(updated);
});

// Delete a category. Without a `reassignTo` query param, an in-use category
// 409s with the live count so the UI can offer the guided flow:
//   ?reassignTo=none   → uncategorise its agents, then delete
//   ?reassignTo=<id>   → move its agents to another category (= merge), then delete
router.delete('/categories/:id', requirePermission('manage_agents'), validate({ query: DeleteCategoryQuery }), async (req, res) => {
    const category = await agentStore.getAgentCategory(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (!(await canManageCategory(req, category))) {
        return res.status(404).json({ error: 'Category not found' });
    }

    const reassignTo = req.query.reassignTo;
    let reassigned = 0;
    if (reassignTo === 'none') {
        reassigned = await agentStore.reassignAgentsCategory(req.params.id, null);
    } else if (reassignTo) {
        const target = await agentStore.getAgentCategory(reassignTo);
        // Merge target must exist in the SAME org bucket — moving agents'
        // category across orgs would leak org structure.
        if (!target || (target.organization_id || null) !== (category.organization_id || null)) {
            return res.status(400).json({ error: 'Invalid reassign target' });
        }
        if (target.id === category.id) return res.status(400).json({ error: 'Cannot reassign a category to itself' });
        reassigned = await agentStore.reassignAgentsCategory(req.params.id, target.id);
    } else {
        const inUse = await agentStore.countAgentsInCategory(req.params.id);
        if (inUse > 0) {
            return res.status(409).json({ error: `Category in use by ${inUse} agent(s)`, code: 'category_in_use', count: inUse });
        }
    }

    const deleted = await agentStore.deleteAgentCategory(
        req.params.id,
        // Super-admins delete unscoped; everyone else re-scopes at the
        // store layer too (defense in depth on top of canManageCategory).
        (await resolveUserOrgIds(req)) === null ? undefined : (category.organization_id || null)
    );
    if (!deleted) return res.status(404).json({ error: 'Category not found' });
    res.json({ success: true, reassigned });
});

// Visibility gate — a user can read an agent only if they own it, it's a
// system/swarm agent, or `canSeePublished` accepts them given the agent's
// org + shared_groups. Without this gate any authenticated user could fetch
// any other user's drafts including the system_prompt, KB ids, and tool
// params (which often hold API keys / customer-specific config).
async function canReadAgent(agent, userId, req) {
    if (!agent) return false;
    if (agent.owner_id === userId) return true;
    if (agent.owner_id === 'system' || agent.owner_id === 'swarm') return true;
    const orgIds = await resolveUserOrgIds(req).catch(() => new Set());
    const userGroups = await resolveUserGroups(userId);
    return canSeePublished(agent, { userId, orgIds, userGroups });
}

// Concept/live projection (A1). Default = what runs (published_* once the
// agent has a published version, the concept otherwise) — mobile reads the
// profile and chats from this one endpoint, so both must agree. An editor
// asks for the concept with `?draft=1`; anyone else asking gets the runtime
// projection (never 403: a draft is not a different resource, it is a view
// only editors have). Shape is unchanged; `runtimeSource`, and for editors
// `unpublishedChanges` (= rev - published_rev, 0 until the first
// publish-version), are additive.
router.get('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);
    // Both views from ONE load: the access decision and `unpublishedChanges`
    // read the concept row, the body is the projection — and they must
    // describe the same snapshot.
    const views = await agentStore.getAgentViews(req.params.id);
    if (!views) return res.status(404).json({ error: 'Agent not found' });
    const agent = views.draft;
    if (!(await canReadAgent(agent, userId, req))) {
        return res.status(404).json({ error: 'Agent not found' });
    }
    // `can_edit` lets the client render read-only editors from the same
    // policy the server enforces (BFSF-271) instead of a local heuristic.
    const canEdit = await canModifyAgent(agent, userId, req);
    const wantsDraft = req.query?.draft === '1' || req.query?.draft === 'true';
    const publishedVersion = Number(agent.published_version) || 0;
    const unpublishedChanges = publishedVersion > 0
        ? Math.max(0, (Number(agent.rev) || 1) - (Number(agent.published_rev) || 0))
        : 0;
    // The Solution stage that manages this agent, or null (design 5.3): the
    // editor shows a managed agent read-only and says where to change it.
    const managed = await managedPayloadOfAgent(agent);
    // Chat signals: is this agent's chat counted for THIS caller, and from
    // when ({ state, from }; no ids). The chat shows its notice from this.
    const complianceCounting = await complianceCountingFor(agent, req);
    if (wantsDraft && canEdit) {
        return res.json({ ...agent, can_edit: true, runtimeSource: 'draft', unpublishedChanges, managed, complianceCounting });
    }
    const body = { ...views.runtime, can_edit: canEdit, managed };
    if (canEdit) body.unpublishedChanges = unpublishedChanges;
    body.complianceCounting = complianceCounting;
    res.json(body);
});

/**
 * The three-state chat-signals gate of GET /agents/:id (core/privacy/
 * chatSignalsNotice.agentCounting): not off only when the agent's org counts
 * agent chat (scheduled or on) AND the caller's org is that org, the same rule
 * the recorder applies to the turn (chatSignals.agentTurnTarget, the caller's
 * org being the first of resolveUserOrgIds as in routes/agents/chat.js). A
 * super admin (no caller org), another org's member and an agent without an
 * org read off. Never throws.
 */
async function complianceCountingFor(agent, req) {
    const notice = require('../../core/privacy/chatSignalsNotice');
    const agentOrgId = typeof agent?.organization_id === 'string' && agent.organization_id ? agent.organization_id : null;
    if (!agentOrgId) return notice.COUNTING_OFF;
    try {
        const mon = await require('../../core/entitlements/chatMonitoringFlag').resolveChatMonitoring(agentOrgId);
        if (!notice.announcesSurface(mon, 'agent')) return notice.COUNTING_OFF;
        const orgIds = await resolveUserOrgIds(req);
        const callerOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        return notice.agentCounting(mon, { callerOrgId, agentOrgId });
    } catch (_) {
        return notice.COUNTING_OFF;
    }
}

// Delete agent - owner can delete own; others need manage_agents within the
// agent's org (enforced by canModifyAgent, which owners short-circuit).
router.delete('/:id', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await canModifyAgent(agent, userId, req))) {
        return sendAgentNotEditable(res);
    }

    /**
     * ── WHAT BREAKS, BEFORE IT BREAKS (A1c) ─────────────────────
     * Deleting an agent is not a local act. Scheduled tasks and Cowork
     * schedules bound to it start failing on their next run
     * ("Linked agent no longer exists"), a support inbox stops drafting
     * replies, and — once R2/P/W3 land — an automation step, an app block
     * and a webpage bridge lose what they call. None of those failures
     * names this agent. So the first DELETE answers 409 with the list,
     * and only a second one carrying `?confirm=1` proceeds. Same shape
     * as the knowledge-base danger zone, which is where the decision
     * actually gets made.
     *
     * Three things count as "in use", and the last two are the ones a
     * reassuring implementation would have got wrong:
     *   • a consumer row — the obvious half;
     *   • anything the scan could NOT check (`unchecked`). A table this
     *     install has not got, or a query that threw, is not the same
     *     statement as "nothing uses this", and this is the one moment
     *     where guessing wrong is unrecoverable;
     *   • conversations belonging to somebody else. They cascade away
     *     with the agent, so on a published agent this delete destroys
     *     colleagues' history. `chat === null` means the count could not
     *     be read — unknown, so it blocks (and rides in `unchecked`).
     * The asker's own conversations do NOT block: throwing away your own
     * draft agent stays one click.
     *
     * What is NOT done here is scrubbing the references afterwards.
     * `ai_tasks.agent_id = NULL` does not disable a task — it turns an
     * agent schedule back into a legacy prompt task that runs an inline
     * LLM loop WITHOUT the agent's knowledge, tools or guardrails. A
     * loud failure is the safer half of that pair.
     */
    // `?.` on purpose: an absent query object must read as NOT confirmed.
    const confirmed = req.query?.confirm === '1' || req.query?.confirm === 'true';
    if (!confirmed) {
        const { gatherUsage } = require('./usage');
        const { rows, counts, chat, unchecked, audience } = await gatherUsage(agent, userId);
        const othersHistory = chat === null || chat.othersConversationCount > 0;
        if (rows.length > 0 || unchecked.length > 0 || othersHistory) {
            return res.status(409).json({
                error: 'This agent is still in use',
                code: 'in_use',
                usage: redactForeign(rows, userId),
                counts,
                chat,
                audience,
                // Named so the dialog can say "and I could not check
                // apps" rather than presenting an incomplete list as a
                // complete one.
                unchecked,
            });
        }
    }

    const deleted = await agentStore.forceDeleteAgent(req.params.id);
    if (deleted) {
        res.json({ success: true });
    } else {
        throw new Error('Failed to delete agent');
    }
});

// Create new agent - requires manage_agents permission.
//
// NO zod schema on this body yet. PUT /:id has one (AgentUpdateBody above):
// it keeps `config` and `persona` open one level down — rejectUnsafeConfigKeys
// below says why an allow-list of config keys is not maintainable — and names
// `organizationId` and `sharedGroups` as accepted and not read, so a client
// that sends them is not refused. This body reads `organizationId` and
// `sharedGroups`, and its three settings read `!== false` / `=== true`, so a
// create with `workspaceEnabled: 1` (what the legacy designers send) is born
// without a workspace; a schema here would coerce that the way PUT does.
router.post('/', requirePermission('manage_agents'), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { name, description, systemPrompt, tools, model: rawModel, starterPrompts, threadsEnabled, copyEnabled, workspaceEnabled, config, organizationId, sharedGroups, categoryId, persona } = req.body;
    // Rewrite legacy tier aliases (e.g. `tier:smart` → `tier:thinking`) so we
    // never persist a tier the selector/permission gate can't represent.
    const model = normalizeTierModel(rawModel);

    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }

    {
        const e = rejectUnsafeConfigKeys(config) || rejectUnsafeConfigKeys(persona);
        if (e) return res.status(400).json({ error: e });
    }

    // Validate that the user actually belongs to the requested organisation
    // (or auto-assign their primary org when none was provided). Trusting
    // organizationId from the body would let any member create agents in
    // other orgs.
    let assignOrgId;
    try {
        assignOrgId = await assertUserCanUseOrg(req, organizationId);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }

    // Strip any shared_groups that don't belong to the agent's org. Empty/
    // unset on create is fine — publish endpoint is the canonical write path.
    let cleanedSharedGroups;
    try {
        cleanedSharedGroups = await validateSharedGroupsForOrg(assignOrgId, sharedGroups);
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }

    // Check agent count limit
    if (assignOrgId) {
        const allAgents = await agentStore.getAllAgents();
        const orgAgentCount = allAgents.filter(a => a.organization_id === assignOrgId).length;
        const limitErr = await checkResourceLimits(assignOrgId, 'agents', orgAgentCount);
        if (limitErr) {
            // Structured so the client can show a clear limit-reached warning
            // with an upgrade CTA instead of a generic save error.
            return res.status(403).json({ error: limitErr, code: 'limit_reached', resource: 'agents' });
        }
    }

    // Persona (A1c). Same resolution as PUT — the hand-off automation is checked
    // against the OWNER, which on create is the requester — so a new agent can
    // never be born with a grant or a prompt line pointing at someone else's
    // automation.
    //
    // Create does not run `validateAgentConfigReferences` (it never has), so
    // the grant a persona can add here is not clamped on the way in. It does
    // not need to be: the only value this path writes is `{confirm:'ask'}` for
    // an id that was just verified, which is exactly what the normaliser would
    // produce — and `getForRuntime` re-clamps the map on every read anyway.
    let personaToSave;
    let personaSystemPrompt = null;
    let configToCreate = config;
    const createWarnings = [];
    if (persona !== undefined && persona !== null) {
        const resolved = await resolvePersonaWrite(
            { id: null, owner_id: userId, organization_id: assignOrgId || null, config: config || {} },
            persona,
            configToCreate,
        );
        personaToSave = resolved.persona;
        personaSystemPrompt = resolved.systemPrompt;
        configToCreate = resolved.config;
        createWarnings.push(...resolved.warnings);
    }

    const agent = await agentStore.createAgent(
        name,
        description,
        personaSystemPrompt !== null ? personaSystemPrompt : systemPrompt,
        userId,
        model,
        starterPrompts || [],
        threadsEnabled !== false,
        copyEnabled !== false,
        workspaceEnabled === true,
        configToCreate || {},
        assignOrgId || null,
        cleanedSharedGroups || [],
        categoryId || null,
        { persona: personaToSave }
    );

    // Set tools if provided
    if (tools && Array.isArray(tools)) {
        await agentStore.setAgentTools(agent.id, tools);
        agent.tools = tools;
    }

    res.json(createWarnings.length > 0 ? { ...agent, warnings: createWarnings } : agent);
});

// Reject prototype-polluting keys at the route boundary. The config object
// gets spread into the stored agent record; allowing __proto__/constructor/
// prototype keys would let a malicious client tamper with Object.prototype on
// stores that JSON.parse + spread without freezing first. Whitelisting all
// "valid" config keys is brittle (new flags are added frequently); rejecting
// the dangerous ones is the minimum bar.
const _FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function rejectUnsafeConfigKeys(config) {
    if (!config || typeof config !== 'object') return null;
    const stack = [config];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        for (const key of Object.keys(node)) {
            if (_FORBIDDEN_CONFIG_KEYS.has(key)) return `forbidden config key: ${key}`;
            const v = node[key];
            if (v && typeof v === 'object') stack.push(v);
        }
    }
    return null;
}

// The anti-leak validation of an agent config's cross-element references, and
// the fold of its verdict into the config that is written, live in
// agents/publishableConfig.js (the deploy engine publishes through them too).
// The stores are handed in from HERE, required at call time, so this router
// and its tests resolve them exactly as they did when the code lived in this
// file.
const publishable = require('../../agents/publishableConfig');

function validateAgentConfigReferences(agent, config) {
    return publishable.validateAgentConfigReferences(agent, config, {
        kbStore: () => require('../../stores/knowledgeBases'),
        skillStore: () => require('../../stores/skillStore'),
    });
}


const { applyConfigValidation } = publishable;

// The edit gate (canModifyAgent) and its prefetch (buildCanModifyContext) live in
// agents/agentAccess.js, so code below routes/ (the automation bindings) asks the
// same question. This router builds its instance from ITS imports, which is what
// keeps the rules testable here (crud.authz.test.js is their contract).
const { buildCanModifyContext, canModifyAgent } = makeAgentAccess({
    hasPermission: (...args) => require('../../auth').hasPermission(...args),
    resolveUserOrgIds: (req) => resolveUserOrgIds(req),
    getUser: (id) => userStore.getUser(id),
    roles: () => ({ SystemRoles, OrgRoles }),
});

// Structured 403 body shared by the mutating endpoints so the client can
// translate the message and flip the editor into read-only mode.
function sendAgentNotEditable(res) {
    return res.status(403).json({
        error: 'You do not have permission to edit this agent.',
        code: 'agent_not_editable',
    });
}

// Update agent - requires manage_agents permission
router.put('/:id', requirePermission('manage_agents'), validate({ body: AgentUpdateBody }), makeUpdateAgentHandler({
    canModifyAgent, sendAgentNotEditable, rejectUnsafeConfigKeys,
    validateAgentConfigReferences, applyConfigValidation, resolveUserOrgIds,
}));

// Get tools with their fixed params — visibility-gated like GET /:id, since
// fixed tool params often hold credentials or customer-specific config.
router.get('/:id/tools', async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!(await canReadAgent(agent, userId, req))) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    const toolsWithParams = await agentStore.getAgentToolsWithParams(req.params.id);
    res.json(toolsWithParams);
});

// Update params for a specific tool. Tool params often hold API keys, so
// require manage_agents + the same canModifyAgent gate the other write
// endpoints use (covers org admins / agent editors, blocks read-only colleagues
// in the same org from rewriting credentials).
router.put('/:id/tools/:componentId/params', requirePermission('manage_agents'), validate({ body: ToolParamsBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!(await canModifyAgent(agent, userId, req))) {
        return sendAgentNotEditable(res);
    }

    const { params } = req.body;
    // The same managed-agent tools lock as PUT /:id: the list with this one
    // component's params replaced must equal what is stored.
    await assertAgentToolsWrite(agent, (current) => current.map((t) => (
        t.componentId === req.params.componentId ? { componentId: t.componentId, params: params || null } : t)));
    await agentStore.updateAgentToolParams(req.params.id, req.params.componentId, params);
    res.json({ success: true });
});

// Transfer ownership of an agent to another user in the same org. Allowed
// for the current owner, the agent's org_admin, or super-admin. The target
// must be a member of the agent's org — otherwise the agent would silently
// jump tenants. Records an access-audit row so the trail of "who owns
// what" is preserved across HR events.
router.put('/:id/transfer', requirePermission('manage_agents'), validate({ body: TransferBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const { newOwnerId } = req.body;

    // Authorisation: current owner OR org-admin of agent's org OR super-admin.
    // BFSF-271: any same-org member with manage_agents used to fall through to
    // allowed=true here — transfers now require an actual org-admin role.
    const isSuperAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    let allowed = isSuperAdmin || agent.owner_id === userId;
    if (!allowed && agent.organization_id) {
        try {
            const { isOrgAdminRole } = require('../../auth');
            const me = await userStore.getUser(userId);
            if (me && me.organizationId === agent.organization_id && isOrgAdminRole(me.orgRole)) {
                allowed = true;
            }
        } catch (_) { /* fall through */ }
    }
    if (!allowed) return res.status(403).json({ error: 'Only the owner or an org admin can transfer this agent' });

    // The new owner must already exist and belong to the agent's org.
    const target = await userStore.getUser(newOwnerId).catch(() => null);
    if (!target) return res.status(404).json({ error: 'New owner not found' });
    if (agent.organization_id && target.organizationId !== agent.organization_id) {
        // Don't leak cross-tenant info: treat as "not found in this org".
        return res.status(400).json({ error: 'New owner must be a member of the same organization' });
    }

    const success = await agentStore.transferAgentOwner(agent.id, newOwnerId, agent.organization_id);
    if (!success) throw new Error('Transfer failed');

    await userStore.logAccessAudit(
        'agent.transfer',
        'agent',
        agent.id,
        userId || null,
        { owner_id: agent.owner_id },
        { owner_id: newOwnerId },
        agent.organization_id || null,
    );

    res.json({ success: true, newOwnerId });
});

module.exports = router;
module.exports.canModifyAgent = canModifyAgent;
module.exports.buildCanModifyContext = buildCanModifyContext;
module.exports.canReadAgent = canReadAgent;
module.exports.validateAgentConfigReferences = validateAgentConfigReferences;
module.exports.applyConfigValidation = applyConfigValidation;
module.exports.resolvePersonaWrite = resolvePersonaWrite;
module.exports.verifyHandoffAutomation = verifyHandoffAutomation;

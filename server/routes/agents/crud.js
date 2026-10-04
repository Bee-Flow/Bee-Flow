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
const log = require('../../telemetry/log');

const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { storedFlag, FLAG_DEFAULTS } = require('./storedFlag');

const router = express.Router();

// ── What a caller may send ──────────────────────────────────────────
//
// The category, transfer and tool-param routes, and the agent save (PUT /:id).
// The create body (POST /) is deliberately not stated here — see the note
// above POST /.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CATEGORY_NAME = 'A category needs a name.';
const CategoryBody = z.object({
    name: worded(CATEGORY_NAME).trim().min(1, CATEGORY_NAME).max(100, 'A category name is at most 100 characters.'),
    icon: worded('A category icon must be text.').trim().max(16, 'A category icon is at most 16 characters.').optional(),
    color: worded('A category colour must be text.').trim().max(32, 'A category colour is at most 32 characters.').nullish(),
}).strict();

/** Every field optional: a rename must not have to resend icon and colour. */
const CategoryPatch = CategoryBody.partial();

const REASSIGN = 'reassignTo is the id of another category, or "none" to uncategorise.';
const DeleteCategoryQuery = z.object({
    reassignTo: worded(REASSIGN).trim().min(1, REASSIGN).optional(),
}).strict();

const NEW_OWNER = 'A transfer needs the id of the new owner.';
const TransferBody = z.object({
    newOwnerId: worded(NEW_OWNER).trim().min(1, NEW_OWNER),
}).strict();

const ToolParamsBody = z.object({
    // A component declares its own params — endpoints, keys, whatever it
    // takes — so only the envelope around them is stated here.
    params: z.record(z.unknown(), { invalid_type_error: 'params is an object of the tool\'s own settings.' }).nullish(),
}).strict();

/**
 * An on/off setting as a client sends it: true or false, or the 1 and 0 that
 * AgentDesignerPanel and the AgentDesigner hook send for `workspaceEnabled`.
 * Anything else is refused: the store writes `!!value`, and `!!'false'` is on.
 */
const setting = (name) => {
    const message = `${name} is true or false.`;
    return z.preprocess(
        (v) => (v === 1 ? true : v === 0 ? false : v),
        z.boolean({ required_error: message, invalid_type_error: message }),
    ).optional();
};

/**
 * An object handed on AS SENT. `z.record` would rebuild it, and zod drops a
 * `__proto__` key while rebuilding — so rejectUnsafeConfigKeys would never see
 * the key it exists to refuse, and a polluting body would save under a 200
 * instead of being turned away by name.
 */
const asSent = (message) => z.custom(
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    { message },
);

/**
 * PUT /:id — every key a real client sends, and nothing else.
 *
 * Taken from the four callers there are: the agent editor's autosave
 * (AgentWizard/state/agentSaveApi.js), the legacy AgentDesignerPanel and
 * AgentDesigner hook, and KnowledgeStudio's "accept suggestion", which sends
 * `{ config }` alone. crud.validation.test.js sends each of their bodies.
 *
 * Every key is optional, and a key left out means "leave it as stored" all the
 * way down to the SET list — the handler falls back to the row for each one.
 * `config` and `persona` stay open one level down: an allow-list of config keys
 * is not maintainable (see rejectUnsafeConfigKeys), and `normalisePersona`
 * owns the persona's shape.
 *
 * TWO KEYS ARE ACCEPTED AND NOT READ: `organizationId` and `sharedGroups`. The
 * legacy panel sends both on every save; the org is set on creation and the
 * audience belongs to PATCH /:id/publish, so arriving here they change nothing.
 */
const AGENT_BODY = "An agent save is an object of the agent's settings.";
const AgentUpdateBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        // `name || agent.name` in the handler: empty or null keeps the name.
        name: worded('name is text.').nullish(),
        description: worded('description is text.').nullish(),
        systemPrompt: worded('systemPrompt is text.').nullish(),
        model: worded('model is the name of a model or a tier.').nullish(),
        avatar: worded('avatar is text: an emoji or the address of an image.').nullish(),
        categoryId: worded('categoryId is the id of a category, or null for none.').nullish(),
        starterPrompts: z.array(worded('starterPrompts is a list of prompts.'), { invalid_type_error: 'starterPrompts is a list of prompts.' }).optional(),
        tools: z.array(worded('tools is a list of component ids.'), { invalid_type_error: 'tools is a list of component ids.' }).nullish(),
        toolParams: asSent("toolParams is an object of each tool's own settings.").nullish(),
        config: asSent("config is an object of the agent's settings.").optional(),
        persona: asSent('persona is an object, or null to clear it.').nullish(),
        threadsEnabled: setting('threadsEnabled'),
        copyEnabled: setting('copyEnabled'),
        workspaceEnabled: setting('workspaceEnabled'),
        embedEnabled: setting('embedEnabled'),
        baseVersion: z.number({ invalid_type_error: 'baseVersion is the rev the editor loaded, a whole number.' })
            .int('baseVersion is the rev the editor loaded, a whole number.').nullish(),
        organizationId: z.unknown().optional(),
        sharedGroups: z.unknown().optional(),
    }, {
        errorMap: (issue, ctx) => {
            if (issue.code === 'unrecognized_keys') {
                const names = issue.keys.map((k) => `'${k}'`).join(', ');
                return { message: `An agent has no ${issue.keys.length === 1 ? 'setting' : 'settings'} called ${names}.` };
            }
            if (issue.code === 'invalid_type') return { message: AGENT_BODY };
            return { message: ctx.defaultError };
        },
    }).strict(),
);

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
    if (wantsDraft && canEdit) {
        return res.json({ ...agent, can_edit: true, runtimeSource: 'draft', unpublishedChanges, managed });
    }
    const body = { ...views.runtime, can_edit: canEdit, managed };
    if (canEdit) body.unpublishedChanges = unpublishedChanges;
    res.json(body);
});

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
        res.status(500).json({ error: 'Failed to delete agent' });
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

// ── Structured role (A1c) ───────────────────────────────────────────
//
// The whole write side of `agents.persona` lives here, next to the config
// validation it has to run BEFORE: a persona can add an automation grant to
// `config.tools`, and a grant that skips `normaliseToolsConfig` is a grant
// nothing clamped.

/**
 * Is this an automation the AGENT'S OWNER may hand off to? Returns the verified
 * `{id, label}` or null — and null is the only answer for anything we could
 * not confirm, including a lookup that threw.
 *
 * The check is against `agent.owner_id`, never the person doing the editing.
 * An org-admin may edit someone else's agent; letting them attach one of THEIR
 * OWN automations to it would mint a grant the agent's owner never made, on an
 * agent that runs under a different identity. Same rule the KB and skill blocks
 * above already apply ("accessible to the AGENT'S OWNER, not the requesting
 * user"), and the same reason.
 *
 * `automationToTool` does the rest of the narrowing: it returns null unless the
 * automation really declares `trigger.kind === 'agent_call'`, and it produces the
 * EXACT tool name the runtime will offer — so the prompt line names the action
 * the model actually has instead of one it has to invent.
 */
async function verifyHandoffAutomation(agent, automationId) {
    if (!automationId || !agent || !agent.owner_id) return null;
    try {
        const automationStore = require('../../stores/automationStore');
        const automation = await automationStore.getAutomation(automationId);
        if (!automation) return null;
        if (automation.userId !== agent.owner_id) return null;
        if (!automation.isActive) return null;
        const { automationToTool } = require('../../automation/agentCallableTools');
        const tool = automationToTool(automation);
        const label = tool && tool.function && tool.function.name;
        if (!label) return null;
        return { id: automationId, label, title: automation.title || null };
    } catch (e) {
        // "I could not check" is not "yes". No grant, no prompt line promising
        // a hand-off, and the persona keeps the mode but loses the id.
        log.warn(`[Agents] hand-off automation ${automationId} could not be verified:`, e.message);
        return null;
    }
}

/**
 * Normalise an incoming persona, verify what it points at, and derive the two
 * things it is the source of: the system prompt and a small, additive set of
 * config keys.
 *
 * @param {object} agent   the agent being written (needs `owner_id`)
 * @param {*} rawPersona   whatever the client sent
 * @param {object|undefined} config  the config the SAME request is writing, or
 *   undefined when it is not writing one
 * @param {object} [opts]
 * @param {string} [opts.sentSystemPrompt] the `systemPrompt` field of the SAME
 *   request, when it sent one. Only an UPDATE passes it — a create has no
 *   stored state to compare against.
 * @returns {Promise<{persona: object, config: object|undefined, systemPrompt: string|null, warnings: string[]}>}
 *   `systemPrompt` is null for "leave the stored prompt alone" — see
 *   `renderedPromptFor`; `config` comes back untouched when the request did not
 *   send one.
 */
async function resolvePersonaWrite(agent, rawPersona, config, opts = {}) {
    const personaPrompt = require('../../core/agentRuntime/personaPrompt');
    let { persona, warnings } = personaPrompt.normalisePersona(rawPersona);

    // ── WHICHEVER FIELD THE REQUEST ACTUALLY CHANGED IS THE ONE THAT WINS ──
    //
    // A client that edits the prompt box and echoes the persona back unchanged
    // has said something precise: this text is new, those fields are not.
    // Rendering the unchanged fields over the new text would delete the edit
    // and answer 200. So when the persona matches what is stored and the
    // prompt does not, the persona FOLLOWS the prompt into free mode — which
    // is the true statement about that row: the text is the source now.
    //
    // Every editor that predates A1c rebuilds its PUT body from a fixed field
    // list and never sends a persona at all, so this costs them nothing. It is
    // here for the one that echoes a whole GET response back, which is a save
    // shape this codebase already has elsewhere.
    //
    // Compared against the STORED PROMPT, never against a fresh render of the
    // stored persona: a later change to the renderer would otherwise read as
    // "the client edited the prompt" for every agent at once and freeze the lot
    // into free mode.
    if (agent && agent.persona !== undefined && typeof opts.sentSystemPrompt === 'string') {
        const storedPersona = personaPrompt.normalisePersona(agent.persona).persona;
        const personaUntouched = JSON.stringify(storedPersona) === JSON.stringify(persona);
        const promptEdited = opts.sentSystemPrompt !== (agent.system_prompt || '');
        if (personaUntouched && promptEdited) {
            persona = personaPrompt.normalisePersona({
                ...persona, mode: 'free', freeText: opts.sentSystemPrompt,
            }).persona;
        }
    }

    let handoff = null;
    if (persona.unknown.mode === 'handoff' && persona.unknown.automationId) {
        handoff = await verifyHandoffAutomation(agent, persona.unknown.automationId);
        if (!handoff) {
            // Dropped, not kept-and-ignored: a stored id that resolves to
            // nothing is a hand-off the editor keeps drawing and the runtime
            // never performs.
            warnings.push(`persona.unknown: automation ${persona.unknown.automationId} is not an active hand-off automation of this agent's owner — dropped`);
            persona.unknown.automationId = null;
        }
    }

    let systemPrompt = personaPrompt.renderedPromptFor(persona, { handoffLabel: handoff ? handoff.label : null });

    // ── A PROJECTION HANDED BACK UNCHANGED MAY NOT SHORTEN WHAT IS STORED ──
    //
    // `personaOf` shows an agent whose instruction is only a prompt as free
    // mode over that prompt — clamped to LIMITS.freeText. For an instruction
    // longer than that, what GET hands out is a TRUNCATION, and rendering it
    // back is a write that silently drops the tail. Measured: a 20 050-char
    // prompt comes back as 20 000, and the 50 characters that go are the last
    // paragraph, which in an instruction is usually the sharpest one.
    //
    // The guard is deliberately not a warning for the client to honour: an
    // editor cannot be relied on to notice, and the editor that round-trips a
    // whole GET response is exactly the shape this fires for. So the check is
    // "is this byte-for-byte the projection we would have handed out, over a
    // prompt that did not fit?" — if so the request changed nothing here, and
    // `null` lets the caller keep the stored prompt. Any real edit differs
    // from the projection and writes normally, including one that deliberately
    // shortens the instruction.
    if (persona.mode === 'free' && agent && typeof agent.system_prompt === 'string') {
        const projected = personaPrompt.personaOf(agent);
        if (projected.mode === 'free'
            && projected.freeText === persona.freeText
            && agent.system_prompt.length > persona.freeText.length) {
            warnings.push('persona.freeText: this instruction is longer than the editor can show, so it was left as it is rather than saved back truncated');
            systemPrompt = null;
        }
    }

    // The config side effects are applied ONLY to a config this request is
    // already writing. Folding them onto the stored config instead would turn
    // a persona-only PUT into a config write nobody asked for, and a request
    // that sends no config is exactly the one whose stored config we have the
    // least reason to trust ourselves to rebuild.
    let outConfig = config;
    if (config && typeof config === 'object') {
        const folded = personaPrompt.applyPersonaToConfig(config, persona, {
            handoffAutomationId: handoff ? handoff.id : null,
        });
        outConfig = folded.config;
        warnings.push(...folded.warnings);
    } else if (persona.mode === 'fields') {
        // No config in this request. Say so only when it MATTERS: fold against
        // the stored config and throw the result away, so the editor hears
        // about a setting that did not land and hears nothing when the stored
        // config already says the same thing.
        const stored = agent && agent.config && typeof agent.config === 'object' ? agent.config : {};
        const probe = personaPrompt.applyPersonaToConfig(stored, persona, {
            handoffAutomationId: handoff ? handoff.id : null,
        });
        if (probe.warnings.length > 0) {
            warnings.push('persona: the matching app/knowledge setting was not applied — this save carried no app configuration');
        }
    }

    return { persona, config: outConfig, systemPrompt, warnings };
}

const { applyConfigValidation } = publishable;

// Prefetch the per-request inputs canModifyAgent needs so list endpoints can
// compute `can_edit` for many agents without N× user/permission lookups.
async function buildCanModifyContext(userId, req) {
    if (!userId) return { hasManage: false, orgIds: new Set(), user: null };
    const { hasPermission } = require('../../auth');
    const [hasManage, orgIds, user] = await Promise.all([
        hasPermission(userId, 'manage_agents', req.session),
        resolveUserOrgIds(req).catch(() => new Set()),
        userStore.getUser(userId).catch(() => null),
    ]);
    return { hasManage, orgIds, user };
}

// The single authoritative per-agent write gate, fronting every mutating agent
// endpoint (PUT/DELETE, tool params, publish, knowledge routes). Rules in order:
//   1. Owners may always modify their own agent (checked FIRST — owners
//      without manage_agents must keep their publish/knowledge flows).
//   2. Super-admins may modify anything.
//   3. Everyone else needs the manage_agents permission AND membership in the
//      agent's organization. (BFSF-271: previously ANY manage_agents holder
//      passed, including users from other orgs — a cross-org IDOR.)
//   4. Org-less agents (system/swarm/personal drafts) are owner/super-admin only.
//   5. Agent Editors cannot modify unpublished drafts from others.
// `ctx` (optional) is a buildCanModifyContext() result for list endpoints.
async function canModifyAgent(agent, userId, req, ctx = null) {
    if (agent.owner_id === userId) return true;

    // Super admin bypass
    if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return true;

    const c = ctx || await buildCanModifyContext(userId, req);

    // Non-owners always need manage_agents. Previously enforced ad-hoc by
    // (most) callers; centralised here so every caller inherits it.
    if (!c.hasManage) return false;

    // Org scoping: the requester must belong to the agent's organization.
    // Org-less agents have no org to scope by → owner/super-admin only.
    if (!agent.organization_id) return false;
    // resolveUserOrgIds returns null only for super-admins (handled above);
    // keep the null-guard so a degenerate ctx can never widen access.
    if (c.orgIds === null || !c.orgIds.has(agent.organization_id)) return false;

    // Agent Editor restriction: cannot modify unpublished drafts from others
    const orgRole = c.user ? c.user.orgRole : null;
    if (orgRole === OrgRoles.AGENT_EDITOR && !agent.is_published) {
        return false;
    }

    return true;
}

// Structured 403 body shared by the mutating endpoints so the client can
// translate the message and flip the editor into read-only mode.
function sendAgentNotEditable(res) {
    return res.status(403).json({
        error: 'You do not have permission to edit this agent.',
        code: 'agent_not_editable',
    });
}

// Update agent - requires manage_agents permission
router.put('/:id', requirePermission('manage_agents'), validate({ body: AgentUpdateBody }), async (req, res) => {
    const userId = getEffectiveUserId(req);
    // `organizationId` and `sharedGroups` are intentionally NOT destructured
    // here. organization is set on creation and only an org-admin should be
    // able to move an agent across orgs (no UI surface today). sharedGroups is
    // managed via the dedicated `PATCH /:id/publish` endpoint to keep the
    // group-membership check in one place. Either field arriving here is
    // accepted by AgentUpdateBody and dropped (the existing values are reused
    // from `agent.*`). Every other key has been through that schema: the
    // settings are booleans, and a key left out is absent, not undefined-ish.
    const { name, description, systemPrompt, tools, toolParams, model: rawModel, starterPrompts, avatar, threadsEnabled, copyEnabled, workspaceEnabled, config, embedEnabled, categoryId, baseVersion, persona } = req.body;
    // `persona` follows undefined-means-preserve down to the SET list; an
    // explicit `null` clears the column, which is not a loss — the row falls
    // back to free mode over its own prompt.
    const hasPersona = Object.prototype.hasOwnProperty.call(req.body || {}, 'persona');
    // Optimistic-concurrency token (the agent's last-seen `rev`). Integer when
    // the editor sends it; null (unguarded, last-write-wins) when omitted so
    // older clients / non-editor callers keep working during rollout.
    const expectedRev = Number.isInteger(baseVersion) ? baseVersion : null;
    // Rewrite legacy tier aliases (e.g. `tier:smart` → `tier:thinking`) up front,
    // so the tier gate below validates — and updateAgent persists — the canonical
    // key. `undefined` (field omitted) passes through unchanged.
    const model = normalizeTierModel(rawModel);

    {
        // `persona` is stored as JSONB and spread by every reader, exactly like
        // `config` — so it goes through the same prototype-pollution gate. It
        // is a SEPARATE body field, which is precisely how a second door gets
        // left open.
        const e = rejectUnsafeConfigKeys(config) || rejectUnsafeConfigKeys(persona);
        if (e) return res.status(400).json({ error: e });
    }

    const agent = await agentStore.getAgent(req.params.id);
    if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
    }

    if (!(await canModifyAgent(agent, userId, req))) {
        return sendAgentNotEditable(res);
    }

    // Tier gate: when the client sets a `tier:<key>` model, validate that the
    // user is actually allowed to use that tier. Both standard and custom tiers
    // are checked — getPermittedTierKeys returns all keys (standard + custom)
    // permitted for this user's groups + beta features. Non-tier raw model
    // strings (legacy) pass through unchanged.
    if (typeof model === 'string' && model.startsWith('tier:')) {
        const tierKey = model.slice('tier:'.length);
        const { getPermittedTierKeys } = require('../../core/entitlements/userTiers');
        const allowed = await getPermittedTierKeys({ userId, session: req.session, taskType: 'direct_chat' });
        if (!allowed.has(tierKey)) {
            // Structured so the editor can reconcile (drop/re-pick the tier) and
            // keep autosaving, instead of dead-ending on a generic save error.
            return res.status(403).json({
                error: `Tier "${tierKey}" is not available on your account.`,
                code: 'tier_not_permitted',
                permittedTierKeys: Array.from(allowed),
            });
        }
    }

    // Parse existing starter_prompts if stored as JSON string
    const existingStarterPrompts = typeof agent.starter_prompts === 'string'
        ? JSON.parse(agent.starter_prompts || '[]')
        : (agent.starter_prompts || []);

    // Parse existing shared_groups (preserved verbatim — only the publish
    // endpoint may mutate this).
    const existingSharedGroups = typeof agent.shared_groups === 'string'
        ? (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
        : (agent.shared_groups || []);

    // Organization is sticky — only set on first save if the agent has none.
    let assignOrgId = agent.organization_id || null;
    if (!assignOrgId) {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null && orgIds.size > 0) {
            assignOrgId = Array.from(orgIds)[0];
        }
    }

    // Validate cross-element references in config (KB / skill IDs). Done
    // BEFORE the DB write so a bad config doesn't half-commit. Cross-org KBs
    // hard-fail (400); unresolvable/cross-org skills are dropped from the
    // config we persist (surfaced as warnings), so a refine that proposes a
    // skill the agent can't hold never breaks the whole save.
    let configToSave = config;
    let saveWarnings = [];

    // ── Persona (A1c) — runs BEFORE the config validation below ──────────
    // The persona is the SOURCE: it renders the system prompt, and its
    // `unknown` mode can add an automation grant to `config.tools`. That grant has
    // to reach `validateAgentConfigReferences` like any other, or the one path
    // that creates a grant server-side would be the one path that skips the
    // clamp.
    let personaToSave;              // undefined ⇒ preserve the column
    let personaPrompt = null;       // null ⇒ keep the caller's systemPrompt
    if (hasPersona) {
        if (persona === null) {
            personaToSave = null;   // explicit clear
        } else {
            const resolved = await resolvePersonaWrite(
                { ...agent, organization_id: assignOrgId },
                persona,
                configToSave,
                { sentSystemPrompt: systemPrompt },
            );
            personaToSave = resolved.persona;
            personaPrompt = resolved.systemPrompt;
            configToSave = resolved.config;
            saveWarnings = saveWarnings.concat(resolved.warnings);
        }
    }

    if (configToSave !== undefined && configToSave !== null) {
        let validation;
        try {
            // Use the *new* config to validate, plus the agent's existing
            // organization_id so skill lookups scope correctly.
            validation = await validateAgentConfigReferences(
                { ...agent, organization_id: assignOrgId },
                configToSave
            );
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
        saveWarnings = saveWarnings.concat(validation?.warnings || []);
        configToSave = applyConfigValidation(configToSave, validation);
    }

    // Validate categoryId belongs to the user's org. Users may not legitimately
    // attach an agent to a category in another org. Null is always allowed
    // (clears the category).
    let resolvedCategoryId = categoryId !== undefined ? categoryId : (agent.category_id || null);
    if (resolvedCategoryId && resolvedCategoryId !== agent.category_id) {
        try {
            const cats = await agentStore.getAgentCategories(assignOrgId);
            const valid = Array.isArray(cats) && cats.some(c => c.id === resolvedCategoryId);
            if (!valid) {
                return res.status(400).json({ error: 'Category does not belong to your organization.' });
            }
        } catch (_) {
            // If the category list can't be loaded, fall back to existing value
            // rather than silently moving to an unverified category.
            resolvedCategoryId = agent.category_id || null;
        }
    }

    // Transform toolParams from frontend format { param: { value, fixed } }
    // to storage format { param: value } (only fixed params)
    const hasTools = Array.isArray(tools);
    const transformedParams = {};
    if (hasTools && toolParams) {
        for (const [componentId, params] of Object.entries(toolParams)) {
            const fixedParams = {};
            for (const [paramName, config] of Object.entries(params || {})) {
                if (config && config.fixed && config.value !== undefined) {
                    fixedParams[paramName] = config.value;
                }
            }
            if (Object.keys(fixedParams).length > 0) {
                transformedParams[componentId] = fixedParams;
            }
        }
    }
    // A managed agent's tool grants change only with a deploy (design 5.2).
    // Refused before updateAgent, so a refused save writes nothing at all.
    if (hasTools) {
        await assertAgentToolsWrite(agent,
            tools.map((componentId) => ({ componentId, params: transformedParams[componentId] || null })));
    }

    const result = await agentStore.updateAgent(
        req.params.id,
        name || agent.name,
        // The store writes `description || ''` unconditionally, so a save
        // that never mentioned the description (a rename, KnowledgeStudio's
        // `{ config }`) erased it. Sent — even as '' — it is written.
        description !== undefined ? description : agent.description,
        // The persona wins when it renders to something. It renders to NULL
        // when there is nothing in it, and then the caller's own systemPrompt
        // is used unchanged — an empty persona object must never be the thing
        // that erases an agent's instructions.
        //
        // THAT PROMISE NEEDED THE THIRD RUNG. A persona-only PUT sends no
        // `systemPrompt` at all, so the middle term was `undefined`, and the
        // store writes `system_prompt = $3` unconditionally with
        // `systemPrompt || ''`. The agent lost its whole instruction and the
        // route answered 200. Every other argument in this call already falls
        // back to the stored row; this one is now the same shape.
        //
        // An explicitly sent empty string still clears it. That is a person
        // saying "no instructions", which is not the same as a request that
        // never mentioned them.
        personaPrompt !== null
            ? personaPrompt
            : (systemPrompt !== undefined ? systemPrompt : agent.system_prompt),
        agent.owner_id,
        model !== undefined ? model : agent.model,
        starterPrompts !== undefined ? starterPrompts : existingStarterPrompts,
        avatar !== undefined ? avatar : agent.avatar,
        // A setting the save does not mention keeps what is stored. These read
        // `agent.x_enabled !== 0`, and on Postgres the columns are booleans:
        // `false !== 0` is true, so every save from the agent editor (which
        // never sends threads, copy or workspace) switched them back on. See
        // ./storedFlag.
        threadsEnabled !== undefined ? threadsEnabled : storedFlag(agent.threads_enabled, FLAG_DEFAULTS.threads_enabled),
        copyEnabled !== undefined ? copyEnabled : storedFlag(agent.copy_enabled, FLAG_DEFAULTS.copy_enabled),
        workspaceEnabled !== undefined ? workspaceEnabled : storedFlag(agent.workspace_enabled, FLAG_DEFAULTS.workspace_enabled),
        configToSave !== undefined ? configToSave : (agent.config || {}),
        embedEnabled !== undefined ? embedEnabled : storedFlag(agent.embed_enabled, FLAG_DEFAULTS.embed_enabled),
        assignOrgId,
        existingSharedGroups,
        resolvedCategoryId,
        { expectedRev, persona: personaToSave }
    );

    if (result.conflict) {
        // The agent's `rev` moved since the editor loaded it (another tab, a
        // version restore, a publish/skill-scrub). Hand back the server's copy
        // so the client can reconcile (load latest vs overwrite) instead of
        // silently clobbering. Shape mirrors studioApps' 409.
        const fresh = await agentStore.getAgent(req.params.id);
        return res.status(409).json({
            error: 'The agent changed since you loaded it',
            conflict: true,
            currentVersion: result.currentRev,
            agent: fresh,
        });
    }
    if (!result.ok) {
        return res.status(500).json({ error: 'Failed to update agent' });
    }

    // Update tools if provided (also pass toolParams)
    if (hasTools) {
        await agentStore.setAgentTools(req.params.id, tools, transformedParams);
    }

    // Return the freshly persisted agent (including server-derived fields like
    // updated_at, parsed config, etc.) so the client can refresh its local
    // shell without a second GET round-trip. The previous `{success:true}`
    // shape silently corrupted the editor's `agent` state and broke every
    // auto-save after the first.
    const fresh = await agentStore.getAgent(req.params.id);
    if (!fresh) return res.json({ success: true });
    // Attach `warnings` only when something was dropped, so the happy-path
    // response stays byte-identical for existing consumers. The editor toasts
    // e.g. "1 skill couldn't be linked".
    res.json(saveWarnings.length > 0 ? { ...fresh, warnings: saveWarnings } : fresh);
});

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
    if (!success) return res.status(500).json({ error: 'Transfer failed' });

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

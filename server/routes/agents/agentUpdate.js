// @typecheck
/**
 * Agent CRUD: the agent save (PUT /:id), in phases. The tier gate, the
 * sticky organisation, the persona and the config validation, the category
 * check, the tool params, the write with its optimistic-concurrency check and
 * the answer. The route is registered in crud.js, which hands in the edit
 * gate and the config validation it builds from its own imports. Split out
 * of crud.js; behaviour unchanged.
 */

const agentStore = require('../../stores/agentStore');
const { normalizeTierModel } = require('../../core/llm/modelResolver');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { assertAgentToolsWrite } = require('../../stores/agent/agentCrud');
const { storedFlag, FLAG_DEFAULTS } = require('./storedFlag');
const { resolvePersonaWrite } = require('./agentPersonaWrite');

/**
 * Tier gate: a `tier:<key>` model must be a tier this user may use. Both
 * standard and custom tiers are checked (getPermittedTierKeys returns all keys
 * permitted for the user's groups + beta features). Non-tier raw model
 * strings (legacy) pass through unchanged. Returns false after refusing.
 */
async function checkTierAllowed(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, model, userId) {
    if (!(typeof model === 'string' && model.startsWith('tier:'))) return true;
    const tierKey = model.slice('tier:'.length);
    const { getPermittedTierKeys } = require('../../core/entitlements/userTiers');
    const allowed = await getPermittedTierKeys({ userId, session: req.session, taskType: 'direct_chat' });
    if (allowed.has(tierKey)) return true;
    // Structured so the editor can reconcile (drop/re-pick the tier) and keep
    // autosaving, instead of dead-ending on a generic save error.
    res.status(403).json({
        error: `Tier "${tierKey}" is not available on your account.`,
        code: 'tier_not_permitted',
        permittedTierKeys: Array.from(allowed),
    });
    return false;
}

/** What the save keeps as stored: starter prompts, shared groups (only publish may change them). */
function storedLists(agent) {
    const existingStarterPrompts = typeof agent.starter_prompts === 'string'
        ? JSON.parse(agent.starter_prompts || '[]')
        : (agent.starter_prompts || []);
    const existingSharedGroups = typeof agent.shared_groups === 'string'
        ? (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
        : (agent.shared_groups || []);
    return { existingStarterPrompts, existingSharedGroups };
}

/** Organization is sticky: only set on first save if the agent has none. */
async function assignOrgFor(/** @type {import('express').Request} */ req, agent, deps) {
    if (agent.organization_id) return agent.organization_id;
    const orgIds = await deps.resolveUserOrgIds(req);
    if (orgIds !== null && orgIds.size > 0) return Array.from(orgIds)[0];
    return null;
}

/**
 * The persona (A1c) first, then the config validation. The persona is the
 * SOURCE: it renders the system prompt, and its `unknown` mode can add an
 * automation grant to `config.tools`. That grant has to reach
 * `validateAgentConfigReferences` like any other, or the one path that
 * creates a grant server-side would be the one path that skips the clamp.
 * Cross-org KBs hard-fail (400); unresolvable/cross-org skills are dropped
 * from the config (surfaced as warnings), so a refine that proposes a skill
 * the agent can't hold never breaks the whole save. Returns null after
 * answering.
 */
async function resolvePersonaAndConfig(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, { agent, assignOrgId, userId, deps }) {
    const { config, systemPrompt, persona } = req.body;
    const hasPersona = Object.prototype.hasOwnProperty.call(req.body || {}, 'persona');
    let configToSave = config;
    let saveWarnings = [];
    let personaToSave;              // undefined ⇒ preserve the column
    /** @type {string | null} */
    let personaPrompt = null;       // null ⇒ keep the caller's systemPrompt
    if (hasPersona) {
        if (persona === null) {
            personaToSave = null;   // explicit clear
        } else {
            const resolved = await resolvePersonaWrite(
                { ...agent, organization_id: assignOrgId },
                persona,
                configToSave,
                { sentSystemPrompt: systemPrompt, actorId: userId, session: req.session },
            );
            personaToSave = resolved.persona;
            personaPrompt = resolved.systemPrompt;
            configToSave = resolved.config;
            saveWarnings = saveWarnings.concat(resolved.warnings);
        }
    }
    if (configToSave !== undefined && configToSave !== null) {
        let validation;
        // Use the *new* config to validate, plus the agent's existing
        // organization_id so skill lookups scope correctly.
        validation = await deps.validateAgentConfigReferences(
            { ...agent, organization_id: assignOrgId },
            configToSave
        );
        saveWarnings = saveWarnings.concat(validation?.warnings || []);
        configToSave = deps.applyConfigValidation(configToSave, validation);
    }
    return { configToSave, saveWarnings, personaToSave, personaPrompt };
}

/**
 * The category must belong to the user's org; a category in another org is
 * refused. Null is always allowed (clears it). If the category list can't be
 * loaded, keep the existing value rather than move to an unverified one.
 * Returns undefined after refusing.
 */
async function resolveCategory(res, agent, categoryId, assignOrgId) {
    let resolvedCategoryId = categoryId !== undefined ? categoryId : (agent.category_id || null);
    if (resolvedCategoryId && resolvedCategoryId !== agent.category_id) {
        try {
            const cats = await agentStore.getAgentCategories(assignOrgId);
            const valid = Array.isArray(cats) && cats.some(c => c.id === resolvedCategoryId);
            if (!valid) {
                res.status(400).json({ error: 'Category does not belong to your organization.' });
                return undefined;
            }
        } catch (_) {
            resolvedCategoryId = agent.category_id || null;
        }
    }
    return resolvedCategoryId;
}

/** toolParams from the frontend format { param: { value, fixed } } to storage { param: value } (fixed only). */
function fixedToolParams(toolParams) {
    const transformedParams = {};
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
    return transformedParams;
}

/** The store write. Every argument falls back to the stored row for a key the save left out. */
function writeAgent(req, agent, s) {
    const { name, description, systemPrompt, starterPrompts, avatar, threadsEnabled, copyEnabled, workspaceEnabled, embedEnabled } = req.body;
    return agentStore.updateAgent(
        req.params.id,
        name || agent.name,
        // The store writes `description || ''` unconditionally, so a save that
        // never mentioned the description (a rename, KnowledgeStudio's
        // `{ config }`) erased it. Sent, even as '', it is written.
        description !== undefined ? description : agent.description,
        // The persona wins when it renders to something. It renders to NULL
        // when there is nothing in it, and then the caller's own systemPrompt
        // is used unchanged: an empty persona object must never be the thing
        // that erases an agent's instructions. A persona-only PUT sends no
        // `systemPrompt` at all, and the store writes `systemPrompt || ''`, so
        // the stored prompt is the third rung. An explicitly sent empty string
        // still clears it: a person saying "no instructions".
        s.personaPrompt !== null
            ? s.personaPrompt
            : (systemPrompt !== undefined ? systemPrompt : agent.system_prompt),
        agent.owner_id,
        s.model !== undefined ? s.model : agent.model,
        starterPrompts !== undefined ? starterPrompts : s.existingStarterPrompts,
        avatar !== undefined ? avatar : agent.avatar,
        // A setting the save does not mention keeps what is stored. These read
        // `agent.x_enabled !== 0`, and on Postgres the columns are booleans:
        // `false !== 0` is true, so every save from the agent editor (which
        // never sends threads, copy or workspace) switched them back on. See
        // ./storedFlag.
        threadsEnabled !== undefined ? threadsEnabled : storedFlag(agent.threads_enabled, FLAG_DEFAULTS.threads_enabled),
        copyEnabled !== undefined ? copyEnabled : storedFlag(agent.copy_enabled, FLAG_DEFAULTS.copy_enabled),
        workspaceEnabled !== undefined ? workspaceEnabled : storedFlag(agent.workspace_enabled, FLAG_DEFAULTS.workspace_enabled),
        s.configToSave !== undefined ? s.configToSave : (agent.config || {}),
        embedEnabled !== undefined ? embedEnabled : storedFlag(agent.embed_enabled, FLAG_DEFAULTS.embed_enabled),
        s.assignOrgId,
        s.existingSharedGroups,
        s.resolvedCategoryId,
        { expectedRev: s.expectedRev, persona: s.personaToSave }
    );
}

/** After the write: the conflict answer, the tools, and the freshly persisted agent. */
async function answerAfterWrite(req, /** @type {import('express').Response} */ res, result, { hasTools, tools, transformedParams, saveWarnings }) {
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
        throw new Error('Failed to update agent');
    }
    if (hasTools) {
        await agentStore.setAgentTools(req.params.id, tools, transformedParams);
    }
    // The freshly persisted agent (server-derived fields like updated_at,
    // parsed config) so the client refreshes its shell without a second GET;
    // the old `{success:true}` shape broke every auto-save after the first.
    const fresh = await agentStore.getAgent(req.params.id);
    if (!fresh) return res.json({ success: true });
    // `warnings` only when something was dropped, so the happy-path response
    // stays byte-identical for existing consumers.
    return res.json(saveWarnings.length > 0 ? { ...fresh, warnings: saveWarnings } : fresh);
}

/**
 * PUT /:id. `organizationId` and `sharedGroups` are intentionally NOT read:
 * the organisation is set on creation, and sharedGroups belongs to
 * PATCH /:id/publish. `deps`: canModifyAgent, sendAgentNotEditable,
 * rejectUnsafeConfigKeys, validateAgentConfigReferences,
 * applyConfigValidation, resolveUserOrgIds.
 */
function makeUpdateAgentHandler(deps) {
    return async function updateAgent(req, /** @type {import('express').Response} */ res) {
        const userId = getEffectiveUserId(req);
        const { tools, toolParams, model: rawModel, config, categoryId, baseVersion, persona } = req.body;
        // Optimistic-concurrency token (the agent's last-seen `rev`). Integer
        // when the editor sends it; null (unguarded) when omitted so older
        // clients keep working during rollout.
        const expectedRev = Number.isInteger(baseVersion) ? baseVersion : null;
        // Rewrite legacy tier aliases (`tier:smart` → `tier:thinking`) up front,
        // so the tier gate validates and updateAgent persists the canonical key.
        const model = normalizeTierModel(rawModel);
        // `persona` is stored as JSONB and spread by every reader, exactly like
        // `config`, so it goes through the same prototype-pollution gate.
        const unsafe = deps.rejectUnsafeConfigKeys(config) || deps.rejectUnsafeConfigKeys(persona);
        if (unsafe) return res.status(400).json({ error: unsafe });

        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        if (!(await deps.canModifyAgent(agent, userId, req))) return deps.sendAgentNotEditable(res);
        if (!(await checkTierAllowed(req, res, model, userId))) return undefined;

        const { existingStarterPrompts, existingSharedGroups } = storedLists(agent);
        const assignOrgId = await assignOrgFor(req, agent, deps);
        const pc = await resolvePersonaAndConfig(req, res, { agent, assignOrgId, userId, deps });
        if (!pc) return undefined;
        const resolvedCategoryId = await resolveCategory(res, agent, categoryId, assignOrgId);
        if (resolvedCategoryId === undefined) return undefined;

        const hasTools = Array.isArray(tools);
        const transformedParams = hasTools && toolParams ? fixedToolParams(toolParams) : {};
        // A managed agent's tool grants change only with a deploy (design 5.2).
        // Refused before updateAgent, so a refused save writes nothing at all.
        if (hasTools) {
            await assertAgentToolsWrite(agent,
                tools.map((componentId) => ({ componentId, params: transformedParams[componentId] || null })));
        }
        const result = await writeAgent(req, agent, {
            ...pc, model, existingStarterPrompts, existingSharedGroups, assignOrgId, resolvedCategoryId, expectedRev,
        });
        return answerAfterWrite(req, res, result, { hasTools, tools, transformedParams, saveWarnings: pc.saveWarnings });
    };
}

module.exports = { makeUpdateAgentHandler };

/**
 * @typedef {import('./crud').AgentRow} LoadedAgent
 * @typedef {{ canModifyAgent: import('./crud').CrudRouter['canModifyAgent'],
 *   sendAgentNotEditable: (res: import('express').Response) => unknown,
 *   rejectUnsafeConfigKeys: (config: unknown) => string|null,
 *   validateAgentConfigReferences: import('./crud').CrudRouter['validateAgentConfigReferences'],
 *   applyConfigValidation: import('./crud').CrudRouter['applyConfigValidation'],
 *   resolveUserOrgIds: typeof import('../../auth').resolveUserOrgIds }} UpdateDeps
 */

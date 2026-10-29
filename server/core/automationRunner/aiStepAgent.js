/**
 * An AI step that is run by an AGENT (R2, part B).
 *
 * `ai_step.agentId` attaches an agent to one step of an automation. What that
 * agent brings there (its role, its knowledge bases, its skills, its tools)
 * is assembled HERE; `execAi.js` calls this and builds the step with the answer.
 *
 * ── WHAT IS LOADED: THE PUBLISHED CONFIG ────────────────────────────
 * `agentStore.getForRuntime` delivers the published config and the `system_prompt`
 * rendered at publication (`stores/agent/agentCrud.js: projectRuntime`), or, for as
 * long as an agent has never been published, the live draft version, with
 * `runtimeSource` alongside so that a run can be read afterwards. The persona is
 * deliberately NOT rendered: `parseConfig` strips it, and pasting the draft persona
 * onto the published prompt would be an assertion nobody checked
 * (see `core/agentRuntime/personaPrompt.js`).
 *
 * That live fallback applies only to the OWNER. Another person's agent may run here
 * only if it really serves a published VERSION: `core/automationModel/agentPublication.js:
 * servesPublishedConfig`. `is_published` is the share switch, `published_version > 0`
 * decides which config runs, and the two are independent of each other; without this
 * rule the unattended automation of one person would run on the living draft of another.
 *
 * ── WHO IS THE ASKER: THE AUTOMATION OWNER ──────────────────────────
 * `ctx.userId`, always. The agent may belong to someone else; its knowledge bases,
 * its automations and its tools are therefore measured against what the AUTOMATION
 * OWNER may do himself. The agent can only narrow, never widen: that is exactly the
 * intersection that `getIntegrationTools` and `filterKbIdsForUser` already make.
 *
 * ── THE TOOLS: PER-ACTION GRANTS MINUS EVERYTHING THAT IS `ask` ─────
 * An automation runs UNATTENDED. There is nobody to ask for a confirmation,
 * so a tool that a person would have to approve may not run automatically here.
 * The subtraction is done with `buildToolPolicy`, the same function with which
 * the chat determines `ask` (`core/agentRuntime/toolPolicy.js`, used by
 * `toolStackAssembly`/`chatStream`), and not with a second list here: a separate
 * list is a second place that can drift from the rights layer, and the place that
 * drifts is always the place nobody looks at.
 *
 * Three things follow from that, and none of the three goes right by itself:
 *
 *   0. THE GRANTS ARE APPLIED TWICE. `getIntegrationTools` applies them while
 *      building the catalogue, but when the policy module is unreachable it
 *      continues WITHOUT them; here `isToolAllowed` is therefore applied once more
 *      to the outcome. Narrowing twice costs nothing and closes the branch in which
 *      a `require` that threw would yield a full toolbelt.
 *   1. NOT `droppedForUnattended`. That list hangs on `hasStoredGrants`
 *      (`toolPolicy.js`: `gated = confirm === 'ask' && (hasStoredGrants ||
 *      hasOverride)`), deliberately, so that an existing mailing automation does not
 *      silently stop. On THIS surface that history does not exist: an agent that
 *      nobody curated would then get every sending tool, unasked and unconfirmed.
 *      Therefore the keep rule is `confirmByTool === 'direct'`: the POLICY verdict,
 *      not the runtime question.
 *   2. A DEGRADED REGISTRY GIVES NO REGISTRY TOOLS. With attribution broken,
 *      every name looks unknown, and "I could not work out which app this is" is
 *      not "there is no app". For a curated agent `isToolAllowed` already refuses
 *      those names; for an agent that nobody curated the answer would be
 *      "then just everything". Unknown narrows: only tools that carry their own
 *      identity (an automation, an MCP server, a custom integration) survive, because
 *      those are not attributed by the registry.
 *   3. A POLICY THAT CANNOT BE BUILT IS NOT A GRANT. If `buildToolPolicy` throws, the
 *      step gets no tools: it runs on as an ordinary text step.
 *
 * What an automation must still be able to do unattended belongs behind an explicit
 * approval step (`approval`) in the automation itself; the withheld names therefore
 * come back (`withheld`) instead of quietly disappearing.
 *
 * ── START AUTOMATIONS ───────────────────────────────────────────────
 * `getIntegrationTools` receives the `agentConfig` and already makes the intersection
 * for AGENT-CALLABLE automations (automations of the ASKER ∩ ids that the agent owner
 * has granted; `core/integrations/integrationTools.js`). If the permission is off,
 * those tools are removed AFTER assembly on their own marker; leaving out `agentConfig`
 * would also switch off the per-action grants on all other tools, and that is a widening.
 *
 * The REUSABLE STEPS (`__step`) do NOT pass through there: they are pushed straight
 * onto the list in `getIntegrationTools`, outside `addTools` and outside the automation
 * curation. Here they DO count as "starts an automation", so the intersection is made
 * for them HERE (`_automationIdOf` + `_curatedAutomations`); otherwise a tool hangs
 * on a switch whose promise does not hold for it.
 *
 * It sits NEXT TO `useTools`, not beneath it: "may this step start other automations"
 * and "may it call integration tools" are two questions with two switches, and only
 * the first being on is a valid setting. One catalogue, every tool past the switch that
 * governs it, `extraTools` (e.g. `activate_skill`) included.
 *
 * ── WHAT THE AGENT PICKER COULD NEVER SHOW, IT DOES NOT GET HERE ────
 * `automation-evolution` and `kb-ingest` are in the registry as
 * `availableTo: ['automation_step']`. The availability probe of the agent picker
 * (`routes/agents/toolCatalog.js`) asks for the catalogue WITHOUT `automationStep`,
 * so no agent owner has ever seen those apps and nobody can write a grant entry
 * for them. They also carry no `grantsRequireEntry`, so `toolPolicy` reads that
 * silence as the no-migration rule and gives them `direct`. On an unattended surface
 * that hands an agent curated down to one read action the tooling to rewrite the
 * automation itself (`automation_apply_evolution` accepts status 'proposed', so with
 * no human in between). Therefore this path asks for the catalogue WITHOUT
 * `automationStep`, and moreover refuses every tool that the registry says does not
 * belong in an agent context: two locks, because one is an argument that someone can
 * reverse and the other reads the declaration itself.
 */

'use strict';

const { servesPublishedConfig } = require('../automationModel/agentPublication');
const log = require('../../telemetry/log');
const { permittedCatalog } = require('./toolIdentity');
// The unattended-tool deduction (withholdConfirmTools) and its tool readers.
const {
    WITHHOLD_REASONS,
    withholdConfirmTools,
    _resetAgentContextApps,
    _startsAutomation,
    _toolName,
} = require('./aiStepToolWithhold');

/**
 * The organisation that the agent gate measures against: the MEMBERSHIP of the
 * automation owner, not the stamp on the automation row.
 *
 * `ctx.orgId` is `runOrgFor(automation, session)`, i.e. the column
 * `automations.organization_id`, with the session as fallback. That stamp does NOT
 * move along when an administrator moves the owner to another organisation, so an
 * automation of a relocated employee kept resolving the published agents of his OLD
 * organisation, with their role, their tool grants and their knowledge bases.
 * `ctx.userHomeOrgId` is read fresh from `users` (execution.js, the same try as
 * `orgRole` and `identityError`), and the datatable step already measures against it;
 * this is the same question about the same person.
 *
 * A ctx without the key `userHomeOrgId`, which the preview route in
 * `routes/automation/catalog.js` builds from the user record of the editor, falls back
 * to `ctx.orgId`, because THERE that is already the membership.
 */
function _viewerOrgId(ctx) {
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, 'userHomeOrgId')) return ctx.userHomeOrgId || null;
    return (ctx && ctx.orgId) || null;
}

/** De drie schakelaars van `ai_step.agentPermissions`. */
const AGENT_PERMISSION_KEYS = Object.freeze(['startAutomations', 'useKnowledge', 'useTools']);

/**
 * The permissions of this step, always all three explicit.
 *
 * Default FALSE, and that is not a copy of the no-migration rule from
 * `toolPolicy`: this surface is NEW, so there is no existing behaviour to preserve,
 * and unknown narrows without exception. A step without (or with an unreadable)
 * `agentPermissions` gives the agent its role and skills, and nothing else that
 * reaches beyond the step.
 */
function stepAgentPermissions(step) {
    const raw = (step && typeof step.agentPermissions === 'object' && !Array.isArray(step.agentPermissions))
        ? step.agentPermissions
        : null;
    /** @type {Record<string, boolean>} */
    const out = {};
    for (const key of AGENT_PERMISSION_KEYS) out[key] = raw ? raw[key] === true : false;
    return out;
}

/**
 * @param {string} message
 * @param {string} errorClass
 */
function _fail(message, errorClass) {
    const err = new Error(message);
    err.errorClass = errorClass;
    return err;
}

/**
 * May the AUTOMATION OWNER deploy this agent?
 *
 * The same rules as `routes/agents/chat.js: userCanAccessPublishedAgent`,
 * but stated against the run context instead of a request: an automation has no
 * session to pull an org from and must do it with `ctx`.
 *
 *   owner                   → yes, also unpublished
 *   not published           → no, including "shared, but never a version published"
 *                             (`servesPublishedConfig`)
 *   identity unreadable     → no
 *   other org (or no org against an org agent) → no
 *   shared with groups      → only if the owner is in one of them
 *
 * All three no's get the same refusal: see `resolveStepAgent`.
 *
 * `owner_id` equality alone (what `aiTaskRunner` does for linked agents) is too strict
 * here, since an automation may deploy a shared org agent, and `organization_id` equality
 * alone is too broad: an unshared agent of a colleague does not belong in someone
 * else's automation.
 */
function _mayUseAgent(agent, ctx) {
    if (!agent) return false;
    const userId = ctx && ctx.userId;
    if (agent.owner_id && userId && agent.owner_id === userId) return true;
    if (!agent.is_published) return false;
    // Shared is not yet published: without a published VERSION `getForRuntime`
    // serves the owner's living draft, and the unattended automation of someone
    // else must not run on that.
    if (!servesPublishedConfig(agent)) return false;
    // A failed identity read is no answer. `userHomeOrgId`, `orgRole` and
    // `userGroupIds` come from the same read (execution.js), so with `identityError`
    // set, both the org question and the group question are unanswered, and "I could
    // not check" is not a yes here. The same rule the datatable step applies; it comes
    // after the owner branch, because `owner_id` equality needs no identity read.
    if (ctx && ctx.identityError) return false;
    const orgId = _viewerOrgId(ctx);
    if (orgId) {
        if (!agent.organization_id || agent.organization_id !== orgId) return false;
    } else if (agent.organization_id) {
        return false;
    }
    const sharedGroups = Array.isArray(agent.shared_groups) ? agent.shared_groups : [];
    if (sharedGroups.length === 0) return true;
    // A group list we could not read (`ctx.identityError`) is empty, and empty means
    // here "in no group at all": the narrow side.
    const groups = Array.isArray(ctx && ctx.userGroupIds) ? ctx.userGroupIds : [];
    return sharedGroups.some((g) => groups.includes(g));
}

/**
 * Load the agent behind this step, or `null` if the step has none.
 *
 * Throws, never silently continues, if there IS an `agentId` and it is not usable.
 * The step is then configured so that the agent does the thinking; letting it answer
 * without role, knowledge and tools looks from outside like a successful run with an
 * empty result, and that is the worse of the two. The save-time check (`crud.js`) is
 * fail-open and explicitly relies on this recheck per run.
 */
async function resolveStepAgent(step, ctx, { agentStore = null } = {}) {
    const agentId = step && typeof step.agentId === 'string' ? step.agentId.trim() : '';
    if (!agentId) return null;

    const store = agentStore || require('../../stores/agentStore');
    let agent = null;
    try {
        agent = await store.getForRuntime(agentId);
    } catch (e) {
        // A lookup that fails is not "the agent does not exist": the step should
        // fail and be retryable, not run on without an agent.
        throw _fail(`Could not load the agent for this step (${/** @type {Error} */ (e).message}).`, 'agent_unavailable');
    }
    // ONE refusal for all three cases: deleted, never published, or not shared
    // with the automation owner. The same rule the save-time check upholds
    // (`ai_step.agent_unavailable`, automation/validate/stepRules.js): three
    // different answers would turn an automation into a way to discover WHICH agents
    // exist elsewhere. The real difference goes to the server log, which only an
    // administrator reads.
    if (!agent || !_mayUseAgent(agent, ctx)) {
        log.warn(`[AutomationRunner] ai_step agent refused (${agentId}): ${agent ? 'not visible to the automation owner' : 'no such agent'}`);
        throw _fail(`There is no agent "${agentId}" this automation can use. Pick an agent in the step, or remove it so the step answers on its own prompt.`, 'agent_unavailable');
    }

    const config = (agent.config && typeof agent.config === 'object' && !Array.isArray(agent.config)) ? agent.config : {};
    const systemPrompt = typeof agent.system_prompt === 'string' ? agent.system_prompt.trim() : '';
    return {
        agent,
        agentId: agent.id || agentId,
        config,
        // De bij publicatie gerenderde rol. Niet opnieuw renderen — zie de kop.
        systemPrompt,
        // 'published' of 'live'; het enige eerlijke antwoord op "wat draaide er".
        runtimeSource: agent.runtimeSource || null,
        permissions: stepAgentPermissions(step),
    };
}

/**
 * The knowledge bases of this step: those of the step itself, plus those of the agent
 * if `useKnowledge` is on.
 *
 * The step comes FIRST so that its own choice survives the cap (`MAX_AI_STEP_KB_IDS`).
 * Authorisation does not happen here but in `execAi`'s `resolveAllowedKnowledgeBaseIds`,
 * with the automation owner as the asker: the whole union goes through that one filter,
 * otherwise an automation owner would read via a colleague's agent into bases he may
 * not see himself.
 */
function knowledgeBaseIdsForStep(step, binding) {
    const stepIds = Array.isArray(step && step.knowledgeBaseIds) ? step.knowledgeBaseIds : [];
    const agentIds = (binding && binding.permissions.useKnowledge && Array.isArray(binding.config.knowledge_base_ids))
        ? binding.config.knowledge_base_ids
        : [];
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const id of [...stepIds, ...agentIds]) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * The skills for this step, in the form `buildSkillInjection` expects.
 *
 * "Leading" = the STEP skill, and that is not arranged with an extra field but with
 * the order that `mergeSkillIds` already keeps: attached first, then the rest,
 * deduplicated, cut off at SKILL_CAP. The step skills thus go in as `attached` and the
 * agent skills as `session`: then the step wins both the order and the cap, without
 * anything in the shared function having to change.
 */
function skillIdsForStep(step, binding) {
    const clean = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []);
    const attachedSkillIds = clean(step && step.skillIds);
    // Handoff 5: the step can switch individual agent skills off for itself
    // (`disabledAgentSkillIds`). The step's own skills are never affected, and
    // a skill that is both the step's and the agent's stays with the step.
    const disabled = new Set(clean(step && step.disabledAgentSkillIds));
    const own = new Set(attachedSkillIds);
    return {
        attachedSkillIds,
        sessionSkillIds: binding
            ? clean(binding.config.attachedSkillIds).filter((id) => !disabled.has(id) && !own.has(id))
            : [],
    };
}

/**
 * The tool stack for an agent-driven AI step.
 *
 * @param {{ binding: Awaited<ReturnType<typeof resolveStepAgent>>, ctx: import('./toolIdentity').IdentityCtx,
 *   extraTools?: AgentTool[], extraToolsStartAutomations?: boolean, allowList?: string[]|null,
 *   skillApps?: string[]|null, skillAutomationIds?: string[]|null,
 *   deps?: { integrationTools?: typeof import('../integrations/integrationTools') } }} opts
 *   `binding` is the result of `resolveStepAgent`; `ctx` the run context (the ASKER is `ctx.userId`).
 *   `extraTools` are tools from outside the catalogue (e.g. `activate_skill`). Those go through the
 *   same subtraction AND past the switch that governs them, so there is no second door beside the gate.
 *   `extraToolsStartAutomations`: `extraTools` may start an automation (a skill with an
 *   `automationId` runs `executeAutomation` as soon as the model calls `activate_skill`). Then they
 *   hang on `startAutomations`, like every other automation starter.
 *   `allowList` is `step.tools`, if the author set it explicitly; can only narrow.
 * @returns {Promise<{tools: Array, withheld: string[], reasons: Object,
 *   degraded: boolean, catalogError: string|null}>}
 */
async function agentToolsForStep({ binding, ctx, extraTools = [], extraToolsStartAutomations = false, allowList = null, skillApps = null, skillAutomationIds = null, deps = {} }) {
    const out = { tools: [], withheld: [], reasons: {}, degraded: false, catalogError: null };
    if (!binding) return out;
    // Handoff 5: what the step's skills grant, already filtered by the step's
    // switches in execAi (aiStepSkills.grantsUnderPermissions). Apps widen the
    // catalog the way a skill does in chat (`extraEnabledApps`); automations join
    // a CURATED agent's automation grants. Both still pass every narrowing below.
    const { configWithSkillAutomations } = require('./aiStepSkills');
    const agentConfig = configWithSkillAutomations(binding.config, skillAutomationIds);
    const gatedBinding = agentConfig === binding.config ? binding : { ...binding, config: agentConfig };
    /**
     * @param {string | null} name
     * @param {string} reason
     */
    const dropped = (name, reason) => {
        if (!name) return;
        if (!(name in out.reasons)) out.reasons[name] = reason;
        out.withheld.push(name);
    };

    // One catalogue, two independent switches. `startAutomations` governs the automations
    // the agent may start and `useTools` the rest, so "automations only" is a valid
    // setting and must not quietly come to zero. Without either, nothing is built: that
    // saves the whole catalogue build on the step that gets nothing anyway.
    let catalogTools = [];
    if (binding.permissions.useTools || binding.permissions.startAutomations) {
        try {
            const { getIntegrationTools } = deps.integrationTools || require('../integrations/integrationTools');
            // Connection lending (gated, default off): same shape as execIntegrationAction,
            // so the two catalogues of one run do not drift apart.
            // When runPolicy.connections is 'caller', the catalogue is the intersection of
            // that of the OWNER and that of the STARTER (toolIdentity.js).
            const catalog = await permittedCatalog(ctx, getIntegrationTools, {
                // DELIBERATELY OFF, see the header. `automationStep` switches on exactly two
                // things (`automation-evolution` and `kb-ingest`), and those are the two apps
                // the agent picker could never show. An agent thus gets the same apps as in a
                // conversation, plus nothing that its owner could never have refused.
                automationStep: false,
                lend: true,
                // The agent's per-action grants. Also the path by which `tools.automations`
                // narrows the automation set of the asker.
                //
                // `useKnowledge` decides on the KNOWLEDGE half of it: `getIntegrationTools`
                // offers `kb_search` on the mere presence of `knowledge_base_ids`, so a step
                // with useKnowledge OFF and useTools ON got a tool that explicitly does
                // "search this agent's knowledge base". The grants remain; only the knowledge
                // list is emptied, and that can only narrow.
                agentConfig: _catalogConfig(gatedBinding),
                // The automations bound to THIS agent are the ones the step may
                // start; the step has no other route to an agent_call automation.
                agentId: binding.agentId || null,
                // Apps the step's skills enable (only when useTools is on; the
                // caller filtered them). Bypasses the personal app toggle only,
                // exactly as in chat; org and group grants still decide.
                extraEnabledApps: Array.isArray(skillApps) && skillApps.length ? skillApps : null,
            });
            catalogTools = Array.isArray(catalog && catalog.tools) ? catalog.tools : [];
        } catch (e) {
            // A catalogue that cannot be built yields no tools. For a step that can also
            // give an answer without tools, that is the right failure: narrow, and visible
            // in the run log.
            out.catalogError = e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : 'integration catalog unavailable';
            log.warn(`[AutomationRunner] ai_step agent tool catalog lookup failed: ${out.catalogError}`);
            catalogTools = [];
        }
    }

    // Each tool passes the switch that governs it: `extraTools` included, because a
    // tool that comes in from outside the catalogue is not a tool that comes in past
    // the switches. The automation tools are recognised by their own marker and are
    // not dropped by leaving out `agentConfig`: that would ALSO switch off the
    // per-action grants on all other tools, and that is a widening.
    const extras = [];
    for (const t of Array.isArray(extraTools) ? extraTools : []) {
        const name = _toolName(t);
        if (!name || extras.some((x) => _toolName(x) === name)) continue;
        extras.push(t);
    }
    const bySwitch = [];
    for (const t of catalogTools) {
        const allowed = _startsAutomation(t)
            ? binding.permissions.startAutomations
            : binding.permissions.useTools;
        if (allowed) { bySwitch.push(t); continue; }
        dropped(_toolName(t), 'permission');
    }
    for (const t of extras) {
        // Skills belong to what the agent IS: they do not sit behind `useTools`.
        // `activate_skill` is the exception once one of the injected skills has an
        // automation behind it: `executeActivateSkill` then runs
        // `executeAutomation(..., mode: 'live')`, and that is exactly what
        // `startAutomations` governs.
        if (extraToolsStartAutomations && !binding.permissions.startAutomations) {
            dropped(_toolName(t), 'permission');
            continue;
        }
        if (bySwitch.some((x) => _toolName(x) === _toolName(t))) continue;
        bySwitch.push(t);
    }

    // An EXPLICIT `step.tools` remains the allowlist it also is on a plain ai_step:
    // it can only narrow. `[]` means "no tools", not "all": same reading as the
    // existing path in execAi.
    let merged = bySwitch;
    if (Array.isArray(allowList)) {
        const allowed = new Set(allowList.filter((n) => typeof n === 'string' && n));
        merged = merged.filter((t) => allowed.has(_toolName(t)));
    }

    const gate = withholdConfirmTools(merged, gatedBinding.config);
    // Every definition this step was offered or refused, so a reader (the
    // step editor's preview) can say which app a withheld NAME belongs to.
    out.toolDefs = [...catalogTools, ...extras];
    out.tools = gate.tools;
    for (const name of gate.withheld) dropped(name, gate.reasons[name] || 'unavailable');
    out.degraded = gate.degraded;
    if (gate.policyError) out.catalogError = out.catalogError || gate.policyError;
    return out;
}

/**
 * The agent config as the CATALOGUE may see it.
 *
 * ── THE KNOWLEDGE LIST ALWAYS GOES OUT ─────────────────────────────
 * `getIntegrationTools` offers `kb_search` on the mere PRESENCE of `knowledge_base_ids`.
 * That caused two problems at once. With `useKnowledge: false` and `useTools: true`,
 * the step got a tool that explicitly does "search the knowledge bases of this agent",
 * the permission that had just been switched off. And with `useKnowledge: true` it got
 * a tool that ALWAYS fails: the dispatch context that `execAi` builds carries no
 * `agentId`, so `kb_search` reads `getForRuntime(undefined)` and answers "No knowledge
 * base configured".
 *
 * The knowledge of the agent reaches this step via the path that does exist for it:
 * `knowledgeBaseIdsForStep` puts the bases in the union, and `execAi` searches them once
 * per run, with the automation owner as the asker. Offering a tool that cannot work is a
 * promise to the model that goes nowhere, so it is not offered. (If you want it later,
 * pass `agentId` in the dispatch context of execAi, but then that also switches on
 * `datatable_query`, and that is a second decision.)
 *
 * The grants go along untouched: leaving them out would switch off the per-action
 * restrictions on ALL tools. A shallow copy: `binding.config` is the shared runtime
 * projection and must not be mutated.
 */
function _catalogConfig(binding) {
    const config = binding.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    if (!Array.isArray(config.knowledge_base_ids) || config.knowledge_base_ids.length === 0) return config;
    return { ...config, knowledge_base_ids: [] };
}

module.exports = {
    AGENT_PERMISSION_KEYS,
    WITHHOLD_REASONS,
    _resetAgentContextApps,
    stepAgentPermissions,
    resolveStepAgent,
    knowledgeBaseIdsForStep,
    skillIdsForStep,
    withholdConfirmTools,
    agentToolsForStep,
};

/**
 * @typedef {import('./aiStepToolWithhold').WithholdTool} AgentTool
 * @typedef {import('./aiStepSkills').StepAgentConfig} StepAgentConfig
 * @typedef {{ userId?: string|null, orgId?: string|null, userHomeOrgId?: string|null, identityError?: string|null,
 *             userGroupIds?: string[] }} StepAgentCtx  the run context, as far as the agent gate reads it
 * @typedef {{ id?: string, owner_id?: string|null, is_published?: boolean, organization_id?: string|null,
 *             shared_groups?: unknown, runtimeSource?: string, published_version?: unknown,
 *             name?: string, config?: StepAgentConfig, system_prompt?: unknown }} StepAgentRow  an agent as getForRuntime serves it
 * @typedef {{ agentId?: unknown, agentPermissions?: unknown, knowledgeBaseIds?: string[], skillIds?: unknown[],
 *             disabledAgentSkillIds?: unknown[], [k: string]: unknown }} AgentAiStep  the agent fields of an ai_step
 * @typedef {{ tools: AgentTool[], withheld: string[], reasons: Record<string, string>, degraded: boolean,
 *             catalogError: string|null, toolDefs?: AgentTool[] }} AgentToolsResult
 */

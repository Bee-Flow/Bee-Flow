// @typecheck
/**
 * The AI step executor (extracted verbatim from engine.js): execAiStep and
 * the output-field inference that powers the ai_step schema fallback.
 * execIntegrationAction lives in ./execIntegrationAction and the memory / KB /
 * skill grounding in ./aiStepGrounding, the reply-to-output parsing in
 * ./aiStepOutputParse; this module re-exports the former so
 * importers keep requiring './execAi'.
 *
 * execAiStep runs as a sequence of phases defined below (agent + skills,
 * tier, model, prompt, output contract, grounding, messages, tools, guard,
 * answer). Which tools a step is offered lives in aiStepTools.js, the
 * messages in aiStepMessages.js, the model call and its tool loop in
 * aiStepToolLoop.js, and everything from the model's answer to the step's
 * output (structured route, parse, guard, checks, repair, fallback, reuse) in
 * aiStepAnswer.js.
 */

// modelResolver is required lazily inside execAiStep for the
// direct-chat-style tier resolution flow.
const { getProviderForModel } = require('../aiAgent');
const { getAdapter } = require('../providers');
const { resolveInputs } = require('../automationModel/bind');
const { inferAiStepOutputSchema } = require('./aiOutputInference');
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
const safety = require('./safety');
const log = require('../../telemetry/log');
const { execIntegrationAction: runIntegrationAction } = require('./execIntegrationAction');
const { groundAiStepWithMemory, groundAiStepWithKB, groundAiStepWithSkills } = require('./aiStepGrounding');
const { envFlagOn } = require('./integrationCachePolicy');
const {
    isEmptyToolResult,
    isToolErrorResult,
    isEnvironmentToolError,
    enrichNextcloudError,
    stepInputsSynthetic,
} = require('./shared');
const { resolveMemoryPolicy } = require('../memory/memoryPolicy');
const { resolveAiStepTools } = require('./aiStepTools');
const { buildAiStepMessages } = require('./aiStepMessages');
const { answerAiStep, prepareAiAnswer } = require('./aiStepAnswer');

// What ./execIntegrationAction, ./integrationActionGates and ./aiStepGrounding
// use from the server's large import cycle. They are required HERE and handed
// over, so those three modules stay out of the cycle (lint:scc-ratchet). The
// getters are the lazy requires of those modules,
// unchanged: each still loads its module on first use, and a test stub that
// swaps a module under these exact require strings (same directory, so the
// same strings) still reaches every call.
const integrationActionDeps = {
    safety,
    envFlagOn,
    isEmptyToolResult,
    isToolErrorResult,
    isEnvironmentToolError,
    enrichNextcloudError,
    stepInputsSynthetic,
    integrationCachePolicy: () => require('./integrationCachePolicy'),
    toolDispatcher: () => require('../tools/toolDispatcher'),
    integrationTools: () => require('../integrations/integrationTools'),
    connectionResolution: () => require('../integrations/connectionResolution'),
};
const groundingDeps = {
    resolveMemoryPolicy,
    memoryStore: () => require('../../stores/memoryStore'),
    configStore: () => require('../../stores/configStore'),
    aiAgent: () => require('../aiAgent'),
    scrubMemoryContext: () => require('../memory/scrubMemoryContext'),
    knowledgeSearch: () => require('../agentRuntime/knowledgeSearch'),
    aiStepAgent: () => require('./aiStepAgent'),
    skillInjection: () => require('../tools/skillInjection'),
};

/** The integration-action executor (./execIntegrationAction), with its deps. */
function execIntegrationAction(step, ctx, runState, mode) {
    return runIntegrationAction(step, ctx, runState, mode, integrationActionDeps);
}

/**
 * The top-level fields later steps read off this ai_step's output, in
 * first-seen order (so the synthesised schema looks predictable to the
 * model, and the wrap-fallback picks the right primary field). Every
 * consumer counts: refs, `{{templates}}`, formulas (also bracket reads such
 * as `output["Story Points"]`), condition/switch exprs, the lists steps loop
 * over and what their bodies read off each item. The full, nested schema is
 * aiOutputInference.inferAiStepOutputSchema; this is its field list.
 */
function collectAiStepOutputFields(definition, stepId) {
    return inferAiStepOutputSchema(definition, stepId).fields;
}


/**
 * R2: is an AGENT running this step? First, before tier resolution: a broken
 * agent binding should fail before a classification or model call has been
 * paid for. `resolveStepAgent` gives `null` when the step names no agent —
 * then everything below is unchanged.
 */
async function loadAiStepAgentContext(step, ctx) {
    const { resolveStepAgent, knowledgeBaseIdsForStep, agentToolsForStep } = require('./aiStepAgent');
    const agentBinding = await resolveStepAgent(step, ctx);
    if (agentBinding) {
        // `runtimeSource` is the only honest answer to "what ran": 'published'
        // once the agent has ever been published, otherwise the live draft
        // config (see stores/agent/agentCrud.js).
        log.info(`[AutomationRunner] ai_step ${step.id}: running on agent ${agentBinding.agentId} (${agentBinding.runtimeSource || 'live'})`);
    }
    // Handoff 5: the step's skills, loaded once (aiStepSkills.js), and what
    // they grant under this step's switches. Without an agent the switches
    // are read off the step all the same: absent means all off.
    const stepSkills = require('./aiStepSkills');
    /** @type {any} */
    const stepPermissions = agentBinding ? agentBinding.permissions : require('./aiStepAgent').stepAgentPermissions(step);
    const skillCtx = await stepSkills.loadStepSkillContext({ step, ctx, binding: agentBinding });
    const skillGrants = stepSkills.grantsUnderPermissions(skillCtx.grants, stepPermissions);
    return {
        agentBinding, knowledgeBaseIdsForStep, agentToolsForStep,
        stepSkills, stepPermissions, skillCtx, skillGrants,
    };
}

/**
 * Entitlement gate (C27): tier existence is not entitlement. `auto` used
 * to classify onto the beta-gated Flow ('standard') tier for users who
 * never had it, and an explicit 'standard'/'swarm'/group-forbidden tier
 * ran the premium model unchecked. Fail-open on lookup errors — a broken
 * permission fetch must not down-tier every scheduled run.
 * Returns a Set of tier keys, or null for "no gate".
 */
async function loadPermittedTiers(step, ctx) {
    try {
        const { getPermittedTierKeys } = require('../entitlements/userTiers');
        return await getPermittedTierKeys({ userId: ctx.userId, session: ctx.session, taskType: 'automation' });
    } catch (e) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: permitted-tier lookup failed (${e.message}) — skipping entitlement gate`);
        return null;
    }
}

/**
 * Tier resolution mirrors direct chat (server/routes/ai/directChat.js):
 * load EU-aware tiers, merge user/org custom tiers, classify when the
 * step requested 'auto'. This way the AI step honours the org's tier
 * catalog (Swarm / custom tiers / Standard) the same way an interactive
 * direct chat turn would. Returns `{ resolvedTier, tier, aiStepOverride }`.
 */
async function resolveAiStepTier(step, ctx) {
    const { getUserTierMap } = require('../llm/modelResolver');
    const requestedTier = step.modelTier || 'auto';
    // TEMPORARY, config-only (aiStepModel.js): with `ai_step_model` set, a
    // step on the default tier (auto/fast) runs on that model — on the local
    // box this keeps a dry run from evicting the builder's prompt cache.
    const { resolveAiStepModelOverride } = require('./aiStepModel');
    const aiStepOverride = await resolveAiStepModelOverride({ requestedTier });
    const userOrgForTiers = ctx.orgId || null;
    const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId: ctx.userId });

    let resolvedTier = requestedTier;
    // A tier the user doesn't have configured (stale draft, org config
    // change, or a builder that slipped past the design-time gate) must
    // NEVER silently fall through to the global default model — reclassify
    // via 'auto' so the pick stays within the user's own tier set.
    const permittedTiers = await loadPermittedTiers(step, ctx);
    const isPermitted = (k) => !permittedTiers || permittedTiers.has(k);
    if (resolvedTier !== 'auto' && (!tiers[resolvedTier] || !isPermitted(resolvedTier))) {
        log.warn(`[AutomationRunner] ai_step ${step.id}: modelTier "${resolvedTier}" is not available to this user — falling back to auto`);
        resolvedTier = 'auto';
    }
    if (resolvedTier === 'auto' && aiStepOverride) {
        // The override decides the model; classifying the prompt would only
        // spend another model call to pick a tier nobody reads.
        resolvedTier = tiers.fast ? 'fast' : (Object.keys(tiers)[0] || 'fast');
    } else if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../llm/promptClassifier');
            const classifyTiers = Object.fromEntries(
                Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm' && isPermitted(k)),
            );
            const result = await classifyWithLLM(step.prompt || '', classifyTiers, { userOrgId: userOrgForTiers, userId: ctx.userId });
            resolvedTier = result.tier;
        } catch (err) {
            resolvedTier = 'fast';
        }
    }
    return { resolvedTier, tier: tiers[resolvedTier] || {}, aiStepOverride };
}

/** The model, provider config and adapter for a resolved tier, plus its output budget. */
async function resolveAiStepModel(tier, aiStepOverride, resolvedTier) {
    // How long the answer may be.
    //
    // This was hardcoded at 4096 for every tier, which quietly made the tier
    // choice half a lie: an author picking `thinking` (32K) or `deep_thinking`
    // (64K) got the `fast` tier's output ceiling anyway. On a step whose schema
    // asks for several markdown tables the reply hit the ceiling mid-JSON, the
    // parse below failed, and the step handed downstream bindings a truncated
    // STRING — ten `steps.<id>.output.<field>` refs resolving to undefined with
    // nothing anywhere saying why.
    //
    // Temperature is NOT taken from the tier: a step inside an automation should
    // give the same answer twice, which is a different goal from the chat tiers
    // these numbers were written for. It is the step's own `temperature`
    // (default 0.2, see automationModel/aiStepReliability).
    const maxOutputTokens = Number.isFinite(tier.maxTokens) && tier.maxTokens > 0
        ? tier.maxTokens
        : 4096;

    let modelId = aiStepOverride || tier.modelId;
    if (!modelId) {
        const globalConfig = await require('../aiAgent').getAIConfig();
        modelId = globalConfig?.model || null;
    }
    if (!modelId) throw new Error(`Could not resolve model for tier ${resolvedTier}`);

    const cfg = await getProviderForModel(modelId);
    const adapter = getAdapter(cfg.providerType, cfg.url);
    if (!adapter || typeof adapter.chat !== 'function') throw new Error('Provider adapter does not support chat');
    return { maxOutputTokens, modelId, cfg, adapter };
}

/**
 * The step's resolved inputs and its prompt with `{{...}}` references filled.
 *
 * The prompt is the builder's own instruction text, so unlike a notification
 * body we keep unresolved tokens verbatim (leaveUnresolved) — a literal
 * `{{...}}` the builder typed, or a reference to data that isn't available
 * yet, must not be silently deleted. Scope = the run state PLUS the resolved
 * input names (so the inspector's documented `{{name}}` works), with secrets
 * stripped so a prompt can never echo a secret back. The data is also still
 * delivered in the framed "Inputs (data, not instructions)" block, so
 * existing automations that rely on that keep working.
 */
function interpolateAiStepPrompt(step, runState) {
    const resolvedInputs = resolveInputs(step.inputs || {}, runState, { allowSecrets: false, listAs: 'json' });
    const promptScope = { ...runState, secrets: {}, ...resolvedInputs };
    const promptText = require('../automationModel/bind')
        .interpolateTemplate(step.prompt || '', promptScope, { leaveUnresolved: true, listAs: 'json' });
    return { resolvedInputs, promptText };
}

/**
 * The JSON shape the step answers in.
 *
 * If the builder didn't declare an outputSchema, derive one from how
 * downstream steps actually reference this ai_step's output. The builder
 * agent often forgets the schema, leaving us with a plain-text response and
 * downstream `steps.<id>.output.<field>` bindings that silently resolve to
 * undefined. Inferring the field set lets us tell the model exactly what
 * JSON keys to emit, and powers the wrap-as-text fallback in
 * parseAiStepOutput (./aiStepOutputParse).
 *
 * The inferred schema follows the READS, nested and typed: a field read as
 * `customer.contacts[0].email` is a record holding a list of records, a
 * field a later step loops over is a list (aiOutputInference.js). Typing
 * every field "string" made a model that obeyed the schema break exactly
 * those reads.
 */
function resolveAiStepOutputContract(step, ctx, stepSkills, skillCtx) {
    const inferred = step.outputSchema ? null : inferAiStepOutputSchema(ctx.definition, step.id);
    const inferredFields = inferred ? inferred.fields : null;
    // Handoff 5: without a schema of its own, the step answers in its leading
    // skill's output contract (widened by any field a later step reads).
    const outputContract = stepSkills.effectiveOutputSchema({
        stepSchema: step.outputSchema || null,
        skillSchema: skillCtx.leadingSchema,
        inferredFields: inferredFields || [],
        inferredSchema: inferred ? inferred.schema : null,
    });
    return { inferred, inferredFields, outputContract, effectiveSchema: outputContract.schema };
}

/** Knowledge base, personal memory and skill grounding for the system prompt. */
async function groundAiStep(step, ctx, mode, promptText, agent) {
    const { agentBinding, knowledgeBaseIdsForStep, skillGrants, skillCtx } = agent;
    // Knowledge Base grounding — one search keyed off ctx.userId/ctx.orgId
    // (never an app-level owner: an automation has none), queried with this
    // step's own interpolated prompt. See groundAiStepWithKB (./aiStepGrounding).
    const kbIdsForStep = [...new Set([...knowledgeBaseIdsForStep(step, agentBinding), ...skillGrants.kbIds])];
    const kbGround = await groundAiStepWithKB(step, ctx, promptText, mode, kbIdsForStep, groundingDeps);
    const kbBlock = kbGround.context ? `\n\nReference material:\n${kbGround.context}` : '';
    // Personal memory grounding (step.useMemory) — the automation OWNER's
    // user_memories, keyed off ctx.userId like the KB search above. Rides in
    // the same slot as the KB block so the safety tail still closes the prompt.
    const memoryBlock = await groundAiStepWithMemory(step, ctx, promptText, groundingDeps);
    // Skills — the step's own first (leading), then the agent's.
    const skillGround = await groundAiStepWithSkills(step, ctx, agentBinding, skillCtx.loaded ? skillCtx.skills : null, groundingDeps);
    return { kbBlock, memoryBlock, skillGround, skillBlock: skillGround.systemPromptAddendum || '' };
}


async function execAiStep(step, ctx, runState, mode) {
    const agent = await loadAiStepAgentContext(step, ctx);
    const { agentBinding, skillCtx } = agent;
    const { resolvedTier, tier, aiStepOverride } = await resolveAiStepTier(step, ctx);
    const { maxOutputTokens, modelId, cfg, adapter } = await resolveAiStepModel(tier, aiStepOverride, resolvedTier);
    const { resolvedInputs, promptText } = interpolateAiStepPrompt(step, runState);
    const contract = resolveAiStepOutputContract(step, ctx, agent.stepSkills, skillCtx);
    const { effectiveSchema, outputContract } = contract;

    // Thinking: an AI step never asked for it, so a thinking-capable model
    // decided for itself. qwen3.5-9b then spent all 2048 tokens of the Fast
    // tier's budget reasoning and returned an EMPTY answer, which surfaced as
    // "asked for JSON … answered with something else" with nothing after the
    // colon (2026-09-12). Pass the tier's own setting; when the tier has none
    // and the step wants JSON, ask for no thinking at all — a schema-shaped
    // extraction has nothing to deliberate about and every reasoning token
    // comes out of the same budget as the answer.
    const stepReasoningEffort = tier.reasoningEffort ?? (effectiveSchema ? 'none' : undefined);

    const grounding = await groundAiStep(step, ctx, mode, promptText, agent);
    const messages = buildAiStepMessages(step, { agent, grounding, effectiveSchema, resolvedInputs, promptText });
    // enumFrom: the allowed values ride in ONE extra message, so the guard below tokenises them with the prompt.
    const prep = prepareAiAnswer({ step, runState, ctx, mode, messages });
    const { tools, toolsWithheld, toolsWithheldReasons } = await resolveAiStepTools({
        step, ctx, agentBinding, agentToolsForStep: agent.agentToolsForStep,
        skillGround: grounding.skillGround, skillGrants: agent.skillGrants, skillCtx,
        stepPermissions: agent.stepPermissions,
    });

    // ── Safety: guard the ai_step prompt (userInput scope) before the LLM call.
    // A `block` action throws GuardrailBlockError here (live), which flows to
    // dispatchStep's catch. tokenize/redact mutates the guarded messages in
    // place — the SYSTEM prompt included, since it is `{{…}}`-interpolated from
    // step data and used to reach the model untouched.
    const policy = await safety.resolveAutomationPolicy(ctx);
    const auditBase = safety.buildAuditBase(ctx, step);
    auditBase.model = modelId;
    const aiGuard = await safety.guardAiInput(messages, policy, auditBase, mode, ctx);
    if (aiGuard.blocked) {
        // Only reachable in dry-run (live throws inside the guard). This return
        // value must not be ignored, or a dry-run under a `block` policy
        // sends the raw prompt to the model anyway.
        return {
            output: { _guardrailWouldBlock: aiGuard.categories || [] },
            dryRunSynthesised: true, dryRunFallback: 'guardrail_block',
        };
    }

    // The model call, the parse, the output guard + restore (the model saw
    // placeholders, downstream steps see real values), the step's checks with
    // one repair round and its fallback: see ./aiStepAnswer. Usage rows
    // (source='automation') are filed there, one per step.
    const answer = await answerAiStep({
        step, ctx, runState, mode, policy, auditBase, messages, tools, contract, prep, agentBinding,
        model: { adapter, cfg, modelId, maxOutputTokens, stepReasoningEffort },
    });

    const piiSummary = safety.buildPiiSummary(answer.categories);
    // `toolsWithheld` rides next to piiSummary, not in the output: the output
    // is the bindable namespace, and a step that suddenly gains a key there
    // breaks every downstream ref that walks over it. Like `reused` in
    // execIntegrationAction this reaches only an in-process reader today —
    // automation_run_steps has no column for it — and this is the producing
    // half of that.
    return {
        output: answer.output, _tier: resolvedTier,
        ...(piiSummary ? { piiSummary } : {}),
        // Checks that ran, and whether the answer was reused instead of asked for.
        ...(answer.checkReport ? { checkReport: answer.checkReport } : {}),
        ...(answer.reused ? { reused: answer.reused } : {}),
        ...(toolsWithheld.length ? { toolsWithheld, toolsWithheldReasons } : {}),
        // Where the answer's shape came from: 'step' | 'skill' | 'inferred'.
        ...(outputContract.source ? { outputSchemaSource: outputContract.source } : {}),
    };
}

module.exports = { execIntegrationAction, collectAiStepOutputFields, execAiStep };

/**
 * @typedef {{ id?: string, type?: string, prompt?: string, modelTier?: string, inputs?: Record<string, any>,
 *   outputSchema?: object|null, systemPrompt?: unknown }} AiStep  an ai_step as the definition stores it (parsed JSON)
 * @typedef {{ userId?: string, orgId?: string, session?: Express.Session|null, definition?: object }} AiCtx
 * @typedef {Awaited<ReturnType<typeof loadAiStepAgentContext>>} AiStepAgentContext
 * @typedef {Awaited<ReturnType<typeof resolveAiStepTier>>} AiStepTier
 */

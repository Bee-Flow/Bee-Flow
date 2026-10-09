/**
 * Automations as agent tools — §28.
 *
 * When an automation declares trigger.kind === 'agent_call', it becomes
 * addressable as a function-calling tool, but ONLY by the agents it is bound
 * to (automation_agent_bindings, automation/agentBinding.js). No agent, no
 * access: direct chat without an agent, Cowork / AI tasks, voice without an
 * agent and the /mcp endpoint are offered none of them. The agent calls the
 * tool with structured arguments; this module renders the per-tool schema from
 * the automation's declared input shape and invokes the runner with those
 * arguments as the trigger payload.
 *
 * Public API:
 *   - getAgentCallableTools({ agentId }) → tool[] bound to that agent, suitable
 *     for dropping into the agent runtime's tool list.
 *   - dispatchAgentCallableTool(toolMeta, args, ctx) → re-checks the binding
 *     and invokes the automation synchronously, returning the run's final output.
 *
 * The run executes as the automation's OWNER, whoever asked: the binding is the
 * agent's right to call it, so the asker needs no run rights of their own. The
 * asker and the agent are recorded on the run (startedByUserId, callerAgentId).
 *
 * The tool catalog (server/automation/toolRegistry.js) doesn't list
 * these — they're per-agent and per-automation, so they're discovered
 * dynamically at agent-runtime construction time. Phase 2 work moves
 * them into the unified catalog (§15).
 */

const automationStore = require('../stores/automationStore');
// Handoff 5: an agent sees, and runs, the LIVE definition of an automation.
const { automationForRun } = require('../core/automationRunner/definitionForRun');
const log = require('../telemetry/log');
// The tool name is declared by the builder too, so the rule lives in one place.
const { sanitizeToolName, MAX_TOOL_DESCRIPTION_LEN } = require('./agentCallContract');

/**
 * Convert an automation into the OpenAI/Anthropic-shaped function
 * schema the agent runtime expects.
 */
function automationToTool(automation, { agentId = null } = {}) {
    if (!automation || !automation.definition) return null;
    const trigger = automation.definition.trigger;
    if (!trigger || trigger.kind !== 'agent_call') return null;

    const toolName = sanitizeToolName(trigger.toolName || `automation_${automation.id}`);
    // Cut to the cap the builder enforces on what it writes: the canvas textarea
    // allows more, and validation only warns about it.
    const description = String(trigger.description
        || automation.description
        || `Run the "${automation.title || 'Untitled automation'}" automation.`).slice(0, MAX_TOOL_DESCRIPTION_LEN);
    const parameters = normalizeParameters(trigger.parametersSchema);

    return {
        type: 'function',
        function: {
            name: toolName,
            description,
            parameters,
        },
        // Non-standard metadata used by the dispatcher to route the call
        // back to the right automation. Not sent to the LLM.
        __automation: {
            id: automation.id,
            userId: automation.userId,
            organizationId: automation.organizationId || null,
            // The agent this tool was offered to; dispatch reads the caller's
            // agent from its own context and re-checks the binding, never this.
            ...(agentId ? { agentId } : {}),
        },
    };
}

/**
 * The agent-callable automations bound to one agent, shaped as function tools
 * ready to register with it. Active automations whose LIVE definition is an
 * agent trigger, whose binding exists and whose owner may still use the agent;
 * anything else is simply not offered. Without an agent there is nothing to
 * offer, and a lookup that fails offers nothing (fail closed).
 *
 * Offering is advisory: dispatchAgentCallableTool decides again at call time.
 * `forDispatch` is the lookup that call makes to find which automation a tool
 * NAME means: it keeps paused automations and ones whose owner can no longer
 * use the agent, so dispatchAgentCallableTool can refuse them with a sentence
 * instead of the model hearing "unknown tool".
 *
 * `deps` is the test seam: { automationStore, agentBinding }.
 *
 * @param {{ agentId?: string|null, forDispatch?: boolean }} p
 */
async function getAgentCallableTools({ agentId = null, forDispatch = false } = {}, deps = {}) {
    if (!agentId) return [];
    const store = deps.automationStore || automationStore;
    const binding = deps.agentBinding || require('./agentBinding');
    let bound;
    try { bound = await store.listAutomationsBoundToAgent(agentId); }
    catch (e) {
        log.warn(`[agentCallableTools] bindings of agent ${agentId} unreadable — offering none: ${e.message}`);
        return [];
    }
    const tools = [];
    const ownerVerdict = new Map();
    for (const a of bound) {
        if (!forDispatch && !a?.isActive) continue;
        const tool = automationToTool(automationForRun(a, { mode: 'live' }), { agentId });
        if (!tool) continue;
        if (!forDispatch) {
            if (!ownerVerdict.has(a.userId)) {
                ownerVerdict.set(a.userId, await binding.ownerMayUseAgent(a.userId, agentId, { deps }));
            }
            if (!ownerVerdict.get(a.userId)) continue;
        }
        tools.push(tool);
    }
    return tools;
}

/**
 * Who is starting an automation as a tool, from the dispatch context.
 *
 * `callerAgentId` is set by an AI step that runs on an agent (execAi passes it
 * under its own key, never as `agentId`, which would switch on agent-scoped
 * tools); a chat agent's own `agentId` counts as well. `runScope` is present
 * when the call comes from inside an automation run.
 */
function callerTraceOf(ctx) {
    const c = ctx || {};
    const runScope = c.runScope && typeof c.runScope === 'object' ? c.runScope : null;
    return {
        callerAgentId: c.callerAgentId || c.agentId || null,
        callerConversationId: c.callerConversationId || c.conversationId || null,
        callerRunId: (runScope && runScope.runId) || null,
        callerRootRunId: (runScope && (runScope.rootRunId || runScope.runId)) || null,
    };
}

/**
 * The runner options that record who started the automation (handoff 5).
 *
 * The caller's RUN is deliberately not written into parent_run_id /
 * root_run_id: those mean "the run this one replays" and "the journey this
 * leg belongs to". The resume path walks parent_run_id to replay step rows,
 * and the run lists hide every row whose root_run_id is not its own id, so a
 * cross-automation link there would replay another automation's steps and hide this
 * run from its own history. The chain lives in the call frame
 * (automationCallDepth.js) until the schema has a column of its own for it.
 */
function runnerTraceOptions(trace, ctx) {
    // The person who asked, never an acting or borrowed integration identity
    // (`userId` may be one); the dispatcher passes the asker under its own key.
    const asker = (ctx && (ctx.askerUserId || ctx.userId)) || null;
    return {
        callerAgentId: trace.callerAgentId,
        callerConversationId: trace.callerConversationId,
        // Whenever a person asked (chat, voice, a call without a conversation id),
        // they are recorded; a missing conversation id must not erase them. Inside
        // an automation run (callerRunId) the owner is already the run's user and
        // nobody asked, so nothing is added.
        ...(asker && !trace.callerRunId ? { startedByUserId: asker } : {}),
    };
}

/**
 * A call the binding does not allow. Carries a `code` so the tool result reads
 * `{ error, code }` (toolErrorFor) and names no agent or automation.
 */
class AgentCallRefusedError extends Error {
    constructor(message, code = 'agent_not_allowed') {
        super(message);
        this.name = 'AgentCallRefusedError';
        this.code = code;
    }
}

/**
 * Invoke an agent-callable automation. The runner runs synchronously
 * (no scheduler hop) and the final step's output is returned verbatim
 * to the calling agent.
 *
 * AUTHORITATIVE and independent of what was offered: every call re-reads the
 * automation and checks, now, that its LIVE definition is an agent trigger, that
 * it is active, that the calling agent is bound to it and that the owner may
 * still use that agent, then reads the agent's own curation (granted in
 * config.tools.automations, and 'ask' only through a surface with a confirm
 * layer: ctx.confirmLayer). The agent is the one in the server-built ctx
 * (callerAgentId, else agentId), never anything the model sent in `args`. A
 * refusal throws AgentCallRefusedError and is logged (ids only).
 *
 * `ctx` carries the caller: the agent, the asker (askerUserId, else userId), the
 * conversation and the run scope (see callerTraceOf). The run is started as the
 * automation's owner whoever asked.
 *
 * Refuses with `automation_call_depth_exceeded` when agents are already
 * MAX_AUTOMATION_CALL_DEPTH automation starts deep (automationCallDepth.js).
 *
 * `deps` is the test seam: { automationStore, automationRunner, agentBinding }.
 */
async function dispatchAgentCallableTool(toolMeta, args, ctx, deps = {}) {
    if (!toolMeta?.id) throw new Error('dispatchAgentCallableTool: missing automation id');
    const store = deps.automationStore || automationStore;
    const trace = callerTraceOf(ctx);
    const refuse = (reason, message, code) => {
        log.info(`[agentCallableTools] refused automation=${toolMeta.id} agent=${trace.callerAgentId || 'none'} reason=${reason}`);
        return new AgentCallRefusedError(message, code);
    };

    const automation = automationForRun(await store.getAutomation(toolMeta.id), { mode: 'live' });
    if (!automation) throw refuse('automation_missing', 'This automation no longer exists.');
    const trigger = automation.definition && automation.definition.trigger;
    if (!trigger || trigger.kind !== 'agent_call') {
        throw refuse('not_agent_call', 'This automation is no longer an agent tool.');
    }
    if (!automation.isActive) {
        throw refuse('inactive', 'Automation is not active — activate it first or use the manual run endpoint.', 'automation_inactive');
    }
    const binding = deps.agentBinding || require('./agentBinding');
    const verdict = await binding.agentMayCall({ automation, agentId: trace.callerAgentId, deps: { ...deps, store } });
    if (!verdict.ok) {
        throw refuse(verdict.reason, 'This agent is not allowed to call this automation.');
    }
    // The agent's own curation on top of the binding (granted? asks first?). The
    // offer applies it too, but voice and the non-streaming chat dispatch any
    // name the model emits, so it is decided again here.
    const grant = await binding.agentGrantVerdict({
        automation, agentId: trace.callerAgentId, confirmed: !!(ctx && ctx.confirmLayer === true), deps: { ...deps, store },
    });
    if (!grant.ok) {
        throw grant.reason === 'needs_confirmation'
            ? refuse(grant.reason, 'This automation needs the user\'s approval first, and this chat cannot ask for it.', 'confirmation_required')
            : refuse(grant.reason, 'This agent is not allowed to call this automation.');
    }

    // Lazy-require the runner so this module stays loadable from any
    // path (the runner pulls in db connections that would otherwise
    // bind at module-load time).
    const automationRunner = deps.automationRunner || require('../core/automationRunner');
    const { runNestedAutomationCall } = require('./automationCallDepth');
    const result = await runNestedAutomationCall(
        { automationId: automation.id, ...trace },
        () => automationRunner.executeAutomation(automation, {
            triggerKind: 'agent_call',
            triggerPayload: args || {},
            mode: 'live',
            ...runnerTraceOptions(trace, ctx),
        }),
    );
    return result?.lastOutput ?? null;
}

/**
 * The dispatcher's entry: find the automation a tool NAME means among the
 * calling agent's bound automations and start it. `{ handled: false }` when
 * there is no calling agent or no such tool (the dispatcher tries its next
 * matcher); otherwise `{ handled: true, result }`, where a refused or failed
 * start is the `{ error, code }` result the model reads.
 */
async function dispatchAgentCallableByName(toolName, toolArgs, ctx, deps = {}) {
    const agentId = callerTraceOf(ctx).callerAgentId;
    if (!agentId) return { handled: false };
    let match = null;
    try {
        const tools = await getAgentCallableTools({ agentId, forDispatch: true }, deps);
        match = tools.find((t) => t?.function?.name === toolName) || null;
    } catch (e) {
        log.warn('[agentCallableTools] agent-callable automation lookup failed:', e.message);
    }
    if (!match) return { handled: false };
    try {
        return { handled: true, result: await dispatchAgentCallableTool(match.__automation, toolArgs, ctx, deps) };
    } catch (e) {
        log.warn(`[agentCallableTools] automation ${match.__automation?.id} not started: ${e.message}`);
        return { handled: true, result: require('./automationCallDepth').toolErrorFor(e) };
    }
}

// ── Reusable Steps (kind='block') as chat/agent tools ──────
//
// A published Step the owner marked expose_as_tool=true becomes a function
// tool, named from its title, with a JSON-schema built from its layer_input
// params. Owner-only in v1 so it runs under the caller's own identity.

function paramTypeToJsonSchema(type) {
    switch (type) {
        case 'number': case 'integer': return 'number';
        case 'boolean': return 'boolean';
        case 'object': return 'object';
        case 'array': return 'array';
        default: return 'string';
    }
}

function stepToTool(step) {
    if (!step || !step.id) return null;
    const name = sanitizeToolName(step.title ? `step_${step.title}` : `step_${step.id}`);
    const properties = {};
    const required = [];
    for (const p of (step.params || [])) {
        if (!p || !p.name) continue;
        properties[p.name] = { type: paramTypeToJsonSchema(p.type), description: p.description || '' };
        if (p.required) required.push(p.name);
    }
    const parameters = { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    return {
        type: 'function',
        function: {
            name,
            description: step.description || `Run the "${step.title || 'Untitled'}" Step.`,
            parameters,
        },
        // Routing metadata — not sent to the LLM.
        __step: { id: step.id, userId: step.ownerId },
    };
}

/**
 * The published Steps a user exposed as chat tools. v1: owner-only, so we ask
 * the store for the caller's callable Steps (org list empty → owner rows only)
 * and keep the ones flagged expose_as_tool.
 */
async function getStepToolsForUser(userId) {
    if (!userId) return [];
    const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: [] }).catch(() => []);
    const tools = [];
    for (const s of callable) {
        if (s.ownerId !== userId || !s.exposeAsTool) continue;
        const tool = stepToTool(s);
        if (tool) tools.push(tool);
    }
    return tools;
}

/**
 * Invoke a Step tool — runs the published definition under the caller.
 * Counts as a nested automation start for the depth guard, like an agent-callable
 * automation; the caller trace rides along in the runner ctx.
 */
async function dispatchStepTool(stepMeta, args, ctx, deps = {}) {
    if (!stepMeta?.id) throw new Error('dispatchStepTool: missing Step id');
    const automationRunner = deps.automationRunner || require('../core/automationRunner');
    const { runNestedAutomationCall } = require('./automationCallDepth');
    const trace = callerTraceOf(ctx);
    return await runNestedAutomationCall(
        { automationId: stepMeta.id, ...trace },
        () => automationRunner.runStepAsTool(stepMeta.id, args || {}, {
            userId: ctx?.userId || stepMeta.userId,
            ...runnerTraceOptions(trace, ctx),
        }),
    );
}

function normalizeParameters(schema) {
    // Builder gives us a JSON-schema-like object. Default to "any object"
    // when the automation author hasn't declared one yet — the agent will
    // still be able to call with arbitrary keys, validated downstream.
    if (schema && typeof schema === 'object' && schema.type === 'object') return schema;
    return {
        type: 'object',
        properties: {},
        additionalProperties: true,
    };
}

module.exports = {
    automationToTool,
    getAgentCallableTools,
    dispatchAgentCallableTool,
    dispatchAgentCallableByName,
    AgentCallRefusedError,
    stepToTool,
    getStepToolsForUser,
    dispatchStepTool,
    callerTraceOf,
    runnerTraceOptions,
};

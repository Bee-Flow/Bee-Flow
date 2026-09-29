/**
 * Automations as agent tools — §28.
 *
 * When a routine declares trigger.kind === 'agent_call', it becomes
 * addressable from agents and direct chat as a function-calling tool.
 * The agent calls `automation_<id>` with structured arguments; this
 * module renders the per-tool schema from the automation's declared
 * input shape and invokes the runner with those arguments as the
 * trigger payload.
 *
 * Public API:
 *   - getAgentCallableToolsForUser(userId) → tool[] suitable for
 *     dropping into the agent runtime's tool list.
 *   - dispatchAgentCallableTool(toolName, args, ctx) → invokes the
 *     automation synchronously and returns the run's final output.
 *
 * The tool catalog (server/automation/toolRegistry.js) doesn't list
 * these — they're per-user and per-automation, so they're discovered
 * dynamically at agent-runtime construction time. Phase 2 work moves
 * them into the unified catalog (§15).
 */

const automationStore = require('../stores/automationStore');
// Handoff 5: an agent sees, and runs, the LIVE definition of a routine.
const { automationForRun } = require('../core/automationRunner/definitionForRun');

/**
 * Convert an automation into the OpenAI/Anthropic-shaped function
 * schema the agent runtime expects.
 */
function automationToTool(automation) {
    if (!automation || !automation.definition) return null;
    const trigger = automation.definition.trigger;
    if (!trigger || trigger.kind !== 'agent_call') return null;

    const toolName = sanitizeToolName(trigger.toolName || `automation_${automation.id}`);
    const description = trigger.description
        || automation.description
        || `Run the "${automation.title || 'Untitled automation'}" routine.`;
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
        },
    };
}

/**
 * List every agent-callable automation owned by the user (or shared
 * with their org, per the automation visibility rules), shaped as
 * function tools ready to register with the agent.
 */
async function getAgentCallableToolsForUser(userId) {
    if (!userId) return [];
    const list = await automationStore.getAutomationsForUser(userId).catch(() => []);
    const tools = [];
    for (const a of list) {
        if (!a?.isActive) continue;
        const tool = automationToTool(automationForRun(a, { mode: 'live' }));
        if (tool) tools.push(tool);
    }
    return tools;
}

/**
 * Who is starting a routine as a tool, from the dispatch context.
 *
 * `callerAgentId` is set by an AI step that runs on an agent (execAi passes it
 * under its own key, never as `agentId`, which would switch on agent-scoped
 * tools); a chat agent's own `agentId` counts as well. `runScope` is present
 * when the call comes from inside a routine run.
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
 * The runner options that record who started the routine (handoff 5).
 *
 * The caller's RUN is deliberately not written into parent_run_id /
 * root_run_id: those mean "the run this one replays" and "the journey this
 * leg belongs to". The resume path walks parent_run_id to replay step rows,
 * and the run lists hide every row whose root_run_id is not its own id, so a
 * cross-routine link there would replay another routine's steps and hide this
 * run from its own history. The chain lives in the call frame
 * (automationCallDepth.js) until the schema has a column of its own for it.
 */
function runnerTraceOptions(trace, ctx) {
    return {
        callerAgentId: trace.callerAgentId,
        callerConversationId: trace.callerConversationId,
        // A person chatting with an agent started it. Inside a routine run the
        // routine owner is already the run's user, so nothing is added.
        ...(trace.callerConversationId && ctx && ctx.userId ? { startedByUserId: ctx.userId } : {}),
    };
}

/**
 * Invoke an agent-callable automation. The runner runs synchronously
 * (no scheduler hop) and the final step's output is returned verbatim
 * to the calling agent.
 *
 * `ctx` carries the caller identity — the user the agent is acting on
 * behalf of. Enforced by the runner's permission catalog re-check.
 * It may also carry the caller trace (callerAgentId / agentId,
 * callerConversationId / conversationId, runScope): see callerTraceOf.
 *
 * Refuses with `automation_call_depth_exceeded` when agents are already
 * MAX_AUTOMATION_CALL_DEPTH routine starts deep (automationCallDepth.js).
 *
 * `deps` is the test seam: { automationStore, automationRunner }.
 */
async function dispatchAgentCallableTool(toolMeta, args, ctx, deps = {}) {
    if (!toolMeta?.id) throw new Error('dispatchAgentCallableTool: missing automation id');
    const store = deps.automationStore || automationStore;
    const automation = automationForRun(await store.getAutomation(toolMeta.id), { mode: 'live' });
    if (!automation) throw new Error(`Automation ${toolMeta.id} not found`);
    if (automation.userId !== (ctx?.userId || toolMeta.userId)) {
        throw new Error('Forbidden: caller does not own the automation');
    }
    if (!automation.isActive) {
        throw new Error('Automation is not active — activate it first or use the manual run endpoint.');
    }

    // Lazy-require the runner so this module stays loadable from any
    // path (the runner pulls in db connections that would otherwise
    // bind at module-load time).
    const automationRunner = deps.automationRunner || require('../core/automationRunner');
    const { runNestedAutomationCall } = require('./automationCallDepth');
    const trace = callerTraceOf(ctx);
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

function sanitizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'automation_unnamed';
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
 * Counts as a nested routine start for the depth guard, like an agent-callable
 * routine; the caller trace rides along in the runner ctx.
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
    // when the routine author hasn't declared one yet — the agent will
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
    getAgentCallableToolsForUser,
    dispatchAgentCallableTool,
    stepToTool,
    getStepToolsForUser,
    dispatchStepTool,
    callerTraceOf,
    runnerTraceOptions,
};

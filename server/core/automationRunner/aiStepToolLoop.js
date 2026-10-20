/**
 * The model call of an ai_step (split out of execAi.execAiStep): a single
 * chat call when the step has no tools, otherwise a short tool-calling loop
 * in which every call the model asks for is checked against the offered set,
 * synthesised on a dry run when it has a side effect, guarded on the way out
 * and on the way back, and logged as egress.
 */

const { isSideEffect } = require('../automationModel/sideEffectMap');
// synthesizeDryRunOutput comes through execIntegrationAction so the
// core -> automation edge to outputSchemas stays a single require.
const { synthesizeDryRunOutput } = require('./execIntegrationAction');
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
const { toolIdentity } = require('./toolIdentity');
const safety = require('./safety');
const { runWithProbe, markLocal } = require('../http/outboundProbe');

// Tool-calling loop. When tools are off (the default) this collapses to
// a single chat call exactly as before. When tools are on, the model can
// chain a few calls — capped at 4 iterations so a misbehaving step can't
// burn the run budget.
const MAX_AI_STEP_TOOL_ITERATIONS = 4;

const pushToolMessage = (messages, tc, payload) => {
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(payload) });
};

/** The assistant turn that asked for `response.toolCalls`, as the next request replays it. */
function assistantToolCallMessage(response) {
    return {
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.toolCalls.map(tc => ({
            id: tc.id, type: 'function',
            function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
            },
            _thought_signature: tc._thought_signature || undefined,
            _raw_content_parts: tc._raw_content_parts || undefined,
        })),
    };
}

/**
 * Run one permitted, guarded tool call for real (inside the outbound probe)
 * and file its egress row. Returns the tool result, or `{ error }`.
 */
async function dispatchAiToolCall(tc, callArgs, toolAudit, env) {
    const { ctx, mode, policy, agentBinding, executeTool } = env;
    const aiToolT0 = Date.now();
    const who = toolIdentity(ctx);
    const ran = await runWithProbe(async () => {
        const { resolveIntegration } = require('../integrations/integrationToolMap');
        const meta = resolveIntegration(tc.function.name, callArgs, { nextcloudUrl: ctx.nextcloudUrl });
        if (meta && meta.isLocal) markLocal(meta.label || meta.integration);
        try {
            return {
                ok: true,
                value: await executeTool(tc.function.name, callArgs, {
                    userId: who.userId, session: who.session, orgId: who.orgId,
                    userGroupIds: who.userGroupIds,
                    // The person whose connections this run uses, so a nested
                    // automation call records the same starter (agentCallableTools).
                    connectionsCallerUserId: ctx.callerOnly ? ctx.callerOnly.userId : null,
                    // The automation this step belongs to — what lets a
                    // self-scoped tool (automation_*) act on its own automation
                    // and nothing else.
                    automationId: ctx.automationId || null,
                    userOrgIds: ctx.userOrgIds || [],
                    runScope: ctx.runId ? { runId: ctx.runId, rootRunId: ctx.rootRunId || ctx.runId } : null,
                    autoSend: mode === 'live',
                    // Who starts an automation from here (handoff
                    // 5 caller trace). Its own key: `agentId`
                    // would switch on agent-scoped tools.
                    callerAgentId: agentBinding ? agentBinding.agentId : null,
                }),
            };
        } catch (err) {
            return { ok: false, error: err };
        }
    });
    if (!ran.result?.ok) {
        const err = ran.result?.error || new Error('tool dispatch failed');
        // Failed AI-step tool calls get an egress row with status.
        await safety.logEgress({
            toolName: tc.function.name, toolArgs: callArgs, error: err,
            probe: ran.probe, policy, auditBase: toolAudit, mode,
            durationMs: Date.now() - aiToolT0,
        });
        return { error: err.message };
    }
    const toolResult = ran.result.value;
    await safety.logEgress({
        toolName: tc.function.name, toolArgs: callArgs, result: toolResult,
        probe: ran.probe, policy, auditBase: toolAudit, mode,
        durationMs: Date.now() - aiToolT0,
    });
    return toolResult;
}

/**
 * Answer one tool call the model asked for: push the `tool` message the next
 * round reads. Never throws for a tool failure (that is the model's to read);
 * only a non-block guard failure on the result propagates.
 */
async function handleAiToolCall(tc, env) {
    const { step, ctx, mode, policy, auditBase, shieldGate, allowedToolNames, messages } = env;
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; }
    catch { args = {}; }
    if (!allowedToolNames.has(tc.function.name)) {
        pushToolMessage(messages, tc, { error: `Tool "${tc.function.name}" is not in the permitted tool set for this step` });
        return;
    }
    // Dry-run parity with execIntegrationAction: an AI step's tool
    // loop must never fire a real side effect during a dry-run
    // (autoSend:false only softens email-style tools — a
    // youtrack_create_issue would really create the issue).
    // Reads still run for real.
    if (mode === 'dry_run' && isSideEffect(tc.function.name)) {
        pushToolMessage(messages, tc, { ...synthesizeDryRunOutput(tc.function.name, args), _dryRunSynthesised: true });
        return;
    }
    let toolResult;
    try {
        // Guard the AI-chosen tool args + log the egress, just like a
        // first-class integration_action — ai_step tool calls were
        // previously completely unmonitored.
        const toolAudit = { ...auditBase, step_id: `${step.id}:${tc.function.name}` };
        const gIn = await safety.guardToolInput(args, policy, toolAudit, mode, ctx);
        const { resolveIntegration: _resolveInteg } = require('../integrations/integrationToolMap');
        const argMeta = _resolveInteg(tc.function.name, gIn.value, { nextcloudUrl: ctx.nextcloudUrl });
        const callArgs = safety.prepareForEgress(gIn.value, policy, ctx, {
            destination: argMeta && argMeta.isLocal ? 'internal' : 'external',
        });
        const refusal = await shieldGate.refuse(tc.function.name, callArgs);
        if (refusal) {
            pushToolMessage(messages, tc, { error: refusal.modelError });
            return;
        }
        toolResult = await dispatchAiToolCall(tc, callArgs, toolAudit, env);
    } catch (e) {
        toolResult = { error: e.message };
    }
    // Guard the RESULT before it goes back to the model. Only the
    // args were guarded before, so a tool that returned personal
    // data handed it straight to the LLM — the one thing the shield
    // exists to prevent. Chat has done this since toolResultRedact.
    try {
        const gOut = await safety.guardToolOutput(toolResult, policy, { ...auditBase, step_id: `${step.id}:${tc.function.name}` }, mode, ctx);
        toolResult = gOut.result;
    } catch (e) {
        // A `block` action on a tool result must not silently pass
        // the raw payload to the model.
        if (e && e.guardrailBlocked) toolResult = { error: e.message };
        else throw e;
    }
    messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // What the model reads, with the categories this tool's
        // class forbids stripped out (BFSF-354).
        content: await shieldGate.forModel(
            typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).slice(0, 30_000),
            tc.function.name,
        ),
    });
}

/**
 * The privacy-shield gate for this step's tool loop. The Privacy Shield tool
 * block lists ("Outside tools" / "Own server") apply to what a tool would
 * receive and to what the model reads back, as in chat (BFSF-354).
 * policy.shield is null when the org keeps automations out of the shield, so
 * that switch holds here too. A guardrail event is filed like the
 * automation's own, per tool call.
 */
function stepShieldGate(step, mode, policy, auditBase) {
    return require('../privacy/toolPiiGate').toolLoopGate({
        shield: policy.shield, tag: 'AutomationRunner',
        audit: (fields, toolName) => require('../../stores/guardrailEventStore').logGuardrailEvent({
            ...auditBase, step_id: `${step.id}:${toolName}`, ...fields, is_dry_run: mode === 'dry_run',
        }),
    });
}

// What a step answers at when it names no temperature of its own (the spec
// default is aiStepReliability.AI_STEP_DEFAULT_TEMPERATURE; same number).
const DEFAULT_TEMPERATURE = 0.2;

/**
 * Call the model for an ai_step. `call` carries
 * { adapter, cfg, modelId, messages, maxOutputTokens, stepReasoningEffort,
 *   temperature, tools, accrueUsage, step, ctx, mode, policy, auditBase,
 *   agentBinding }; `messages` grows in place with the tool rounds.
 * Every request goes through the provider limiter (queue + Retry-After
 * backoff, cancelled with the run). Returns `{ response, hitIterationCap }`.
 */
async function runAiStepChat(call) {
    const { adapter, cfg, modelId, messages, maxOutputTokens, stepReasoningEffort, tools, accrueUsage, ctx } = call;
    const { limitedChat } = require('../llm/providerLimiter');
    const temperature = Number.isFinite(call.temperature) ? call.temperature : DEFAULT_TEMPERATURE;
    const effort = stepReasoningEffort !== undefined ? { reasoningEffort: stepReasoningEffort } : {};
    const send = (options) => limitedChat({ adapter, cfg, modelId, messages, options, signal: ctx && ctx.cancelSignal });
    if (!tools) {
        const response = await send({ maxTokens: maxOutputTokens, temperature, ...effort });
        accrueUsage(response);
        return { response, hitIterationCap: false };
    }
    const { executeTool } = require('../tools/toolDispatcher');
    const shieldGate = stepShieldGate(call.step, call.mode, call.policy, call.auditBase);
    // Names the model was actually offered this call. The model is
    // untrusted input: nothing stops a response from naming a tool
    // outside `tools` (hallucination, or a crafted prompt-injection
    // payload from step data). Dispatch must only ever run a tool the
    // catalog lookup above actually permitted for this user/org.
    const allowedToolNames = new Set(tools.map(t => t?.function?.name).filter(Boolean));
    const env = { ...call, executeTool, shieldGate, allowedToolNames };
    let response;
    for (let iter = 0; iter < MAX_AI_STEP_TOOL_ITERATIONS; iter++) {
        response = await send({ maxTokens: maxOutputTokens, temperature, tools, toolChoice: 'auto', ...effort });
        accrueUsage(response);
        if (!response.toolCalls || response.toolCalls.length === 0) break;
        messages.push(assistantToolCallMessage(response));
        for (const tc of response.toolCalls) await handleAiToolCall(tc, env);
    }
    // Exhausted the loop with the model still wanting to call tools.
    return { response, hitIterationCap: !!(response && response.toolCalls && response.toolCalls.length) };
}

module.exports = { runAiStepChat, MAX_AI_STEP_TOOL_ITERATIONS, dispatchAiToolCall };

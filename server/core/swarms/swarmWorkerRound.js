// @typecheck
/**
 * One tool-call round of a swarm worker (runWorker in ./swarmRuntime.js):
 * the stream callback that forwards text, collects tool calls and logs
 * usage; the guarded stream call itself; and the round's tool calls,
 * dispatched in parallel through the Privacy Shield gate.
 *
 * `w` is the worker's run context built in runWorker: { worker, workerId,
 * model, send, runSnapshot, isSynthesiser, userId, swarmRunId,
 * organizationId, conversationId, startedAt, workerTools, toolContext,
 * shield, logShieldEvent, toolPiiGate, totals }.
 */
const { executeTool: dispatchTool } = require('../tools/toolDispatcher');
const usageStore = require('../../stores/usageStore');
const { usageLogFields } = require('../providers/usageNormalizer');
const { bestEffort, fallback } = require('../../utils/bestEffort');

const WORKER_DEFAULT_MAX_TOKENS = 6000;

/**
 * @typedef {import('./builtins/researchSwarm').SwarmWorker} SwarmWorker
 * @typedef {(event: string, data: Record<string, unknown>) => void} SwarmSend
 * @typedef {{ name: string, status: string, at: number }} WorkerToolEntry
 * @typedef {{ workerId: string, role: string, name: string, tier: string, modelId: string | null, status: string,
 *   content: string, tools: WorkerToolEntry[], startedAt: number, durationMs: number | null,
 *   error: string | null }} WorkerCard
 * @typedef {{ state: string, swarmId: string, swarmName: string, phases: unknown[],
 *   phaseStates: Record<string, { status: string, startedAt: number, durationMs: number | null }>,
 *   workers: Record<string, WorkerCard>, startedAt: number, durationMs: number | null,
 *   activePhaseId?: string }} RunSnapshot
 * @typedef {{ modelId: string, adapter: ReturnType<typeof import('../providers').getAdapter>, apiKey: string, apiUrl: string,
 *   config: Awaited<ReturnType<typeof import('../aiAgent').getProviderForModel>> }} WorkerModel
 * @typedef {{ id: string, type: string, function: { name: string, arguments: string } }} WorkerToolCall
 * @typedef {{ role: string, content: string | null, tool_calls?: WorkerToolCall[], tool_call_id?: string,
 *   name?: string }} WorkerMessage
 * @typedef {{ worker: SwarmWorker, workerId: string, model: WorkerModel, send: SwarmSend,
 *   runSnapshot: RunSnapshot | null, isSynthesiser: boolean, userId: string, swarmRunId: string | null,
 *   organizationId: string | null, conversationId: string | null, startedAt: number,
 *   workerTools: Awaited<ReturnType<typeof import('../tools/directChatToolStack').buildDirectChatToolStack>>['tools'],
 *   toolContext: Record<string, unknown>,
 *   shield: import('../privacy/toolPiiGate').ToolShield | null,
 *   logShieldEvent: import('../privacy/toolPiiGate').LogEvent,
 *   toolPiiGate: typeof import('../privacy/toolPiiGate'),
 *   totals: { usage: { prompt: number, completion: number, reasoning: number } | null } }} WorkerRun
 * @typedef {{ text: string, toolCalls: WorkerToolCall[], error: string | null }} WorkerRound
 * @typedef {{ text?: string, id?: string, name?: string, input?: unknown, error?: string, stop_reason?: string,
 *   prompt_tokens?: number, completion_tokens?: number, reasoning_tokens?: number }} RoundEventData
 */

/**
 * The adapter callback for one round. Text deltas go to either `content`
 * (synthesiser → straight to the chat bubble) or `swarm_worker_content`
 * (researcher → its own card); tool calls are collected for after the
 * stream. Writes into `round` ({ text, toolCalls, error }).
 *
 * @param {WorkerRun} w
 * @param {WorkerRound} round
 */
function makeRoundCallback(w, round) {
    const { worker, workerId, model, send, runSnapshot, isSynthesiser } = w;
    return async (/** @type {string} */ type, /** @type {RoundEventData | null | undefined} */ data) => {
        if (type === 'text' && typeof data?.text === 'string') {
            round.text += data.text;
            if (runSnapshot?.workers?.[workerId]) {
                runSnapshot.workers[workerId].content += data.text;
            }
            if (isSynthesiser) {
                send('content', { text: data.text });
            } else {
                send('swarm_worker_content', { workerId, delta: data.text });
            }
        } else if (type === 'tool_use' && data) {
            // Providers emit { id, name, input } — `input` is the
            // parsed args object. Echo back into OpenAI-shape so
            // adapters (incl. the Claude one which converts internally)
            // get a consistent assistant tool_calls history.
            round.toolCalls.push({
                // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- fallback tool-call id that pairs a call with its result in the history, not a secret or a token
                id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                type: 'function',
                function: {
                    name: data.name,
                    arguments: typeof data.input === 'string'
                        ? data.input
                        : JSON.stringify(data.input || {}),
                },
            });
        } else if (type === 'error') {
            round.error = data?.error || 'Stream error';
        } else if (type === 'done' && data) {
            // Adapters emit final usage on `done`. Log per worker per
            // round so swarm dashboards see real token counts (workers
            // were previously invisible because the runtime ignored
            // this event).
            try {
                await usageStore.logUsage({
                    user_id: w.userId,
                    agent_id: workerId,
                    agent_name: worker.name || workerId,
                    agent_type: 'swarm',
                    model: model.modelId,
                    ...usageLogFields(data),
                    stop_reason: data.stop_reason || null,
                    swarm_run_id: w.swarmRunId,
                    parent_call_id: w.swarmRunId,  // worker's parent is the swarm run itself
                    source: 'swarm_orchestrator',
                    organization_id: w.organizationId,
                    conversation_id: w.conversationId,
                    duration_ms: Date.now() - w.startedAt,
                });
            } catch (e) { bestEffort('core/swarms/swarmWorkerRound:makeRoundCallback', e); /* ignore logging errors */ }
            // Track totals for snapshot
            w.totals.usage = w.totals.usage || { prompt: 0, completion: 0, reasoning: 0 };
            w.totals.usage.prompt += data.prompt_tokens || 0;
            w.totals.usage.completion += data.completion_tokens || 0;
            w.totals.usage.reasoning += data.reasoning_tokens || 0;
        }
        // thinking_* and image events are intentionally ignored for
        // workers — the synthesiser's reasoning surfaces in its
        // streamed text either way.
    };
}

/**
 * Stream one round. Resolves to `{ text, toolCalls, error }`; a thrown
 * stream is reported as `error`, like an `error` event.
 *
 * @param {WorkerRun} w
 * @param {WorkerMessage[]} messages
 * @returns {Promise<WorkerRound>}
 */
async function streamWorkerRound(w, messages) {
    const { model, workerId, isSynthesiser, workerTools, conversationId, swarmRunId, userId } = w;
    /** @type {WorkerRound} */
    const round = { text: '', toolCalls: [], error: null };
    try {
        // Outbound-prompt guard — re-tokenise any real values that
        // may have crept into the worker's context (memory, KB,
        // hive block, …) before the LLM sees them. Idempotent.
        const { applyTokenMapToMessages } = require('../dlp/applyTokenMapToOutbound');
        const _guardedMessages = applyTokenMapToMessages({ conversationId, messages });
        await model.adapter.stream(model.apiKey, model.apiUrl, model.modelId, _guardedMessages, {
            maxTokens: WORKER_DEFAULT_MAX_TOKENS,
            temperature: isSynthesiser ? 0.4 : 0.3,
            tools: workerTools.length > 0 ? workerTools : undefined,
            toolChoice: workerTools.length > 0 ? 'auto' : undefined,
            // Stable per-(run, worker) prompt-cache routing key: the
            // worker's system prompt + initial message prefix is identical
            // across tool-call rounds, so this lifts the OpenAI prefix
            // cache hit-rate across rounds. Ignored by non-OpenAI adapters.
            // Account-scoped routing hint — cannot leak across tenants.
            promptCacheKey: swarmRunId ? `swarm-${swarmRunId}-${workerId}` : undefined,
            userId,
        }, makeRoundCallback(w, round));
    } catch (streamErr) {
        round.error = streamErr?.error?.message || streamErr?.message || 'Stream failed';
    }
    return round;
}

/**
 * Execute a round's tool calls in parallel and append the `tool` messages,
 * in call order, to `messages`. Records each call on the worker's snapshot
 * card and in `toolHistory`.
 *
 * @param {WorkerRun} w
 * @param {WorkerToolCall[]} toolCalls
 * @param {WorkerMessage[]} messages
 * @param {Array<{ name: string, status: string }>} toolHistory
 */
async function runWorkerToolCalls(w, toolCalls, messages, toolHistory) {
    const { worker, workerId, model, send, runSnapshot, toolContext, shield, logShieldEvent, toolPiiGate } = w;
    const results = await Promise.all(toolCalls.map(async (tc) => {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (err) { fallback('core/swarms/swarmWorkerRound:runWorkerToolCalls', err); /* default to {} */ }
        const toolEntry = { name, status: 'running', at: Date.now() };
        if (runSnapshot?.workers?.[workerId]) runSnapshot.workers[workerId].tools.push(toolEntry);
        send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: 'start' });
        let toolResult;
        try {
            // Privacy Shield tool block lists (BFSF-354): a call whose
            // arguments carry a forbidden category is never dispatched.
            const refusal = await toolPiiGate.refuseToolCall({
                toolName: name, args, shield, logEvent: logShieldEvent, tag: `Swarm/${workerId} ToolPiiGuard`,
            });
            // A worker has no capture context of its own: the
            // dispatcher's chokepoint writes the egress row, and these
            // ids put it on this swarm run's worker.
            toolResult = refusal ? { error: refusal.modelError } : await dispatchTool(name, args, {
                ...toolContext,
                egress: {
                    source: 'swarm',
                    model: model.modelId,
                    ids: {
                        organization_id: w.organizationId || null,
                        user_id: w.userId || null,
                        agent_id: workerId,
                        agent_name: worker.name || workerId,
                        conversation_id: w.conversationId || null,
                    },
                },
            });
        } catch (err) {
            toolResult = { error: err.message };
        }
        const finalStatus = toolResult?.error ? 'error' : 'done';
        toolEntry.status = finalStatus;
        toolHistory.push({ name, status: finalStatus });
        send('swarm_worker_tool', { workerId, role: worker.role, toolName: name, status: finalStatus });
        return { tc, toolResult };
    }));

    for (const { tc, toolResult } of results) {
        messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            // What the worker's model reads, with the categories this
            // tool's class forbids stripped out (BFSF-354).
            content: await toolPiiGate.stripToolResultForModel(
                typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || ''),
                { toolName: tc.function.name, shield, logEvent: logShieldEvent, tag: `Swarm/${workerId} ToolResultDlp` },
            ),
        });
    }
}

module.exports = { streamWorkerRound, runWorkerToolCalls };

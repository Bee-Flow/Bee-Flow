// @typecheck strict
/**
 * The tool-calling loop of a plain-prompt Cowork run (executeTask in
 * core/aiTaskRunner.js): model round, tool calls through the shield gate and
 * the run's dispatcher, until the model answers without tools or the
 * iteration cap is hit.
 *
 * Everything with a side effect is handed in — the adapter, the dispatch of
 * one tool call, the termination logger — so this module requires nothing
 * from the server's stores.
 */
const log = require('../../telemetry/log');
const { createOutsideTextMark, holdCall } = require('./outsideTextGuard.mts');

// Schedules that fan out across several topics (news digests, multi-source
// research) routinely chain 6-8 tool calls before producing a final answer.
// Capping at 5 would silently truncate them — the loop would exit with no
// final assistant text and the user would get a blank notification. 20 leaves
// room for Opus 4.7 agent runs, which reach ~15 rounds.
const MAX_TOOL_ITERATIONS = 20;

/**
 * A tool call as the adapters emit it: always a named function.
 * @typedef {{ id?: string, function: { name: string, arguments?: unknown }, _thought_signature?: string, _raw_content_parts?: unknown }} LoopToolCall
 * @typedef {{ content?: string | null, toolCalls?: LoopToolCall[] | null, usage?: unknown, stop_reason?: string, stopReason?: string, finish_reason?: string }} LoopReply
 * @typedef {ReturnType<typeof import('../privacy/toolPiiGate').toolLoopGate>} ShieldGate
 * @typedef {(toolName: string, toolArgs: Record<string, unknown>) => Promise<unknown>} DispatchTool
 */

/**
 * The assistant message that carries a round's tool calls.
 * @param {LoopReply} response
 */
function toolCallMessage(response) {
    // Preserve _thought_signature — required by Gemini 3.x for multi-turn tool calls
    return {
        role: 'assistant',
        content: response.content || null,
        tool_calls: /** @type {LoopToolCall[]} */ (response.toolCalls).map(tc => ({ // asked only for a reply with tool calls
            id: tc.id,
            type: 'function',
            function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function.arguments),
            },
            _thought_signature: tc._thought_signature || undefined,
            _raw_content_parts: tc._raw_content_parts || undefined,
        })),
    };
}

/**
 * Stop a run whose signal aborted (its deadline passed, ./runDeadline.mts):
 * throws the reason the signal was aborted with.
 * @param {AbortSignal | undefined} signal
 */
function stopIfAborted(signal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The run was stopped');
}

/**
 * Execute one round's tool calls in order, pushing a `tool` message for each.
 * A call the shield refuses is never dispatched.
 * @param {LoopToolCall[]} toolCalls
 * @param {{ messages: object[], shieldGate: ShieldGate, dispatchTool: DispatchTool, signal?: AbortSignal, outsideText?: import('./outsideTextGuard.mts').OutsideTextMark }} opts
 */
async function runToolCalls(toolCalls, { messages, shieldGate, dispatchTool, signal, outsideText }) {
    for (const tc of toolCalls) {
        // Past the run's deadline no further tool call starts.
        stopIfAborted(signal);
        const toolName = tc.function.name;
        let toolArgs;
        try {
            toolArgs = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments;
        } catch (_) {
            toolArgs = {};
        }

        log.info(`[AITaskRunner]   Tool call: ${toolName}(${Object.keys(toolArgs || {}).join(', ')})`);

        // Once the run read outside text it sends nothing more (./outsideTextGuard.mts).
        const held = outsideText ? holdCall(outsideText, toolName) : null;
        if (held) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: held }) });
            continue;
        }

        const refusal = await shieldGate.refuse(toolName, toolArgs);
        if (refusal) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: refusal.modelError }) });
            continue;
        }

        let result;
        try {
            result = await dispatchTool(toolName, toolArgs);
        } catch (toolErr) {
            log.error(`[AITaskRunner]   Tool error (${toolName}):`, /** @type {Error} */ (toolErr).message);
            result = { error: /** @type {Error} */ (toolErr).message };
        }

        messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            // What the model reads, with the categories this
            // tool's class forbids stripped out (BFSF-354).
            content: await shieldGate.forModel(typeof result === 'string' ? result : JSON.stringify(result), toolName),
        });
    }
}

/**
 * Run the loop. `run.lastIter` is kept current (the caller's usage and
 * termination rows read it); `logTermination(type)` writes a termination row.
 * Resolves to `{ finalResponse, lastAssistantContent, hitIterationCap }`.
 * @param {{
 *   adapter: { chat: (apiKey: string | undefined, baseUrl: string, model: string, messages: object[], options: object) => Promise<LoopReply> },
 *   config: { apiKey?: string, url: string },
 *   modelId: string,
 *   messages: object[],
 *   tools: unknown[],
 *   tierDefaults: { maxTokens?: number, temperature?: number },
 *   usageAcc: ReturnType<typeof import('../providers/usageNormalizer').createUsageAccumulator>,
 *   shieldGate: ShieldGate,
 *   dispatchTool: DispatchTool,
 *   logTermination: (type: string) => unknown,
 *   run: { lastIter?: number },
 *   signal?: AbortSignal,
 * }} opts
 */
async function runPromptToolLoop({ adapter, config, modelId, messages, tools, tierDefaults, usageAcc, shieldGate, dispatchTool, logTermination, run, signal }) {
    let finalResponse = '';
    let lastAssistantContent = ''; // tracks any non-empty assistant text seen across iterations
    let hitIterationCap = true;    // flipped to false if the loop exits via `break`
    // Whether this run has read outside text: from then on it sends nothing to other people (./outsideTextGuard.mts).
    const outsideText = createOutsideTextMark();

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        run.lastIter = iter + 1;
        // Past the run's deadline no further model round starts, and the
        // adapter cancels the call in flight on the same signal.
        stopIfAborted(signal);
        const response = await adapter.chat(config.apiKey, config.url, modelId, messages, {
            maxTokens: tierDefaults.maxTokens,
            temperature: tierDefaults.temperature ?? 0.7,
            tools: tools.length > 0 ? tools : undefined,
            toolChoice: tools.length > 0 ? 'auto' : undefined,
            signal,
        });
        // adapter.chat returns normalised usage (non-stream Claude/Gemini
        // included); the accumulator also accepts a raw provider block.
        usageAcc.add(response?.usage);

        // Track any assistant text the model produced alongside tool
        // calls — if we later exhaust iterations without a clean break,
        // this is the best outcome we can surface to the user.
        if (response.content && response.content.trim()) {
            lastAssistantContent = response.content;
        }

        if (response.stop_reason === 'max_tokens' || response.stopReason === 'max_tokens' || response.finish_reason === 'length') {
            logTermination('max_tokens');
        }

        // Handle tool calls if present
        if (response.toolCalls && response.toolCalls.length > 0) {
            messages.push(toolCallMessage(response));
            await runToolCalls(response.toolCalls, { messages, shieldGate, dispatchTool, signal, outsideText });
            // Continue the loop to let the model process tool results
            continue;
        }

        // No tool calls — this is the final response
        finalResponse = response.content || '';
        hitIterationCap = false;
        break;
    }
    return { finalResponse, lastAssistantContent, hitIterationCap };
}

/**
 * The result text of a plain-prompt run: never empty, at most 50,000 chars.
 * @param {{ id: string }} task
 * @param {{ finalResponse: string, lastAssistantContent: string, hitIterationCap: boolean }} loop
 * @param {{ messages: unknown[], tools: unknown[] }} prep
 */
function promptRunOutcome(task, { finalResponse, lastAssistantContent, hitIterationCap }, { messages, tools }) {
    if (!finalResponse || !finalResponse.trim()) {
        log.warn(`[AITaskRunner] Schedule ${task.id} produced no outcome text. ` +
            `hitIterationCap=${hitIterationCap}, ` +
            `messages=${messages.length}, ` +
            `tools=${tools.length}, ` +
            `lastInterim=${lastAssistantContent.length} chars`);
        finalResponse = hitIterationCap
            ? `_(Deze cowork bereikte de limiet van ${MAX_TOOL_ITERATIONS} tool-aanroepen voordat een eindresultaat werd geproduceerd. Splits de prompt op of koppel een agent met grotere context.)_`
            : `_(Deze cowork is uitgevoerd, maar er is geen tekstresultaat geproduceerd.)_`;
    }

    // Truncate if needed (safety net — ignore task.maxResultLength since DB defaults to 2000)
    const maxLen = 50000;
    if (finalResponse.length > maxLen) {
        finalResponse = finalResponse.substring(0, maxLen) + '\n\n… (truncated)';
    }
    return finalResponse;
}

module.exports = { runPromptToolLoop, promptRunOutcome, MAX_TOOL_ITERATIONS };

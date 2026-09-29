/**
 * One turn of the code assistant: the model loop behind
 * POST /api/automation/builder/code/assist.
 *
 *   1. Check the code as it came in (analyzeCode) and tell the model what the
 *      check says, beside the code, the step's tools and hosts and the
 *      upstream field names (codeAssistPrompt.renderStepContext).
 *   2. Let the model work with the edit tools (codeAssistTools) until it
 *      answers without a tool call. Every edit lands on the in-memory copy
 *      and goes out as an `edit` event; the text goes out as `delta`.
 *   3. When the turn EDITED the code: check it again. A syntax error or a
 *      BLOCK finding opens a repair round (at most two), inputs without a
 *      described @param one round; the model reads a CHECK REPORT and fixes
 *      it with the same tools. A turn that only answered a question is never
 *      repaired: nobody asked for its code to change.
 *   4. Send `code` once: the final code and its analysis.
 *
 * Nothing is saved here. The client keeps its own snapshot per turn for Undo.
 *
 * Every outside dependency is a parameter (the model stream, the analyser,
 * the Privacy Shield gate, the SSE writer), so the whole turn is testable
 * with a scripted stream and a stub analyser.
 */

'use strict';

const defaultLog = require('../../../telemetry/log');
const toolLoop = require('../../../core/llm/toolLoop');
const { recoverLeakedToolCalls, RECOVERED_CALL_HINT } = require('../../../core/llm/leakedToolCalls');
const { windowHistory, HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { CODE_TOOLS, CODE_TOOL_NAMES, executeCodeTool } = require('./codeAssistTools');
const {
    CODE_ASSIST_SYSTEM_PROMPT, STEP_CONTEXT_PREFIX, CHECK_REPORT_PREFIX,
    renderStepContext, repairNeeds, renderRepairNote,
} = require('./codeAssistPrompt');

// Model rounds one phase (the request, or one repair) may take before the
// turn moves on. An edit is one or two calls; six leaves room for a read, a
// refused find_text and its retry.
const MAX_ROUNDS_PER_PHASE = 6;
// Repair rounds after the request, server-side, at most.
const MAX_REPAIR_ROUNDS = 2;
// Every model call of a turn together.
const MAX_MODEL_ROUNDS = 14;
// Prior conversation the model re-reads, in tokens. The code itself is sent
// fresh every turn, so the chat only has to carry what was asked.
const HISTORY_BUDGET_TOKENS = 4000;

const CUT_OFF_HINT = 'The arguments of this call were cut off (usually the length limit), so nothing was applied. Send a smaller edit: change one part at a time with code_replace or code_patch.';

/** The conversation the client sent, as the model may read it. */
function sanitizeConversation(messages) {
    return (Array.isArray(messages) ? messages : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        // A client that echoed a machine note back does not get to speak in
        // the server's voice.
        .filter(m => !m.content.startsWith(STEP_CONTEXT_PREFIX) && !m.content.startsWith(CHECK_REPORT_PREFIX))
        .map(m => ({ role: m.role, content: m.content }));
}

/**
 * The model's messages: the constant system prompt, the earlier turns, the
 * step context as a late system message (after the cacheable prefix, the
 * same placement as the builder's draft state), and the person's message.
 */
function composeMessages({ messages, context }) {
    const convo = sanitizeConversation(messages);
    const last = convo.length && convo[convo.length - 1].role === 'user' ? convo[convo.length - 1] : null;
    const earlier = last ? convo.slice(0, -1) : convo;
    return [
        { role: 'system', content: CODE_ASSIST_SYSTEM_PROMPT },
        ...windowHistory(earlier, { budgetTokens: HISTORY_BUDGET_TOKENS, block: HISTORY_EVICT_BLOCK }),
        { role: 'system', content: context },
        { role: 'user', content: last ? last.content : '(no message)' },
    ];
}

/**
 * What the person reads when the model call itself failed. A 4xx other than
 * 408/429 is the provider refusing the request: sending it again cannot help,
 * and saying "try again" would send the person round in a loop.
 */
function describeProviderError(err) {
    const status = Number(err?.status || err?.statusCode) || toolLoop.providerErrorStatus(err);
    const permanent = !!status && status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (permanent) {
        return {
            message: `The AI model refused the request (HTTP ${status}): ${toolLoop.providerErrorExcerpt(err?.message)}. Sending it again will not help; check the model or tier settings.`,
            messageKey: 'code_step.assist.error.provider_rejected',
        };
    }
    return {
        message: 'The AI model had a temporary problem. Please send your message again.',
        messageKey: 'code_step.assist.error.provider_temporary',
    };
}

/** Signed thinking (and, on a raw-reasoning runtime, plain) to replay before tool calls. */
function thinkingToReplay(response, surfacesRawReasoning) {
    return (response.thinkingParts || [])
        .filter(p => p.text && !p.redacted && (p.signature || surfacesRawReasoning))
        .map(p => (p.signature ? { text: p.text, signature: p.signature } : { text: p.text }));
}

const PASS_GATE = { refuse: async () => null, forModel: async (content) => content };

/**
 * @param {object} p
 * @param {Array<{role: string, content: string}>} p.messages  the conversation, last = the person's new message
 * @param {string} p.code
 * @param {string[]} [p.allowedTools]
 * @param {string[]} [p.allowedHosts]
 * @param {Array<object>} [p.upstreamFields]
 * @param {Array<object>} [p.toolDocs]
 * @param {(messages: Array, opts: { tools: Array, onText: (text: string) => void }) => Promise<object>} p.streamRound
 *   one model call; resolves to builderShared.streamWithRetry's shape
 *   ({ content, toolCalls, invalidToolCalls, thinkingParts, usage, finishReason })
 * @param {((code: string, opts: object) => object)|null} [p.analyse]  analyzeCode, or null when unavailable
 * @param {{ refuse: Function, forModel: Function }} [p.gate]  the Privacy Shield tool gate
 * @param {(event: string, data: object) => void} p.send
 * @param {() => boolean} [p.isGone]   true once the client closed the stream
 * @param {boolean} [p.surfacesRawReasoning]
 * @param {{ warn: Function }} [p.log]
 * @returns {Promise<{ code: string, analysis: object|null, changed: boolean, repairRounds: number, usage: object, error: object|null }>}
 */
async function runCodeAssistTurn({
    messages, code, allowedTools = [], allowedHosts = [], upstreamFields = [], toolDocs = [],
    streamRound, analyse = null, gate = PASS_GATE, send, isGone = () => false,
    surfacesRawReasoning = false, log = defaultLog,
}) {
    const startCode = typeof code === 'string' ? code : '';
    let current = startCode;
    const analyseOpts = { allowedTools, allowedHosts };
    const checked = new Map();
    const check = (text) => {
        if (checked.has(text)) return checked.get(text);
        let analysis = null;
        if (typeof analyse === 'function') {
            try { analysis = analyse(text, analyseOpts) || null; }
            catch (e) { log.warn(`[CodeAssist] analysis failed: ${e.message}`); analysis = null; }
        }
        checked.set(text, analysis);
        return analysis;
    };

    const context = renderStepContext({ code: startCode, allowedTools, allowedHosts, upstreamFields, analysis: check(startCode), toolDocs });
    const msgs = composeMessages({ messages, context });

    // Text of a later round starts on its own paragraph, so "I'll add it."
    // and "Done." never run together in the bubble.
    let wroteText = false;
    let roundHasText = false;
    const onText = (text) => {
        if (!text) return;
        if (!roundHasText && wroteText) send('delta', { text: '\n\n' });
        roundHasText = true;
        wroteText = true;
        send('delta', { text });
    };

    const usage = toolLoop.emptyUsageTotals();
    let rounds = 0;
    let repairRounds = 0;
    let docsRepairUsed = false;
    let truncationRetryUsed = false;
    let emptyRetryUsed = false;
    let error = null;

    async function runToolCall(tc) {
        const name = tc.function && tc.function.name;
        const { args, truncated } = toolLoop.parseToolArgs(tc.function && tc.function.arguments, name);
        let result;
        if (!CODE_TOOL_NAMES.has(name)) {
            result = { error: `Unknown tool "${name}". The tools are ${[...CODE_TOOL_NAMES].join(', ')}.` };
        } else if (truncated || tc._repaired) {
            // A whole-code write cut off mid-way would replace the person's
            // code with half of it; no partial call is applied.
            result = { error: CUT_OFF_HINT };
        } else {
            const refusal = await gate.refuse(name, args);
            if (refusal) {
                result = { error: refusal.modelError };
            } else {
                const out = executeCodeTool(name, args, current);
                if (out.edit) {
                    current = out.code;
                    send('edit', out.edit);
                }
                result = out.result;
            }
        }
        if (tc._recovered) result = { ...result, note: RECOVERED_CALL_HINT };
        return { role: 'tool', tool_call_id: tc.id, content: await gate.forModel(JSON.stringify(result), name) };
    }

    /** One phase: model rounds until it answers without a tool call. */
    async function runPhase() {
        let phaseRounds = 0;
        while (phaseRounds < MAX_ROUNDS_PER_PHASE && rounds < MAX_MODEL_ROUNDS) {
            if (isGone()) return false;
            phaseRounds++;
            rounds++;
            roundHasText = false;
            let response;
            try {
                response = await streamRound(msgs, { tools: CODE_TOOLS, onText });
            } catch (e) {
                if (isGone()) return false;
                log.warn(`[CodeAssist] model call failed: ${e.message}`);
                error = describeProviderError(e);
                send('error', error);
                return false;
            }
            toolLoop.accumulateUsage(usage, response.usage);
            const thinking = thinkingToReplay(response, surfacesRawReasoning);

            // A call written as text (Gemma's thought channel) is run like a
            // made one, and the model is told so in the result.
            if (!response.toolCalls || !response.toolCalls.length) {
                const recovered = recoverLeakedToolCalls(response, { toolNames: CODE_TOOL_NAMES, iter: rounds });
                if (recovered.toolCalls.length) {
                    response.toolCalls = recovered.toolCalls;
                    response.content = recovered.content;
                }
            }

            if (response.toolCalls && response.toolCalls.length) {
                msgs.push({
                    role: 'assistant',
                    content: response.content || null,
                    ...(thinking.length ? { thinking } : {}),
                    tool_calls: response.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}),
                        },
                        _thought_signature: tc._thought_signature || undefined,
                    })),
                });
                for (const tc of response.toolCalls) msgs.push(await runToolCall(tc));
                continue;
            }

            if (toolLoop.isTruncatedStop(response.finishReason) && !truncationRetryUsed) {
                truncationRetryUsed = true;
                msgs.push(...toolLoop.truncationRetryMessages(response.content, thinking, { notePrefix: CHECK_REPORT_PREFIX }));
                continue;
            }
            if (toolLoop.isBlankReply(response.content) && !emptyRetryUsed) {
                emptyRetryUsed = true;
                const rejected = (response.invalidToolCalls || []).map(c => ({ name: c.name, reason: 'bad_arguments' }));
                msgs.push(...toolLoop.emptyReplyRetryMessages(response.content, thinking, { notePrefix: CHECK_REPORT_PREFIX, rejected }));
                continue;
            }
            msgs.push({ role: 'assistant', content: toolLoop.isBlankReply(response.content) ? toolLoop.EMPTY_REPLY_PLACEHOLDER : response.content });
            return true;
        }
        return true;
    }

    while (await runPhase()) {
        if (current === startCode) break;
        const needs = repairNeeds(check(current));
        const blocking = needs.blocking.length > 0;
        const docsOnly = !blocking && needs.docs.length > 0 && !docsRepairUsed;
        if ((!blocking && !docsOnly) || repairRounds >= MAX_REPAIR_ROUNDS || rounds >= MAX_MODEL_ROUNDS || isGone()) break;
        if (docsOnly) docsRepairUsed = true;
        repairRounds++;
        msgs.push({ role: 'user', content: renderRepairNote(needs) });
    }

    const analysis = check(current);
    const changed = current !== startCode;
    send('code', { code: current, analysis, changed, repairRounds });
    return { code: current, analysis, changed, repairRounds, usage, error };
}

module.exports = {
    runCodeAssistTurn,
    composeMessages,
    sanitizeConversation,
    describeProviderError,
    MAX_REPAIR_ROUNDS,
    MAX_ROUNDS_PER_PHASE,
    MAX_MODEL_ROUNDS,
};

// @typecheck
/**
 * The ways a turn of ./turnLoop ends other than through ../finalizeTurn, and
 * the words it says when it has to speak for the model.
 *
 *   - a round that throws: classified, logged once, rethrown for the route;
 *   - the loop running out without a final answer: a client disconnect
 *     (AbortError) or the tool-round budget (max_iterations);
 *   - the test-chat rule attribution that runs right before `done`.
 */
const terminationStore = require('../../../stores/terminationStore');
const testChatMod = require('../testChat');
const { sanitizeError } = require('../../privacy/errorSanitizer');
const { findWireProblems } = require('../../../utils/messageUtils');
const { classifyStreamError } = require('../streamRetry');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * What the wrap-up round says when the model produced no prose. The two
 * reasons must not borrow each other's words: telling someone "a tool kept
 * failing" when the truth is "I am waiting for you to approve it" sends them
 * to debug a tool that is fine.
 * @param {string | null} bailReason
 */
function wrapUpFallbackText(bailReason) {
    return bailReason === 'pending_confirmation'
        ? 'I have asked for your approval before running that action, and I am waiting for it. Nothing has run yet — approve it and I will carry on.'
        : 'I stopped because a tool kept failing with the same arguments and I could not complete this request. Please check that tool\'s configuration, or try a different approach.';
}

/**
 * The wrap-up round's answer. Its dropped tool calls (no tools were offered)
 * are only logged, never dispatched. If the model spent the round entirely on
 * them it produced no prose either, and the turn would end with an empty
 * assistant bubble — the original defect (a graceful bail that saves no
 * reply) wearing a different hat. Say what happened instead.
 * @param {{ currentToolCalls: import('./turnState').ToolCall[], fullResponse: string, _bailReason: string | null, onEvent: import('./turnState').OnEvent }} round
 */
function wrapUpAnswer({ currentToolCalls, fullResponse, _bailReason, onEvent }) {
    if (currentToolCalls.length > 0) {
        log.warn(`[AgentRuntime] Wrap-up round returned ${currentToolCalls.length} tool call(s) with no tools offered — dropped, ending the turn.`);
    }
    if (!fullResponse || !fullResponse.trim()) {
        const text = wrapUpFallbackText(_bailReason);
        onEvent('content', { text });
        return text;
    }
    return fullResponse;
}

/**
 * "Rule followed: …" — the attribution pass, and this is its ONLY call site:
 * it runs after the turn and before `done`, it does not touch the answer and
 * it only costs anything in a test chat. `attributeTurn` guards that spend
 * itself (`testChat !== true` ⇒ null), so the caller's `if` is a saving, not
 * a gate.
 *
 * The persona comes from `getAgent`, not from `agent`: the runtime
 * projection STRIPS `persona` (it is an editor artefact), so without this
 * read there is nothing to attribute against. One extra query, only in a
 * test chat, only at the end.
 *
 * The agent store and the attribution module are handed in (they sit in the
 * server's large import cycle, which this module stays out of).
 * @param {{ agent: import('./turnState').AgentRow, agentId: string, userId: string, userMessage: string, messageMetadata: import('./turnState').MessageMetadata, fullResponse: string, onEvent: import('./turnState').OnEvent }} turn
 * @param {{ agentStore: Pick<typeof import('../../../stores/agentStore'), 'getAgent'>, ruleAttribution: () => typeof import('../ruleAttribution') }} deps
 */
async function attributeTestChatTurn({ agent, agentId, userId, userMessage, messageMetadata, fullResponse, onEvent }, { agentStore, ruleAttribution }) {
    try {
        const _editorView = await agentStore.getAgent(agentId);
        const _attribution = await ruleAttribution().attributeTurn({
            testChat: true,
            persona: _editorView ? _editorView.persona : null,
            configInfo: testChatMod.testChatConfigInfo(agent),
            answer: fullResponse,
            question: typeof userMessage === 'string' ? userMessage : '',
            orgId: messageMetadata?.orgId || agent.organization_id || null,
            userId,
        });
        // No event on `null`: no chip is no claim, and an empty event would
        // be one.
        if (_attribution) onEvent?.('rule_attribution', _attribution);
    } catch (e) {
        log.warn('[AgentRuntime] rule attribution skipped:', /** @type {Error} */ (e).message);
    }
}

/**
 * A round threw: classify it for logging and the user-facing message, write
 * the `error` termination row once, and rethrow for the route handler.
 * @param {Error & { _classified?: ReturnType<typeof classifyStreamError>, _terminationLogged?: boolean }} error
 * @param {{ messages: import('./turnState').ChatMessage[], terminationBaseRow: import('./turnLoop').TerminationBaseRow }} ctx
 * @returns {never}
 */
function rethrowRoundError(error, { messages, terminationBaseRow }) {
    const classified = error._classified || classifyStreamError(error);
    log.error(`[Agent Stream] Error (${classified.errorType}):`, error.message);
    if (classified.errorType === 'invalid_request_body') {
        // Indexes and kinds only, never content.
        log.warn('[Agent Stream] Request body rejected as unparseable; wire problems in sent messages:', JSON.stringify(findWireProblems(messages)));
    }
    terminationStore.logTermination({
        ...terminationBaseRow(),
        termination_type: 'error',
        ...sanitizeError(error),
    }).catch((e) => bestEffort('core/agentRuntime/chatStream/turnExits:rethrowRoundError', e));
    error._terminationLogged = true;
    // Attach classification so the route handler can send a descriptive error
    error._classified = classified;
    error.message = classified.userMessage;
    throw error;
}

/**
 * The loop ran out without a final response.
 *
 * `fullResponse` is assigned in exactly one place (the "no more tool calls"
 * branch), and that branch returns a few lines later or throws from the
 * catch — so it is ALWAYS empty here. Do not reintroduce a "return the
 * buffered response" guard; handle each exit explicitly instead.
 *
 * Client disconnected mid-turn: when one of the in-loop breaks ran it already
 * wrote the `aborted` row, so logging again would double-count the stop;
 * logging max_iterations instead would mislabel it (with an iteration_count
 * far below the cap). But the loop can also reach the cap while the client is
 * gone — the disconnect lands after both in-loop checks, on the last round —
 * and that exit wrote nothing at all. `abortLogged` tells the two apart so
 * every aborted turn leaves exactly one row. The AbortError makes the route
 * (routes/agents/chat.js) take its abort branch and close the SSE stream
 * without pushing an `error` frame at a client that is already gone.
 *
 * Otherwise it is genuine budget exhaustion: the model kept asking for tools
 * until the configured max_tool_rounds_chat ran out.
 * @param {{ signal: AbortSignal | null, abortLogged: boolean, terminationBaseRow: import('./turnLoop').TerminationBaseRow }} ctx
 * @returns {never}
 */
function throwLoopExit({ signal, abortLogged, terminationBaseRow }) {
    if (signal?.aborted) {
        if (!abortLogged) {
            terminationStore.logTermination({ ...terminationBaseRow(), termination_type: 'aborted' }).catch((e) => bestEffort('core/agentRuntime/chatStream/turnExits:throwLoopExit', e));
        }
        /** @type {Error & { _terminationLogged?: boolean }} */
        const _abortErr = /** @type {Error & {_terminationLogged?: boolean}} */ (new Error('Client disconnected before the turn finished'));
        _abortErr.name = 'AbortError';
        _abortErr._terminationLogged = true;
        throw _abortErr;
    }

    terminationStore.logTermination({ ...terminationBaseRow(), termination_type: 'max_iterations' }).catch((e) => bestEffort('core/agentRuntime/chatStream/turnExits:throwLoopExit#2', e));
    const _maxIterErr = /** @type {Error & {_terminationLogged?: boolean}} */ (new Error('Agent exceeded maximum tool call iterations'));
    _maxIterErr._terminationLogged = true;
    throw _maxIterErr;
}

module.exports = { wrapUpFallbackText, wrapUpAnswer, attributeTestChatTurn, rethrowRoundError, throwLoopExit };

// @typecheck noImplicitAny
/**
 * Direct Chat — the LLM rounds of a streamed turn: the non-streaming tool
 * pre-check loop, the primary stream, and the streamed tool rounds (with the
 * pipeline wrap-up kickstart). Split out of streamTurn.js; behaviour
 * unchanged. `loop` is what prepareToolLoop (./toolLoopSetup.js) returned.
 */

const log = require('../../../telemetry/log');
const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
} = require('../../../core/tools/sessionSkillRuntime');
const { applyTokenMapToMessages } = require('../../../core/dlp/applyTokenMapToOutbound');
const { executeDirectChatToolCall } = require('./toolExec');
const { skipToolPrecheck } = require('./volatileLayout');
// Org-health capture: fire-and-forget emits for the silent chat-killers
// (provider config/stream failures) plus a success-side resolve so the
// dashboard self-heals once an org's chats work again.
const orgHealth = require('../../../services/orgHealth');
const { _resolveChatProblemsThrottled } = require('./shared');
const { emitPhase } = require('../../../core/agentRuntime/phaseEvents');
const { getUserAuth } = require('../../../utils/routeHelpers');
const { computeStepMachineGuard, pipelineNeedsWrapUp, callAdapterWithFallback } = require('./stepMachine');
const { createStreamCallbacks, snapshotThinkingParts } = require('./streamCallbacks');
const { emitToolResultEvents } = require('./toolResultEvents');
const { logTurnUsage } = require('./turnUsage');
const { bestEffort } = require('../../../utils/bestEffort');

const MAX_STREAM_TOOL_ROUNDS = 15;
const SHAPE_REJECTED = /invalid_request_message_order|Unexpected role|invalid.*tool_choice/i;

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */
/** @typedef {Awaited<ReturnType<typeof import('./toolLoopSetup').prepareToolLoop>>} ToolLoop */

const errText = /** @param {{ error?: { message?: string }, message?: string } | null | undefined} err */ (err) => String(err?.error?.message || err?.message || '');

/**
 * One adapter.stream call over the turn's (token-mapped) messages.
 * @param {Turn} turn
 * @param {Parameters<Turn['adapter']['stream']>[4]} options
 * @param {Parameters<Turn['adapter']['stream']>[5]} callback
 */
function streamRound(turn, options, callback) {
    return turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), options, callback);
}

/**
 * Step-machine bookkeeping: activation resets the in-step counter (new step
 * started); completion reset happens inside handleSessionSkillCompleteResult
 * after dispatch. Any other tool-only round advances the counter toward the
 * soft cap that force-requires complete_session_skill.
 * @template T
 * @param {Turn} turn
 * @param {T[]} toolCalls
 * @param {(tc: T) => string | undefined} nameOf
 */
function countStepRound(turn, toolCalls, nameOf) {
    const calledActivation = toolCalls.some(tc => nameOf(tc) === ACTIVATE_SESSION_SKILL_TOOL_NAME);
    const calledCompletion = toolCalls.some(tc => nameOf(tc) === COMPLETE_SESSION_SKILL_TOOL_NAME);
    if (calledActivation) turn.roundsInCurrentStep = 0;
    else if (!calledCompletion) turn.roundsInCurrentStep += 1;
}

/**
 * Reset what a discarded stream attempt accumulated before it is retried.
 * @param {Turn} turn
 */
function resetStreamedOutput(turn) {
    turn.fullContent = '';
    turn.thinkingContent = '';
    turn.thinkingParts = [];
    turn.thinkingSnapshotFrom = 0; // the array was replaced: reset the replay cursor with it
    turn.streamToolCalls = [];
}

/**
 * Release any held untokeniser tail into THIS round's text and
 * record it before the reset wipes it, so the pre-tool preamble survives into
 * persistence and is separated from the follow-up text in the live view.
 * @param {Turn} turn
 */
function closeVisibleRound(turn) {
    try { turn.streamContentFlush(); } catch (err) { bestEffort('routes/ai/directChat/toolLoopRounds:closeVisibleRound', err); /* best-effort */ }
    turn.displaySegments.onRoundEnd(turn.fullContent);
    turn.fullContent = '';
}

/**
 * Run the tool calls of one round in parallel, emit their events, append the results.
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {Array<Parameters<typeof executeDirectChatToolCall>[0]>} toolCalls
 * @param {{ streamed: boolean }} opts
 */
async function executeToolRound(turn, loop, toolCalls, { streamed }) {
    const { req } = turn;
    const userAuth = await getUserAuth(req);
    const toolPromises = toolCalls.map((toolCall) => executeDirectChatToolCall(toolCall, loop.mkToolCtx({ userAuth, streamed })));
    const toolResults = await Promise.all(toolPromises);
    // Process draft SSE events sequentially (after all tools settle) to avoid race conditions
    emitToolResultEvents(turn, toolResults, { streamed });
    // Strip internal fields before pushing to messages
    if (streamed) turn.messages.push(...toolResults.map(({ _toolResult, _toolName, ...rest }) => rest));
    else turn.messages.push(...toolResults.map(({ _toolResult, ...rest }) => rest));
}

/**
 * The non-streaming tool pre-check loop via adapter.chat(). It is skipped for
 * every provider whose stream path parses tool calls itself: the SDK adapters
 * and, since 2026-09, the self-hosted runtimes (BaseProvider._parseSseStream
 * accumulates streamed tool_calls; see base.js).
 *
 * What the pre-check bought: a chance to downgrade the step-machine
 * toolChoice before streaming. What covers that now: each stream call retries
 * once with toolChoice 'auto' on the same bad-shape error regex, and the
 * streamed-tool loop mirrors the step-machine bookkeeping round for round.
 * What it cost on a single-slot llama.cpp server: one FULL generation thrown
 * away plus one extra prompt evaluation per turn (measured 2026-09-11: a
 * 4.3k-token prompt is ~29 s per evaluation at ~150 tok/s).
 *
 * Returns false when a provider error ended the stream.
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {() => ((reason: string) => Promise<unknown>) | null | undefined} persistInterruptedTurn
 */
async function runPrecheckLoop(turn, loop, persistInterruptedTurn) {
    const { req, send } = turn;
    while (turn.toolCallRounds < loop.maxToolRounds) {
        // A tool round starts no new work once the user is gone.
        if (turn.clientGone) break;
        if (!(turn.directChatTools.length > 0 && !skipToolPrecheck(turn))) break;
        let result;
        try {
            const guard = computeStepMachineGuard(turn);
            loop.setVolatileGuard(guard.systemAppend);
            log.info(`[DirectChat pipeline] pre-check round=${turn.toolCallRounds} active=${turn.activatedSessionSkillIds.length} completed=${turn.completedSessionSkillIds.length}/${turn.sessionSkills.length} toolChoice=${guard.mode} roundsInStep=${turn.roundsInCurrentStep}`);
            result = await callAdapterWithFallback(
                (tc) => turn.adapter.chat(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), {
                    ...turn.chatOptions,
                    tools: turn.directChatTools,
                    toolChoice: tc,
                }),
                guard.toolChoice,
            );
        } catch (err) {
            log.error('[DirectChat] Tool check error:', err.message);
            orgHealth.problem('chat.provider_error', {
                orgId: turn.userOrgId || null, source: 'directChat', req,
                meta: { modelId: turn.modelId, provider: /** @type {{ providerName?: string }} */ (turn.config)?.providerName || turn.config?.providerType || null, error: err },
            });
            const persist = persistInterruptedTurn();
            if (persist) await persist(`API error: ${err.message}`);
            send('error', { error: `API error: ${err.message}` });
            turn.res.end();
            return false;
        }
        if (!(result.toolCalls && result.toolCalls.length > 0)) break;
        countStepRound(turn, result.toolCalls, tc => tc.function?.name || /** @type {{ name?: string }} */ (tc).name);
        // Add assistant message with tool calls to history
        turn.messages.push({
            role: 'assistant',
            content: result.content || null,
            tool_calls: result.toolCalls,
        });
        turn.toolCallRounds++;
        await executeToolRound(turn, loop, result.toolCalls, { streamed: false });
        // If the AI proposed a webpage plan this round, halt the tool loop so
        // the user can approve before any work happens. The streamed final
        // response still runs so the chat shows the "review the plan" message.
        if (turn.webpagePlanProposedThisTurn) break;
    }
    return true;
}

/**
 * Stream the final response via adapter.stream(). Pipeline guard at the
 * streaming-call boundary: while a session-skill pipeline is mid-run, the
 * LLM is forced to keep calling tools instead of emitting final text.
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {ReturnType<typeof import('./streamCallbacks').createStreamCallbacks>['primary']} streamCallback
 */
async function streamPrimary(turn, loop, streamCallback) {
    const { send } = turn;
    turn.streamStartTime = Date.now();
    const streamGuard = computeStepMachineGuard(turn);
    loop.setVolatileGuard(streamGuard.systemAppend);
    loop.layoutVolatile();
    loop.traceStablePrefix('primary');
    log.info(`[DirectChat pipeline] primary stream active=${turn.activatedSessionSkillIds.length} completed=${turn.completedSessionSkillIds.length}/${turn.sessionSkills.length} toolChoice=${streamGuard.mode} mute=${streamGuard.mute} roundsInStep=${turn.roundsInCurrentStep}`);
    // Tracks the mute state for the current stream round. Updated again
    // before the follow-up stream so each round gets a fresh read.
    turn.muteAssistantText = !!streamGuard.mute;
    const streamOptions = {
        ...turn.chatOptions,
        tools: (turn.toolCallRounds > 0) ? undefined : (turn.directChatTools.length > 0 ? turn.directChatTools : undefined),
        toolChoice: (turn.toolCallRounds > 0)
            ? undefined
            : (turn.directChatTools.length > 0 ? streamGuard.toolChoice : undefined),
    };
    // Final pre-LLM phase marker, only on the first round so the UI status
    // placeholder fades out before the first token arrives.
    if (turn.toolCallRounds === 0) {
        emitPhase(send, 'streaming_start', turn.modelId);
    }
    try {
        await streamRound(turn, streamOptions, streamCallback);
    } catch (streamErr) {
        const errMsg = errText(streamErr);
        // Retry without previousResponseId if the error is about missing tool
        // output (stale response ID pointing to an unresolved tool-call response)
        if (errMsg.includes('No tool output found') && streamOptions.previousResponseId) {
            log.warn('[DirectChat] Stale previousResponseId detected, retrying without chaining');
            turn.lastResponseId = null;
            streamOptions.previousResponseId = undefined;
            resetStreamedOutput(turn);
            await streamRound(turn, streamOptions, streamCallback);
        } else if (SHAPE_REJECTED.test(errMsg)) {
            // Pipeline-guard shape rejected by the provider: retry once with
            // permissive toolChoice so the user's message goes through.
            log.warn(`[DirectChat pipeline] Stream rejected — retrying with toolChoice='auto'. Original: ${errMsg}`);
            resetStreamedOutput(turn);
            await streamRound(turn, { ...streamOptions, toolChoice: 'auto' }, streamCallback);
        } else {
            throw streamErr;
        }
    }
    await logTurnUsage(turn);
    // Stream completed for this org: org-level chat blocks are provably gone;
    // resolve them (throttled, fire-and-forget).
    _resolveChatProblemsThrottled(turn.userOrgId);
}

/**
 * Streaming options for a follow-up or kickstart round under a fresh guard.
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {string} label
 */
function guardedFollowOptions(turn, loop, label) {
    const guard = computeStepMachineGuard(turn);
    loop.setVolatileGuard(guard.systemAppend);
    loop.layoutVolatile();
    loop.traceStablePrefix(label);
    turn.muteAssistantText = !!guard.mute;
    const options = {
        ...turn.chatOptions,
        previousResponseId: /** @type {string | undefined} */ (undefined), // Don't chain: tool results must be sent in full
        tools: turn.directChatTools.length > 0 ? turn.directChatTools : undefined,
        toolChoice: turn.directChatTools.length > 0 ? guard.toolChoice : undefined,
    };
    return { guard, options };
}

/**
 * Pipeline wrap-up kickstart: the LLM emitted no tool calls but the pipeline
 * is still mid-walk (text was muted, so the user would see an empty reply).
 * Force another streaming round with the step-machine tool_choice. Returns
 * false when the LLM still refused to emit tool calls (stop looping; the
 * final save path handles the empty reply).
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {number} toolRound
 * @param {ReturnType<typeof import('./streamCallbacks').createStreamCallbacks>['follow']} followStreamCallback
 */
async function kickstartWrapUp(turn, loop, toolRound, followStreamCallback) {
    const { guard: kickGuard, options: kickOptions } = guardedFollowOptions(turn, loop, `kickstart round=${toolRound + 1}`);
    log.info(`[DirectChat pipeline] wrap-up kickstart round=${toolRound + 1} toolChoice=${kickGuard.mode} mute=${kickGuard.mute}`);
    closeVisibleRound(turn);
    try {
        await streamRound(turn, kickOptions, followStreamCallback);
    } catch (kickErr) {
        const kMsg = errText(kickErr);
        if (!SHAPE_REJECTED.test(kMsg)) throw kickErr;
        log.warn(`[DirectChat pipeline] Wrap-up rejected — retrying with toolChoice='auto'. Original: ${kMsg}`);
        await streamRound(turn, { ...kickOptions, toolChoice: 'auto' }, followStreamCallback);
    }
    if (turn.streamToolCalls.length === 0) {
        log.warn('[DirectChat pipeline] Wrap-up yielded no tool calls — aborting pipeline walk.');
        return false;
    }
    return true;
}

/**
 * Stream the follow-up response after tool execution (with tools, for multi-round).
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {number} toolRound
 * @param {ReturnType<typeof import('./streamCallbacks').createStreamCallbacks>['follow']} followStreamCallback
 */
async function streamFollowUp(turn, loop, toolRound, followStreamCallback) {
    closeVisibleRound(turn);
    turn.streamToolCalls = [];
    const { guard: followGuard, options: followStreamOptions } = guardedFollowOptions(turn, loop, `follow-up round=${toolRound}`);
    log.info(`[DirectChat pipeline] follow-up stream round=${toolRound} active=${turn.activatedSessionSkillIds.length} completed=${turn.completedSessionSkillIds.length}/${turn.sessionSkills.length} toolChoice=${followGuard.mode} mute=${followGuard.mute} roundsInStep=${turn.roundsInCurrentStep}`);
    try {
        await streamRound(turn, followStreamOptions, followStreamCallback);
    } catch (followErr) {
        const fMsg = errText(followErr);
        if (!SHAPE_REJECTED.test(fMsg)) throw followErr;
        log.warn(`[DirectChat pipeline] Follow-up stream rejected — retrying with toolChoice='auto'. Original: ${fMsg}`);
        turn.fullContent = '';
        turn.streamToolCalls = [];
        await streamRound(turn, { ...followStreamOptions, toolChoice: 'auto' }, followStreamCallback);
    }
}

/**
 * Tool calls received during streaming (Google SDK path and the self-hosted
 * runtimes). Loops to support multi-round tool calling (e.g. list →
 * get_summary).
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {ReturnType<typeof import('./streamCallbacks').createStreamCallbacks>['follow']} followStreamCallback
 */
async function runStreamedToolRounds(turn, loop, followStreamCallback) {
    let toolRound = 0;
    while (
        !turn.clientGone &&
        (turn.streamToolCalls.length > 0 || pipelineNeedsWrapUp(turn)) &&
        toolRound < MAX_STREAM_TOOL_ROUNDS
    ) {
        if (turn.streamToolCalls.length === 0) {
            if (!(await kickstartWrapUp(turn, loop, toolRound, followStreamCallback))) break;
        }
        toolRound++;
        log.info(`[DirectChat] Streamed tool round ${toolRound}: ${turn.streamToolCalls.map(t => t.function?.name).join(', ')}`);
        // Step-machine bookkeeping: mirror the pre-check path.
        countStepRound(turn, turn.streamToolCalls, tc => tc.function?.name);
        turn.messages.push({
            role: 'assistant',
            content: turn.fullContent || null,
            tool_calls: turn.streamToolCalls,
            // The reasoning that produced THESE tool calls. Claude needs the
            // signed thinking blocks to precede the tool_use blocks on replay,
            // and without them the next round reads a history where the model
            // called tools for no stated reason.
            thinking: snapshotThinkingParts(turn),
        });
        await executeToolRound(turn, loop, turn.streamToolCalls, { streamed: true });
        // If the AI proposed a webpage plan, stop the streaming tool loop and
        // let the next streamed text come out (the AI's summary alongside the
        // plan card). No further file edits run this turn.
        if (turn.webpagePlanProposedThisTurn) break;
        await streamFollowUp(turn, loop, toolRound, followStreamCallback);
    }
}

/**
 * All LLM rounds of the turn. Returns false when the pre-check loop ended the
 * stream on a provider error.
 * @param {Turn} turn
 * @param {ToolLoop} loop
 * @param {() => ((reason: string) => Promise<unknown>) | null | undefined} persistInterruptedTurn
 */
async function runToolLoop(turn, loop, persistInterruptedTurn) {
    if (!(await runPrecheckLoop(turn, loop, persistInterruptedTurn))) return false;
    // Both callbacks are built up front: they are pure factories over the
    // TurnState, and the follow-up one must survive the primary round.
    const { primary: streamCallback, follow: followStreamCallback } = createStreamCallbacks(turn);
    await streamPrimary(turn, loop, streamCallback);
    await runStreamedToolRounds(turn, loop, followStreamCallback);
    return true;
}

module.exports = { runToolLoop };

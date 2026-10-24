// @typecheck
/**
 * The turn's SPINE: the agentic loop and the round-to-round guards.
 *
 * The phases run in pipeline order and each one lives in its own file beside
 * this one — ./turnPrepare (which runs ./turnSetup, ./turnHistory,
 * ./turnPreflight and builds the ./skillActivation handler), then per round
 * ./roundRequest, ./roundStream (one of ./nativeAdapterStream |
 * ./rawSseStream) and ./toolRoundGate, ending in ../finalizeTurn. The
 * per-turn mutable state those phases write into is ./turnState; the exits
 * that are not a final answer are ./turnExits. What stays here is the loop
 * itself: the round-to-round guards (repeated failures, held confirmations,
 * empty and truncated rounds) and the four ways a turn can end — a final
 * answer, a graceful bail, a client disconnect, or the tool-round budget
 * running out.
 */
const { featureModule } = require('../../featureModules');
const terminationStore = require('../../../stores/terminationStore');
const configStore = require('../../../stores/configStore');
const agentStore = require('../../../stores/agentStore');
const { isTruncatedStop, truncationRetryMessages, emptyReplyRetryMessages } = require('../../llm/toolLoop');
const { respondGuardrailHardBlock } = require('../guardrailHardBlock');
const { finalizeStreamTurn } = require('../finalizeTurn');

// The turn's phases, in pipeline order.
const { prepareTurn } = require('./turnPrepare');
const { resolveProjectContext } = require('../contextEnrichment');
const { setupTurn } = require('./turnSetup');
const { assembleTurnHistory, _serializeConversationWrite } = require('./turnHistory');
const { runTurnPreflight } = require('./turnPreflight');
const { createSkillActivationHandler } = require('./skillActivation');
const { MAX_TOOL_REPEAT, createTurnLoopState, seedNotebookFromEditor } = require('./turnState');
const { attachmentTelemetry, terminationBase } = require('./terminationRow');
const { runModelRound } = require('./roundStream');
const { emitPhase } = require('../phaseEvents');
const { buildRoundRequest } = require('./roundRequest');
const { streamNativeAdapterRound } = require('./nativeAdapterStream');
const { streamRawSseRound } = require('./rawSseStream');
const { buildRoundAssistantMessage, dispatchToolRound } = require('./toolRoundGate');
const { wrapUpAnswer, attributeTestChatTurn, rethrowRoundError, throwLoopExit } = require('./turnExits');
const log = require('../../../telemetry/log');

// The once-per-turn phases, handed to ./turnPrepare, and one round's phases,
// handed to ./roundStream: both modules stay out of the server's large import
// cycle, so what sits in it is required here and passed down.
const PREPARE_PHASES = { setupTurn, resolveProjectContext, assembleTurnHistory, runTurnPreflight, createSkillActivationHandler };
const ROUND_STEPS = { buildRoundRequest, emitPhase, streamNativeAdapterRound, streamRawSseRound };

/**
 * Turn locks awaiting release, keyed by the call that took them.
 *
 * chatWithAgentStreamImpl has many completion branches, so releasing at each
 * one would reliably miss some. The wrapper in ./index.js already has the
 * single `finally` every path passes through; the Impl parks its release
 * callback here and the wrapper runs it. The lock's TTL is the backstop if
 * even that fails, but a thread blocked for two minutes is a bad enough
 * experience that it should not be the primary mechanism.
 */
const _pendingTurnReleases = new Map();

async function chatWithAgentStreamImpl(agentId, userId, userMessage, userAuth = {}, onEvent, historyOverride = null, messageMetadata = {}, _turnCallId = null) {
    // Setup, project context, history, preflight and the skill-activation
    // handler — see ./turnPrepare. `tools` and `onEvent` come back rebound by
    // the preflight (an org policy can drop web search; every event from here
    // on goes through the un-tokeniser).
    const t = await prepareTurn({ agentId, userId, userMessage, userAuth, onEvent, historyOverride, messageMetadata, _pendingTurnReleases, _turnCallId }, PREPARE_PHASES);

    // ── Hard block: skip AI entirely when guardrails/moderation fired ──
    // The AI must never see the user message or KB context when a violation is detected.
    const { moderationViolation, guardrailViolation } = t;
    if (moderationViolation || guardrailViolation) {
        return await respondGuardrailHardBlock({
            moderationViolation, guardrailViolation, onEvent: t.onEvent, messageMetadata,
            durableMessages: t.durableMessages, persistDurable: t.persistDurable, isEphemeral: t.isEphemeral,
            conversation: t.conversation, userAuth, processedUserMessage: t.processedUserMessage,
            userMessage, modelToUse: t.modelToUse, _serializeConversationWrite,
        });
    }

    const maxIterations = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 20;
    await seedNotebookFromEditor({
        messageMetadata, tools: t.tools, conversation: t.conversation, userId,
        workspaceTools: () => featureModule('integrations/workspaceTools'),
    });
    return await runTurnLoop({ ...t, agentId, userId, userMessage, userAuth, messageMetadata, maxIterations });
}

/**
 * The row every termination log writes — see ./terminationRow. The moving
 * counters are read at call time, which is why this is a closure.
 */
function terminationRowFor(t, st) {
    const { userId, agent, agentId, modelToUse, messageMetadata, conversation } = t;
    const _chatStartTime = Date.now();
    const { _termAttachmentCount, _termAttachmentBytes } = attachmentTelemetry({ messageMetadata });
    return () => terminationBase({
        userId, agent, agentId, modelToUse, messageMetadata, conversation,
        iterations: st.iterations, _chatStartTime,
        _termPromptTokens: st.promptTokens, _termCompletionTokens: st.completionTokens,
        _termAttachmentCount, _termAttachmentBytes,
    });
}

/**
 * The agentic loop: one model round after another until a round answers
 * without tool calls (finalized and returned), a round throws, the client
 * disconnects, or the tool-round budget runs out.
 *
 * Its own state, beyond ./turnState:
 *   - `_abortLogged`: set by whichever in-loop break already wrote the
 *     `aborted` row, so the post-loop exit can tell "already logged" from
 *     "disconnected but never logged".
 *   - `_forceFinalAnswer`: set when either repeat guard trips. The loop then
 *     runs ONE more round with the tool list withheld, so the model has to
 *     answer in prose and the normal final-response path (assistant message +
 *     persistence + return) runs — the same wrap-up idiom as
 *     routes/ai/webpageChat.js. Breaking out instead would leave the answer
 *     empty and end the turn on the max_iterations throw: a hard error banner
 *     and no saved reply.
 *   - `_bailReason`: WHY the wrap-up round is happening ('repeated_failure' |
 *     'pending_confirmation'). Turn-scoped because the nudge is written in
 *     one round and the fallback sentence in the next.
 *   - the empty-round guard flags: a round that ends TRULY empty (no text, no
 *     tool calls) is not "done" — reasoning models can spend the whole output
 *     budget on thinking tokens, and finalizing that is the "conversation just
 *     stops" defect. Agent chat gets the builders' (llm/toolLoop.js)
 *     one-retry-then-visible-placeholder treatment.
 */
async function runTurnLoop(t) {
    const { agent, agentId, userId, userMessage, messageMetadata, maxIterations, messages, onEvent, _isTestChat } = t;
    let { guardrailViolation, _assistantTokenisationInfo } = t;
    const st = createTurnLoopState();
    const _snapshotThinkingParts = st.thinking.snapshot;
    const _terminationBase = terminationRowFor(t, st);
    // Abort signal from the route handler (client disconnect)
    const signal = messageMetadata.signal || null;
    let _abortLogged = false;
    let _forceFinalAnswer = false;
    let _forcedFinalRoundUsed = false;
    let _bailReason = null;
    let _truncationRetried = false;
    let _emptyReplyRetried = false;

    // The `_forceFinalAnswer` clause lets the tool-free wrap-up round run even
    // when the tool budget is already spent. `_forcedFinalRoundUsed` only caps
    // that past-the-cap extension; what actually stops the loop is that the
    // wrap-up round is TERMINAL — it never dispatches tools (see the guard on the
    // tool-execution branch below), so it always falls through to the final
    // response and returns.
    while (st.iterations < maxIterations || (_forceFinalAnswer && !_forcedFinalRoundUsed)) {
        // Check if client disconnected
        if (signal?.aborted) {
            log.info('[AgentRuntime] Aborting — client disconnected');
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'aborted' }).catch(() => {});
            _abortLogged = true;
            break;
        }
        st.iterations++;
        if (_forceFinalAnswer) _forcedFinalRoundUsed = true;

        try {
            // What this round sends and the model call that sends it — see
            // runModelRound in ./roundStream. `_invalidToolCalls` are tool calls
            // the adapter dropped as malformed (warn-only in the adapters): the
            // empty-round guard feeds them back as a targeted nudge instead of
            // reading the round as "done".
            const _round = await runModelRound(t, st, {
                guardrailViolation, _assistantTokenisationInfo, _forceFinalAnswer, signal,
                terminationBaseRow: _terminationBase, steps: ROUND_STEPS,
            });
            _assistantTokenisationInfo = _round._assistantTokenisationInfo;
            guardrailViolation = _round.guardrailViolation;
            const { currentToolCalls, contentBuffer, _invalidToolCalls, _roundStopReason } = _round;

            // Check if we have tool calls to execute. The wrap-up round is
            // TERMINAL: no tools were offered, so anything the model emits here is
            // drift, and dispatching it re-armed the exact loop the bail exists to
            // stop — `_forceFinalAnswer` is never cleared, so every later round ran
            // tool-free AND still executed the failing tool, burning the whole
            // budget and ending on the same max_iterations throw.
            if (currentToolCalls.length > 0 && currentToolCalls[0]?.function?.name && !_forceFinalAnswer) {
                // The assistant message, the abort check and the dispatch — see
                // runToolRound below.
                const _toolRound = await runToolRound(t, st, { currentToolCalls, contentBuffer, signal, terminationBaseRow: _terminationBase });
                if (_toolRound.aborted) {
                    _abortLogged = true;
                    break;
                }
                _bailReason = _toolRound.bailReason;

                if (_bailReason) {
                    // Inject a system message so the wrap-up round gets a clear nudge.
                    // PROMPT-ONLY: this is a per-turn instruction, not conversation
                    // history. It must never reach durableMessages — a persisted
                    // `system` row renders as an assistant bubble in the UI.
                    messages.push({
                        role: 'system',
                        content: _bailReason === 'pending_confirmation'
                            ? 'You have asked the user to approve an action and it is still waiting. Calling it again does not run it and does not ask again. Tell the user what you are waiting for and stop.'
                            : 'A tool has failed repeatedly with identical arguments. Stop calling that tool with those arguments and explain to the user what is going wrong, or try a meaningfully different approach.',
                    });
                    // Tell the user-facing client that we are stopping the autonomous loop.
                    onEvent('tool_loop_broken', { reason: _bailReason });
                    // Deliberately NOT `break`: this bail is graceful, and breaking
                    // dropped the turn into the max_iterations throw — the user saw
                    // "Agent exceeded maximum tool call iterations" as a permanent
                    // error and no assistant reply was ever built or persisted.
                    // Run one tool-free round instead so the model can act on the
                    // nudge above and actually answer.
                    _forceFinalAnswer = true;
                    continue;
                }
                continue;
            }

            let fullResponse = contentBuffer;

            // ── Empty-round guard ──
            // Reaching this line means the round produced NO tool calls. If it
            // also produced no text, the turn is not "done": a reasoning model
            // can spend the whole output budget on thinking (truncated before
            // the first token), and a dropped malformed tool call leaves the
            // same silence. Finalizing that as a normal turn persists an empty
            // assistant bubble. The wrap-up round is exempt — it has its own
            // fallback below.
            if (!_forceFinalAnswer && (!fullResponse || !fullResponse.trim())) {
                if (isTruncatedStop(_roundStopReason) && !_truncationRetried) {
                    _truncationRetried = true;
                    log.warn(`[AgentRuntime] Round hit ${_roundStopReason} before any output — retrying once, thinking off`);
                    // Prompt-only (never durableMessages): the pair is per-turn
                    // instruction, like the bail nudge above.
                    messages.push(...truncationRetryMessages(fullResponse, _snapshotThinkingParts()));
                    continue;
                }
                if (!isTruncatedStop(_roundStopReason) && !_emptyReplyRetried) {
                    _emptyReplyRetried = true;
                    log.warn('[AgentRuntime] Round produced neither text nor a tool call — nudging once before giving up');
                    messages.push(...emptyReplyRetryMessages(fullResponse, _snapshotThinkingParts(), { rejected: _invalidToolCalls }));
                    continue;
                }
                // Retried already, or truncation persisted: never persist an
                // empty bubble — say what happened in the provider's place.
                fullResponse = isTruncatedStop(_roundStopReason)
                    ? 'The model hit its output length limit before it could answer. Please try again — a shorter conversation or a higher token budget helps.'
                    : 'The model returned an empty response. Please try again.';
                onEvent('content', { text: fullResponse });
            }

            // Wrap-up round: its own fallback — see wrapUpAnswer in ./turnExits.
            if (_forceFinalAnswer) {
                fullResponse = wrapUpAnswer({ currentToolCalls, fullResponse, _bailReason, onEvent });
            }

            // "Rule followed: …" chip, test chats only — see ./turnExits.
            if (_isTestChat) {
                await attributeTestChatTurn({ agent, agentId, userId, userMessage, messageMetadata, fullResponse, onEvent }, {
                    agentStore, ruleAttribution: () => require('../ruleAttribution'),
                });
            }

            // End of turn: assistant-message build, persistence, memory
            // extraction, redaction re-write and raw-payload transparency —
            // see ../finalizeTurn.
            return await finalizeRound(t, st, { fullResponse, useNativeAdapter: _round.useNativeAdapter, guardrailViolation, _assistantTokenisationInfo });
        } catch (error) {
            rethrowRoundError(error, { messages, terminationBaseRow: _terminationBase });
        }
    }

    // Loop exits without a final response — see throwLoopExit in ./turnExits.
    return throwLoopExit({ signal, abortLogged: _abortLogged, terminationBaseRow: _terminationBase });
}

/**
 * A round that asked for tools: dedupe the batch and build the assistant
 * message that carries it (plus the reasoning that led to it), check for a
 * client disconnect, then run the round's tool policy and dispatch — see
 * ./toolRoundGate. Resolves to `{ aborted: true }` (the `aborted` row is
 * already written) or `{ bailReason }`.
 */
async function runToolRound(t, st, { currentToolCalls, contentBuffer, signal, terminationBaseRow }) {
    const _prepared = buildRoundAssistantMessage({ currentToolCalls, contentBuffer, onEvent: t.onEvent, _snapshotThinkingParts: st.thinking.snapshot });
    const assistantMessage = _prepared.assistantMessage;
    t.messages.push(assistantMessage);
    t.durableMessages.push(assistantMessage);

    // Check abort before tool execution
    if (signal?.aborted) {
        log.info('[AgentRuntime] Aborting before tool execution — client disconnected');
        terminationStore.logTermination({ ...terminationBaseRow(), termination_type: 'aborted' }).catch(() => {});
        return { aborted: true };
    }
    return { bailReason: await dispatchRound(t, st, { currentToolCalls: _prepared.currentToolCalls, signal }) };
}

/** One round's tool policy and dispatch (./toolRoundGate); resolves to the bail reason, if any. */
function dispatchRound(t, st, { currentToolCalls, signal }) {
    return dispatchToolRound({
        currentToolCalls, toolCalls: st.toolCalls, signal, onEvent: t.onEvent, messages: t.messages,
        durableMessages: t.durableMessages, persistDurable: t.persistDurable, dlpShield: t.dlpShield,
        regexConfig: t.regexConfig, webSearchGuardEnabled: t.webSearchGuardEnabled,
        webSearchGuardPiiCategories: t.webSearchGuardPiiCategories, toolParamsMap: t.toolParamsMap,
        userAuth: t.userAuth, userId: t.userId, agent: t.agent, agentId: t.agentId,
        conversation: t.conversation, modelToUse: t.modelToUse, messageMetadata: t.messageMetadata,
        onSkillsActivated: t.onSkillsActivated, tools: t.tools, unattended: t.unattended,
        _failingToolCounts: st.failingToolCounts, MAX_TOOL_REPEAT, _toolHistory: st.toolHistory,
        _emailDrafts: st.emailDrafts, _calendarDrafts: st.calendarDrafts, _linkedInDrafts: st.linkedInDrafts,
        _mapEmbeds: st.mapEmbeds, _audioFiles: st.audioFiles, _generatedFiles: st.generatedFiles,
        _kbSources: t._kbSources, _seenChunkIds: t._seenChunkIds,
        _pendingToolCalls: st.pendingToolCalls, _pendingToolCounts: st.pendingToolCounts,
    });
}

/** Hand the final answer and everything the turn collected to ../finalizeTurn. */
function finalizeRound(t, st, { fullResponse, useNativeAdapter, guardrailViolation, _assistantTokenisationInfo }) {
    return finalizeStreamTurn({
        fullResponse, useNativeAdapter, onEvent: t.onEvent, messageMetadata: t.messageMetadata,
        _emailDrafts: st.emailDrafts, _calendarDrafts: st.calendarDrafts, _linkedInDrafts: st.linkedInDrafts,
        _mapEmbeds: st.mapEmbeds, _audioFiles: st.audioFiles, _generatedFiles: st.generatedFiles,
        _pendingToolCalls: st.pendingToolCalls,
        _toolHistory: st.toolHistory, _kbSources: t._kbSources, _thinkingParts: st.thinking.parts,
        _thinking: st.thinking.text, conversation: t.conversation,
        _ut: t._ut, _captureRaw: t._captureRaw, _rawResponseBuffer: t._eventWrapper.getRawResponseBuffer(),
        _assistantTokenisationInfo, _userPrivacyMeta: t._userPrivacyMeta, userSave: t.userSave,
        durableMessages: t.durableMessages, messages: t.messages, persistDurable: t.persistDurable,
        isEphemeral: t.isEphemeral, agent: t.agent, agentId: t.agentId, userId: t.userId,
        guardrailViolation, processedUserMessage: t.processedUserMessage, userMessage: t.userMessage,
        userAuth: t.userAuth, extractMemoriesEnabled: t.extractMemoriesEnabled,
        validProjectId: t.validProjectId, modelToUse: t.modelToUse, toolCalls: st.toolCalls,
        _serializeConversationWrite, memoryPolicy: t.memoryPolicy, memoryUsed: t.memoryUsed,
    });
}

module.exports = { chatWithAgentStreamImpl, _pendingTurnReleases };

/**
 * The turn's SPINE: the agentic loop, the state it carries and its exits.
 *
 * The phases run in pipeline order and each one lives in its own file beside
 * this one — ./turnSetup, ./turnHistory, ./turnPreflight, ./skillActivation,
 * then per round ./roundRequest, one of ./nativeAdapterStream | ./rawSseStream
 * and ./toolRoundGate, ending in ../finalizeTurn. What stays here is what the
 * loop itself owns: the per-turn mutable state those phases write into, the
 * round-to-round guards (repeated failures, held confirmations, empty and
 * truncated rounds) and the four ways a turn can end — a final answer, a
 * graceful bail, a client disconnect, or the tool-round budget running out.
 */
const terminationStore = require('../../../stores/terminationStore');
const agentStore = require('../../../stores/agentStore');
const configStore = require('../../../stores/configStore');
const testChatMod = require('../testChat');
const { sanitizeError } = require('../../privacy/errorSanitizer');
const { findWireProblems } = require('../../../utils/messageUtils');
const { emitPhase } = require('../phaseEvents');
const { isTruncatedStop, truncationRetryMessages, emptyReplyRetryMessages } = require('../../llm/toolLoop');
const { resolveProjectContext } = require('../contextEnrichment');
const { respondGuardrailHardBlock } = require('../guardrailHardBlock');
const { finalizeStreamTurn } = require('../finalizeTurn');

// ============ RETRY & ERROR HELPERS ============
// Extracted to ../streamRetry so they're unit-testable without this module's
// heavy require graph. See that file for the per-attempt reset contract.
const { classifyStreamError } = require('../streamRetry');

// The turn's phases, in pipeline order.
const { setupTurn } = require('./turnSetup');
const { assembleTurnHistory, _serializeConversationWrite } = require('./turnHistory');
const { runTurnPreflight } = require('./turnPreflight');
const { createSkillActivationHandler } = require('./skillActivation');
const { attachmentTelemetry, terminationBase } = require('./terminationRow');
const { buildRoundRequest } = require('./roundRequest');
const { streamNativeAdapterRound } = require('./nativeAdapterStream');
const { streamRawSseRound } = require('./rawSseStream');
const { buildRoundAssistantMessage, dispatchToolRound } = require('./toolRoundGate');
const log = require('../../../telemetry/log');

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
    // Which agent row, which model and provider, which tools, which
    // conversation — and the shared project thread's turn lock. See
    // ./turnSetup; the release callback is parked with the wrapper (via
    // _pendingTurnReleases), which owns the one `finally` every completion
    // branch of this function passes through.
    const _setup = await setupTurn({ agentId, userId, userMessage, userAuth, onEvent, messageMetadata, _pendingTurnReleases, _turnCallId });
    const {
        _isTestChat, agent, globalConfig, modelToUse, config,
        disableExternalTools, isStandardTier, activatedSkillIds,
        skillApps, baseIntegrationToolNames, toolParamsMap, unattended,
        isEphemeral, conversation, _sharedThread,
    } = _setup;
    let tools = _setup.tools;

    // Assign new conversation to project if projectId provided — validated and
    // resolved in ./contextEnrichment.
    let { extractMemoriesEnabled, validProjectId, validProject } = await resolveProjectContext({ userId, messageMetadata, conversation, isEphemeral });

    // The two message arrays — prompt shape vs durable history — plus the
    // current user turn, the attachment replay and (opt-in) compaction. See
    // ./turnHistory, which also owns `persistDurable`, the single point of
    // truth for what gets persisted.
    const _history = await assembleTurnHistory({
        agent, userId, userMessage, userAuth, messageMetadata, modelToUse,
        conversation, isEphemeral, historyOverride, onEvent, _sharedThread,
    });
    const { durableMessages, persistedByLive, persistDurable, userSave, promptUserMsg } = _history;
    let messages = _history.messages;

    // The shield, the prompt halves, the guardrails, the outbound DLP verdict,
    // the un-tokenising event wrapper and the project/KB injection — see
    // ./turnPreflight. Two bindings come back REBOUND rather than merely
    // reported: `tools` (an org policy can drop web search for this turn) and
    // `onEvent` (every event from here on goes through the un-tokeniser).
    const _preflight = await runTurnPreflight({
        agent, agentId, userId, userMessage, userAuth, messageMetadata, globalConfig,
        config, modelToUse, conversation, messages, tools, validProjectId, validProject,
        isStandardTier, onEvent, userSave, promptUserMsg,
    });
    tools = _preflight.tools;
    onEvent = _preflight.onEvent;
    const {
        dlpShield, regexConfig, webSearchGuardEnabled,
        webSearchGuardPiiCategories, _eventWrapper, _ut, _captureRaw,
        _kbSources, _seenChunkIds, memoryPolicy, memoryUsed,
    } = _preflight;
    let {
        systemPrompt, volatileSystemPrompt, moderationViolation, guardrailViolation,
        processedUserMessage, _userPrivacyMeta, _assistantTokenisationInfo,
    } = _preflight;

    // Skill activation → mid-loop tool refresh (./skillActivation). Built here
    // rather than higher up because it closes over the FINAL `tools` array and
    // the un-tokenising `onEvent`: the preflight may have replaced both.
    const onSkillsActivated = createSkillActivationHandler({
        agent, agentId, userId, userAuth, messageMetadata, onEvent,
        conversation, isEphemeral, tools, disableExternalTools,
        skillApps, activatedSkillIds, baseIntegrationToolNames,
    });


    // ── Hard block: skip AI entirely when guardrails/moderation fired ──
    // The AI must never see the user message or KB context when a violation is detected.
    const hasViolation = moderationViolation || guardrailViolation;
    if (hasViolation) {
        return await respondGuardrailHardBlock({ moderationViolation, guardrailViolation, onEvent, messageMetadata, durableMessages, persistDurable, isEphemeral, conversation, userAuth, processedUserMessage, userMessage, modelToUse, _serializeConversationWrite });
    }

    let iterations = 0;
    const maxIterations = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 20;
    let toolCalls = [];
    let fullResponse = '';
    const _chatStartTime = Date.now();
    let _termPromptTokens = 0;
    let _termCompletionTokens = 0;
    const { _termAttachmentCount, _termAttachmentBytes } = attachmentTelemetry({ messageMetadata });
    // The row every termination log writes — see ./terminationRow. The moving
    // counters are read at call time, which is why this stays a closure.
    const _terminationBase = () => terminationBase({
        userId, agent, agentId, modelToUse, messageMetadata, conversation,
        iterations, _chatStartTime, _termPromptTokens, _termCompletionTokens,
        _termAttachmentCount, _termAttachmentBytes,
    });
    let _emailDrafts = [];
    let _calendarDrafts = [];
    let _linkedInDrafts = [];
    let _mapEmbeds = [];
    let _audioFiles = [];
    let _generatedFiles = []; // decks and other files a tool built — shown as a card, persisted
    // Tool calls this turn held back for a person to approve. Same mechanism
    // as the draft arrays above: the turn runs on to `done`, the pending call
    // rides out on the assistant message, and a client that does not draw it
    // simply shows nothing — exactly how email_draft degrades today.
    let _pendingToolCalls = [];
    let _toolHistory = []; // Track tool calls for persistence
    let _thinking = '';    // Accumulate model reasoning for persistence (legacy string form)
    let _thinkingParts = []; // Structured thinking parts — carry signature (Claude) + timing for UI
    // Helper: look up / create a thinking part by provider-supplied partId.
    const _getThinkingPart = (partId) => {
        if (!partId) return null;
        let part = _thinkingParts.find(p => p.id === partId);
        if (!part) {
            part = { id: partId, text: '', startedAt: Date.now(), endedAt: null };
            _thinkingParts.push(part);
        }
        return part;
    };
    // Replay-shaped copy of the reasoning produced so far this turn. Only parts
    // that can actually be sent back are worth carrying: a signed thinking block
    // or a redacted block with its payload. Everything else is UI-only.
    let _thinkingSnapshotFrom = 0;
    const _snapshotThinkingParts = () => {
        const slice = _thinkingParts.slice(_thinkingSnapshotFrom);
        _thinkingSnapshotFrom = _thinkingParts.length;
        const replayable = slice
            // A signature alone is enough: under `display: 'omitted'` the text
            // is empty and the signature carries the reasoning.
            .filter(p => p.signature || (p.redacted && p.redactedData))
            .map(p => ({
                id: p.id,
                text: p.text,
                redacted: p.redacted || undefined,
                signature: p.signature || undefined,
                redactedData: p.redactedData || undefined,
            }));
        return replayable.length > 0 ? replayable : undefined;
    };

    // Abort signal from the route handler (client disconnect)
    const signal = messageMetadata.signal || null;
    // Set by whichever in-loop break already wrote the `aborted` termination row,
    // so the post-loop exit below can tell "already logged" from "disconnected but
    // never logged" instead of assuming the row exists.
    let _abortLogged = false;

    // Track repeated failing tool calls so the loop breaks instead of burning
    // the full max-iterations budget on a deterministic failure (e.g. permission
    // denied). Key: tool-name + stable JSON of args; value: failure count.
    const _failingToolCounts = new Map();
    const MAX_TOOL_REPEAT = 3;
    // The same guard for calls that are HELD rather than failing: key → how many
    // rounds that action has sat waiting for approval. A held call is not a
    // failure (it has not run at all), but a model that keeps re-asking for one
    // burns the same budget, so it bails on the same threshold.
    const _pendingToolCounts = new Map();
    // Set when either guard trips. The loop then runs ONE more round with the
    // tool list withheld, so the model has to answer in prose and the normal
    // final-response path (assistant message + persistence + return) runs.
    // Same wrap-up idiom as routes/ai/webpageChat.js:1069-1094. Breaking out
    // instead would leave `fullResponse` empty and end the turn on the
    // max_iterations throw below — a hard error banner and no saved reply.
    let _forceFinalAnswer = false;
    let _forcedFinalRoundUsed = false;
    // WHY the wrap-up round is happening: 'repeated_failure' | 'pending_confirmation'.
    // Turn-scoped because the nudge is written in one round and the fallback
    // sentence in the next — and the two reasons must not borrow each other's
    // words: telling someone "a tool kept failing" when the truth is "I am
    // waiting for you to approve it" sends them to debug a tool that is fine.
    let _bailReason = null;
    // _flattenToolRoundTrips / _stableStringify moved to ./toolRoundExecutor.

    // ── Empty-round guard state ──
    // Stop reason of the most recent round, hoisted out of the two streaming
    // branches (native adapter / raw SSE) so the post-round guard below can
    // tell "cut off at the output limit" from "the model simply said nothing".
    // A round that ends TRULY empty (no text, no tool calls) is not "done":
    // reasoning models can spend the whole output budget on thinking tokens,
    // and finalizing that as a normal turn is the "conversation just stops"
    // defect. The builders have had these guards (llm/toolLoop.js); agent
    // chat gets the same one-retry-then-visible-placeholder treatment.
    let _roundStopReason = null;
    let _truncationRetried = false;
    let _emptyReplyRetried = false;

    // ── Seed notebook store from the live client editor content (BFSF-287) ──
    // notebookspaceContent is the freshest editor Markdown; historically used
    // only as an "is the panel open" flag (contextBuilder.js:149). Seed the SAME
    // store the notebook tools read (document_content when linked, else
    // workspace_content) ONCE, before the loop, so notebook_read/replace/write
    // build on the user's current edits instead of the agent's last write.
    // Gated on the notebook tools actually being present — that array is only
    // populated when the notebooks entitlement + use_notebooks permission pass,
    // so this mirrors the tool gate exactly without re-running the checks.
    const _seedNbContent = messageMetadata?.notebookspaceContent;
    const _hasNotebookTools = Array.isArray(tools) && tools.some(t =>
        t.function?.name === 'notebook_read' || t.function?.name === 'notebook_write');
    if (_hasNotebookTools && typeof _seedNbContent === 'string' && _seedNbContent.trim() !== '' && conversation?.id) {
        try {
            const { syncClientWorkspaceContent } = require('../../../integrations/workspaceTools');
            const _seedRes = await syncClientWorkspaceContent(conversation.id, userId, _seedNbContent);
            if (_seedRes?.seeded) log.info(`[AgentRuntime] Seeded notebook from live editor content (${_seedNbContent.length} chars, ${_seedRes.reason})`);
        } catch (e) {
            log.warn('[AgentRuntime] notebook seed-on-entry failed:', e.message);
        }
    }
    // The `_forceFinalAnswer` clause lets the tool-free wrap-up round run even
    // when the tool budget is already spent. `_forcedFinalRoundUsed` only caps
    // that past-the-cap extension; what actually stops the loop is that the
    // wrap-up round is TERMINAL — it never dispatches tools (see the guard on the
    // tool-execution branch below), so it always falls through to the final
    // response and returns.
    while (iterations < maxIterations || (_forceFinalAnswer && !_forcedFinalRoundUsed)) {
        // Check if client disconnected
        if (signal?.aborted) {
            log.info('[AgentRuntime] Aborting — client disconnected');
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'aborted' }).catch(() => {});
            _abortLogged = true;
            break;
        }
        iterations++;
        if (_forceFinalAnswer) _forcedFinalRoundUsed = true;

        try {
            // What this round sends, and down which branch — see ./roundRequest.
            const _req = await buildRoundRequest({
                agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
                messages, iterations, persistedByLive, dlpShield, onEvent,
                systemPrompt, volatileSystemPrompt, guardrailViolation, moderationViolation,
                _forceFinalAnswer, _assistantTokenisationInfo,
            });
            const {
                headers, apiUrl, finalMessages, effectiveSystemPrompt, effectiveVolatilePrompt,
                tierSettings, providerAdapter, useNativeAdapter, _adapterIsLocal, _streamCallStart,
            } = _req;
            _assistantTokenisationInfo = _req._assistantTokenisationInfo;

            // Final pre-LLM phase marker — only on the first iteration. This
            // tells the UI "we're handing the request to the model now" so the
            // status placeholder fades out before the first token arrives.
            if (iterations === 1) {
                emitPhase(onEvent, 'streaming_start', modelToUse);
            }

            let currentToolCalls = [];
            let contentBuffer = '';
            // Tool calls the adapter dropped as malformed this round (warn-only
            // in the adapters) — the empty-round guard feeds them back as a
            // targeted nudge instead of reading the round as "done".
            let _invalidToolCalls = [];
            _roundStopReason = null;

            if (useNativeAdapter) {
                // ─── Adapter streaming (SDK providers + self-hosted runtimes) ─────
                const _round = await streamNativeAdapterRound({
                    agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
                    tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
                    effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
                    providerAdapter, _adapterIsLocal, _streamCallStart,
                    _thinking, _thinkingParts, _thinkingSnapshotFrom, _getThinkingPart,
                });
                currentToolCalls = _round.currentToolCalls;
                contentBuffer = _round.contentBuffer;
                _invalidToolCalls = _round._invalidToolCalls;
                guardrailViolation = _round.guardrailViolation;
                _thinking = _round._thinking;
                _thinkingSnapshotFrom = _round._thinkingSnapshotFrom;
                const _adapterStreamUsage = _round._adapterStreamUsage;

                _termPromptTokens += _adapterStreamUsage?.prompt_tokens || 0;
                _termCompletionTokens += _adapterStreamUsage?.completion_tokens || 0;
                _roundStopReason = _adapterStreamUsage?.stop_reason || null;
                if (isTruncatedStop(_roundStopReason)) {
                    terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_tokens' }).catch(() => {});
                }

            } else {
                // ─── Raw fetch SSE streaming (OpenAI-compatible) ──────────────
                const _round = await streamRawSseRound({
                    agent, agentId, userId, messageMetadata, modelToUse, conversation,
                    tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
                    effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
                    headers, apiUrl, _streamCallStart, _thinking,
                });
                currentToolCalls = _round.currentToolCalls;
                contentBuffer = _round.contentBuffer;
                guardrailViolation = _round.guardrailViolation;
                _thinking = _round._thinking;
                const _sseStreamUsage = _round._sseStreamUsage;
                const _sseFinishReason = _round._sseFinishReason;

                _termPromptTokens += _sseStreamUsage?.prompt_tokens || 0;
                _termCompletionTokens += _sseStreamUsage?.completion_tokens || 0;
                _roundStopReason = _sseFinishReason || null;
                if (isTruncatedStop(_roundStopReason)) {
                    terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_tokens' }).catch(() => {});
                }
            } // end else (raw fetch SSE)

            // Check if we have tool calls to execute. The wrap-up round is
            // TERMINAL: no tools were offered, so anything the model emits here is
            // drift, and dispatching it re-armed the exact loop the bail exists to
            // stop — `_forceFinalAnswer` is never cleared, so every later round ran
            // tool-free AND still executed the failing tool, burning the whole
            // budget and ending on the same max_iterations throw.
            if (currentToolCalls.length > 0 && currentToolCalls[0]?.function?.name && !_forceFinalAnswer) {
                // Dedupe the batch and build the assistant message that carries
                // it (plus the reasoning that led to it) — see ./toolRoundGate.
                const _prepared = buildRoundAssistantMessage({ currentToolCalls, contentBuffer, onEvent, _snapshotThinkingParts });
                currentToolCalls = _prepared.currentToolCalls;
                const assistantMessage = _prepared.assistantMessage;
                messages.push(assistantMessage);
                durableMessages.push(assistantMessage);

                // Check abort before tool execution
                if (signal?.aborted) {
                    log.info('[AgentRuntime] Aborting before tool execution — client disconnected');
                    terminationStore.logTermination({ ..._terminationBase(), termination_type: 'aborted' }).catch(() => {});
                    _abortLogged = true;
                    break;
                }

                // The round's tool policy and its dispatch — see ./toolRoundGate.
                _bailReason = await dispatchToolRound({
                    currentToolCalls, toolCalls, signal, onEvent, messages, durableMessages,
                    persistDurable, dlpShield, regexConfig, webSearchGuardEnabled,
                    webSearchGuardPiiCategories, toolParamsMap, userAuth, userId, agent,
                    agentId, conversation, modelToUse, messageMetadata, onSkillsActivated,
                    tools, unattended,
                    _failingToolCounts, MAX_TOOL_REPEAT, _toolHistory, _emailDrafts,
                    _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles,
                    _kbSources, _seenChunkIds, _pendingToolCalls, _pendingToolCounts,
                });

                if (_bailReason) {
                    // Inject a system message so the wrap-up round gets a clear nudge.
                    // PROMPT-ONLY: this is a per-turn instruction, not conversation
                    // history. It must never reach durableMessages — a persisted
                    // `system` row renders as an assistant bubble in the UI.
                    messages.push({
                        role: 'system',
                        content: _bailReason === 'pending_confirmation'
                            ? 'You have asked the user to approve an action and it is still waiting. Calling it again does not run it and does not ask again. Tell the user what you are waiting for and stop.'
                            : 'A tool has failed repeatedly with identical arguments. Stop calling that tool with those arguments and explain to the user what is going wrong, or try a meaningfully different approach.'
                    });
                    // Tell the user-facing client that we are stopping the autonomous loop.
                    onEvent('tool_loop_broken', { reason: _bailReason });
                    // Deliberately NOT `break`: this bail is graceful, and breaking
                    // dropped the turn into the max_iterations throw at the bottom
                    // of this function — the user saw "Agent exceeded maximum tool
                    // call iterations" as a permanent error and no assistant reply
                    // was ever built or persisted. Run one tool-free round instead
                    // so the model can act on the nudge above and actually answer.
                    _forceFinalAnswer = true;
                    continue;
                }
                continue;
            }

            fullResponse = contentBuffer;

            // ── Empty-round guard ──
            // Reaching this line means the round produced NO tool calls. If it
            // also produced no text, the turn is not "done": a reasoning model
            // can spend the whole output budget on thinking (truncated before
            // the first token), and a dropped malformed tool call leaves the
            // same silence. Finalizing that as a normal turn persists an empty
            // assistant bubble and the UI shows the conversation simply
            // stopping. The builders have had this guard (llm/toolLoop.js);
            // agent chat gets the same one-retry-then-visible-words treatment.
            // The wrap-up round is exempt — it has its own fallback below.
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

            // Wrap-up round: the dropped tool calls (see the guard above) are only
            // logged, never dispatched. If the model spent the round entirely on
            // them it produced no prose either, and the turn would end with an
            // empty assistant bubble — which is the original defect (a graceful
            // bail that saves no reply) wearing a different hat. Say what happened.
            if (_forceFinalAnswer) {
                if (currentToolCalls.length > 0) {
                    log.warn(`[AgentRuntime] Wrap-up round returned ${currentToolCalls.length} tool call(s) with no tools offered — dropped, ending the turn.`);
                    currentToolCalls = [];
                }
                if (!fullResponse || !fullResponse.trim()) {
                    fullResponse = _bailReason === 'pending_confirmation'
                        ? 'I have asked for your approval before running that action, and I am waiting for it. Nothing has run yet — approve it and I will carry on.'
                        : 'I stopped because a tool kept failing with the same arguments and I could not complete this request. Please check that tool\'s configuration, or try a different approach.';
                    onEvent('content', { text: fullResponse });
                }
            }

            // ── "Regel gevolgd: …" (A4 deel B) ─────────────────────
            // De attributie-pass, en dit is zijn ENIGE call-site: hij draait
            // ná de beurt en vóór `done`, hij raakt het antwoord niet aan en
            // hij kost alleen iets in een testchat. `attributeTurn` bewaakt
            // die geldkraan zelf (`testChat !== true` ⇒ null), dus deze `if`
            // is een besparing en geen poort.
            //
            // De rol komt van `getAgent`, niet van `agent`: de
            // runtime-projectie STRIPT `persona` (het is een editor-artefact),
            // dus zonder deze lezing is er niets om tegen te attribueren. Eén
            // extra query, alleen in een testchat, alleen aan het eind.
            if (_isTestChat) {
                try {
                    const _editorView = await agentStore.getAgent(agentId);
                    const _attribution = await require('../ruleAttribution').attributeTurn({
                        testChat: true,
                        persona: _editorView ? _editorView.persona : null,
                        configInfo: testChatMod.testChatConfigInfo(agent),
                        answer: fullResponse,
                        question: typeof userMessage === 'string' ? userMessage : '',
                        orgId: messageMetadata?.orgId || agent.organization_id || null,
                        userId,
                    });
                    // Geen event bij `null`: geen chip is geen bewering, en een
                    // leeg event zou er wél een zijn.
                    if (_attribution) onEvent?.('rule_attribution', _attribution);
                } catch (e) {
                    log.warn('[AgentRuntime] rule attribution skipped:', e.message);
                }
            }

            // End of turn: assistant-message build, persistence, memory
            // extraction, redaction re-write and raw-payload transparency —
            // see ./finalizeTurn.
            return await finalizeStreamTurn({
                fullResponse, useNativeAdapter, onEvent, messageMetadata,
                _emailDrafts, _calendarDrafts, _linkedInDrafts, _mapEmbeds, _audioFiles, _generatedFiles,
                _pendingToolCalls,
                _toolHistory, _kbSources, _thinkingParts, _thinking, conversation,
                _ut, _captureRaw, _rawResponseBuffer: _eventWrapper.getRawResponseBuffer(),
                _assistantTokenisationInfo, _userPrivacyMeta, userSave, durableMessages,
                messages, persistDurable, isEphemeral, agent, agentId, userId,
                guardrailViolation, processedUserMessage, userMessage, userAuth,
                extractMemoriesEnabled, validProjectId, modelToUse, toolCalls,
                _serializeConversationWrite, memoryPolicy, memoryUsed,
            });
        } catch (error) {
            // Classify the error for better logging and user-facing messages
            const classified = error._classified || classifyStreamError(error);
            log.error(`[Agent Stream] Error (${classified.errorType}):`, error.message);
            if (classified.errorType === 'invalid_request_body') {
                // Indexes and kinds only, never content.
                log.warn('[Agent Stream] Request body rejected as unparseable; wire problems in sent messages:', JSON.stringify(findWireProblems(messages)));
            }
            terminationStore.logTermination({
                ..._terminationBase(),
                termination_type: 'error',
                ...sanitizeError(error),
            }).catch(() => {});
            error._terminationLogged = true;
            // Attach classification so the route handler can send a descriptive error
            error._classified = classified;
            error.message = classified.userMessage;
            throw error;
        }
    }

    // ── Loop exits without a final response ──────────────────────────────
    // `fullResponse` is assigned in exactly one place (the "no more tool calls"
    // branch), and that branch returns a few lines later or throws from the
    // catch — so it is ALWAYS empty down here. The old `if (fullResponse) { … }`
    // guard, plus its duplicate memory-extraction/return body, could never run;
    // every exit fell straight through to the max_iterations throw. Do not
    // reintroduce a "return the buffered response" guard here — handle each
    // exit explicitly instead.

    // Client disconnected mid-turn. When one of the in-loop breaks ran it already
    // wrote the `aborted` row, so logging again here would double-count the stop;
    // logging max_iterations instead would mislabel it (with an iteration_count
    // far below the cap). But the loop can also reach the cap while the client is
    // gone — the disconnect lands after both in-loop checks, on the last round —
    // and that exit wrote nothing at all. `_abortLogged` tells the two apart so
    // every aborted turn leaves exactly one row.
    // Throw an AbortError so routes/agents/chat.js:322 takes its abort branch
    // and closes the SSE stream without pushing an `error` frame at a client
    // that is already gone.
    if (signal?.aborted) {
        if (!_abortLogged) {
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'aborted' }).catch(() => {});
        }
        const _abortErr = new Error('Client disconnected before the turn finished');
        _abortErr.name = 'AbortError';
        _abortErr._terminationLogged = true;
        throw _abortErr;
    }

    // Genuine budget exhaustion: the model kept asking for tools until the
    // configured max_tool_rounds_chat ran out.
    terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_iterations' }).catch(() => {});
    const _maxIterErr = new Error('Agent exceeded maximum tool call iterations');
    _maxIterErr._terminationLogged = true;
    throw _maxIterErr;
}

module.exports = { chatWithAgentStreamImpl, _pendingTurnReleases };

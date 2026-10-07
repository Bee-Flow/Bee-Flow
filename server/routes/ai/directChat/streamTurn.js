/**
 * Direct Chat — the streaming turn (POST /chat/direct/stream).
 *
 * This file holds the route handler's spine: the SSE lifecycle, the two
 * tool-calling loops (pre-check + streamed), the volatile-block layout that
 * keeps the cached prompt prefix stable, and the outer catch/finally that
 * releases the shared-thread turn lock. Everything else is a phase beside it
 * in this folder, called in pipeline order and sharing one TurnState: the
 * Swarm branch, turnSetup, toolStackAssembly, promptAssembly,
 * sharedThreadLock, sessionSkillSetup, stageModelSwap, attachmentIntake,
 * inputGates, compactionPhase, chatOptions, stepMachine, toolRefresh,
 * toolContext, streamCallbacks, toolResultEvents, turnUsage and finalizeTurn.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { toolSetFingerprint } = require('../../../core/llm/promptCacheStability');
const agentStore = require('../../../stores/agentStore');
const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
} = require('../../../core/tools/sessionSkillRuntime');
const { syncClientWorkspaceContent } = require('../../../integrations/workspaceTools');
const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
const { applyTokenMapToMessages } = require('../../../core/dlp/applyTokenMapToOutbound');
const { executeDirectChatToolCall } = require('./toolExec');
const {
    skipToolPrecheck,
    layoutVolatile: layoutVolatileBlock,
    createVolatileGuard,
    traceStablePrefix: traceTurnPrefix,
} = require('./volatileLayout');
// Org-health capture — fire-and-forget emits for the silent chat-killers
// (provider config/stream failures, DLP hard blocks) plus a success-side
// resolve so the dashboard self-heals once an org's chats work again.
const orgHealth = require('../../../services/orgHealth');
const { encryptionOpts, emitThreadEvent, _resolveChatProblemsThrottled } = require('./shared');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { startSseHeartbeat } = require('../../../core/http/sseHelpers');
const { getUserAuth } = require('../../../utils/routeHelpers');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');

// The turn's pipeline phases — bodies moved verbatim out of this handler.
// They share one mutable TurnState instead of the handler's own bindings.
const { createTurnState } = require('./turnState');
const { runSwarmTierTurn } = require('./swarmTurn');
const { resolveTurnSetup } = require('./turnSetup');
const { assembleToolStack } = require('./toolStackAssembly');
const { buildPromptAndHistory } = require('./promptAssembly');
const { setupSessionSkills } = require('./sessionSkillSetup');
const { claimSharedThreadTurn } = require('./sharedThreadLock');
const { swapModelForActiveStage } = require('./stageModelSwap');
const { processAttachmentsAndUserMessage } = require('./attachmentIntake');
const { runInputGates } = require('./inputGates');
const { countDirectTurn } = require('./chatSignalsTurn');
const { compactConversation } = require('./compactionPhase');
const { buildChatOptions } = require('./chatOptions');
const { computeStepMachineGuard, pipelineNeedsWrapUp, callAdapterWithFallback } = require('./stepMachine');
const { applyLoadTools, onSkillsActivated } = require('./toolRefresh');
const { createToolContextFactory } = require('./toolContext');
const { createUntokeniserSink, createStreamCallbacks, snapshotThinkingParts } = require('./streamCallbacks');
const { emitToolResultEvents } = require('./toolResultEvents');
const { logTurnUsage } = require('./turnUsage');
const { toFriendlyTurnError } = require('./turnErrors');
const { finalizeDirectChatTurn } = require('./finalizeTurn');
const { validate } = require('../../../core/http/validate');
// Typed, not closed: see the header of ./turnSchema.js.
const { DirectTurnBody } = require('./turnSchema');

// ─── Streaming Direct Chat ───────────────────────────────────────

router.post('/chat/direct/stream', requireAuth, validate({ body: DirectTurnBody }), async (req, res) => {
    const { message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings, disabledMedia, webSearchEnabled = true, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable, sidePanelWebpage, projectId, timezone, systemPrompt: requestSystemPrompt, activeSkillIds, reasoningEffort: requestReasoningEffort, sessionSkills: requestSessionSkills, activatedSessionSkillIds: requestActivatedSessionSkillIds, knowledgeBaseIds: requestedKbIds, planExecution: webpagePlanExecution } = req.body;
    const userId = req.session.user.id;

    if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }

    // ─── Swarm tier branch ─────────────────────────────────────────
    // When the user picked the "Swarm" tier in the model dropdown, the entire
    // turn runs through the swarm runtime. Each worker uses the SAME tool
    // stack as a regular direct-chat call (components + integrations + MCP),
    // so research workers can hit web search, KB, gmail, drive, calendar,
    // notebook, custom components — anything the user has wired up.
    // The synthesiser worker streams its tokens as ordinary `content` events
    // so the existing chat renderer handles the answer with no special UI.
    if (modelTier === 'swarm') {
        return runSwarmTierTurn({ req, res, userId, message, conversationId, attachments });
    }
    // ───────────────────────────────────────────────────────────────
    const turnSetup = await resolveTurnSetup({ req, res, userId, message, modelTier, conversationId, attachments });
    if (res.headersSent) return;

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        // Best-effort side channels (title generation, memory extraction)
        // outlive the turn; a write after end() raises on the response and,
        // unhandled, takes the process down.
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // STOP. The composer's stop button aborts the browser's fetch, which closes
    // this response — and until 2026-09-16 nothing here listened, so the turn
    // ran to the end: every tool round, every token. On a single-slot local
    // llama.cpp that is the worst case, because the slot stays busy and the
    // NEXT message queues behind the answer the user just cancelled.
    //
    // `writableEnded` tells a normal completion apart from a cancel: the close
    // that follows our own res.end() must not be reported as a client stop.
    const clientAbort = new AbortController();
    const turn = createTurnState({
        req, res, send, clientAbort, userId,
        message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
        disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
        sidePanelWebpage, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
        requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
    });
    Object.assign(turn, turnSetup);
    res.on('close', () => {
        if (res.writableEnded) return;
        turn.clientGone = true;
        log.info('[DirectChat] client disconnected — aborting the generation');
        try { clientAbort.abort(); } catch (_) { /* already aborted */ }
    });
    // Keep the stream warm through the NC AppAPI proxy during long, silent tool
    // loops (e.g. webpage builds) so it isn't idle-timed-out into a 504 that the
    // client misreports as "Error generating response." (BFSF-221).
    startSseHeartbeat(res);

    // Emit on every turn so the "How I got this answer" panel always knows
    // which concrete model produced this reply, including for fixed tiers.
    // `fromAuto` distinguishes the case where the classifier picked the tier
    // (we want to show "Auto → Fast (gpt-5-mini)") from a user-pinned choice.
    send('model_selected', { tier: turn.resolvedTier, modelId: turn.modelId, fromAuto: modelTier === 'auto' });
    emitPhase(send, 'model_resolved', turn.modelId);
    emitPhaseEnd(send, 'model_resolved');

    // Armed once the tool loop starts, disarmed after the successful final
    // save. When the turn dies in between while a side-effecting tool already
    // ran, the failure exits call this so the DB records what happened —
    // otherwise the next turn's model re-runs the side effect (duplicate
    // issues, double emails, …). Hoisted here because the outer catch below
    // cannot see variables declared inside the try.
    let _persistInterruptedTurn = null;

    try {
        Object.assign(turn, await assembleToolStack({
            req, send, userId, conversationId, resolvedTier: turn.resolvedTier, attachments, history, disabledMedia,
            webSearchEnabled, disableSearchOnUpload: turn.disableSearchOnUpload, message, notebookspaceContent,
            activeSkillIds, userOrgForTiers: turn.userOrgForTiers,
        }));

        // `usableKbIds` = the attached knowledge bases this turn was actually
        // ALLOWED to search (client list ∩ kbVisibility ∩ usage_contexts).
        // finalizeTurn persists exactly that — never the raw client list.
        Object.assign(turn, await buildPromptAndHistory({
            req, send, userId, message, conversationId, history, timezone, requestSystemPrompt, activeSkillIds,
            requestedKbIds, projectId, notebookspaceAvailable, notebookspaceContent, notebookspaceSelection,
            sidePanelWebpage, webpagePlanExecution, userOrgForTiers: turn.userOrgForTiers,
            orgIdsForTiers: turn.orgIdsForTiers, notebooksEnabled: turn.notebooksEnabled,
            canUseNotebooks: turn.canUseNotebooks, toolCatalogText: turn.toolCatalogText,
            directChatTools: turn.directChatTools,
        }));

        const claimedThread = await claimSharedThreadTurn(turn);
        if (!claimedThread) return;

        Object.assign(turn, await setupSessionSkills({
            req, send, userId, convId: turn.convId, config: turn.config,
            clientHistoryProvided: turn.clientHistoryProvided, modelId: turn.modelId,
            disableSearchOnUpload: turn.disableSearchOnUpload, directChatTools: turn.directChatTools,
            resolvedTier: turn.resolvedTier, requestSessionSkills, requestActivatedSessionSkillIds, message, timezone,
            tier: turn.tier, adapter: turn.adapter, apiKey: turn.apiKey, apiUrl: turn.apiUrl,
            messages: turn.messages, volatileMessage: turn.volatileMessage,
        }));

        // Reassigns the turn's model/adapter when a Flow stage asked for its
        // own tier; bound here because the tool dispatcher calls it too.
        turn.swapModelForActiveStage = () => swapModelForActiveStage(turn);
        // Run once at the start so a step-1 stage with a tier override picks
        // its model before the first LLM round.
        await turn.swapModelForActiveStage();
        const attachmentIntake = await processAttachmentsAndUserMessage({
            req, res, send, userId, convId: turn.convId, conversationId, modelTier, message, attachments,
            adapter: turn.adapter, modelId: turn.modelId, config: turn.config, messages: turn.messages,
        });
        if (!attachmentIntake) return;
        Object.assign(turn, attachmentIntake);

        // NOTE: a previous block here tried to inject TERMINAL_TOOLS
        // (convert_document_to_text, etc.) via require('../../terminal/tools')
        // when Gmail/Drive tools were present. That module does not exist, so
        // the require always threw MODULE_NOT_FOUND and the catch silently
        // swallowed it — dead code that injected nothing. It also let the model
        // believe a generic document-conversion tool existed, so it tried to
        // call one and surfaced "I don't have the tool!" (BFSF-127). Removed.
        // The real path for Gmail attachments is gmail_read_attachment; the
        // system prompt now steers the model there (see GMAIL/ATTACHMENT note).
        // Chat signals: the gates fill this in with what they decided.
        const chatSignal = { pii: {}, dlp: null, allowlistedHosts: [] };
        const inputGates = await runInputGates({
            req, res, send, userId, convId: turn.convId, message, messages: turn.messages, modelId: turn.modelId,
            config: turn.config, hasAttachments: !!(attachments && attachments.length > 0),
            volatileMessage: turn.volatileMessage, chatSignal,
        });
        // Reached on a normal return AND on every gate that ended the stream
        // (undefined); a throw skips it, so an unexpected error is never
        // counted. Fire-and-forget: see ./chatSignalsTurn.js.
        countDirectTurn({ req, userId, chatSignal, config: turn.config });
        if (!inputGates) return;
        Object.assign(turn, inputGates);

        await compactConversation(turn);

        // ─── Tool calling loop via unified adapter.chat() ──────────
        buildChatOptions(turn);

        // Skip the non-streaming tool pre-check for every provider whose stream
        // path parses tool calls itself — the SDK adapters and, since 2026-09,
        // the self-hosted runtimes (BaseProvider._parseSseStream accumulates
        // streamed tool_calls; see base.js).
        //
        // What the pre-check bought: a chance to downgrade the step-machine
        // toolChoice before streaming. What covers that now: each stream call
        // below already retries once with toolChoice 'auto' on the same
        // bad-shape error regex, and the streamed-tool loop mirrors the
        // step-machine bookkeeping (roundsInCurrentStep) round for round.
        //
        // What it cost on a single-slot llama.cpp server: one FULL generation
        // that was thrown away plus one extra prompt evaluation per turn —
        // measured 2026-09-11 on this box, a 4.3k-token prompt is ~29 s per
        // evaluation at ~150 tok/s, so the pre-check alone doubled the wait
        // before the first visible token.
        //
        // A function, not a constant: `adapter`/`config` are reassigned by
        // swapModelForActiveStage mid-turn, so the decision has to be taken
        // per round at the call site. See ./volatileLayout.js.
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 15;

        // The step-machine guard is written onto the VOLATILE block as
        // base + guard — REPLACED every round, never appended. It used to be
        // appended to messages[0], the provider-cached prefix: the text
        // interpolates roundsInCurrentStep, so it changed every round and grew
        // for the whole turn, and every change re-read the entire prompt on a
        // self-hosted model.
        const volatileGuard = createVolatileGuard(turn);
        const setVolatileGuard = (text) => volatileGuard.set(text);

        // Strip internal metadata (_mcp etc.) before sending tools to LLM — providers may reject unknown fields
        turn.directChatTools = turn.directChatTools.map(t => {
            const { _mcp, _n8n, ...clean } = t;
            return clean;
        });

        // Deterministic order. Tools are serialised ahead of the system prompt,
        // so two turns with the same tool SET but a different ORDER produce a
        // different cache prefix and rebuild the whole cache. Assembly order
        // depends on integration-resolution timing and Set iteration, so sort
        // by name and stop relying on it being incidentally stable.
        turn.directChatTools.sort((a, b) =>
            (a.function?.name || a.name || '').localeCompare(b.function?.name || b.name || ''));
        log.info(`[DirectChat] Tool set for this turn: ${turn.directChatTools.length} tools, fingerprint=${toolSetFingerprint(turn.directChatTools)}`);

        // The tool dispatcher calls these when the model asks for more tools
        // mid-turn; both push onto the live turn.directChatTools.
        turn.applyLoadTools = (toolArgs) => applyLoadTools(turn, toolArgs);
        turn.onSkillsActivated = (justActivatedIds) => onSkillsActivated(turn, justActivatedIds);

        // Eager-create moved above the attachment scan so `convId` is
        // available when the attachment scanner calls
        // `dlpRunner.mergeTokenMap(convId, …)`. See the block earlier in
        // this route just before attachment processing.

        // ─── PII token-preservation system-prompt addendum ─────────────
        // For message-level PII and DLP, the addendum is appended inside
        // those blocks at the point of tokenisation. Attachment-only turns
        // (clean user prompt, tokens came only from a PDF/Office scan)
        // never enter those blocks, so without this fallback the model has
        // no idea what `[person_N]` placeholders mean — it then volunteers
        // meta-commentary like "deze namen zijn geanonimiseerd" which
        // confuses the end user (who actually sees the un-tokenised names
        // in the rendered output). Mirrors the unconditional injection
        // already used by the agent runtime, where buildTokenPreservationAddendum
        // is appended to the volatile prompt (chatStream/roundRequest.js).
        // Idempotent: skips when the addendum tag is already on the volatile
        // block (i.e. an earlier in-block injection already fired this turn).
        // The token list grows over a conversation, so it lives on the
        // per-turn block, never on the cached prefix.
        try {
            const { volatileMessage } = turn;
            if (volatileMessage && typeof volatileMessage.content === 'string'
                && !volatileMessage.content.includes('[PII TOKEN PRESERVATION')) {
                const _convMap = require('../../../core/dlp/dlpRunner').getConversationTokenMap(turn.convId);
                const _add = buildTokenPreservationAddendum(_convMap);
                if (_add) volatileMessage.content += _add;
            }
        } catch (_) { /* addendum is best-effort; missing it just means the model may
                        meta-comment on placeholders — not a runtime failure */ }

        // Streamed text passes through the PII un-tokeniser before it reaches
        // the user; see ./streamCallbacks.js.
        createUntokeniserSink(turn);

        // The tool dispatcher's view of this turn; see ./toolContext.js.
        const mkToolCtx = createToolContextFactory(turn);
        _persistInterruptedTurn = async (reason) => {
            try {
                const { buildInterruptedTurnMessages } = require('./interruptedTurn');
                const convNow = await agentStore.getDirectConversation(turn.convId, userId, encryptionOpts(req));
                const msgs = buildInterruptedTurnMessages({
                    baseMessages: convNow?.messages || [],
                    tokenizedMessage: turn.tokenizedMessage,
                    persistedAttachments: turn.persistedAttachments,
                    toolHistory: turn.collectedToolHistory,
                    errorNote: reason,
                });
                // meta null → meta_json stays untouched
                if (msgs) await agentStore.updateDirectConversation(turn.convId, msgs, userId, null, encryptionOpts(req));
            } catch (e) {
                log.warn('[DirectChat] Interrupted-turn persistence failed:', e.message);
            }
        };

        // ── Seed notebook store from the live client editor content (BFSF-287) ──
        // Same rationale as the agent runtime (chatStream.js). Gated on
        // canUseNotebooks (the authoritative entitlement/permission gate, also
        // used to inject WORKSPACE_TOOLS) and non-empty live content. convId
        // is already resolved (eagerly created earlier in this handler).
        if (turn.canUseNotebooks && typeof notebookspaceContent === 'string' && notebookspaceContent.trim() !== '' && turn.convId) {
            try {
                const _seedRes = await syncClientWorkspaceContent(turn.convId, userId, notebookspaceContent);
                if (_seedRes?.seeded) log.info(`[DirectChat] Seeded notebook from live editor content (${notebookspaceContent.length} chars, ${_seedRes.reason})`);
            } catch (e) {
                log.warn('[DirectChat] notebook seed-on-entry failed:', e.message);
            }
        }

        // ─── Volatile block behind the history ─────────────────────────
        // Assembly kept the per-turn block at index 1 (compaction and the
        // messages[0] checks above rely on that). From here on nothing else
        // appends to it except the step-machine guard, so this is the moment
        // to move it to just before the current user message: a self-hosted
        // prefix cache then keeps the stable prompt AND the history, and only
        // the folded volatile+user tail is re-read (~56-75 tokens instead of
        // the whole prompt, measured 2026-09-11). Hosted adapters that
        // extract/fold system messages are indifferent; for the rest
        // (Scaleway's strict templates) the block is hoisted back to index 1.
        // Re-run before every stream call because swapModelForActiveStage can
        // change the adapter mid-turn.
        const layoutVolatile = () => layoutVolatileBlock(turn);
        layoutVolatile();
        // The guard's base is the block as it stands once it has been moved.
        volatileGuard.capture();
        // Stable-prefix trace: the same fingerprint on consecutive turns of a
        // conversation is what a prefix cache needs; a drifting one names the
        // culprit in the app log instead of on the latency.
        const traceStablePrefix = (label) => traceTurnPrefix(turn, label);
        traceStablePrefix('placed');

        while (turn.toolCallRounds < MAX_TOOL_ROUNDS) {
            // A tool round starts no new work once the user is gone.
            if (turn.clientGone) break;
            if (turn.directChatTools.length > 0 && !skipToolPrecheck(turn)) {
                // Non-streaming tool check via adapter.chat()
                let result;
                try {
                    const guard = computeStepMachineGuard(turn);
                    setVolatileGuard(guard.systemAppend);
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
                        meta: { modelId: turn.modelId, provider: turn.config?.providerName || turn.config?.providerType || null, error: err },
                    });
                    if (_persistInterruptedTurn) await _persistInterruptedTurn(`API error: ${err.message}`);
                    send('error', { error: `API error: ${err.message}` });
                    res.end();
                    return;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Step-machine bookkeeping: activation resets the in-step
                    // counter (new step started); completion reset happens
                    // inside handleSessionSkillCompleteResult after dispatch.
                    // Any other tool-only round advances the counter toward
                    // the soft cap that force-requires complete_session_skill.
                    const calledActivation = result.toolCalls.some(tc => (tc.function?.name || tc.name) === ACTIVATE_SESSION_SKILL_TOOL_NAME);
                    const calledCompletion = result.toolCalls.some(tc => (tc.function?.name || tc.name) === COMPLETE_SESSION_SKILL_TOOL_NAME);
                    if (calledActivation) turn.roundsInCurrentStep = 0;
                    else if (!calledCompletion) turn.roundsInCurrentStep += 1;
                    // Add assistant message with tool calls to history
                    turn.messages.push({
                        role: 'assistant',
                        content: result.content || null,
                        tool_calls: result.toolCalls,
                    });
                    turn.toolCallRounds++;

                    // Execute all tool calls in parallel
                    const userAuth = await getUserAuth(req);
                    const toolPromises = result.toolCalls.map((toolCall) => executeDirectChatToolCall(toolCall, mkToolCtx({ userAuth, streamed: false })));

                    const toolResults = await Promise.all(toolPromises);

                    // Process draft SSE events sequentially (after all tools settle) to avoid race conditions
                    emitToolResultEvents(turn, toolResults, { streamed: false });

                    // Strip internal _toolResult before pushing to messages
                    turn.messages.push(...toolResults.map(({ _toolResult, ...rest }) => rest));
                    // If the AI proposed a webpage plan this round, halt the
                    // tool loop so the user can approve before any work
                    // happens. The streamed final response below still runs so
                    // the chat shows the AI's "I'd like to do X — review the
                    // plan above" message.
                    if (turn.webpagePlanProposedThisTurn) break;
                    continue;
                }
            }
            break;
        }

        // ─── Stream final response via adapter.stream() ──────────
        // Both callbacks are built up front: they are pure factories over the
        // TurnState, and the follow-up one must survive the primary round.
        const { primary: streamCallback, follow: followStreamCallback } = createStreamCallbacks(turn);
        turn.streamStartTime = Date.now();

        // Pipeline guard at the streaming-call boundary: same rule as the
        // pre-check path — while a session-skill pipeline is mid-run, the
        // LLM is forced to keep calling tools instead of emitting final text.
        const streamGuard = computeStepMachineGuard(turn);
        setVolatileGuard(streamGuard.systemAppend);
        layoutVolatile();
        traceStablePrefix('primary');
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

        // Final pre-LLM phase marker — emit only on the first round so the UI
        // status placeholder fades out before the first token arrives.
        if (turn.toolCallRounds === 0) {
            emitPhase(send, 'streaming_start', turn.modelId);
        }

        try {
            await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), streamOptions, streamCallback);
        } catch (streamErr) {
            const errMsg = String(streamErr?.error?.message || streamErr?.message || '');
            // Retry without previousResponseId if the error is about missing tool output
            // (stale response ID pointing to unresolved tool-call response)
            if (errMsg.includes('No tool output found') && streamOptions.previousResponseId) {
                log.warn('[DirectChat] Stale previousResponseId detected, retrying without chaining');
                turn.lastResponseId = null;
                streamOptions.previousResponseId = undefined;
                turn.fullContent = '';
                turn.thinkingContent = '';
                turn.thinkingParts = [];
                turn.thinkingSnapshotFrom = 0; // the array was replaced — reset the replay cursor with it
                turn.streamToolCalls = [];
                await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), streamOptions, streamCallback);
            } else if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(errMsg)) {
                // Pipeline-guard shape rejected by the provider — retry once
                // with permissive toolChoice so the user's message goes through.
                log.warn(`[DirectChat pipeline] Stream rejected — retrying with toolChoice='auto'. Original: ${errMsg}`);
                turn.fullContent = '';
                turn.thinkingContent = '';
                turn.thinkingParts = [];
                turn.thinkingSnapshotFrom = 0; // the array was replaced — reset the replay cursor with it
                turn.streamToolCalls = [];
                await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), { ...streamOptions, toolChoice: 'auto' }, streamCallback);
            } else {
                throw streamErr;
            }
        }

        await logTurnUsage(turn);
        // Stream completed for this org → org-level chat blocks are provably
        // gone; resolve them (throttled, fire-and-forget).
        _resolveChatProblemsThrottled(turn.userOrgId);

        // Handle tool calls received during streaming (Google SDK path)
        // Loop to support multi-round tool calling (e.g. list → get_summary)
        const MAX_STREAM_TOOL_ROUNDS = 15;
        let toolRound = 0;

        while (
            !turn.clientGone &&
            (turn.streamToolCalls.length > 0 || pipelineNeedsWrapUp(turn)) &&
            toolRound < MAX_STREAM_TOOL_ROUNDS
        ) {
            // Pipeline wrap-up kickstart: the LLM emitted no tool calls but
            // the pipeline is still mid-walk (text was muted, so the user
            // would see an empty reply). Force another streaming round with
            // the step-machine tool_choice to coax it back onto the rails.
            if (turn.streamToolCalls.length === 0) {
                const kickGuard = computeStepMachineGuard(turn);
                setVolatileGuard(kickGuard.systemAppend);
                layoutVolatile();
                traceStablePrefix(`kickstart round=${toolRound + 1}`);
                turn.muteAssistantText = !!kickGuard.mute;
                log.info(`[DirectChat pipeline] wrap-up kickstart round=${toolRound + 1} toolChoice=${kickGuard.mode} mute=${kickGuard.mute}`);
                const kickOptions = {
                    ...turn.chatOptions,
                    previousResponseId: undefined,
                    tools: turn.directChatTools.length > 0 ? turn.directChatTools : undefined,
                    toolChoice: turn.directChatTools.length > 0 ? kickGuard.toolChoice : undefined,
                };
                // BFSF-261: release any held untokeniser tail into THIS round's
                // text, then record it before the reset wipes it.
                try { turn.streamContentFlush(); } catch (_) { /* best-effort */ }
                turn.displaySegments.onRoundEnd(turn.fullContent);
                turn.fullContent = '';
                try {
                    await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), kickOptions, followStreamCallback);
                } catch (kickErr) {
                    const kMsg = String(kickErr?.error?.message || kickErr?.message || '');
                    if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(kMsg)) {
                        log.warn(`[DirectChat pipeline] Wrap-up rejected — retrying with toolChoice='auto'. Original: ${kMsg}`);
                        await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), { ...kickOptions, toolChoice: 'auto' }, followStreamCallback);
                    } else {
                        throw kickErr;
                    }
                }
                // LLM still refused to emit tool calls — stop looping so we
                // don't spin. The final save path handles the empty reply.
                if (turn.streamToolCalls.length === 0) {
                    log.warn('[DirectChat pipeline] Wrap-up yielded no tool calls — aborting pipeline walk.');
                    break;
                }
            }

            toolRound++;
            log.info(`[DirectChat] Streamed tool round ${toolRound}: ${turn.streamToolCalls.map(t => t.function?.name).join(', ')}`);

            // Step-machine bookkeeping — mirror the pre-check path.
            {
                const calledActivation = turn.streamToolCalls.some(tc => tc.function?.name === ACTIVATE_SESSION_SKILL_TOOL_NAME);
                const calledCompletion = turn.streamToolCalls.some(tc => tc.function?.name === COMPLETE_SESSION_SKILL_TOOL_NAME);
                if (calledActivation) turn.roundsInCurrentStep = 0;
                else if (!calledCompletion) turn.roundsInCurrentStep += 1;
            }

            turn.messages.push({
                role: 'assistant',
                content: turn.fullContent || null,
                tool_calls: turn.streamToolCalls,
                // The reasoning that produced THESE tool calls. Claude needs the
                // signed thinking blocks to precede the tool_use blocks on
                // replay, and without them the next round reads a history where
                // the model called tools for no stated reason.
                thinking: snapshotThinkingParts(turn),
            });

            const userAuth = await getUserAuth(req);
            const toolPromises = turn.streamToolCalls.map((toolCall) => executeDirectChatToolCall(toolCall, mkToolCtx({ userAuth, streamed: true })));

            const toolResults = await Promise.all(toolPromises);

            // Process draft SSE events sequentially (after all tools settle) to avoid race conditions
            emitToolResultEvents(turn, toolResults, { streamed: true });

            // Strip internal fields before pushing to messages
            turn.messages.push(...toolResults.map(({ _toolResult, _toolName, ...rest }) => rest));

            // If the AI proposed a webpage plan, stop the streaming tool loop
            // and let the next streamed text come out (so the chat shows the
            // AI's natural-language summary alongside the plan card). No
            // further file edits run this turn.
            if (turn.webpagePlanProposedThisTurn) break;

            // Stream the follow-up response after tool execution (with tools for multi-round)
            // BFSF-261: record this round's visible text before the reset —
            // the pre-tool preamble must survive into persistence and be
            // separated from the follow-up text in the live view.
            try { turn.streamContentFlush(); } catch (_) { /* best-effort */ }
            turn.displaySegments.onRoundEnd(turn.fullContent);
            turn.fullContent = '';
            turn.streamToolCalls = [];
            const followGuard = computeStepMachineGuard(turn);
            setVolatileGuard(followGuard.systemAppend);
            layoutVolatile();
            traceStablePrefix(`follow-up round=${toolRound}`);
            turn.muteAssistantText = !!followGuard.mute;
            log.info(`[DirectChat pipeline] follow-up stream round=${toolRound} active=${turn.activatedSessionSkillIds.length} completed=${turn.completedSessionSkillIds.length}/${turn.sessionSkills.length} toolChoice=${followGuard.mode} mute=${followGuard.mute} roundsInStep=${turn.roundsInCurrentStep}`);
            const followStreamOptions = {
                ...turn.chatOptions,
                previousResponseId: undefined, // Don't chain — we need to send tool results in full
                tools: turn.directChatTools.length > 0 ? turn.directChatTools : undefined,
                toolChoice: turn.directChatTools.length > 0 ? followGuard.toolChoice : undefined,
            };
            try {
                await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), followStreamOptions, followStreamCallback);
            } catch (followErr) {
                const fMsg = String(followErr?.error?.message || followErr?.message || '');
                if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(fMsg)) {
                    log.warn(`[DirectChat pipeline] Follow-up stream rejected — retrying with toolChoice='auto'. Original: ${fMsg}`);
                    turn.fullContent = '';
                    turn.streamToolCalls = [];
                    await turn.adapter.stream(turn.apiKey, turn.apiUrl, turn.modelId, applyTokenMapToMessages({ conversationId: turn.convId, messages: turn.messages }), { ...followStreamOptions, toolChoice: 'auto' }, followStreamCallback);
                } else {
                    throw followErr;
                }
            }
        }
        // The interrupted-turn hook is the handler's own `let` — the outer
        // catch reads it — so finalize clears it through this setter.
        turn.clearInterruptedTurnHook = () => { _persistInterruptedTurn = null; };
        const finalized = await finalizeDirectChatTurn(turn);
        turn.convId = finalized.convId;

        send('done', { conversationId: turn.convId });

        // The title is generated in the background (finalizeTurn). `done` has
        // gone out, so the client has already unblocked; keep the socket open
        // long enough for the `title` event to ride along — bounded, because
        // the title is a nicety and the slot behind it may be busy. After the
        // bound, `send` is a no-op on the ended response and the title is
        // still persisted for the next sidebar load.
        if (finalized.pendingTitle) {
            const TITLE_HOLD_MS = 15_000;
            await Promise.race([
                finalized.pendingTitle.catch(() => {}),
                new Promise(resolve => { const t = setTimeout(resolve, TITLE_HOLD_MS); if (t.unref) t.unref(); }),
            ]);
        }
    } catch (error) {
        // The user pressed stop: the socket is gone, there is nobody to tell,
        // and this is not an outage — reporting it as one would poison the
        // org-health signal with every cancelled answer.
        if (turn.clientGone || error?.name === 'AbortError' || clientAbort.signal.aborted) {
            log.info('[DirectChat] turn cancelled by the client');
            try { if (!res.writableEnded) res.end(); } catch (_) { /* socket already gone */ }
            return;
        }
        log.error('[DirectChat] Stream error:', error);
        // Org-health: surface the failed stream per org. The Error instance is
        // routed through core/errorSanitizer inside the emitter — raw provider
        // payloads (which can echo keys/content) are never stored.
        orgHealth.problem('chat.provider_error', {
            orgId: turn.userOrgForTiers || null, source: 'directChat', req,
            meta: {
                modelId: turn.modelId,
                provider: turn.config?.providerName || turn.config?.providerType || null,
                // Always an Error instance → always sanitized via errorSanitizer.
                error: (error instanceof Error) ? error : new Error(String(error?.message || error || 'unknown')),
            },
        });
        const raw = String(error?.message || error || '');
        const friendly = toFriendlyTurnError(raw);
        if (_persistInterruptedTurn) await _persistInterruptedTurn(friendly);
        try {
            if (!res.writableEnded) {
                send('error', { error: friendly, raw });
            }
        } catch (sendErr) {
            log.warn('[DirectChat] Failed to send SSE error event:', sendErr.message);
        }
    } finally {
        // Release the turn even on a crash or an abort — a lock that outlived
        // its run would block the thread for its full TTL. Scoped to the run id
        // so a late release cannot free a turn someone else has since claimed.
        //
        // The try starts at the `if`, not inside it: anything that throws here
        // would otherwise skip the res.end() below and leave the client holding
        // a stream the server never closes.
        try {
            if (turn._turnLock) {
                await require('../../../stores/conversationLockStore').releaseTurn(turn._turnLock);
                if (turn._sharedThread) {
                    await emitThreadEvent(turn._sharedThread.projectId, {
                        kind: 'run.finished', actorId: userId,
                        targetType: 'conversation', targetId: turn._turnLock.conversationId,
                    });
                }
            }
        } catch (e) {
            log.warn('[DirectChat] turn release failed:', e.message);
        }
        try { if (!res.writableEnded) res.end(); } catch (_) { /* socket already gone */ }
    }
});

module.exports = router;

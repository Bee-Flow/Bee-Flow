// @typecheck noImplicitAny
/**
 * Direct Chat — the streaming turn (POST /chat/direct/stream).
 *
 * This file holds the route handler's spine: the SSE lifecycle, the input
 * gates and their chat-signal count, the interrupted-turn hook, and the outer
 * catch/finally that releases the shared-thread turn lock. Everything else is
 * a phase beside it in this folder, called in pipeline order and sharing one
 * TurnState: the Swarm branch, turnSetup, turnPhases (toolStackAssembly,
 * promptAssembly, sharedThreadLock, sessionSkillSetup, stageModelSwap,
 * attachmentIntake), inputGates, compactionPhase, chatOptions, toolLoopSetup
 * and toolLoopRounds (the two tool-calling loops, the volatile-block layout,
 * stepMachine, toolRefresh, toolContext, streamCallbacks, toolResultEvents,
 * turnUsage) and finalizeTurn.
 */

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */
/** @typedef {(reason: string) => Promise<void>} InterruptedTurnPersister */
const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const agentStore = require('../../../stores/agentStore');
// Org-health capture — fire-and-forget emits for the silent chat-killers
// (provider config/stream failures, DLP hard blocks) plus a success-side
// resolve so the dashboard self-heals once an org's chats work again.
const orgHealth = require('../../../services/orgHealth');
const { encryptionOpts, emitThreadEvent } = require('./shared');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
const { openSse } = require('../../../core/http/sseHelpers');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');

// The turn's pipeline phases. They share one mutable TurnState instead of
// the handler's own bindings.
const { createTurnState } = require('./turnState');
const { runSwarmTierTurn } = require('./swarmTurn');
const { resolveTurnSetup } = require('./turnSetup');
const { runSetupPhases } = require('./turnPhases');
const { runInputGates } = require('./inputGates');
const { countDirectTurn } = require('./chatSignalsTurn');
const { compactConversation } = require('./compactionPhase');
const { buildChatOptions } = require('./chatOptions');
const { prepareToolLoop } = require('./toolLoopSetup');
const { runToolLoop } = require('./toolLoopRounds');
const { toFriendlyTurnError } = require('./turnErrors');
const { finalizeDirectChatTurn } = require('./finalizeTurn');
const { validate } = require('../../../core/http/validate');
// Typed, not closed: see the header of ./turnSchema.js.
const { DirectTurnBody } = require('./turnSchema');
const { fallback } = require('../../../utils/bestEffort');
const { sessionUser } = require('../../../core/http/sessionUser');

const TITLE_HOLD_MS = 15_000;

/**
 * The interrupted-turn hook. Armed once the tool loop starts, disarmed after
 * the successful final save. When the turn dies in between while a
 * side-effecting tool already ran, the failure exits call it so the DB
 * records what happened; otherwise the next turn's model re-runs the side
 * effect (duplicate issues, double emails, ...).
 */
/**
 * @param {Turn} turn
 * @returns {InterruptedTurnPersister}
 */
function makeInterruptedTurnPersister(turn) {
    const { req, userId } = turn;
    /** @param {string} reason */
    return async (reason) => {
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
}

/**
 * The input gates, then the chat-signal count. Returns false when a gate
 * ended the stream.
 * @param {Turn} turn
 * @param {{ message: string, attachments?: unknown[] }} input
 */
async function runGates(turn, { message, attachments }) {
    const { req, res, send, userId } = turn;
    // Chat signals: the gates fill this in with what they decided.
    /** @type {Parameters<typeof countDirectTurn>[0]['chatSignal']} */
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
    if (!inputGates) return false;
    Object.assign(turn, inputGates);
    return true;
}

/**
 * The title is generated in the background (finalizeTurn). `done` has gone
 * out, so the client has already unblocked; keep the socket open long enough
 * for the `title` event to ride along, bounded, because the title is a
 * nicety and the slot behind it may be busy. After the bound, `send` is a
 * no-op on the ended response and the title is still persisted.
 * @param {Promise<unknown> | null | undefined} pendingTitle
 */
async function holdForTitle(pendingTitle) {
    if (!pendingTitle) return;
    await Promise.race([
        pendingTitle.catch((e) => fallback('routes/ai/directChat/streamTurn:holdForTitle', e)),
        new Promise(resolve => { const t = setTimeout(resolve, TITLE_HOLD_MS); if (t.unref) t.unref(); }),
    ]);
}

/**
 * A failed turn: quiet on a client cancel, otherwise org-health + persist + error event.
 * @param {Partial<Error>} error
 * @param {{ turn: Turn, clientAbort: AbortController, persistInterruptedTurn: InterruptedTurnPersister | null }} ctx
 */
async function handleTurnError(error, { turn, clientAbort, persistInterruptedTurn }) {
    const { req, res, send } = turn;
    // The user pressed stop: the socket is gone, there is nobody to tell, and
    // this is not an outage; reporting it as one would poison the org-health
    // signal with every cancelled answer.
    if (turn.clientGone || error?.name === 'AbortError' || clientAbort.signal.aborted) {
        log.info('[DirectChat] turn cancelled by the client');
        try { if (!res.writableEnded) res.end(); } catch (err) { log.debug('socket already gone', err); }
        return;
    }
    log.error('[DirectChat] Stream error:', error);
    // Org-health: surface the failed stream per org. The Error instance is
    // routed through core/errorSanitizer inside the emitter: raw provider
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
    if (persistInterruptedTurn) await persistInterruptedTurn(friendly);
    try {
        if (!res.writableEnded) {
            send('error', { error: friendly, raw });
        }
    } catch (sendErr) {
        log.warn('[DirectChat] Failed to send SSE error event:', sendErr.message);
    }
}

/**
 * Release the turn even on a crash or an abort: a lock that outlived its run
 * would block the thread for its full TTL. Scoped to the run id so a late
 * release cannot free a turn someone else has since claimed. The try starts
 * at the `if`, not inside it: anything that throws here would otherwise skip
 * the res.end() and leave the client holding a stream the server never closes.
 * @param {Turn} turn
 */
async function releaseTurn(turn) {
    const { res, userId } = turn;
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
    try { if (!res.writableEnded) res.end(); } catch (err) { log.debug('socket already gone', err); }
}

// ─── Streaming Direct Chat ───────────────────────────────────────

router.post('/chat/direct/stream', requireAuth, validate({ body: DirectTurnBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof DirectTurnBody>, import('qs').ParsedQs>} */ req, res) => {
    const { message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings, disabledMedia, webSearchEnabled = true, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable, sidePanelWebpage, sidePanelDocument, projectId, timezone, systemPrompt: requestSystemPrompt, activeSkillIds, reasoningEffort: requestReasoningEffort, sessionSkills: requestSessionSkills, activatedSessionSkillIds: requestActivatedSessionSkillIds, knowledgeBaseIds: requestedKbIds, planExecution: webpagePlanExecution } = req.body;
    const userId = sessionUser(req).id;

    if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }

    // ─── Swarm tier branch ─────────────────────────────────────────
    // When the user picked the "Swarm" tier in the model dropdown, the entire
    // turn runs through the swarm runtime. Each worker uses the SAME tool
    // stack as a regular direct-chat call (components + integrations + MCP).
    // The synthesiser worker streams its tokens as ordinary `content` events
    // so the existing chat renderer handles the answer with no special UI.
    if (modelTier === 'swarm') {
        return runSwarmTierTurn({ req, res, userId, message, conversationId, attachments });
    }
    const turnSetup = await resolveTurnSetup({ req, res, userId, message, modelTier, conversationId, attachments });
    if (res.headersSent) return;

    // Best-effort side channels (title generation, memory extraction) outlive
    // the turn; openSse's send is a no-op after end(), because a write after
    // end() raises on the response and, unhandled, takes the process down.
    // The keep-alive holds the stream warm through the NC AppAPI proxy during
    // long, silent tool loops (e.g. webpage builds) so it isn't idle-timed-out
    // into a 504 that the client misreports as "Error generating response."
    // (BFSF-221).
    const { send } = openSse(res, { heartbeat: true });
    // STOP. The composer's stop button aborts the browser's fetch, which closes
    // this response — and until 2026-09-16 nothing here listened, so the turn
    // ran to the end: every tool round, every token. On a single-slot local
    // llama.cpp that is the worst case, because the slot stays busy and the
    // NEXT message queues behind the answer the user just cancelled.
    //
    // `writableEnded` tells a normal completion apart from a cancel: the close
    // that follows our own res.end() must not be reported as a client stop.
    const clientAbort = new AbortController();
    const body = {
        message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings,
        disabledMedia, webSearchEnabled, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable,
        sidePanelWebpage, sidePanelDocument, projectId, timezone, requestSystemPrompt, activeSkillIds, requestReasoningEffort,
        requestSessionSkills, requestActivatedSessionSkillIds, requestedKbIds, webpagePlanExecution,
    };
    const turn = createTurnState({ req, res, send, clientAbort, userId, ...body });
    Object.assign(turn, turnSetup);
    res.on('close', () => {
        if (res.writableEnded) return;
        turn.clientGone = true;
        log.info('[DirectChat] client disconnected — aborting the generation');
        try { clientAbort.abort(); } catch (err) { log.debug('already aborted', err); }
    });

    // Emit on every turn so the "How I got this answer" panel always knows
    // which concrete model produced this reply, including for fixed tiers.
    // `fromAuto` distinguishes the case where the classifier picked the tier
    // (we want to show "Auto → Fast (gpt-5-mini)") from a user-pinned choice.
    send('model_selected', { tier: turn.resolvedTier, modelId: turn.modelId, fromAuto: modelTier === 'auto' });
    emitPhase(send, 'model_resolved', turn.modelId);
    emitPhaseEnd(send, 'model_resolved');

    // The interrupted-turn hook (see makeInterruptedTurnPersister). Declared
    // here, outside the try, because the catch below reads it.
    /** @type {InterruptedTurnPersister | null} */
    let _persistInterruptedTurn = null;

    try {
        if (!(await runSetupPhases(turn, body))) return;
        if (!(await runGates(turn, { message, attachments }))) return;
        await compactConversation(turn);
        // ─── Tool calling loop via unified adapter.chat() ──────────
        buildChatOptions(turn);

        const loop = await prepareToolLoop(turn, {
            notebookspaceContent,
            armInterruptedTurnHook: () => { _persistInterruptedTurn = makeInterruptedTurnPersister(turn); },
        });
        if (!(await runToolLoop(turn, loop, () => _persistInterruptedTurn))) return;

        // The interrupted-turn hook is the handler's own `let` (the outer
        // catch reads it), so finalize clears it through this setter.
        turn.clearInterruptedTurnHook = () => { _persistInterruptedTurn = null; };
        const finalized = await finalizeDirectChatTurn(turn);
        turn.convId = finalized.convId;

        send('done', { conversationId: turn.convId });
        await holdForTitle(finalized.pendingTitle);
    } catch (error) {
        await handleTurnError(error, { turn, clientAbort, persistInterruptedTurn: _persistInterruptedTurn });
    } finally {
        await releaseTurn(turn);
    }
});

module.exports = router;

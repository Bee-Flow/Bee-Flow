// @typecheck
/**
 * Direct Chat — end-of-turn finalization after the streamed rounds are done:
 * untokeniser flush + display-segment join, the empty-response guard with the
 * Claude no-thinking auto-retry, PII token restoration for display, the regex
 * guard on agent output (finalizeContent.js), conversation persistence (user +
 * assistant rows with privacy metadata, media, drafts, tool history,
 * session-skill snapshots and meta; finalizeRows.js), the shared-thread feed
 * event, title generation and the background memory extraction
 * (finalizeAftercare.js).
 *
 * `clearInterruptedTurnHook` bridges the handler-scoped interrupted-turn hook
 * (a `let` the route's outer catch reads): once the turn is durably recorded
 * it must be cleared on the CALLER's binding, so the caller passes a setter.
 *
 * No request schema lives here: this file declares no route. The one body value
 * it reads, `memoryWriteEnabled`, arrives through POST /chat/direct/stream
 * (streamTurn.js) and is typed by that route's schema (./turnSchema.js).
 */

const agentStore = require('../../../stores/agentStore');
const { encryptionOpts, emitThreadEvent } = require('./shared');
const log = require('../../../telemetry/log');
const {
    settleStreamedContent, emitRawResponse, restoreForDisplay, applyOutputRegexGuard, guardEmptyResponse,
} = require('./finalizeContent');
const { persistenceBase, buildUserRow, resolveTokenisationInfo, buildAssistantRow, buildUpdateMeta } = require('./finalizeRows');
const { scheduleTitle, extractTurnMemories } = require('./finalizeAftercare');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * ATTACHED KNOWLEDGE BASES. What is stored is `usableKbIds`: the ids
 * promptAssembly ran through kbVisibility + usage_contexts, never the raw
 * list the client named, so the column is by construction a subset of what
 * this person was authorised to search, and a guessed uuid never lands in it.
 *
 * It is rewritten on EVERY turn, including to `[]`. Absent or empty on the
 * request means NO knowledge bases exactly as it does at retrieval: today's
 * clients omit the key when nothing is ticked, and "leave the stored list
 * alone" would leave a picker showing bases the answer did not use. The
 * stored list is "what the last turn actually searched". Returns the convId
 * (created here when the turn has none yet).
 */
async function ensureConversationWithKbs({ convId, userId, modelTier, usableKbIds, validProjectId, send }) {
    const attachedKbIds = Array.isArray(usableKbIds) ? usableKbIds : [];
    if (!convId) {
        const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast', attachedKbIds);
        send('conversation_created', { conversationId: conv.id });
        // Assign to the project: only one we validated the caller belongs to.
        // Stamping a conversation with an arbitrary project id was a one-way
        // door: unassigning goes through PUT /:id/conversations, which requires
        // editor on that project, so a mis-stamped chat could never be cleaned up.
        if (validProjectId) {
            try {
                const projectStore = require('../../../stores/projectStore');
                await projectStore.assignConversation(conv.id, validProjectId, userId, 'direct_conversations');
            } catch (e) {
                log.warn('[DirectChat] Failed to assign conversation to project:', /** @type {Error} */ (e).message);
            }
        }
        return conv.id;
    }
    // Owner-scoped inside the store (`AND user_id = $n`): a project EDITOR
    // posting into somebody else's shared thread does NOT get to rewrite the
    // owner's attachment list. Their write matches no row and returns false,
    // which is the safe direction and is not an error.
    try {
        await agentStore.setDirectConversationKnowledgeBases(convId, attachedKbIds, userId);
    } catch (kbErr) {
        log.warn('[DirectChat] Failed to persist attached knowledge bases:', /** @type {Error} */ (kbErr).message);
    }
    return convId;
}

/**
 * Save the user + assistant rows and the meta, clear the interrupted-turn
 * hook, tell the shared thread, remember the tier pick and schedule the
 * title. Returns the pending title promise (or null).
 */
async function persistTurn(t, conv) {
    const { req, send, userId, convId, modelTier, history, _sharedThread, clearInterruptedTurnHook } = t;
    const savedMessages = persistenceBase(history, conv.messages || []);
    const userSave = buildUserRow(t);
    const tokenisationInfo = resolveTokenisationInfo(t);
    savedMessages.push(userSave);
    savedMessages.push(buildAssistantRow({ ...t, tokenisationInfo }));

    // Save with metadata for OpenAI response chaining + compaction
    await agentStore.updateDirectConversation(convId, savedMessages, userId, buildUpdateMeta(t), encryptionOpts(req));
    // Turn is durably recorded: a later throw (title generation etc.) must
    // not append a duplicate user/assistant pair via the hook.
    clearInterruptedTurnHook();

    // Only NOW tell the project, after the rows are committed. Firing earlier
    // would wake other members into reading a thread that does not yet
    // contain the turn they were told about.
    if (_sharedThread) {
        await emitThreadEvent(_sharedThread.projectId, {
            kind: 'message.created',
            actorId: userId,
            targetType: 'conversation',
            targetId: convId,
        });
    }
    // Persist the user's tier selection so a refresh restores the picker to
    // what they last chose ("auto" stays "auto"); otherwise model_tier is
    // frozen at creation and never reflects mid-conversation switches.
    if (modelTier) {
        await agentStore.updateDirectConversationModelTier(convId, modelTier, userId).catch((e) => bestEffort('routes/ai/directChat/finalizeTurn:persistTurn', e));
    }
    // Memory extraction runs ONCE per turn, at the tail of
    // finalizeDirectChatTurn (the retired core/memoryExtractor used to fire
    // from here as well: two fast-tier calls and two dedupe-then-insert races).
    // Returned wrapped: an async function that returns a promise adopts it,
    // and the caller's await would then wait for the title model call.
    return scheduleTitle({ ...t, conv, savedMessages, send });
}

/**
 * `turn` is the TurnState (./turnState.js) that every phase of this turn
 * shares. `fullContent` (stored, tokenised) and `displayContent` (shown) are
 * settled first; then the turn is persisted and the aftercare scheduled.
 */
async function finalizeDirectChatTurn(turn) {
    const { send, generatedFiles = [] } = turn;
    let fullContent = settleStreamedContent(turn);
    emitRawResponse({ fullContent, orgShield: turn.orgShield, tokenisationInfo: turn._assistantTokenisationInfo, send });
    // `displayContent` is used for: SSE content_replace, regex agent-output
    // check, memory extraction, title generation.
    let displayContent = restoreForDisplay({ fullContent, convId: turn.convId, piiTokenMap: turn.piiTokenMap, send });
    ({ fullContent, displayContent } = applyOutputRegexGuard({ fullContent, displayContent, regexConfig: turn.regexConfig, send }));
    // Content moderation on agent output was removed when the Azure Content
    // Safety backend was dropped. PII detection still runs on the user input;
    // output is streamed through `untokeniseStream`, which restores PII
    // tokens to real values for display.

    const convId = await ensureConversationWithKbs(turn);
    ({ fullContent, displayContent } = await guardEmptyResponse({ ...turn, convId, fullContent, displayContent }));

    // Title generation runs in the background; the promise is handed back so
    // the route can hold the SSE open briefly for the `title` event without
    // making `done` wait for a second model call.
    let pendingTitle = null;
    const conv = await agentStore.getDirectConversation(convId, turn.userId, encryptionOpts(turn.req));
    if (conv) {
        ({ pendingTitle } = await persistTurn({ ...turn, convId, fullContent, generatedFiles }, conv));
    }
    await extractTurnMemories({ ...turn, convId });
    return { convId, pendingTitle };
}

module.exports = { finalizeDirectChatTurn };

/** @typedef {ReturnType<typeof import('./turnState').createTurnState>} Turn */

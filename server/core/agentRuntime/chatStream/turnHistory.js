/**
 * The turn's two message arrays, and the one place they are written.
 *
 * `messages` is PROMPT shape and `durableMessages` is DURABLE history; the
 * distinction is load-bearing (BFSF-307) and spelled out where they are built
 * below. This phase assembles both — from the conversation or from an
 * edit/retry override — appends the current user turn, replays historical
 * attachments and runs (opt-in) compaction over the prompt copy only.
 *
 * It also owns `persistDurable`, the single point of truth for "what gets
 * persisted", and the per-conversation write serializer underneath it.
 *
 * Moved verbatim out of chatStream.js.
 */
const agentStore = require('../../../stores/agentStore');
const { _emitAgentThreadEvent } = require('../sharedThread');
const { appendUserTurn } = require('../attachmentIntake');
const { withPhase } = require('../phaseEvents');
const { hydrateHistoryAttachments } = require('../historyHydrator');
const { compactMessages, needsSummarization } = require('../../llm/compaction');
const { resolveContextPolicy, buildCompactionOptions } = require('../../llm/contextPolicy');
const log = require('../../../telemetry/log');

// ─────────────────────────────────────────────────────────────────
// Per-conversation write serializer.
// A single conversation row gets multiple updateConversation calls per turn
// (after tool execution, after final response, plus a setImmediate redaction).
// Without a transaction/version column, two concurrent turns on the same
// conversation can interleave and clobber each other. Until the schema gets
// optimistic-lock support, queue writes per conversation in-process so the
// last-write-wins behaviour is at least intra-process ordered.
// ─────────────────────────────────────────────────────────────────
const _convWriteChains = new Map();
async function _serializeConversationWrite(convId, fn) {
    const prev = _convWriteChains.get(convId) || Promise.resolve();
    // Chain so the next call waits for the previous one regardless of result.
    const next = prev.then(() => fn(), () => fn());
    _convWriteChains.set(convId, next);
    try {
        return await next;
    } finally {
        // Free the map slot once the tail of the chain settles, so the Map
        // doesn't grow unboundedly across conversations.
        if (_convWriteChains.get(convId) === next) {
            _convWriteChains.delete(convId);
        }
    }
}

async function assembleTurnHistory({
    agent, userId, userMessage, userAuth, messageMetadata, modelToUse,
    conversation, isEphemeral, historyOverride, onEvent, _sharedThread,
}) {
    // Use historyOverride if provided (for thread context isolation / edit-retry
    // truncation), otherwise use the conversation's full history. Either way the
    // current user turn is appended below — without that append, retrying the
    // first message of a conversation passes [] as the override and the request
    // reached the LLM with no messages at all (Anthropic 400: "messages: at
    // least one message is required").
    // TWO ARRAYS, and the distinction is load-bearing (BFSF-307).
    //
    //   messages         PROMPT shape. Hydrated with attachment content blocks,
    //                    compacted, attachment-expanded. NEVER persisted.
    //   durableMessages  DURABLE history. Append-only. The ONLY array that
    //                    agentStore.updateConversation ever sees.
    //
    // They previously were one variable, so `messages = compactedMessages` below
    // handed the compacted PROMPT to updateConversation — which is a destructive
    // full replace (agentConversations.js replaceMessages = DELETE + INSERT).
    // Every turn past the compaction threshold therefore deleted the oldest turns
    // from Postgres and replaced them with compaction's synthetic priming pairs.
    //
    // Element objects are SHARED between the two arrays on purpose:
    // hydrateHistoryAttachments replaces array SLOTS (`messages[i] = {...msg}`),
    // it does not mutate the message objects — see historyHydrator.js and the
    // test that pins it. The one object that must exist twice is the current
    // user turn, because processAttachments() DOES mutate it in place.
    //
    // `durableMessages` is const deliberately: it makes `durableMessages = x`
    // a syntax error rather than a silent regression.
    let messages;
    const durableMessages = [];
    // Map of live-attachment object → its persisted sidecar so processAttachments()
    // can write extracted text back onto the sidecar (replay across turns).
    const persistedByLive = new Map();
    if (historyOverride && Array.isArray(historyOverride)) {
        // Edit / retry: the client sends a TRUNCATED, SLIM history —
        // {role, content, attachments:[{name,type}]} and nothing else. Taking it
        // verbatim used to be a second data-loss path alongside BFSF-307: because
        // updateConversation is a full replace, persisting the client's copy
        // destroyed, for every earlier turn, the attachment sidecars
        // (storageKey / extractedText / extractionKey), id/parentId, toolHistory,
        // thinking, kbSources and tokenisationInfo.
        //
        // Direct chat solved this already; this is the same treatment.
        const { alignClientToDb, mergeAttachmentSidecars } = require('../../conversation/historyMerge');
        const dbMessages = conversation.messages || [];

        // Prompt side: graft the sidecars back on so hydrateHistoryAttachments
        // can still replay extractedText for earlier turns.
        messages = [...mergeAttachmentSidecars(historyOverride, dbMessages)];

        // Durable side: prefer the rich DB row wholesale. Content stays the
        // client's where there is no match — their truncation is authoritative.
        durableMessages.push(...alignClientToDb(historyOverride, dbMessages).map(({ client, dbMatch }) =>
            dbMatch || {
                role: client.role,
                content: client.content,
                ...(Array.isArray(client.attachments) && client.attachments.length > 0
                    ? { attachments: client.attachments } : {}),
            }));
    } else {
        messages = [...conversation.messages];
        durableMessages.push(...conversation.messages);
    }

    // Single point of truth for "what gets persisted". Three call sites used to
    // spell this out independently, which is how they could quietly diverge —
    // and it gives a test one seam to spy on instead of three.
    const persistDurable = async () => {
        if (isEphemeral) return;
        await _serializeConversationWrite(conversation.id, () =>
            agentStore.updateConversation(conversation.id, durableMessages,
                userAuth.encryptionKey, userAuth.userId));
        // Announce only AFTER the write commits. Waking other members earlier
        // would send them to read a thread that does not yet hold the turn they
        // were told about.
        if (_sharedThread) {
            await _emitAgentThreadEvent(_sharedThread.projectId, {
                kind: 'message.created',
                actorId: userAuth.userId,
                targetType: 'conversation',
                targetId: conversation.id,
            });
        }
    };

    // Build persisted attachments (strip base64, upload to RustFS) and append
    // the current user turn to both arrays — see ./attachmentIntake for the
    // userSave / promptUserMsg two-object contract.
    const { userSave, promptUserMsg } = await appendUserTurn({ messageMetadata, userMessage, userId, messages, durableMessages, persistedByLive });

    // ============ HYDRATE HISTORY ATTACHMENTS ============
    // Rebuilds multimodal content from each historical message's persisted
    // attachments sidecar so images/files from earlier turns stay visible to
    // the LLM, and refreshes any stale RustFS temp URLs (900 s TTL).
    // The current (last) user message is skipped — processAttachments() below
    // handles it with live upload data.
    await withPhase(onEvent, 'processed_history', null, () => hydrateHistoryAttachments(messages, { userId }));

    // ============ COMPACTION ============
    // OPT-IN, off by default — see core/llm/contextPolicy.js. When the org has
    // it on, older turns collapse into a summary block; any image_url blocks in
    // the summarised window are hoisted into the summary so visual context
    // survives, and both the summary and its watermark live on the
    // conversation's meta_json so later turns extend the fold instead of
    // redoing it. When it is off, the history passes through untouched and
    // Anthropic's server-side context_management does the trimming losslessly
    // — with an emergency fold if the conversation ever approaches the model's
    // context window.
    try {
        // Key names are the store's own: agentConversations.js reads
        // `meta.conversationSummary` / `meta.summaryUpTo` to decide whether a
        // stored conversation was ever compacted, and direct chat writes the
        // same pair. Inventing a third spelling here would leave the
        // read-time repair blind to a fold this turn just performed.
        const existingSummary = conversation?.meta?.conversationSummary || null;
        const existingUpTo = conversation?.meta?.summaryUpTo || 0;
        const contextPolicy = await resolveContextPolicy(
            messageMetadata?.userOrgId || agent?.organization_id || null
        );
        const compactionOpts = buildCompactionOptions({
            policy: contextPolicy,
            existingSummary,
            // The watermark was never passed here, so every turn past the
            // threshold re-summarised the WHOLE prefix from scratch: expensive,
            // lossier each time, and it rewrote the summary block on every turn
            // so the prompt-cache prefix never survived either.
            summaryUpTo: existingUpTo,
            modelId: modelToUse,
            userOrgId: messageMetadata?.userOrgId || agent?.organization_id || null,
        });
        // Only surface the user-visible "compacting" phase when a real
        // summarization LLM call is about to run — otherwise compactMessages is
        // a cheap local pass and the phase would just flicker on every turn.
        const runCompaction = () => compactMessages(messages, compactionOpts);
        const { messages: compactedMessages, newSummary, summaryUpTo, didSummarize } =
            needsSummarization(messages, compactionOpts)
                ? await withPhase(onEvent, 'compacting', null, runCompaction)
                : await runCompaction();
        messages = compactedMessages;
        if (didSummarize && newSummary && conversation?.id) {
            // Fire-and-forget — the next turn picks it up even if this write
            // races with the message persistence.
            agentStore.updateConversationMeta(conversation.id, {
                conversationSummary: newSummary,
                summaryUpTo: summaryUpTo || 0,
            }).catch(err => log.warn('[AgentRuntime] Failed to persist compaction summary:', err.message));
        }
    } catch (compactErr) {
        log.warn('[AgentRuntime] Compaction failed (continuing with full history):', compactErr.message);
    }

    return { messages, durableMessages, persistedByLive, persistDurable, userSave, promptUserMsg };
}

module.exports = { assembleTurnHistory, _serializeConversationWrite };

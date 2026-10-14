/**
 * Direct Chat prompt assembly: the conversation history. Which history the
 * turn replays (the client's, with the persisted attachment sidecars grafted
 * back, or the persisted rows), appended to the prompt and hydrated so
 * earlier images and files stay visible. Split out of promptAssembly.js;
 * behaviour unchanged.
 */

const agentStore = require('../../../stores/agentStore');
const { encryptionOpts } = require('./shared');
const log = require('../../../telemetry/log');

/**
 * Source-of-truth rule:
 *   - If the client sent `history` in the body, use it. This covers brand-new
 *     conversations (no DB row yet) and edit/retry flows where the client has
 *     truncated history before the edit point.
 *   - If `history` is missing/empty AND there is a conversationId, fall back
 *     to the persisted message rows. This eliminates the class of bugs where
 *     the client's in-memory history drifts from the durable record (e.g.
 *     tool messages stripped, page reload).
 */
async function resolveHistory({ req, userId, conversationId, history }) {
    let resolvedHistory = Array.isArray(history) ? history : null;
    // Whether the CLIENT supplied history this turn (edit/retry, or a surface
    // that never synced its conversation id), captured before the DB fallback
    // reassigns resolvedHistory. Also drives the OpenAI Responses chaining
    // guard: a provider-side chain would replay the pre-edit conversation and
    // ignore the client's truncation.
    const clientHistoryProvided = !!(resolvedHistory && resolvedHistory.length > 0);
    if (clientHistoryProvided && conversationId) {
        // Client copies strip attachment sidecars to {name, type}. Graft the
        // persisted sidecars (extractedText / extractionKey / storageKey) back
        // onto the client history so the hydrator can re-inject real file
        // content instead of a bare "[File previously attached]" placeholder.
        try {
            const { mergeAttachmentSidecars } = require('../../../core/conversation/historyMerge');
            const persisted = await agentStore.getDirectConversation(conversationId, userId, { restore: false, ...encryptionOpts(req) });
            if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                resolvedHistory = mergeAttachmentSidecars(resolvedHistory, persisted.messages);
            }
        } catch (mergeErr) {
            log.warn('[DirectChat] Attachment sidecar merge failed:', mergeErr.message);
        }
    }
    if ((!resolvedHistory || resolvedHistory.length === 0) && conversationId) {
        try {
            // restore:false keeps [email_N] tokens in the history handed to the
            // model on follow-up turns so PII never re-leaks into its context.
            // UI fetch paths still default to restore:true.
            const persisted = await agentStore.getDirectConversation(conversationId, userId, { restore: false, ...encryptionOpts(req) });
            if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                resolvedHistory = persisted.messages;
                log.info(`[DirectChat] No client history — loaded ${resolvedHistory.length} persisted messages from DB`);
            }
        } catch (loadErr) {
            log.warn('[DirectChat] Failed to load persisted history:', loadErr.message);
        }
    }
    return { resolvedHistory, clientHistoryProvided };
}

/**
 * Append the history to `messages`, preserving the `attachments` sidecar so
 * the hydrator can rebuild multimodal content (images stay visible across
 * turns). Stripping sidecar fields here is what used to make the AI "lose"
 * uploaded images one turn after the upload.
 */
async function appendHistory(messages, resolvedHistory, userId) {
    if (!(resolvedHistory && resolvedHistory.length > 0)) return;
    for (const msg of resolvedHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            const entry = { role: msg.role, content: msg.content };
            if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                entry.attachments = msg.attachments;
            }
            messages.push(entry);
        }
    }
    try {
        const { hydrateHistoryAttachments } = require('../../../core/agentRuntime/historyHydrator');
        await hydrateHistoryAttachments(messages, { userId, skipLast: false });
    } catch (hydrateErr) {
        log.warn('[DirectChat] History hydration failed:', hydrateErr.message);
    }
}

module.exports = { resolveHistory, appendHistory };

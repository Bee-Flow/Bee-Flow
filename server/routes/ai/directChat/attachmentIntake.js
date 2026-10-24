// @typecheck
/**
 * Direct Chat — attachment intake for the streaming turn: eager conversation
 * creation (the scanner needs a real convId for its token-map merge), per-
 * format extraction (attachmentFormats.js), the Privacy Shield attachment
 * scan with its block/tokenize/pass handling and audit + SSE surfacing
 * (attachmentScan.js), the prompt-cache breakpoint on the last attachment
 * block, and the final user-message push.
 *
 * Returns { convId, persistedAttachments, _turnAttachmentSummaries } — or
 * undefined when the Privacy Shield BLOCKED an attachment, in which case the
 * SSE stream has already been ended and the caller must stop the turn.
 */

const agentStore = require('../../../stores/agentStore');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
require('./shared');
const log = require('../../../telemetry/log');
const { processAttachment } = require('./attachmentFormats');
const {
    resolveAttachmentShield,
    makeAttachmentScanner,
    reportAttachmentBlock,
    auditScanSummaries,
    surfaceScanSummaries,
} = require('./attachmentScan');

/**
 * Eagerly create the conversation BEFORE the attachment scan. Two reasons:
 *   1) workspace_* tools later in the turn need a valid DB row.
 *   2) the attachment scanner calls `dlpRunner.mergeTokenMap(convId, tokenMap)`;
 *      if convId is null at scan time the merge is a no-op and Claude's
 *      `[person_N]` echoes leak through to the rendered response.
 * Side effect: a brand-new conversation row appears slightly earlier in the
 * turn; the orphan-row risk is unchanged.
 */
async function ensureConversation({ convId, userId, modelTier, send }) {
    if (convId) return convId;
    // Persist the user's pick (e.g. "auto"), not the classifier's resolution.
    // On reload the UI restores `selectedTier` from this value; storing "fast"
    // here would turn Auto into Fast after refresh.
    const newConv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
    send('conversation_created', { conversationId: newConv.id });
    log.info(`[DirectChat] Eagerly created conversation ${newConv.id} for workspace/tool access`);
    return newConv.id;
}

/**
 * Prompt cache breakpoint on the last attachment block. OCR / PDF extraction
 * is expensive and the document content is stable across follow-up questions
 * in the same chat. Mark the LAST attachment-derived block so Anthropic caches
 * the document for >=5 min at 10% cost on the next turn. The Claude provider's
 * normalizeMessages counts this pre-existing marker against its own breakpoint
 * budget so we stay under the 4-marker API limit.
 */
function markCacheBreakpoint(contentParts) {
    if (contentParts.length === 0) return;
    const lastBlock = contentParts[contentParts.length - 1];
    if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: 'ephemeral' };
    }
}

/**
 * Extract, scan and inline every attachment. Returns the content parts and
 * the per-file scan summaries, or `{ blocked: true }` after the Privacy
 * Shield blocked one (the SSE stream is then already ended).
 */
async function intakeAttachments({ req, res, send, userId, convId, conversationId, message, attachments, adapter, modelId, config, persistedAttachments, documentScope }) {
    const contentParts = [];
    if (message) contentParts.push({ type: 'text', text: message });
    const { persistExtractedText } = require('../../../core/documents/extractedTextStore');
    const { userOrgId, shield } = await resolveAttachmentShield(req);
    const summaries = [];
    const scan = makeAttachmentScanner({ shield, config, convId, userId, send, summaries });

    // Sidecar carries the persistent representation of an attachment. Big
    // extractions are tiered to RustFS via persistExtractedText so meta_json
    // doesn't grow unbounded, while the head+tail snippet stays inline for replay.
    const pushAttachment = async (base, fullText) => {
        if (!fullText) {
            persistedAttachments.push(base);
            return;
        }
        const tiered = await persistExtractedText(fullText, userId, base.name);
        persistedAttachments.push({
            ...base,
            extractedText: tiered.extractedText,
            ...(tiered.extractionKey ? { extractionKey: tiered.extractionKey } : {}),
        });
    };

    const ctx = { req, send, documentScope, userId, adapter, modelId, config, shield, contentParts, persistedAttachments, pushAttachment, scan, summaries };
    const auditCtx = { userOrgId, userId, conversationId, config, modelId };
    try {
        for (const att of attachments) await processAttachment(att, ctx);
    } catch (attErr) {
        if (attErr && attErr.code === 'ATTACHMENT_PII_BLOCKED') {
            await reportAttachmentBlock(attErr, { send, ...auditCtx });
            send('done', {}); res.end();
            return { blocked: true };
        }
        throw attErr;
    }
    // Audit + UI surfacing for tokenised attachments.
    await auditScanSummaries(summaries, auditCtx);
    if (summaries.length > 0) surfaceScanSummaries(summaries, { send, shield, contentParts, modelId, convId });
    markCacheBreakpoint(contentParts);
    return { contentParts, summaries };
}

async function processAttachmentsAndUserMessage({ req, res, send, userId, convId, conversationId, modelTier, message, attachments, adapter, modelId, config, messages, documentScope }) {
    convId = await ensureConversation({ convId, userId, modelTier, send });

    const persistedAttachments = []; // Track attachments for conversation persistence
    // Per-turn attachment scan summaries, returned to the route so they
    // survive the `messages = compactionResult.messages` reassignment that
    // happens later. The assistant-message builder reads them; without this
    // the privacy panel's "From attachments:" section disappears on reload.
    let _turnAttachmentSummaries = null;
    const hasAttachments = !!(attachments && attachments.length > 0);
    if (hasAttachments) {
        // Surface attachment processing as a phase so the user sees "Reading
        // attachment <filename>..." while OCR / PDF extraction runs (often the
        // slowest step before the first token).
        const detail = attachments.length === 1 && attachments[0]?.name
            ? attachments[0].name
            : `${attachments.length} files`;
        emitPhase(send, 'processing_attachments', detail);
    }
    const _attT = hasAttachments ? Date.now() : null;
    if (hasAttachments) {
        const intake = await intakeAttachments({ req, res, send, userId, convId, conversationId, message, attachments, adapter, modelId, config, persistedAttachments, documentScope });
        if (intake.blocked) return undefined;
        if (intake.summaries.length > 0) _turnAttachmentSummaries = intake.summaries;
        messages.push({ role: 'user', content: intake.contentParts });
    } else {
        messages.push({ role: 'user', content: message });
    }
    if (_attT !== null) {
        emitPhaseEnd(send, 'processing_attachments', Date.now() - _attT);
    }
    return { convId, persistedAttachments, _turnAttachmentSummaries };
}

module.exports = { processAttachmentsAndUserMessage };

// @typecheck noImplicitAny
/**
 * Put a turn's attachments onto its user message. Each kind is handled in
 * ./attachmentKinds; extracted text passes the Privacy Shield gate in
 * ./attachmentScanGate first.
 */
const log = require('../../telemetry/log');
const { createAttachmentScanGate } = require('./attachmentScanGate');
const { appendPdf, appendImage, appendInlineText, appendParsedDocument } = require('./attachmentKinds');

// Decide whether a model ID supports vision for the PDF-vision-fallback
// decision, independently of which adapter the agent ultimately selects.
//
// This used to be a standalone regex that "mirrors the supportsVision regexes
// in the individual provider adapters" — and had drifted out of sync with them:
// it omitted claude-sonnet-5, claude-opus-5 and claude-fable, silently turning
// the PDF-vision fallback OFF for models we already ship. Claude now answers
// from the same catalog the adapter reads, so the two cannot diverge again.
/**
 * @param {string} modelId
 */
function modelSupportsVisionById(modelId) {
    if (!modelId) return false;
    if (/claude|anthropic/i.test(modelId)) {
        const { describeClaudeModel } = require('../providers/claudeModels');
        return describeClaudeModel(modelId).vision;
    }
    // Mistral from its catalog: vision is no longer Pixtral-only — Large 3,
    // Medium 3.5, Small 4 and Ministral 3 all take images.
    if (/^(mistral|ministral|magistral|codestral|devstral|pixtral)-/i.test(modelId)) {
        const { describeMistralModel } = require('../providers/mistralModels');
        return describeMistralModel(modelId).vision;
    }
    return /gpt-4o|gpt-4\.1|gpt-5|o4|gemini/i.test(modelId);
}

/**
 * @param {import('./attachmentKinds').Attachment[] | undefined} attachments
 * @param {{ content: string | import('./attachmentKinds').MessagePart[] }} lastMsg
 * @param {string | null} [userId]
 * @param {{ orgShield?: unknown, conversationId?: string | null, provider?: Parameters<typeof createAttachmentScanGate>[0]['provider'], emit?: Parameters<typeof createAttachmentScanGate>[0]['emit'], registerDecision?: Parameters<typeof createAttachmentScanGate>[0]['registerDecision'], modelId?: string, persistedByLive?: import('./attachmentKinds').PersistedByLive }} [opts]
 */
async function processAttachments(attachments = [], lastMsg, userId = null, opts = {}) {
    if (!attachments || attachments.length === 0) return { attachmentScanSummaries: [] };

    if (typeof lastMsg.content === 'string') {
        lastMsg.content = [{ type: 'text', text: lastMsg.content }];
    }

    const { maybeScan, summaries: attachmentScanSummaries } = createAttachmentScanGate({
        orgShield: opts.orgShield || null,
        conversationId: opts.conversationId || null,
        provider: opts.provider || null,
        userId,
        emit: opts.emit || null,
        registerDecision: opts.registerDecision || null,
    }, {
        attachmentScanner: () => require('../dlp/attachmentScanner'),
        attachmentAskFlow: () => require('../dlp/attachmentAskFlow'),
    });
    const ctx = {
        modelSupportsVision: modelSupportsVisionById(opts.modelId ?? ''),
        persistedByLive: opts.persistedByLive || null,
        maybeScan,
        userId,
        attachmentExtractor: () => require('../documents/attachmentExtractor'),
    };

    for (const att of attachments) {
        if (att.type.includes('pdf')) {
            await appendPdf(att, /** @type {import('./attachmentKinds').LastMsg} */ (lastMsg), ctx);
        } else if (att.type.startsWith('image/')) {
            await appendImage(att, /** @type {import('./attachmentKinds').LastMsg} */ (lastMsg), ctx);
        } else if ((att.source === 'gmail' || (att.type && att.type.startsWith('text/'))) && typeof att.content === 'string' && !att.content.startsWith('data:')) {
            await appendInlineText(att, /** @type {import('./attachmentKinds').LastMsg} */ (lastMsg), ctx);
        } else {
            await appendParsedDocument(att, /** @type {import('./attachmentKinds').LastMsg} */ (lastMsg), ctx);
        }
    }

    warnOnLargeBase64(lastMsg);
    return { attachmentScanSummaries };
}

/**
 * Warn on an oversized base64 payload (only relevant when RustFS is unavailable).
 * @param {{ content: string | { type: string, image_url?: { url?: string } }[] }} lastMsg
 */
function warnOnLargeBase64(lastMsg) {
    if (!Array.isArray(lastMsg.content)) return;
    const totalBase64Size = lastMsg.content
        .filter((/** @type {{ type: string; }} */ p) => p.type === 'image_url')
        .reduce((sum, p) => {
            const url = p.image_url?.url || '';
            // Only count base64 data URLs, not short https:// URLs
            return sum + (url.startsWith('data:') ? url.length : 0);
        }, 0);
    if (totalBase64Size > 3_000_000) {
        log.warn(`[AttachmentProcessor] ⚠️ Large base64 image payload: ${Math.round(totalBase64Size / 1024)} KB — configure RustFS to avoid context overflow`);
    }
}

module.exports = { processAttachments };

/** @typedef {import('./chatStream/turnState').MessageMetadata} MessageMetadata */
/** @typedef {import('./chatStream/turnState').ChatMessage} ChatMessage */
/** @typedef {import('./attachmentKinds').PersistedByLive} PersistedByLive */
/** @typedef {import('./chatStream/turnState').ConversationRow} ConversationRow */
/** @typedef {import('../providers/base').OnEvent} OnEvent */
/** @typedef {import('./chatStream/turnState').AgentRow} AgentRow */
/** @typedef {import('./chatStream/roundRequest').ProviderConfig} ProviderConfig */
// @typecheck
/**
 * Streaming agent chat — attachment intake.
 *
 * Two phases of the same domain, moved verbatim out of chatStream.js:
 *   appendUserTurn         — persist uploaded attachments (strip base64,
 *                            upload to RustFS) and append the current user
 *                            turn to both history arrays as two objects
 *                            (durable `userSave`, prompt-side `promptUserMsg`).
 *   processTurnAttachments — first-iteration attachment expansion: extraction
 *                            via processAttachments, Privacy-Shield scan
 *                            audits, tokenisation badges and raw-payload
 *                            transparency for the chat UI.
 */
const { withPhase } = require('./phaseEvents');
const { processAttachments } = require('./attachmentProcessor');
const log = require('../../telemetry/log');
const { phaseDetail, auditContext, reportBlockedAttachment, auditScanSummaries, mergeScanSummaries, showRawPayload } = require('./attachmentTurnSteps');

async function appendUserTurn({ messageMetadata, userMessage, userId, messages, durableMessages, persistedByLive }) {
    // The current user turn, as two objects: `userSave` is what gets persisted,
    // `promptUserMsg` is what the model sees after attachment expansion.
    let userSave = null;
    let promptUserMsg = null;

    // Build persisted attachments (strip base64, upload to RustFS for persistent URLs)
    {
        const persistedAttachments = [];
        if (messageMetadata?.attachments && messageMetadata.attachments.length > 0) {
            const storageStore = require('../../stores/storageStore');
            const crypto = require('crypto');
            for (const att of messageMetadata.attachments) {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    // Upload image to RustFS for persistence
                    /** @type {string | null} */
                    let imageProxyUrl = null;
                    /** @type {string | null} */
                    let storageKey = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const ext = att.type.includes('jpeg') || att.type.includes('jpg') ? 'jpg' : 'png';
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            imageProxyUrl = storageStore.buildProxyUrl(key);
                            storageKey = key;
                            log.info(`[AgentRuntime] Uploaded attachment image to RustFS: ${key}`);
                        }
                    } catch (e) {
                        log.warn(`[AgentRuntime] Failed to upload attachment image to RustFS: ${/** @type {Error} */ (e).message}`);
                    }
                    const record = { name: att.name, type: att.type, storageKey, url: imageProxyUrl };
                    persistedAttachments.push(record);
                    persistedByLive.set(att, record);
                } else if (att.type && att.type.includes('pdf')) {
                    // PDF — persist metadata without base64 content
                    /** @type {string | null} */
                    let pdfProxyUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${(att.name || 'document').replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            pdfProxyUrl = storageStore.buildProxyUrl(key);
                            log.info(`[AgentRuntime] Uploaded attachment PDF to RustFS: ${key}`);
                        }
                    } catch (e) {
                        log.warn(`[AgentRuntime] Failed to upload attachment PDF to RustFS: ${/** @type {Error} */ (e).message}`);
                    }
                    const record = { name: att.name, type: att.type, url: pdfProxyUrl };
                    persistedAttachments.push(record);
                    persistedByLive.set(att, record);
                } else if (att.name) {
                    // Other file types — persist metadata only
                    /** @type {string | null} */
                    let fileProxyUrl = null;
                    try {
                        if (att.content && storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${(att.name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type || 'application/octet-stream');
                            fileProxyUrl = storageStore.buildProxyUrl(key);
                            log.info(`[AgentRuntime] Uploaded attachment file to RustFS: ${key}`);
                        }
                    } catch (e) {
                        log.warn(`[AgentRuntime] Failed to upload attachment file to RustFS: ${/** @type {Error} */ (e).message}`);
                    }
                    const record = { name: att.name, type: att.type, url: fileProxyUrl };
                    persistedAttachments.push(record);
                    persistedByLive.set(att, record);
                }
            }
        }

        // Include id and parentId for persistence
        const userMsg = {
            id: messageMetadata.messageId,
            role: 'user',
            content: userMessage,
            parentId: messageMetadata.parentId || null
        };
        // SHARED BY REFERENCE, deliberately: processAttachments() →
        // persistExtractionOntoSidecar() writes extractedText/extractionKey onto
        // these exact record objects via persistedByLive. Cloning the array here
        // would silently break sidecar replay on later turns.
        if (persistedAttachments.length > 0) userMsg.attachments = persistedAttachments;
        durableMessages.push(userMsg);

        // Prompt-side twin. `content` is a string at this point, so the spread is
        // a value copy — processAttachments() may turn THIS one into an array of
        // content blocks and inline an entire extracted PDF into it, while
        // userMsg keeps the plain user text that belongs in the transcript.
        userSave = userMsg;
        promptUserMsg = { ...userMsg };
        messages.push(promptUserMsg);
    }

    return { userSave, promptUserMsg };
}

/**
 * What attachment expansion reaches outside this file. The provider
 * classification, the block audit, the guardrail ledger and the token maps
 * load on first use, at the point the turn needs them; a test passes its own.
 */
const INTAKE_DEPS = {
    processAttachments,
    classification: () => require('../providers/classification'),
    blockAudit: () => require('../dlp/attachmentBlockAudit'),
    guardrailEvents: () => require('../../stores/guardrailEventStore'),
    dlpRunner: () => require('../dlp/dlpRunner'),
    log,
};

/**
 * What the attachment processor is told about this turn.
 * Privacy Shield: scan extracted text from each attachment and either
 * tokenise (default) or block (when org chose "Block the message" action) —
 * or, under dlpMode:'ask', pause for the same review the typed message
 * already gets (see attachmentAskFlow.js). Auto-follows the message-level
 * toggle — same categories, threshold, action.
 */
function attachOptions({ modelToUse, persistedByLive, dlpShield, conversation, onEvent, config }, deps) {
    const { classifyProvider } = deps.classification();
    return {
        modelId: modelToUse,
        persistedByLive,
        orgShield: dlpShield,
        conversationId: conversation?.id,
        emit: onEvent,
        provider: classifyProvider(config || {}, dlpShield?.dlpAllowlistedHosts || []),
    };
}

// The second parameter is the collaborators above; only a test passes its own.
async function processTurnAttachments(turn, deps = INTAKE_DEPS) {
    const { messageMetadata, lastMsg, userId, modelToUse, dlpShield, conversation, onEvent, _assistantTokenisationInfo } = turn;
    deps.log.info(`[Agent] Processing ${messageMetadata.attachments.length} attachments...`);
    const _attachOpts = attachOptions(turn, deps);
    let _attachResult;
    try {
        const detail = phaseDetail(messageMetadata.attachments);
        _attachResult = await withPhase(onEvent, 'processing_attachments', detail, () =>
            deps.processAttachments(messageMetadata.attachments, lastMsg, userId, _attachOpts)
        );
    } catch (attErr) {
        if (attErr && attErr.code === 'ATTACHMENT_PII_BLOCKED') throw reportBlockedAttachment(attErr, turn, deps);
        throw attErr;
    }

    // Audit + UI surfacing for tokenised attachments.
    const summaries = _attachResult?.attachmentScanSummaries;
    if (!(summaries?.length > 0)) return _assistantTokenisationInfo;
    const dlpStore = deps.guardrailEvents();
    auditScanSummaries(summaries, auditContext(turn), dlpStore);
    const { info, aggCount, aggCats } = mergeScanSummaries(_assistantTokenisationInfo, summaries);

    // Live SSE so the chat UI displays the privacy badge during
    // the turn (not only after a page reload). Mirrors directChat.
    if (aggCount > 0 || summaries.some(s => s.timeout || s.reason)) {
        onEvent?.('pii_tokenized', {
            entities: [...aggCats].map(label => ({ label, category: label })),
            tokenCount: aggCount,
            attachments: summaries,
            source: 'privacy_shield',
        });
    }
    if (aggCount > 0 && dlpShield?.showRawPayload) showRawPayload({ lastMsg, modelToUse, conversation, onEvent }, info, deps);
    return info;
}

module.exports = { appendUserTurn, processTurnAttachments, INTAKE_DEPS };

/**
 * @typedef {import('./attachmentKinds').Attachment} Attachment
 * @typedef {import('./attachmentKinds').MessagePart} MessagePart
 * @typedef {import('./attachmentKinds').PersistedAttachment} PersistedAttachment
 * @typedef {{ id?: string, role: string, content: string | MessagePart[], parentId: string | null, attachments?: PersistedAttachment[] }} UserTurnMessage
 * @typedef {{ source: string, action: string, count: number, categories: string[], automatic?: boolean, provider?: string, attachments?: import('./attachmentScanGate').ScanSummaryRow[], tokenizedPrompt?: string, tokenMap?: Record<string, string> }} AttachmentTokenisationInfo
 */

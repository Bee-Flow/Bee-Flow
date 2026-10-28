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
const { bestEffort, fallback } = require('../../utils/bestEffort');

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

async function processTurnAttachments({ messageMetadata, lastMsg, userId, modelToUse, persistedByLive, dlpShield, conversation, onEvent, agent, agentId, config, _assistantTokenisationInfo }) {
                log.info(`[Agent] Processing ${messageMetadata.attachments.length} attachments...`);
                const { classifyProvider } = require('../providers/classification');
                const _attachOpts = {
                    modelId: modelToUse,
                    persistedByLive,
                    // Privacy Shield: scan extracted text from each attachment
                    // and either tokenise (default) or block (when org chose
                    // "Block the message" action) — or, under dlpMode:'ask',
                    // pause for the same review the typed message already gets
                    // (see attachmentAskFlow.js). Auto-follows the message-
                    // level toggle — same categories, threshold, action.
                    orgShield: dlpShield,
                    conversationId: conversation?.id,
                    emit: onEvent,
                    provider: classifyProvider(config || {}, dlpShield?.dlpAllowlistedHosts || []),
                };
                let _attachResult;
                try {
                    const firstAtt = messageMetadata.attachments[0];
                    const detail = messageMetadata.attachments.length === 1 && firstAtt?.name
                        ? firstAtt.name
                        : `${messageMetadata.attachments.length} files`;
                    _attachResult = await withPhase(onEvent, 'processing_attachments', detail, () =>
                        processAttachments(messageMetadata.attachments, lastMsg, userId, _attachOpts)
                    );
                } catch (attErr) {
                    if (attErr && attErr.code === 'ATTACHMENT_PII_BLOCKED') {
                        const cats = Object.keys(attErr.summary?.byCategory || {});
                        // Held (scan couldn't cover the input) vs blocked (policy or
                        // the person decided) — see attachmentBlockAudit.
                        const { attachmentBlockAudit } = require('../dlp/attachmentBlockAudit');
                        const audit = attachmentBlockAudit(attErr.reason, cats);
                        const cause = audit.cause;
                        const sseReason = cause === 'pii' ? 'attachment_pii' : `attachment_${cause}`;
                        onEvent?.('dlp_blocked', {
                            reason: sseReason,
                            filename: attErr.filename,
                            categories: cats,
                            findings: [],
                            provider: { isExternal: false, reason: sseReason },
                        });
                        const guardEvents = require('../../stores/guardrailEventStore');
                        guardEvents.logGuardrailEvent({
                            organization_id: agent.organization_id || null,
                            user_id: userId || null,
                            agent_id: agentId || null,
                            agent_name: agent.name || null,
                            conversation_id: conversation?.id || null,
                            model: modelToUse,
                            source: config?.providerName || config?.providerType || 'LLM',
                            violation_type: 'pii',
                            violation_categories: audit.violation_categories,
                            direction: 'input',
                            action_taken: audit.action_taken,
                            attachment_filename: attErr.filename,
                            attachment_page: null,
                        }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments', e));
                        const e = new Error(/** @type {Error} */ (attErr).message);
                        e.code = 'ATTACHMENT_PII_BLOCKED';
                        throw e;
                    }
                    throw attErr;
                }

                // Audit + UI surfacing for tokenised attachments.
                if (_attachResult?.attachmentScanSummaries?.length > 0) {
                    const dlpStore = require('../../stores/guardrailEventStore');
                    const auditBase = {
                        organization_id: agent.organization_id || null,
                        user_id: userId || null,
                        agent_id: agentId || null,
                        agent_name: agent.name || null,
                        conversation_id: conversation?.id || null,
                        model: modelToUse,
                        source: config?.providerName || config?.providerType || 'LLM',
                    };
                    for (const s of _attachResult.attachmentScanSummaries) {
                        if (s.action === 'tokenize') {
                            dlpStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'redacted' }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#2', e));
                        }
                        // Found something but sent it unredacted anyway (ask
                        // flow "send anyway", or a remembered "allow") — audit
                        // it explicitly, same as a redaction is audited. Never
                        // silent just because nothing was masked.
                        if (s.action === 'allowed') {
                            dlpStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'allowed' }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#3', e));
                        }
                        // Incomplete scan passed through unredacted (fail_open) —
                        // audit it explicitly so large-input pass-throughs are
                        // measurable, never silent.
                        if (s.reason) {
                            dlpStore.logAttachmentScanIncomplete({
                                auditBase, filename: s.filename, reason: s.reason,
                                scannedPages: s.scannedPages, totalPages: s.totalPages,
                                action_taken: s.action === 'tokenize' ? 'partial_redacted' : 'passed_unredacted',
                            }).catch((e) => bestEffort('core/agentRuntime/attachmentIntake:processTurnAttachments#4', e));
                        }
                    }
                    // Merge per-file detail into the assistant tokenisation info
                    // so the chat UI can render the per-attachment badge.
                    const aggCount = _attachResult.attachmentScanSummaries.reduce((a, s) => a + (s.count || 0), 0);
                    const aggCats = new Set();
                    for (const s of _attachResult.attachmentScanSummaries) {
                        for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
                    }
                    _assistantTokenisationInfo = _assistantTokenisationInfo || {
                        source: 'privacy_shield',
                        action: 'redact',
                        count: 0,
                        categories: [],
                        automatic: true,
                    };
                    _assistantTokenisationInfo.attachments = _attachResult.attachmentScanSummaries;
                    _assistantTokenisationInfo.count = (_assistantTokenisationInfo.count || 0) + aggCount;
                    const catSet = new Set([...(_assistantTokenisationInfo.categories || []), ...aggCats]);
                    _assistantTokenisationInfo.categories = [...catSet];

                    // Live SSE so the chat UI displays the privacy badge during
                    // the turn (not only after a page reload). Mirrors directChat.
                    if (aggCount > 0 || _attachResult.attachmentScanSummaries.some(s => s.timeout || s.reason)) {
                        onEvent?.('pii_tokenized', {
                            entities: [...aggCats].map(label => ({ label, category: label })),
                            tokenCount: aggCount,
                            attachments: _attachResult.attachmentScanSummaries,
                            source: 'privacy_shield',
                        });
                    }

                    // Raw-payload transparency for attachments (only when the
                    // org opted in). Lets the user verify the exact tokenised
                    // text Claude received — the missing "Sent to AI" pane
                    // in the privacy panel was the source of the "I can't see
                    // that anything was tokenised" feedback.
                    if (aggCount > 0 && dlpShield?.showRawPayload) {
                        try {
                            const flat = Array.isArray(lastMsg?.content)
                                ? lastMsg.content
                                    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
                                    .map(p => p.text)
                                    .join('\n')
                                : (typeof lastMsg?.content === 'string' ? lastMsg.content : '');
                            if (flat) {
                                onEvent?.('privacy_payload', {
                                    tokenizedPrompt: flat,
                                    provider: modelToUse,
                                    source: 'privacy_shield',
                                    timestamp: Date.now(),
                                });
                                _assistantTokenisationInfo.tokenizedPrompt = flat;
                            }
                            const _convMap = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
                            if (_convMap && Object.keys(_convMap).length > 0) {
                                onEvent?.('privacy_token_map', { tokenMap: _convMap, source: 'privacy_shield' });
                                _assistantTokenisationInfo.tokenMap = _convMap;
                            }
                        } catch (err) { fallback('core/agentRuntime/attachmentIntake:processTurnAttachments#5', err); /* transparency is best-effort */ }
                    }
                }

    return _assistantTokenisationInfo;
}

module.exports = { appendUserTurn, processTurnAttachments };

/**
 * @typedef {import('./attachmentKinds').Attachment} Attachment
 * @typedef {import('./attachmentKinds').MessagePart} MessagePart
 * @typedef {import('./attachmentKinds').PersistedAttachment} PersistedAttachment
 * @typedef {{ id?: string, role: string, content: string | MessagePart[], parentId: string | null, attachments?: PersistedAttachment[] }} UserTurnMessage
 * @typedef {{ source: string, action: string, count: number, categories: string[], automatic?: boolean, provider?: string, attachments?: import('./attachmentScanGate').ScanSummaryRow[], tokenizedPrompt?: string, tokenMap?: Record<string, string> }} AttachmentTokenisationInfo
 */

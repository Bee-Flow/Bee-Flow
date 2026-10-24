// @typecheck
/**
 * Notebook chat: the conversation one turn sends and the input gates it
 * passes before the model sees it (routes/ai/notebookChat.js), in the order
 * the route runs them: history within its budget, the user message with its
 * attachments, Unicode smuggling, PII tokenisation, the token-preservation
 * addendum and the input regex guardrails.
 *
 * A step that returns STOP has answered the client and ended the response.
 */

'use strict';

const log = require('../../../telemetry/log');
const dlpRunner = require('../../../core/dlp/dlpRunner');
const { startPrivacyScanPhase, messageText } = require('../../../core/agentRuntime/phaseEvents');
const { sanitizeMessagesUnicode } = require('../../../utils/unicodeSanitizer');
const { mergeWithOrgShield } = require('../../../core/privacy/orgShield');
const { applyRegexGuardrails } = require('../../../core/agentRuntime/guardrailsRunner');
const guardrailEventStore = require('../../../stores/guardrailEventStore');
const { buildTokenPreservationAddendum } = require('../../../core/dlp/tokenPreservationPrompt');
const { STOP } = require('./privacyScans');
const { bestEffort, fallback } = require('../../../utils/bestEffort');

/**
 * Add conversation history, newest-first within a token budget.
 *
 * This used to push EVERY prior turn unconditionally, on top of a
 * ≤20k-token document and the KB context. Past a certain thread length
 * the request exceeded the model's context window and the turn failed —
 * and because the history only ever grew, it then failed forever: the
 * conversation was permanently unusable with no recovery but deleting
 * it. Dropping the oldest turns keeps a long thread working; the model
 * is told the transcript was trimmed so it doesn't claim to recall
 * something it can no longer see.
 */
function appendHistory(messages, history) {
    if (history && Array.isArray(history)) {
        const HISTORY_TOKEN_BUDGET = 12000;         // ≈48k chars
        const approxTokens = (s) => Math.ceil(String(s || '').length / 4);
        const usable = history.filter(
            (m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim()
        );
        const kept = [];
        let spent = 0;
        for (let i = usable.length - 1; i >= 0; i--) {
            const cost = approxTokens(usable[i].content);
            if (spent + cost > HISTORY_TOKEN_BUDGET && kept.length > 0) break;
            kept.unshift(usable[i]);
            spent += cost;
        }
        const dropped = usable.length - kept.length;
        if (dropped > 0) {
            log.info(`[NotebookChat] history trimmed: dropped ${dropped} of ${usable.length} messages (~${spent} tok kept)`);
            messages.push({
                role: 'user',
                content: `[Earlier in this conversation, ${dropped} message(s) were omitted to stay within the context limit. If the user refers to something not shown below, say you no longer have it in view and ask them to restate it, or search the notebook's sources.]`,
            });
        }
        for (const msg of kept) {
            messages.push({ role: msg.role, content: msg.content });
        }
    }
}

/**
 * Add current message with attachments.
 * @returns {Promise<typeof STOP | null>}
 */
async function appendUserMessage({ messages, message, attachments, adapter, modelId, scans }) {
    const { _abortFailClosed, _abortBlocked, _scanAttBody } = scans;
    if (attachments && attachments.length > 0) {
        const contentParts = [];
        if (message) contentParts.push({ type: 'text', text: message });

        // Use the same server-side extraction pipeline as direct chat so
        // PDFs/DOCX/spreadsheets are turned into real text (pdfjs → Azure →
        // Mistral OCR → vision) instead of being UTF-8-decoded into garbage.
        const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote, isPdf, isDocx, isSpreadsheet } = require('../../../core/documents/attachmentExtractor');
        for (const att of attachments) {
            try {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                } else if (att.content && (isPdf(att) || isDocx(att) || isSpreadsheet(att))) {
                    const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision?.(modelId) });
                    if (result.kind === 'text') {
                        const _scan = await _scanAttBody((result.text || '').slice(0, 20000), att.name);
                        if (_scan.blocked) { _abortBlocked('attachment'); return STOP; }
                        if (_scan.scanFailed) { _abortFailClosed('attachment'); return STOP; }
                        const _body = _scan.text;
                        contentParts.push({ type: 'text', text: `${formatTextHeader(att, result)}\n---\n${_body}\n---` });
                    } else if (result.kind === 'images' && Array.isArray(result.images)) {
                        contentParts.push({ type: 'text', text: formatImagesHeader(att, result) });
                        for (const img of result.images) {
                            contentParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
                        }
                    } else {
                        contentParts.push({ type: 'text', text: formatFailureNote(att, result) });
                    }
                } else if (att.content && typeof att.content === 'string') {
                    // Plain-text / csv / code files — a UTF-8 decode is correct.
                    const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                    if (textContent) {
                        const _scan = await _scanAttBody(textContent.slice(0, 8000), att.name);
                        if (_scan.blocked) { _abortBlocked('attachment'); return STOP; }
                        if (_scan.scanFailed) { _abortFailClosed('attachment'); return STOP; }
                        const _body = _scan.text;
                        contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${_body}\n---` });
                    }
                }
            } catch (attErr) {
                contentParts.push({ type: 'text', text: `[Bestand: ${att.name} — kon niet worden gelezen: ${attErr.message}]` });
            }
        }

        const hasImages = contentParts.some(p => p.type === 'image_url');
        if (hasImages) {
            messages.push({ role: 'user', content: contentParts });
        } else {
            const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
            if (combined.trim()) messages.push({ role: 'user', content: combined });
        }
    } else {
        messages.push({ role: 'user', content: message });
    }
    return null;
}

/** Unicode Smuggling Defense (must run FIRST). */
function stripUnicodeSmuggling({ messages, send, userOrgForTiers, userId, notebookId }) {
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        log.warn(`[NotebookChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
        send('unicode_smuggling_detected', {
            strippedCount: unicodeResult.totalStripped,
            messageIndices: unicodeResult.detectedIn,
        });
        guardrailEventStore.logGuardrailEvent({
            organization_id: userOrgForTiers || null,
            user_id: userId || null,
            conversation_id: notebookId || null,
            violation_type: 'unicode_smuggling',
            violation_categories: `${unicodeResult.totalStripped} hidden chars`,
            direction: 'input',
            action_taken: 'stripped',
            source: 'notebook',
        }).catch((e) => bestEffort('routes/ai/notebookChat/inputGates:stripUnicodeSmuggling', e));
    }
}

/**
 * PII detection / tokenization (Privacy Shield).
 * Mirrors directChat: if the org's Privacy Shield is enabled,
 * run validateInputForPii on the last user message and apply
 * tokenize/block actions. detectPii() calls the PII Guard service.
 * @returns {Promise<typeof STOP | { piiTokenMap: object|null, _assistantTokenisationInfo: object|null, _userPiiCategories: string[] }>}
 */
async function runInputPiiGate({ messages, docShield, notebookId, modelId, send, res }) {
    let piiTokenMap = null;
    // Privacy-panel parity with directChat: assembled once per turn, emitted
    // to the client (live) AND persisted on the assistant message (so the
    // "Privacy protection" panel survives a refresh). `_userPiiCategories`
    // backs the redacted badge on the user bubble; `_showRawPayload` gates
    // surfacing the exact tokenised prompt / token map (org opt-in).
    let _assistantTokenisationInfo = null;
    let _userPiiCategories = [];
    let _showRawPayload = false;
    try {
        const orgShield = docShield;
        const orgPiiEnabled = !!orgShield?.enabled;
        _showRawPayload = !!orgShield?.showRawPayload;
        // Hydrate the conversation-scoped token map (keyed on notebookId
        // here, matching the mergeTokenMap key below) before tokenisation
        // runs so turn 2+ reuses tokens minted on turn 1 instead of
        // leaking them to the LLM as literal text. Idempotent.
        if (notebookId) {
            try { await require('../../../core/dlp/dlpRunner').getConversationTokenMapAsync(notebookId); }
            catch (err) { bestEffort('routes/ai/notebookChat/inputGates:runInputPiiGate', err); /* hydration is best-effort */ }
        }
        if (orgPiiEnabled) {
            const { validateInputForPii } = require('../../../core/privacy/piiDetection');
            const _np = startPrivacyScanPhase(send, messageText(messages[messages.length - 1]));
            let piiResult;
            try {
                piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield, null, null, { onProgress: _np.onProgress });
            } finally {
                _np.end();
            }
            if (piiResult && piiResult.tokenizedText) {
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                try { require('../../../core/dlp/dlpRunner').mergeTokenMap(notebookId, piiResult.tokenMap); } catch (err) { bestEffort('routes/ai/notebookChat/inputGates:runInputPiiGate#2', err); /* non-fatal */ }
                log.warn(`[NotebookChat] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);

                // ── Surface the tokenisation to the client (parity w/ directChat) ──
                // Drives the user-bubble "redacted" badge + the assistant-side
                // "Privacy protection" panel. The exact tokenised prompt + the
                // real-value token map are only emitted when the org opted into
                // showRawPayload; the count/categories badge always shows.
                _userPiiCategories = [...new Set((piiResult.entities || []).map(e => e.label || e.category).filter(Boolean))];
                const _piiCount = Object.keys(piiTokenMap).length;
                send('pii_tokenized', {
                    entities: (piiResult.entities || []).map(e => ({ label: e.label, category: e.category })),
                    tokenCount: _piiCount,
                });
                _assistantTokenisationInfo = {
                    source: 'pii', action: 'redact', count: _piiCount,
                    categories: _userPiiCategories, provider: modelId || null, automatic: true,
                };
                if (_showRawPayload) {
                    send('privacy_payload', { tokenizedPrompt: piiResult.tokenizedText, provider: modelId || null, source: 'pii', timestamp: Date.now() });
                    _assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                    if (_piiCount > 0) {
                        send('privacy_token_map', { tokenMap: piiTokenMap, source: 'pii' });
                        _assistantTokenisationInfo.tokenMap = piiTokenMap;
                    }
                }
            }
        }
    } catch (piiError) {
        if (piiError?.message?.includes('PII Detected')) {
            send('error', { error: piiError.message, violationCodes: piiError.violationCodes });
            res.end();
            return STOP;
        }
        if (piiError?.privacyUnavailable) {
            // Fail_closed: detection degraded (guard down / model not ready) —
            // block instead of sending unmasked legal text to the LLM (BFSF-269).
            log.warn(`[NotebookChat] 🛑 Privacy protection unavailable (${piiError.degradedReason || 'degraded'}) — blocking (fail_closed)`);
            send('dlp_blocked', {
                reason: 'pii_unavailable',
                kind: piiError.privacyUnavailableKind || 'unavailable',
                message: piiError.message,
            });
            res.end();
            return STOP;
        }
        // Service unavailable → fail-open
    }
    return { piiTokenMap, _assistantTokenisationInfo, _userPiiCategories };
}

/**
 * Token-preservation prompt addendum.
 * Teach the model to treat tokens as opaque and reuse them verbatim so it
 * doesn't invent new placeholders or mangle `[person_1]`. Must run AFTER
 * the doc/KB/message tokenization above so the map already holds this
 * turn's tokens. Mirrors directChat.
 */
function addTokenPreservation(messages, notebookId) {
    try {
        if (messages[0]?.role === 'system' && typeof messages[0].content === 'string'
            && !messages[0].content.includes('[PII TOKEN PRESERVATION')) {
            const _add = buildTokenPreservationAddendum(dlpRunner.getConversationTokenMap(notebookId));
            if (_add) messages[0].content += _add;
        }
    } catch (err) { fallback('routes/ai/notebookChat/inputGates:addTokenPreservation', err); /* addendum is best-effort */ }
}

/**
 * Regex Guardrails (org Privacy Shield + input check).
 * @returns {{ regexConfig: any, stop?: true }}
 */
function runInputRegex({ orgShieldConfig, messages, message, send, res, userOrgForTiers, userId, notebookId }) {
    // Resolve org-wide regex rules; mirrors directChat.js:2348-2393
    let regexConfig = mergeWithOrgShield(orgShieldConfig, null); // no notebook-local overrides

    // Input regex check: block/redact before the model sees the message.
    // Match on the typed message, but redact the content the model will
    // receive: the PII gate above may have tokenised it, and without an
    // attachment image it also carries the attachment text. Redacting the
    // raw `message` put the real values back and dropped the attachments.
    const _rxLast = messages[messages.length - 1];
    const _rxTextPart = Array.isArray(_rxLast?.content) ? _rxLast.content.find(p => p.type === 'text') : null;
    const inputRx = applyRegexGuardrails({
        text: message,
        redactBase: typeof _rxLast?.content === 'string' ? _rxLast.content : (_rxTextPart ? _rxTextPart.text : message),
        regexConfig, scope: 'userInput', emit: send, direction: 'input',
        audit: { organization_id: userOrgForTiers || null, user_id: userId || null, conversation_id: notebookId || null, source: 'notebook' },
    });
    if (inputRx.action !== 'pass') {
        log.info(`[NotebookChat RegexGuard] User input violated rules: ${inputRx.ruleNames}, action: ${regexConfig.action}`);
    }
    if (inputRx.action === 'redact') {
        if (typeof _rxLast.content === 'string') {
            _rxLast.content = inputRx.processedText;
        } else if (_rxTextPart) {
            _rxTextPart.text = inputRx.processedText;
        }
    } else if (inputRx.action === 'block') {
        res.end();
        return { regexConfig, stop: true };
    }
    return { regexConfig };
}

module.exports = {
    appendHistory, appendUserMessage, stripUnicodeSmuggling, runInputPiiGate, addTokenPreservation, runInputRegex,
};

/**
 * Webpage chat: the messages of one turn (routes/ai/webpageChat.js). The
 * system prompt, the plan-approval authorisation, the history, and the user's
 * message with its attachments (PDF / Office through the unified extractor,
 * images when the model has vision), each extracted text scanned by the
 * Privacy Shield before it enters the prompt.
 */

'use strict';

const log = require('../../../telemetry/log');

/** Returned when an attachment was blocked: the error is sent, the turn ends. */
const STOP = Symbol('webpageChat.stop');

/**
 * `_dlpConvId` scopes the token map the scan merges into, so the response
 * un-tokeniser of the tool loop restores the same tokens.
 */
async function buildTurnMessages({
    send, systemPrompt, planExecution, history, attachments, message,
    modelSupportsVision, adapter, modelId, config, _psShield, _dlpConvId, _dlpActive,
}) {
    let messages = [{ role: 'system', content: systemPrompt }];

    // The Privacy Shield's attachment scan (see webpageChat.js): tokenise PII
    // or block per org policy before the text enters the prompt.
    const { scanAttachmentText: _scanAttText } = require('../../../core/dlp/attachmentScanner');
    const _scanExtracted = async (text, filename) => {
        if (!_dlpActive || !text) return text;
        const r = await _scanAttText({ text, filename, orgShield: _psShield, conversationId: _dlpConvId });
        if (r.action === 'block') { /** @type {Error & { filename?: string, summary?: unknown }} */ const e = new Error('attachment blocked'); e.code = 'ATTACHMENT_PII_BLOCKED'; e.filename = filename; e.summary = r.summary; throw e; }
        // Prefer whatever the scanner returned: on an incomplete scan that is
        // the TRUNCATED document, and falling back to `text` would put the
        // unchecked tail straight back into the prompt.
        return typeof r.text === 'string' ? r.text : text;
    };

    // Plan-execution turn: the user clicked Approve & build on a previously
    // proposed plan. Inject a system-style authorisation so the AI proceeds
    // straight to webpage_file_write / replace / patch without proposing
    // another plan (the propose_webpage_plan tool is also stripped from
    // the toolset in ./toolLoop.js when planExecution is set).
    if (planExecution && planExecution.action === 'execute' && planExecution.planId) {
        messages.push({
            role: 'system',
            content: `The user APPROVED your previously proposed plan (planId=${planExecution.planId}). Execute it now using webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`,
        });
    }

    if (history && Array.isArray(history)) {
        for (const msg of history) {
            if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }
    }

    if (attachments && attachments.length > 0) {
        // Use the unified extractor so PDFs / DOCX / spreadsheets get the
        // same pipeline as direct chat — previously this path was just
        // base64-decode-as-utf8-and-slice, which fed the model raw PDF
        // binary and made it claim it "can't read the file."
        const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../../../core/documents/attachmentExtractor');
        const { nativePdfPart, isShieldActive } = require('../../../core/documents/nativePdf');

        const contentParts = [];
        if (message) contentParts.push({ type: 'text', text: message });
        try {
        for (const att of attachments) {
            try {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    if (modelSupportsVision) {
                        // Image PII not scanned (deferred).
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else {
                        contentParts.push({ type: 'text', text: `[Attached image: ${att.name || 'image'} — current model has no vision; ask the user to switch to a vision-capable model to analyse it.]` });
                    }
                    continue;
                }
                if (!att.content || typeof att.content !== 'string') continue;

                const looksLikePdf = (att.type && att.type.includes('pdf')) || /\.pdf$/i.test(att.name || '');
                const looksLikeOfficeDoc = (att.type && (att.type.includes('wordprocessingml') || att.type.includes('spreadsheetml') || att.type.includes('ms-excel') || att.type === 'text/csv' || att.type === 'application/csv'))
                    || /\.(docx|xlsx|xls|csv)$/i.test(att.name || '');

                if (looksLikePdf || looksLikeOfficeDoc) {
                    const result = await extractAttachment(att, { modelSupportsVision });
                    log.info(`[WebpageChat] Attachment ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);
                    if (result.kind === 'text') {
                        const safe = await _scanExtracted(result.text, att.name);
                        const docText = `${formatTextHeader(att, result)}\n---\n${safe}\n---`;
                        const _wasTokenised = safe !== result.text;
                        contentParts.push({ type: 'text', text: docText });
                        // The original PDF alongside (Claude, OpenAI, Azure), never
                        // while the Privacy Shield is active: the raw bytes carry
                        // what the text scan never saw. Rule: core/documents/nativePdf.js.
                        if (looksLikePdf) {
                            const pdfPart = nativePdfPart({
                                adapter, modelId, providerType: config?.providerType,
                                shieldActive: isShieldActive(_psShield), tokenised: _wasTokenised,
                                base64Data: att.content.includes(',') ? att.content.split(',')[1] : att.content,
                                mediaType: att.type, filename: att.name, tag: 'WebpageChat',
                            });
                            if (pdfPart) contentParts.push(pdfPart);
                        }
                    } else if (result.kind === 'images') {
                        contentParts.push({ type: 'text', text: formatImagesHeader(att, result) });
                        for (const img of result.images) {
                            contentParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
                        }
                    } else {
                        contentParts.push({ type: 'text', text: formatFailureNote(att, result) });
                    }
                    continue;
                }

                // Plain text / unknown — best-effort UTF-8 inline.
                const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                if (textContent) {
                    const safe = await _scanExtracted(textContent.slice(0, 8000), att.name);
                    contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${safe}\n---` });
                }
            } catch (err) {
                if (err?.code === 'ATTACHMENT_PII_BLOCKED') throw err;
                log.warn(`[WebpageChat] Attachment processing failed for ${att?.name}: ${err.message}`);
                contentParts.push({ type: 'text', text: `[${att?.name || 'attachment'} — failed to read: ${err.message}]` });
            }
        }
        } catch (e) {
            if (e?.code === 'ATTACHMENT_PII_BLOCKED') {
                const cats = Object.keys(e.summary?.byCategory || {}).join(', ');
                send('error', { error: `Attachment "${e.filename}" was blocked by your organization's Privacy Shield${cats ? ` (contains ${cats})` : ''}.` });
                return STOP;
            }
            throw e;
        }
        const hasMultimodalBlocks = contentParts.some(p => p.type === 'image_url' || p.type === 'document');
        if (hasMultimodalBlocks) {
            messages.push({ role: 'user', content: contentParts });
        } else {
            const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
            if (combined.trim()) messages.push({ role: 'user', content: combined });
        }
    } else {
        messages.push({ role: 'user', content: message });
    }

    return messages;
}

module.exports = { buildTurnMessages, STOP };

/** @typedef {{ role: string, content: string | unknown[] | null, tool_calls?: unknown[], tool_call_id?: string }} TurnMessage */

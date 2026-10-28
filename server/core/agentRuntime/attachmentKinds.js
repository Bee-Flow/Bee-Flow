// @typecheck noImplicitAny
/**
 * One attachment of each kind put onto the user message, for
 * ./attachmentProcessor: PDFs (through the unified extractor), images
 * (preferably as a storage URL), plain text / Gmail, and every other document
 * through the parser. Extracted text passes the turn's scan gate
 * (./attachmentScanGate) first and is written onto the persisted sidecar.
 *
 * mistralOCR is still invoked, but via the unified attachmentExtractor helper
 * (see ../documents/attachmentExtractor.js) so PDF handling stays consistent
 * with direct chat. The extractor itself is handed in by ./attachmentProcessor
 * as `ctx.attachmentExtractor()` (lazy): it sits in the server's large import
 * cycle, which this module stays out of.
 */
const path = require('path');
const { randomUUID } = require('crypto');
const { persistExtractedText } = require('../documents/extractedTextStore');
const { safeTextOf } = require('./attachmentScanGate');
const log = require('../../telemetry/log');

/**
 * @typedef {{ name?: string, type?: string, content?: string, source?: string }} Attachment
 * @typedef {{ name?: string, type?: string, storageKey?: string | null, url: string | null, extractedText?: string, extractionKey?: string }} PersistedAttachment
 * @typedef {Map<Attachment, PersistedAttachment> | null} PersistedByLive
 * @typedef {{ type: string, text?: string, image_url?: { url: string, detail?: string } }} MessagePart
 * @typedef {{ content: MessagePart[] }} LastMsg
 * @typedef {{ kind: string, source?: string, text?: string, pages?: { pageNumber: number, text: string }[], images?: { mimeType: string, base64: string }[] }} ExtractedAttachment
 * @typedef {{
 *   modelSupportsVision?: boolean,
 *   maybeScan: import('./attachmentScanGate').MaybeScan,
 *   persistedByLive: PersistedByLive,
 *   userId: string | null,
 *   attachmentExtractor: () => typeof import('../documents/attachmentExtractor'),
 * }} AttachmentCtx
 */

// Writes the extracted text onto the matching persisted attachment sidecar
// so that historyHydrator can replay the file on future turns. Without this,
// XLSX/DOCX/CSV uploads only existed in the current turn's context and the
// model would lose access to them after ~4 messages once compaction kicked in.
/**
 * @param {Attachment} att
 * @param {string} fullText
 * @param {PersistedByLive} persistedByLive
 * @param {string} userId
 */
async function persistExtractionOntoSidecar(att, fullText, persistedByLive, userId) {
    if (!fullText || !persistedByLive) return;
    const record = persistedByLive.get(att);
    if (!record || record.extractedText) return; // idempotent: skip if already persisted
    try {
        const tiered = await persistExtractedText(fullText, userId, att.name);
        record.extractedText = tiered.extractedText;
        if (tiered.extractionKey) record.extractionKey = tiered.extractionKey;
    } catch (err) {
        log.warn(`[AttachmentProcessor] Failed to persist extracted text for ${log.nameForLog(att.name)}: ${/** @type {Error} */ (err).message}`);
    }
}

/**
 * Try to upload an image to RustFS and return a short-lived public URL.
 * This is far more efficient than embedding base64 in the prompt:
 *  - The URL string is ~200 chars vs 500–1000 KB of base64 text
 *  - The AI fetches the image directly; token cost is based on pixels, not string length
 *
 * Falls back silently to null if RustFS is unavailable.
 *
 * @param {string} base64DataUrl  Full data URL (data:image/png;base64,...)
 * @param {string} mimeType       e.g. 'image/png'
 * @param {string} userId         User ID for key namespacing
 * @param {string} [filename]     Original filename (used in the key)
 * @returns {Promise<string|null>} A short-lived HTTPS URL or null
 */
async function uploadImageForInference(base64DataUrl, mimeType, userId, filename = 'image.png') {
    try {
        const storageStore = require('../../stores/storageStore');
        if (!storageStore.isAvailable()) return null;

        // Strip data URL prefix
        const base64 = base64DataUrl.includes(',')
            ? base64DataUrl.split(',')[1]
            : base64DataUrl;
        const buffer = Buffer.from(base64, 'base64');

        // Build a unique key under attachments/
        const ext = path.extname(filename) || `.${mimeType.split('/')[1] || 'png'}`;
        const key = `users/${userId}/attachments/${randomUUID()}${ext}`;

        await storageStore.uploadFile(key, buffer, mimeType);

        // Generate a 15-minute HMAC-signed temp URL (served by our own proxy)
        const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
        const url = generateTempDownloadUrl(key, 900);
        log.info(`[AttachmentProcessor] Generated inference URL: ${url}`);
        log.info(`[AttachmentProcessor] SERVER_PUBLIC_HOST=${process.env.SERVER_PUBLIC_HOST || '(unset)'}, SERVER_PROTOCOL=${process.env.SERVER_PROTOCOL || '(unset)'}`);
        return url;
    } catch (err) {
        log.warn('[AttachmentProcessor] Could not upload image to RustFS:', /** @type {Error} */ (err).message);
        return null;
    }
}

/**
 * Append text to the message's first text block, or add one.
 * @param {string} text
 * @param {LastMsg} lastMsg
 */
function appendTextPart(lastMsg, text) {
    const textBlock = lastMsg.content.find((/** @type {{ type: string; }} */ c) => c.type === 'text');
    if (textBlock) textBlock.text += text;
    else lastMsg.content.push({ type: 'text', text });
}

/**
 * PDF — unified extractor, same pipeline as direct chat: pdfjs → Azure
 * Document Intelligence → Mistral OCR → vision fallback. Behaviour change
 * from the old agent path: Azure now fires here too.
 * @param {Attachment} att
 * @param {LastMsg} lastMsg
 * @param {AttachmentCtx} ctx
 */
async function appendPdf(att, lastMsg, { modelSupportsVision, maybeScan, persistedByLive, userId, attachmentExtractor }) {
    const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = attachmentExtractor();
    const result = /** @type {ExtractedAttachment} */ (await extractAttachment(/** @type {import('../documents/attachmentExtractor').Attachment} */ (att), { modelSupportsVision }));
    log.info(`[AttachmentProcessor] PDF ${log.nameForLog(att.name)} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);

    const textBlock = lastMsg.content.find((/** @type {{ type: string; }} */ c) => c.type === 'text');
    if (result.kind === 'text') {
        // Privacy Shield: scan extracted PDF text before it touches the
        // model. On `block`, the thrown AttachmentPrivacyBlock bubbles
        // up to chatStream which emits a `dlp_blocked` SSE event and
        // aborts the turn — matching the message-block UX.
        const scanned = await maybeScan({ text: result.text, pages: result.pages, filename: att.name });
        const safeText = safeTextOf(scanned, result.text);
        const appendText = `\n\n${formatTextHeader(att, result)}\n---\n${safeText}\n---\n`;
        if (textBlock) textBlock.text += appendText;
        else lastMsg.content.push({ type: 'text', text: appendText });
        await persistExtractionOntoSidecar(att, safeText, persistedByLive, userId);
    } else if (result.kind === 'images') {
        // Vision fallback: a header note followed by the page images.
        const note = `\n\n${formatImagesHeader(att, result)}\n`;
        if (textBlock) textBlock.text += note;
        else lastMsg.content.push({ type: 'text', text: note });
        for (const img of result.images) {
            lastMsg.content.push({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' },
            });
        }
    } else {
        const fallbackText = `\n\n${formatFailureNote(att, result)}\n`;
        if (textBlock) textBlock.text += fallbackText;
        else lastMsg.content.push({ type: 'text', text: fallbackText });
    }
}

/**
 * Image — prefer a RustFS URL over inline base64: it keeps the persisted
 * message small. The model never fetches it: the provider adapter swaps our
 * storage URLs back for bytes at send-time (core/imageInline.js), because
 * Anthropic's fetcher honours our robots.txt and self-hosted origins aren't
 * reachable at all.
 * @param {Attachment} att
 * @param {LastMsg} lastMsg
 * @param {AttachmentCtx} ctx
 */
async function appendImage(att, lastMsg, { userId }) {
    const sizeKB = Math.round((att.content?.length || 0) / 1024);
    log.info(`[AttachmentProcessor] Processing image ${log.nameForLog(att.name)} (${sizeKB} KB base64)`);

    /** @type {string | null} */
    let imageUrl = null;
    if (userId) {
        imageUrl = await uploadImageForInference(att.content, att.type, userId, att.name);
        if (imageUrl) {
            log.info(`[AttachmentProcessor] Image uploaded to RustFS → using URL for inference (${log.nameForLog(att.name)})`);
        }
    }

    lastMsg.content.push({
        type: 'image_url',
        image_url: {
            url: imageUrl || att.content,  // URL preferred; base64 as fallback
            detail: 'auto',                 // Let the model choose low/high based on task
        },
    });

    if (!imageUrl) {
        log.info(`[AttachmentProcessor] RustFS unavailable — using base64 for ${log.nameForLog(att.name)}`);
    }
}

/**
 * Gmail email / plain-text attachment — content is already text. Inline it
 * directly instead of base64-decoding the plaintext into garbage in the
 * generic document branch (BFSF-87).
 * @param {Attachment} att
 * @param {LastMsg} lastMsg
 * @param {AttachmentCtx} ctx
 */
async function appendInlineText(att, lastMsg, { maybeScan, persistedByLive, userId }) {
    const scanned = await maybeScan({ text: att.content, pages: undefined, filename: att.name });
    const safeText = safeTextOf(scanned, att.content);
    appendTextPart(lastMsg, `\n\n[${att.source === 'gmail' ? 'Gmail' : 'Attachment'}: ${att.name}]\n---\n${safeText}\n---\n`);
    await persistExtractionOntoSidecar(att, safeText, persistedByLive, userId);
}

/**
 * Every other document (docx/xlsx/pptx/csv, …) through the parser. A parse
 * failure is logged and the file skipped; a privacy block still throws.
 * @param {Attachment} att
 * @param {LastMsg} lastMsg
 * @param {AttachmentCtx} ctx
 */
async function appendParsedDocument(att, lastMsg, { maybeScan, persistedByLive, userId }) {
    try {
        // core/documentParser — NOT './documentParser'. The relative
        // path was wrong, so this require threw MODULE_NOT_FOUND on
        // every generic document attachment and the catch below
        // swallowed it: docx/xlsx/pptx/csv uploads were silently
        // dropped from the model's context (same failure shape as
        // BFSF-127 in routes/ai/directChat.js).
        const { parseDocument } = require('../documents/documentParser');
        // att.content is a data URL like "data:<mime>;base64,XXX". If
        // upstream sent only the raw base64 (no comma) treat the whole
        // value as the payload rather than crashing on undefined.
        const base64Data = att.content && att.content.includes(',')
            ? att.content.split(',')[1]
            : att.content;
        if (!base64Data) {
            log.warn(`[AttachmentProcessor] Skipping ${log.nameForLog(att.name)}: no content payload`);
            return;
        }
        // Reject oversized base64 before we allocate the buffer. 50 MB raw
        // file → ~67 MB base64; cap there to avoid memory blow-up from a
        // malicious or buggy uploader.
        const MAX_BASE64_LEN = 80 * 1024 * 1024;
        if (typeof base64Data === 'string' && base64Data.length > MAX_BASE64_LEN) {
            log.warn(`[AttachmentProcessor] Skipping ${log.nameForLog(att.name)}: base64 payload too large (${base64Data.length} chars)`);
            appendTextPart(lastMsg, `\n\n[Attachment: ${att.name} — skipped, payload exceeded ${MAX_BASE64_LEN} chars]\n`);
            return;
        }
        const buffer = Buffer.from(base64Data, 'base64');
        const text = await parseDocument(buffer, att.type, att.name);

        const scanned = await maybeScan({ text, pages: undefined, filename: att.name });
        const safeText = safeTextOf(scanned, text);
        appendTextPart(lastMsg, `\n\n[Attachment: ${att.name}]\n---\n${safeText}\n---\n`);
        await persistExtractionOntoSidecar(att, safeText, persistedByLive, userId);
    } catch (e) {
        if (e && e.code === 'ATTACHMENT_PII_BLOCKED') throw e;
        log.error(`[AttachmentProcessor] Failed to parse document ${log.nameForLog(att.name)}`, e);
    }
}

module.exports = { uploadImageForInference, appendPdf, appendImage, appendInlineText, appendParsedDocument };

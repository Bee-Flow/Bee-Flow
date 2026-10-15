/**
 * Direct Chat: per-format attachment handlers for the streaming turn (image,
 * Google Drive, PDF, DOCX/PPTX, spreadsheet, Gmail, plain text, generic file).
 * Each handler appends the prompt parts for one attachment to `contentParts`
 * and records its persistent sidecar through `pushAttachment`. Split out of
 * attachmentIntake.js; behaviour unchanged.
 *
 * Shared context `ctx`: { userId, adapter, modelId, config, shield,
 * contentParts, persistedAttachments, pushAttachment, scan, summaries, req, send, documentScope }.
 */

const crypto = require('crypto');
const configStore = require('../../../stores/configStore');
const log = require('../../../telemetry/log');
const { importUploadedSpreadsheet, isSpreadsheetUpload } = require('./spreadsheetImportIntake');

const IMAGE_FALLBACK_MAX_BASE64 = 300 * 1024;

const base64Of = (content) => content.split(',')[1] || content;
const safeName = (name) => name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
const uniquePrefix = () => `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

/**
 * Upload an original to RustFS for persistence. Returns the proxy URL, or
 * null when storage is unavailable or the upload failed (logged, non-fatal).
 * `filename` and `buffer` are thunks, evaluated only when storage is there.
 */
async function uploadOriginal({ userId, filename, buffer, contentType, label }) {
    const storageStore = require('../../../stores/storageStore');
    try {
        if (storageStore.isAvailable()) {
            const key = storageStore.buildKey(userId, 'uploads', filename());
            await storageStore.uploadFile(key, buffer(), contentType);
            const url = storageStore.buildProxyUrl(key);
            log.info(`[DirectChat] Uploaded ${label} to RustFS: ${key}`);
            return { key, url };
        }
    } catch (e) {
        log.warn(`[DirectChat] Failed to upload ${label} to RustFS: ${e.message}`);
    }
    return null;
}

/**
 * Text of an office document or spreadsheet: Azure Document Intelligence
 * first when enabled (Markdown with tables/headings), then the local parser.
 */
async function extractOfficeText(buffer, mime, name, kindLabel) {
    let text = '';
    const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (useAzureDoc) {
        try {
            const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../../core/documents/azureDocIntelligence');
            if (await isAzureDocIntelligenceConfigured()) {
                text = await extractWithAzure(buffer, name);
                if (text) {
                    log.info(`[DirectChat] ${kindLabel.extracted} extracted via Azure Document Intelligence: ${name} (${text.length} chars)`);
                }
            }
        } catch (azureErr) {
            log.warn(`[DirectChat] Azure Document Intelligence failed for ${kindLabel.failed} ${name}:`, azureErr.message);
        }
    }
    if (!text) {
        const { parseDocument } = require('../../../core/documents/documentParser');
        text = await parseDocument(buffer, mime, name);
    }
    return text;
}

async function handleImage(att, ctx) {
    const { userId, adapter, modelId, contentParts, persistedAttachments } = ctx;
    // Upload image to RustFS for persistence + inference URL
    let imageProxyUrl = null;
    let inferenceUrl = null;
    const ext = att.type.includes('jpeg') || att.type.includes('jpg') ? 'jpg' : 'png';
    const stored = await uploadOriginal({
        userId, filename: () => `${uniquePrefix()}.${ext}`,
        buffer: () => Buffer.from(base64Of(att.content), 'base64'), contentType: att.type, label: 'image',
    });
    if (stored) {
        imageProxyUrl = stored.url;
        persistedAttachments.push({ name: att.name, type: att.type, storageKey: stored.key, url: imageProxyUrl });
        try {
            // Temp URL for AI inference: keeps the persisted turn small (~200
            // chars vs 500-1000 KB base64). The provider adapter turns it back
            // into bytes at send-time; see core/imageInline.js for why no
            // provider may fetch it.
            const { generateTempDownloadUrl } = require('../../../utils/tempDownloadUrl');
            inferenceUrl = generateTempDownloadUrl(stored.key, 900);
            log.info(`[DirectChat] Image uploaded to RustFS → using URL for inference (${att.name})`);
        } catch (e) {
            log.warn(`[DirectChat] Failed to upload image to RustFS: ${e.message}`);
        }
    }
    if (!imageProxyUrl) {
        // Storage down/unconfigured: without a sidecar the image vanishes from
        // history entirely on the next turn. Persist capped base64 instead: the
        // historyHydrator lazily uploads `content` to RustFS once storage is back.
        if (typeof att.content === 'string' && att.content.length <= IMAGE_FALLBACK_MAX_BASE64) {
            persistedAttachments.push({ name: att.name, type: att.type, content: att.content });
        } else {
            log.warn(`[DirectChat] Storage unavailable and image too large to inline-persist (${att.name || 'unnamed'})`);
        }
    }
    // Send as image data only if the current model supports vision
    if (adapter.supportsVision(modelId)) {
        const imageDataUrl = inferenceUrl || att.content;
        contentParts.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } });
        if (!inferenceUrl) {
            log.info(`[DirectChat] RustFS unavailable — using base64 for ${att.name || 'unnamed'}`);
        }
    } else {
        // Non-vision model: add a descriptive text note instead of a broken image reference
        contentParts.push({ type: 'text', text: `[Attached image: ${att.name || 'image'} — this model does not support vision. To analyze this image, switch to a vision-capable model such as GPT-4o, Claude 3, Gemini, or Pixtral.]` });
        log.info(`[DirectChat] Model ${modelId} doesn't support vision — converted image to text note`);
    }
}

/** Text already extracted on the client (Drive export, Gmail body, text/*). */
async function handleInlineText(att, ctx, { header, footer, type }) {
    const safe = await ctx.scan(att.content, undefined, att.name);
    const text = `${header}\n${safe}\n${footer}`;
    ctx.contentParts.push({ type: 'text', text });
    await ctx.pushAttachment({ name: att.name, type }, text);
}

async function handlePdf(att, ctx) {
    const { userId, adapter, modelId, config, shield, contentParts, pushAttachment, scan, summaries } = ctx;
    // PDF, unified pipeline (server/core/attachmentExtractor.js):
    //   pdfjs → Azure Document Intelligence → Mistral OCR → vision fallback.
    // The helper handles the density heuristic and vision-capable fallback.
    try {
        const base64Data = base64Of(att.content);
        const pdfBuffer = Buffer.from(base64Data, 'base64');
        const stored = await uploadOriginal({
            userId, filename: () => `${uniquePrefix()}_${safeName(att.name)}`, buffer: () => pdfBuffer, contentType: att.type, label: 'PDF',
        });
        const pdfProxyUrl = stored ? stored.url : null;

        const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../../../core/documents/attachmentExtractor');
        const { nativePdfPart, isShieldActive } = require('../../../core/documents/nativePdf');
        const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision(modelId) });
        log.info(`[DirectChat] PDF ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);

        if (result.kind === 'text') {
            // Privacy Shield: tokenise / block before the text is inlined into
            // the prompt. Throws AttachmentPrivacyBlock on block-action; the
            // intake surfaces that as a dlp_blocked SSE event.
            const scanResultsBefore = summaries.length;
            const safeText = await scan(result.text, result.pages, att.name);
            const wasTokenised = summaries.length > scanResultsBefore;
            const docText = `${formatTextHeader(att, result)}\n---\n${safeText}\n---`;
            // Always inline the extracted text. Some invoice PDFs embed fonts
            // with no usable ToUnicode CMap, and a native PDF parser hits the
            // same dead end pdfjs does; the OCR'd / pdfjs text alongside the
            // document block gives the model a guaranteed-readable channel.
            contentParts.push({ type: 'text', text: docText });
            // Also the original PDF (Claude, OpenAI, Azure) so the model sees
            // logos, signatures and layout. Never while the Privacy Shield is
            // active: the raw bytes carry what the text scan never saw. Rule
            // and size cap: core/documents/nativePdf.js. Current turn only,
            // the persisted sidecar holds the text + URL.
            const pdfPart = nativePdfPart({
                adapter, modelId, providerType: config?.providerType,
                shieldActive: isShieldActive(shield), tokenised: wasTokenised,
                base64Data, mediaType: att.type, filename: att.name, tag: 'DirectChat',
            });
            if (pdfPart) contentParts.push(pdfPart);
            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, docText);
        } else if (result.kind === 'images') {
            // Vision fallback: inline a header note, then the page images.
            const visionHeader = formatImagesHeader(att, result);
            contentParts.push({ type: 'text', text: visionHeader });
            for (const img of result.images) {
                contentParts.push({
                    type: 'image_url',
                    image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' },
                });
            }
            // Persist the header so replays know which file was visually
            // analysed; the rendered pages are not re-uploaded (expensive, and
            // mostly recoverable via the original PDF URL).
            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, visionHeader);
        } else {
            const failureNote = formatFailureNote(att, result);
            contentParts.push({ type: 'text', text: failureNote });
            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, failureNote);
        }
    } catch (e) {
        log.error(`[DirectChat] PDF processing failed for ${att.name}:`, e.message);
        contentParts.push({ type: 'text', text: `[PDF: ${att.name} — failed to process: ${e.message}]` });
    }
}

const isOfficeDoc = (att) => att.type?.includes('wordprocessingml') || att.name?.toLowerCase().endsWith('.docx') ||
    att.type?.includes('presentationml') || att.name?.toLowerCase().endsWith('.pptx');

async function handleOffice(att, ctx) {
    const { userId, contentParts, pushAttachment, scan } = ctx;
    // DOCX / PPTX: Azure Document Intelligence (when enabled), then mammoth /
    // pptxExtractor. One branch for both: the pipeline is identical, only the
    // parser and the label differ.
    const isDeck = att.type?.includes('presentationml') || att.name?.toLowerCase().endsWith('.pptx');
    const officeMime = isDeck
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const officeLabel = isDeck ? 'Presentation' : 'Word Document';
    try {
        const docxBuffer = Buffer.from(base64Of(att.content), 'base64');
        const docxText = await extractOfficeText(docxBuffer, officeMime, att.name, { extracted: 'DOCX', failed: 'DOCX' });
        const stored = await uploadOriginal({
            userId, filename: () => `${uniquePrefix()}_${safeName(att.name)}`, buffer: () => docxBuffer, contentType: att.type || officeMime, label: 'DOCX',
        });
        const docxProxyUrl = stored ? stored.url : null;

        if (docxText && !docxText.startsWith('[Document:') && !docxText.startsWith('[Presentation:')) {
            const safeDocxText = await scan(docxText, undefined, att.name);
            const docText = `[${officeLabel}: ${att.name}]\n---\n${safeDocxText}\n---`;
            contentParts.push({ type: 'text', text: docText });
            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, docText);
            log.info(`[DirectChat] Extracted ${docxText.length} chars from DOCX: ${att.name}`);
        } else {
            // extraction returned empty/error: fall back to container
            const note = `[${officeLabel}: ${att.name} — no extractable text, may contain only images]`;
            contentParts.push({ type: 'text', text: note });
            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, note);
        }
    } catch (e) {
        log.error(`[DirectChat] ${isDeck ? 'PPTX' : 'DOCX'} processing failed for ${att.name}:`, e.message);
        contentParts.push({ type: 'text', text: `[${isDeck ? 'PPTX' : 'DOCX'}: ${att.name} — failed to process: ${e.message}]` });
    }
}

async function handleSpreadsheet(att, ctx) {
    const { req, send, userId, contentParts, pushAttachment, scan, documentScope } = ctx;
    // Spreadsheet: Azure Document Intelligence (when enabled), then the XLSX library
    try {
        const spreadsheetBuffer = Buffer.from(base64Of(att.content), 'base64');
        const mime = att.type || 'application/octet-stream';
        const sheetText = await extractOfficeText(spreadsheetBuffer, mime, att.name, { extracted: 'Spreadsheet', failed: 'spreadsheet' });
        const stored = await uploadOriginal({
            userId, filename: () => `${uniquePrefix()}_${safeName(att.name)}`, buffer: () => spreadsheetBuffer, contentType: mime, label: 'spreadsheet',
        });
        const sheetProxyUrl = stored ? stored.url : null;

        // Also open it as a spreadsheet document next to the chat (when the person has them)
        const { base: importedBase, note: importedNote } = await importUploadedSpreadsheet({ req, send, userId, buffer: spreadsheetBuffer, att, documentScope });

        if (sheetText && !sheetText.startsWith('[Spreadsheet:')) {
            const safeSheetText = await scan(sheetText, undefined, att.name);
            const docText = `[Spreadsheet: ${att.name}]\n---\n${safeSheetText}\n---${importedNote}`;
            contentParts.push({ type: 'text', text: docText });
            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl, ...importedBase }, docText);
            log.info(`[DirectChat] Extracted ${sheetText.length} chars from spreadsheet: ${att.name}`);
        } else {
            const note = (sheetText || `[Spreadsheet: ${att.name} — no data found]`) + importedNote;
            contentParts.push({ type: 'text', text: note });
            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl, ...importedBase }, note);
        }
    } catch (e) {
        log.error(`[DirectChat] Spreadsheet processing failed for ${att.name}:`, e.message);
        contentParts.push({ type: 'text', text: `[Spreadsheet: ${att.name} — failed to process: ${e.message}]` });
    }
}

async function handleGenericFile(att, ctx) {
    // Generic file: upload to RustFS for persistent access
    const buffer = Buffer.from(base64Of(att.content), 'base64');
    const filename = safeName(att.name);
    const stored = await uploadOriginal({
        userId: ctx.userId, filename: () => `${uniquePrefix()}_${filename}`,
        buffer: () => buffer, contentType: att.type || 'application/octet-stream', label: 'file',
    });
    const fileProxyUrl = stored ? stored.url : null;
    const note = `[Attached file: ${filename}] This file has been uploaded${fileProxyUrl ? ' and stored' : ''}.${att.type ? ' Type: ' + att.type : ''}`;
    ctx.contentParts.push({ type: 'text', text: note });
    await ctx.pushAttachment({ name: att.name, type: att.type, url: fileProxyUrl }, note);
}

/** Route one attachment to its format handler (first match wins). */
async function processAttachment(att, ctx) {
    if (att.type && att.type.startsWith('image/') && att.content) return handleImage(att, ctx);
    if (att.source === 'google-drive' && att.content) {
        // Google Drive file: already exported as plain text, inject directly
        return handleInlineText(att, ctx, { header: `--- Google Drive: ${att.name} ---`, footer: `--- End of ${att.name} ---`, type: 'google-drive' });
    }
    if (att.content && att.type && att.type.includes('pdf')) return handlePdf(att, ctx);
    if (att.content && isOfficeDoc(att)) return handleOffice(att, ctx);
    if (att.content && isSpreadsheetUpload(att)) return handleSpreadsheet(att, ctx);
    if (att.source === 'gmail' && att.content) {
        // Gmail email: GmailPicker sends the body as plain text (type
        // 'text/plain'). Inject it directly like Google Drive does; otherwise it
        // fell into the generic branch, which base64-decoded the plaintext into
        // garbage and the model never saw the email (BFSF-87).
        return handleInlineText(att, ctx, { header: `--- Gmail: ${att.name} ---`, footer: `--- End of ${att.name} ---`, type: 'gmail' });
    }
    if (att.content && att.type && att.type.startsWith('text/') && !String(att.content).startsWith('data:')) {
        // Other plain-text attachments (text/plain, text/markdown...): inline
        // as text instead of base64-decoding into garbage (BFSF-87).
        return handleInlineText(att, ctx, { header: `--- ${att.name} ---`, footer: `--- End of ${att.name} ---`, type: att.type });
    }
    if (att.content) return handleGenericFile(att, ctx);
    return undefined;
}

module.exports = { processAttachment };

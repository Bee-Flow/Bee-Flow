/**
 * Direct Chat — attachment intake for the streaming turn: eager conversation
 * creation (the scanner needs a real convId for its token-map merge), per-
 * format extraction (image/PDF/DOCX/spreadsheet/Drive/Gmail/text/generic),
 * the Privacy Shield attachment scan with its block/tokenize/pass handling,
 * audit + SSE surfacing, the prompt-cache breakpoint on the last attachment
 * block, and the final user-message push. Moved verbatim out of streamTurn.js.
 *
 * Returns { convId, persistedAttachments, _turnAttachmentSummaries } — or
 * undefined when the Privacy Shield BLOCKED an attachment, in which case the
 * SSE stream has already been ended and the caller must stop the turn.
 */

const agentStore = require('../../../stores/agentStore');
const configStore = require('../../../stores/configStore');
const { emitPhase, emitPhaseEnd } = require('../../../core/agentRuntime/phaseEvents');
require('./shared');
const log = require('../../../telemetry/log');

async function processAttachmentsAndUserMessage({ req, res, send, userId, convId, conversationId, modelTier, message, attachments, adapter, modelId, config, messages }) {
        // ─── Eagerly create conversation BEFORE the attachment scan ──
        // Two reasons:
        //   1) workspace_* tools later in the turn need a valid DB row.
        //   2) the attachment scanner calls
        //      `dlpRunner.mergeTokenMap(convId, tokenMap)` — if convId is
        //      null at scan time the merge is a no-op and Claude's
        //      `[person_N]` echoes leak through to the rendered response.
        // Moved up so the scanner gets a real convId. Side effect: a
        // brand-new conversation row appears slightly earlier in the turn;
        // orphan-row risk is unchanged because the original location had
        // the same exposure.
        if (!convId) {
            // Persist the user's pick (e.g. "auto"), not the classifier's
            // resolution. On reload the UI restores `selectedTier` from this
            // value; storing "fast" here would turn Auto into Fast after refresh.
            const newConv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
            convId = newConv.id;
            send('conversation_created', { conversationId: convId });
            log.info(`[DirectChat] Eagerly created conversation ${convId} for workspace/tool access`);
        }

        // Add current message (with attachments if any)
        const persistedAttachments = []; // Track attachments for conversation persistence
        // Per-turn attachment scan summaries — route-scoped so they survive
        // the `messages = compactionResult.messages` reassignment that
        // happens later in the route. The previous version stashed these
        // on the messages array and lost them at compaction time, which
        // also broke the on-reload privacy panel.
        let _turnAttachmentSummaries = null;
        if (attachments && attachments.length > 0) {
            // Surface attachment processing as a phase so the user sees
            // "Reading attachment <filename>…" while OCR / PDF extraction
            // runs (often the slowest step before the first token).
            const _attDetail = attachments.length === 1 && attachments[0]?.name
                ? attachments[0].name
                : `${attachments.length} files`;
            emitPhase(send, 'processing_attachments', _attDetail);
        }
        const _attT = (attachments && attachments.length > 0) ? Date.now() : null;
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            const storageStore = require('../../../stores/storageStore');
            const crypto = require('crypto');
            const { persistExtractedText } = require('../../../core/documents/extractedTextStore');

            // Resolve Privacy Shield once for the whole attachment loop so we
            // can scan each extracted document for PII before it enters the
            // model prompt. Mirrors the agent-chat path (attachmentProcessor.js).
            // `userOrgId` is declared further down in this function scope
            // (≈ line 1749) under `const`, which puts a temporal dead zone on
            // the whole scope — we can't reference it here. Resolve the
            // user's org locally instead.
            const { resolveUserOrgIds: _resolveUserOrgIdsForAtt } = require('../../../auth');
            const _attUserOrgIds = await _resolveUserOrgIdsForAtt(req).catch(() => null);
            const _attUserOrgId = (_attUserOrgIds && _attUserOrgIds.size > 0) ? Array.from(_attUserOrgIds)[0] : null;
            const { resolveShieldFor: _resolvePsForAttachments } = require('../../../core/privacy/orgShield');
            let _psShield = await _resolvePsForAttachments({ orgId: _attUserOrgId, userId: req.session?.user?.id });
            // Super-admin edge case (mirrors the input-gate fallback further
            // below): the seed admin account has no organizationId binding
            // and the attachment scanner would otherwise silently no-op for
            // them, so PDF/DOCX uploads leak unredacted to the model. Fall
            // back to the sole org shield when exactly one exists.
            if (!_psShield?.enabled && req.session?.isAdmin) {
                try {
                    const allCfg = await configStore.getAllConfig() || {};
                    const shieldKeys = Object.keys(allCfg).filter(k => k.startsWith('org_privacy_shield_'));
                    if (shieldKeys.length === 1 && allCfg[shieldKeys[0]]?.enabled) {
                        _psShield = allCfg[shieldKeys[0]];
                        log.info(`[DirectChat] Attachment scanner: super-admin fallback → sole org shield ${shieldKeys[0]}`);
                    }
                } catch (_) { /* non-fatal */ }
            }
            const { scanAttachmentText: _scanAttText, AttachmentPrivacyBlock: _AttPiiBlock } = require('../../../core/dlp/attachmentScanner');
            const { resolveAttachmentAsk: _resolveAttachmentAsk } = require('../../../core/dlp/attachmentAskFlow');
            const { classifyProvider: _classifyProvider } = require('../../../core/providers/classification');
            const _attProvider = _classifyProvider(config || {}, _psShield?.dlpAllowlistedHosts || []);
            const _attachmentScanSummaries = [];
            // Local helper so the per-format branches below don't repeat the
            // tokenise/block/pass switch. Returns the text to inline (possibly
            // tokenised) or throws AttachmentPrivacyBlock for the route to catch.
            // The eager-create-conversation block above guarantees `convId`
            // is non-null here, so the scanner's internal
            // `dlpRunner.mergeTokenMap(convId, tokenMap)` call lands in
            // the correct conversation map. No need to accumulate maps
            // locally or merge them later.
            const _scanExtracted = async (text, pages, filename) => {
                if (!_psShield || !text) return text;
                let r = await _scanAttText({ text, pages, filename, orgShield: _psShield, conversationId: convId, allowAsk: true });
                if (r.action === 'ask') {
                    // Pauses the turn until the person answers (one pause per
                    // attachment needing one — see attachmentAskFlow.js).
                    r = await _resolveAttachmentAsk({
                        text: r.text, findings: r.findings, filename, provider: _attProvider,
                        orgShield: _psShield, conversationId: convId, userId, emit: send,
                    });
                }
                if (r.action === 'block') throw new _AttPiiBlock({ filename, summary: r.summary, findings: r.findings, reason: r.reason });
                if (r.action === 'tokenize') {
                    _attachmentScanSummaries.push({
                        filename,
                        action: 'tokenize',
                        // DISTINCT values, matching the token-mapping rows — not
                        // r.findings.length (occurrences). Every text path already
                        // reports Object.keys(tokenMap).length, and the client sums
                        // the two into one badge, so mixing units produced
                        // `spans + unique_values`.
                        count: r.summary.count,
                        mentions: r.summary.mentions,
                        byCategory: r.summary.byCategory,
                        pages: r.summary.pages,
                        overflow: !!r.summary.overflow,
                        timeout: !!r.summary.timeout,
                        reason: r.summary.reason || null,
                        scannedPages: r.summary.scannedPages,
                        totalPages: r.summary.totalPages,
                        truncated: !!r.summary.truncated,
                        sentChars: r.summary.sentChars,
                        totalChars: r.summary.totalChars,
                    });
                    return r.text;
                }
                if (r.action === 'pass' && r.findings?.length > 0) {
                    // Found something but sent it unredacted anyway (ask flow
                    // "send anyway", or a remembered "allow"). Never silent.
                    _attachmentScanSummaries.push({
                        filename,
                        action: 'allowed',
                        count: r.summary.count || 0,
                        mentions: r.summary.mentions || 0,
                        byCategory: r.summary.byCategory || {},
                        pages: r.summary.pages || {},
                        overflow: !!r.summary.overflow,
                        timeout: !!r.summary.timeout,
                        reason: r.summary.reason || null,
                        scannedPages: r.summary.scannedPages,
                        totalPages: r.summary.totalPages,
                        truncated: !!r.summary.truncated,
                        sentChars: r.summary.sentChars,
                        totalChars: r.summary.totalChars,
                    });
                    return r.text;
                }
                if (r.summary && r.summary.reason) {
                    // Incomplete scan, nothing found in the scanned prefix: the
                    // checked part travels, the rest was cut. Surface it (amber
                    // warning + audit), never silently.
                    _attachmentScanSummaries.push({
                        filename,
                        action: 'pass',
                        count: 0,
                        mentions: 0,
                        byCategory: {},
                        pages: {},
                        overflow: !!r.summary.overflow,
                        timeout: !!r.summary.timeout,
                        reason: r.summary.reason,
                        scannedPages: r.summary.scannedPages,
                        totalPages: r.summary.totalPages,
                        truncated: !!r.summary.truncated,
                        sentChars: r.summary.sentChars,
                        totalChars: r.summary.totalChars,
                    });
                    // r.text is the truncated document on this path — returning
                    // the original would put the unchecked tail straight back in.
                    return r.text;
                }
                return text;
            };

            // Sidecar carries the persistent representation of an attachment.
            // Big extractions are tiered to RustFS via persistExtractedText so
            // meta_json doesn't grow unbounded, while the head+tail snippet
            // stays inline for replay.
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

            try {
            for (const att of attachments) {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    // Upload image to RustFS for persistence + inference URL
                    let imageProxyUrl = null;
                    let inferenceUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const ext = att.type.includes('jpeg') || att.type.includes('jpg') ? 'jpg' : 'png';
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            imageProxyUrl = storageStore.buildProxyUrl(key);
                            log.info(`[DirectChat] Uploaded image to RustFS: ${key}`);
                            persistedAttachments.push({ name: att.name, type: att.type, storageKey: key, url: imageProxyUrl });

                            // Temp URL for AI inference — keeps the persisted turn
                            // small (~200 chars vs 500-1000 KB base64). The provider
                            // adapter turns it back into bytes at send-time; see
                            // core/imageInline.js for why no provider may fetch it.
                            const { generateTempDownloadUrl } = require('../../../utils/tempDownloadUrl');
                            inferenceUrl = generateTempDownloadUrl(key, 900);
                            log.info(`[DirectChat] Image uploaded to RustFS → using URL for inference (${att.name})`);
                        }
                    } catch (e) {
                        log.warn(`[DirectChat] Failed to upload image to RustFS: ${e.message}`);
                    }
                    if (!imageProxyUrl) {
                        // Storage down/unconfigured — without a sidecar the image
                        // vanishes from history entirely on the next turn. Persist
                        // capped base64 instead: the historyHydrator lazily uploads
                        // `content` to RustFS once storage is back.
                        const IMAGE_FALLBACK_MAX_BASE64 = 300 * 1024;
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

                } else if (att.source === 'google-drive' && att.content) {
                    // Google Drive file — already exported as plain text, inject directly
                    const safeDrive = await _scanExtracted(att.content, undefined, att.name);
                    const driveText = `--- Google Drive: ${att.name} ---\n${safeDrive}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: driveText });
                    await pushAttachment({ name: att.name, type: 'google-drive' }, driveText);
                } else if (att.content && att.type && att.type.includes('pdf')) {
                    // PDF — unified pipeline (server/core/attachmentExtractor.js):
                    //   pdfjs → Azure Document Intelligence → Mistral OCR → vision fallback.
                    // The helper handles the density heuristic and vision-capable fallback.
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const pdfBuffer = Buffer.from(base64Data, 'base64');

                        // Upload original PDF to RustFS for persistence (unchanged).
                        let pdfProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, pdfBuffer, att.type);
                                pdfProxyUrl = storageStore.buildProxyUrl(key);
                                log.info(`[DirectChat] Uploaded PDF to RustFS: ${key}`);
                            }
                        } catch (e) {
                            log.warn(`[DirectChat] Failed to upload PDF to RustFS: ${e.message}`);
                        }

                        const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../../../core/documents/attachmentExtractor');
                        const { nativePdfPart, isShieldActive } = require('../../../core/documents/nativePdf');
                        const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision(modelId) });
                        log.info(`[DirectChat] PDF ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);

                        if (result.kind === 'text') {
                            // Privacy Shield: tokenise / block before the text
                            // is inlined into the prompt. Throws AttachmentPrivacyBlock
                            // on block-action; the outer try/catch surfaces that
                            // as a dlp_blocked SSE event.
                            const _scanResultsBefore = _attachmentScanSummaries.length;
                            const safeText = await _scanExtracted(result.text, result.pages, att.name);
                            const _wasTokenised = _attachmentScanSummaries.length > _scanResultsBefore;
                            const docText = `${formatTextHeader(att, result)}\n---\n${safeText}\n---`;
                            // Always inline the extracted text. Some invoice PDFs
                            // embed fonts with no usable ToUnicode CMap, and a
                            // native PDF parser hits the same dead end pdfjs
                            // does — the model then reports back "I see raw
                            // font tables, not text". Shipping the OCR'd /
                            // pdfjs text alongside the document block gives the
                            // model a guaranteed-readable channel.
                            contentParts.push({ type: 'text', text: docText });
                            // Also the original PDF (Claude, OpenAI, Azure) so the
                            // model sees logos, signatures and layout. Never while
                            // the Privacy Shield is active: the raw bytes carry
                            // what the text scan never saw. Rule and size cap:
                            // core/documents/nativePdf.js. Current turn only, the
                            // persisted sidecar below holds the text + URL.
                            const _pdfPart = nativePdfPart({
                                adapter, modelId, providerType: config?.providerType,
                                shieldActive: isShieldActive(_psShield), tokenised: _wasTokenised,
                                base64Data, mediaType: att.type, filename: att.name, tag: 'DirectChat',
                            });
                            if (_pdfPart) contentParts.push(_pdfPart);
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, docText);
                        } else if (result.kind === 'images') {
                            // Vision fallback — inline a header note, then the page images.
                            const visionHeader = formatImagesHeader(att, result);
                            contentParts.push({ type: 'text', text: visionHeader });
                            for (const img of result.images) {
                                contentParts.push({
                                    type: 'image_url',
                                    image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' },
                                });
                            }
                            // Persist the header so replays at least know which
                            // file was visually analysed; the rendered pages
                            // themselves aren't re-uploaded (would be expensive
                            // and is mostly recoverable via the original PDF URL).
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, visionHeader);
                        } else {
                            const failureNote = formatFailureNote(att, result);
                            contentParts.push({ type: 'text', text: failureNote });
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, failureNote);
                        }
                    } catch (e) {
                        log.error(`[DirectChat] PDF processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[PDF: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content && (
                    att.type?.includes('wordprocessingml') || att.name?.toLowerCase().endsWith('.docx') ||
                    att.type?.includes('presentationml') || att.name?.toLowerCase().endsWith('.pptx')
                )) {
                    // DOCX / PPTX — Azure Document Intelligence (when enabled) →
                    // mammoth / pptxExtractor fallback. One branch for both: the
                    // pipeline is identical, only the parser and the label differ.
                    const isDeck = att.type?.includes('presentationml') || att.name?.toLowerCase().endsWith('.pptx');
                    const officeMime = isDeck
                        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                    const officeLabel = isDeck ? 'Presentation' : 'Word Document';
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const docxBuffer = Buffer.from(base64Data, 'base64');
                        let docxText = '';

                        // 1. Try Azure Document Intelligence first (highest quality — Markdown with tables/headings)
                        const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
                        if (useAzureDoc) {
                            try {
                                const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../../core/documents/azureDocIntelligence');
                                if (await isAzureDocIntelligenceConfigured()) {
                                    docxText = await extractWithAzure(docxBuffer, att.name);
                                    if (docxText) {
                                        log.info(`[DirectChat] DOCX extracted via Azure Document Intelligence: ${att.name} (${docxText.length} chars)`);
                                    }
                                }
                            } catch (azureErr) {
                                log.warn(`[DirectChat] Azure Document Intelligence failed for DOCX ${att.name}:`, azureErr.message);
                            }
                        }

                        // 2. Fallback to mammoth / pptxExtractor (plain text extraction)
                        if (!docxText) {
                            const { parseDocument } = require('../../../core/documents/documentParser');
                            docxText = await parseDocument(docxBuffer, officeMime, att.name);
                        }

                        // Upload original to RustFS for persistence
                        let docxProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, docxBuffer, att.type || officeMime);
                                docxProxyUrl = storageStore.buildProxyUrl(key);
                                log.info(`[DirectChat] Uploaded DOCX to RustFS: ${key}`);
                            }
                        } catch (e) {
                            log.warn(`[DirectChat] Failed to upload DOCX to RustFS: ${e.message}`);
                        }

                        if (docxText && !docxText.startsWith('[Document:') && !docxText.startsWith('[Presentation:')) {
                            const safeDocxText = await _scanExtracted(docxText, undefined, att.name);
                            const docText = `[${officeLabel}: ${att.name}]\n---\n${safeDocxText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, docText);
                            log.info(`[DirectChat] Extracted ${docxText.length} chars from DOCX: ${att.name}`);
                        } else {
                            // extraction returned empty/error — fall back to container
                            const note = `[${officeLabel}: ${att.name} — no extractable text, may contain only images]`;
                            contentParts.push({ type: 'text', text: note });
                            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, note);
                        }
                    } catch (e) {
                        log.error(`[DirectChat] ${isDeck ? 'PPTX' : 'DOCX'} processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[${isDeck ? 'PPTX' : 'DOCX'}: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content && (
                    att.type?.includes('spreadsheetml') || att.type?.includes('ms-excel') ||
                    att.type === 'text/csv' || att.type === 'application/csv' ||
                    att.name?.toLowerCase().endsWith('.xlsx') || att.name?.toLowerCase().endsWith('.xls') ||
                    att.name?.toLowerCase().endsWith('.csv')
                )) {
                    // Spreadsheet — Azure Document Intelligence (when enabled) → XLSX library fallback
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const spreadsheetBuffer = Buffer.from(base64Data, 'base64');
                        let sheetText = '';

                        // 1. Try Azure Document Intelligence first (when enabled)
                        const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
                        if (useAzureDoc) {
                            try {
                                const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../../core/documents/azureDocIntelligence');
                                if (await isAzureDocIntelligenceConfigured()) {
                                    sheetText = await extractWithAzure(spreadsheetBuffer, att.name);
                                    if (sheetText) {
                                        log.info(`[DirectChat] Spreadsheet extracted via Azure Document Intelligence: ${att.name} (${sheetText.length} chars)`);
                                    }
                                }
                            } catch (azureErr) {
                                log.warn(`[DirectChat] Azure Document Intelligence failed for spreadsheet ${att.name}:`, azureErr.message);
                            }
                        }

                        // 2. Fallback to local XLSX parser
                        if (!sheetText) {
                            const { parseDocument } = require('../../../core/documents/documentParser');
                            sheetText = await parseDocument(spreadsheetBuffer, att.type || 'application/octet-stream', att.name);
                        }

                        // Upload original to RustFS for persistence
                        let sheetProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, spreadsheetBuffer, att.type || 'application/octet-stream');
                                sheetProxyUrl = storageStore.buildProxyUrl(key);
                                log.info(`[DirectChat] Uploaded spreadsheet to RustFS: ${key}`);
                            }
                        } catch (e) {
                            log.warn(`[DirectChat] Failed to upload spreadsheet to RustFS: ${e.message}`);
                        }

                        if (sheetText && !sheetText.startsWith('[Spreadsheet:')) {
                            const safeSheetText = await _scanExtracted(sheetText, undefined, att.name);
                            const docText = `[Spreadsheet: ${att.name}]\n---\n${safeSheetText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl }, docText);
                            log.info(`[DirectChat] Extracted ${sheetText.length} chars from spreadsheet: ${att.name}`);
                        } else {
                            const note = sheetText || `[Spreadsheet: ${att.name} — no data found]`;
                            contentParts.push({ type: 'text', text: note });
                            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl }, note);
                        }
                    } catch (e) {
                        log.error(`[DirectChat] Spreadsheet processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[Spreadsheet: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.source === 'gmail' && att.content) {
                    // Gmail email — GmailPicker sends the body as plain text
                    // (type 'text/plain'). Inject it directly like Google Drive
                    // does; otherwise it fell into the generic branch below,
                    // which base64-decoded the plaintext into garbage and the
                    // model never saw the email (BFSF-87).
                    const safeMail = await _scanExtracted(att.content, undefined, att.name);
                    const mailText = `--- Gmail: ${att.name} ---\n${safeMail}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: mailText });
                    await pushAttachment({ name: att.name, type: 'gmail' }, mailText);
                } else if (att.content && att.type && att.type.startsWith('text/') && !String(att.content).startsWith('data:')) {
                    // Other plain-text attachments (text/plain, text/markdown…) —
                    // inline as text instead of base64-decoding into garbage (BFSF-87).
                    const safeTxt = await _scanExtracted(att.content, undefined, att.name);
                    const txt = `--- ${att.name} ---\n${safeTxt}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: txt });
                    await pushAttachment({ name: att.name, type: att.type }, txt);
                } else if (att.content) {
                    // Generic file — upload to RustFS for persistent access
                    const base64Data = att.content.split(',')[1] || att.content;
                    const buffer = Buffer.from(base64Data, 'base64');
                    const filename = att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

                    let fileProxyUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const storageName = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${filename}`;
                            const key = storageStore.buildKey(userId, 'uploads', storageName);
                            await storageStore.uploadFile(key, buffer, att.type || 'application/octet-stream');
                            fileProxyUrl = storageStore.buildProxyUrl(key);
                            log.info(`[DirectChat] Uploaded file to RustFS: ${key}`);
                        }
                    } catch (storErr) {
                        log.warn(`[DirectChat] Failed to upload file to RustFS: ${storErr.message}`);
                    }

                    const note = `[Attached file: ${filename}] This file has been uploaded${fileProxyUrl ? ' and stored' : ''}.${att.type ? ' Type: ' + att.type : ''}`;
                    contentParts.push({ type: 'text', text: note });
                    await pushAttachment({ name: att.name, type: att.type, url: fileProxyUrl }, note);
                }
            }
            } catch (attErr) {
                if (attErr && attErr.code === 'ATTACHMENT_PII_BLOCKED') {
                    const cats = Object.keys(attErr.summary?.byCategory || {});
                    const cause = attErr.reason && attErr.reason !== 'pii' ? attErr.reason : 'pii';
                    const sseReason = cause === 'pii' ? 'attachment_pii' : `attachment_${cause}`;
                    send('dlp_blocked', {
                        reason: sseReason,
                        filename: attErr.filename,
                        categories: cats,
                        findings: [],
                        provider: { isExternal: false, reason: sseReason },
                    });
                    try {
                        const guardrailEventStore = require('../../../stores/guardrailEventStore');
                        await guardrailEventStore.logGuardrailEvent({
                            organization_id: _attUserOrgId || null,
                            user_id: userId || null,
                            conversation_id: conversationId || null,
                            violation_type: 'pii',
                            violation_categories: cause === 'pii' ? (cats.join(', ') || null) : `scan_${cause}`,
                            direction: 'input',
                            action_taken: cause === 'pii' ? 'blocked' : 'held',
                            source: config?.providerName || config?.providerType || 'LLM',
                            model: modelId || null,
                            attachment_filename: attErr.filename,
                            attachment_page: null,
                        });
                    } catch (_) { /* audit best-effort */ }
                    send('done', {}); res.end(); return;
                }
                throw attErr;
            }
            // Audit + UI surfacing for tokenised attachments.
            if (_attachmentScanSummaries.length > 0) {
                try {
                    const guardrailEventStore = require('../../../stores/guardrailEventStore');
                    const auditBase = {
                        organization_id: _attUserOrgId || null,
                        user_id: userId || null,
                        conversation_id: conversationId || null,
                        source: config?.providerName || config?.providerType || 'LLM',
                        model: modelId || null,
                    };
                    for (const s of _attachmentScanSummaries) {
                        if (s.action === 'tokenize') {
                            await guardrailEventStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'redacted' });
                        }
                        if (s.action === 'allowed') {
                            await guardrailEventStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'allowed' });
                        }
                        if (s.reason) {
                            await guardrailEventStore.logAttachmentScanIncomplete({
                                auditBase, filename: s.filename, reason: s.reason,
                                scannedPages: s.scannedPages, totalPages: s.totalPages,
                                action_taken: s.action === 'tokenize' ? 'partial_redacted' : 'passed_unredacted',
                            });
                        }
                    }
                } catch (_) { /* audit best-effort */ }
            }
            // Per-file summaries — route-scoped so they survive the
            // `messages = compactionResult.messages` reassignment that
            // happens later. The assistant-message builder reads from
            // `_turnAttachmentSummaries`; without this hoist the
            // privacy panel's "From attachments:" section disappears on
            // reload even though it appears live via the SSE event below.
            if (_attachmentScanSummaries.length > 0) {
                _turnAttachmentSummaries = _attachmentScanSummaries;

                // Live SSE notification so the UI shows the privacy badge
                // immediately, not just after a page reload. Without this,
                // the audit row is written but the user sees no evidence
                // that Privacy Shield fired this turn. Re-uses the existing
                // `pii_tokenized` event shape so the client handler
                // (useChatEngine.js: case 'pii_tokenized') ingests both
                // message-level and attachment-level findings the same way.
                const _aggCount = _attachmentScanSummaries.reduce((a, s) => a + (s.count || 0), 0);
                const _aggCats = new Set();
                for (const s of _attachmentScanSummaries) {
                    for (const c of Object.keys(s.byCategory || {})) _aggCats.add(c);
                }
                if (_aggCount > 0 || _attachmentScanSummaries.some(s => s.timeout || s.reason)) {
                    send('pii_tokenized', {
                        // Synthesise an entities-shaped list so the existing
                        // pii_tokenized handler picks the categories up.
                        entities: [..._aggCats].map(label => ({ label, category: label })),
                        tokenCount: _aggCount,
                        attachments: _attachmentScanSummaries,
                        source: 'privacy_shield',
                    });
                }

                // When the org enabled "Show raw payload & token mapping",
                // also push the *exact* tokenised text the model is about
                // to receive (user prompt + tokenised attachment text) and
                // the merged token map. This is what fills the "Sent to AI"
                // pane in the "How I got this answer → Privacy protection"
                // panel — without it the user sees only the un-tokenised
                // round-tripped response and has no way to verify what
                // Claude actually saw.
                if (_aggCount > 0 && _psShield?.showRawPayload) {
                    try {
                        const flat = contentParts
                            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
                            .map(p => p.text)
                            .join('\n');
                        if (flat) {
                            send('privacy_payload', {
                                tokenizedPrompt: flat,
                                provider: modelId,
                                source: 'privacy_shield',
                                timestamp: Date.now(),
                            });
                        }
                        const _dlpRunner = require('../../../core/dlp/dlpRunner');
                        // `convId`, NOT `conversationId`. On the first message of
                        // a new chat `conversationId` is still null — the id only
                        // exists because the eager-create block above minted it
                        // into `convId`, which is also what the scanner merged the
                        // attachment tokens under. Reading the request-scoped
                        // variable here returned an empty map, so a PDF uploaded
                        // into a fresh conversation showed no TOKEN MAPPING at all
                        // while the same content in an existing chat did.
                        const _convMap = _dlpRunner.getConversationTokenMap(convId);
                        if (_convMap && Object.keys(_convMap).length > 0) {
                            send('privacy_token_map', { tokenMap: _convMap, source: 'privacy_shield' });
                        }
                    } catch (_) { /* transparency is best-effort */ }
                }
            }
            // ── Prompt cache breakpoint on the last attachment block ─────
            // OCR / PDF extraction is expensive and the document content is
            // stable across follow-up questions in the same chat. Mark the
            // LAST attachment-derived block so Anthropic caches the document
            // for ≥5 min at 10% cost on the next turn. The Claude provider's
            // normalizeMessages counts this pre-existing marker against its
            // own breakpoint budget so we stay under the 4-marker API limit.
            if (contentParts.length > 0) {
                const lastBlock = contentParts[contentParts.length - 1];
                if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
                    lastBlock.cache_control = { type: 'ephemeral' };
                }
            }
            messages.push({ role: 'user', content: contentParts });
        } else {
            messages.push({ role: 'user', content: message });
        }
        if (_attT !== null) {
            emitPhaseEnd(send, 'processing_attachments', Date.now() - _attT);
        }
        return { convId, persistedAttachments, _turnAttachmentSummaries };
}

module.exports = { processAttachmentsAndUserMessage };

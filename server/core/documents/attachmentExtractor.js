// @typecheck
/**
 * Unified attachment extractor — single pipeline used by both direct chat
 * (server/routes/ai/directChat.js) and agent chat (server/core/agentRuntime/
 * attachmentProcessor.js). Previously the two paths handled PDFs differently,
 * so Azure Document Intelligence only worked in direct chat.
 *
 * Return shape:
 *   { kind: 'text', text, source, meta }        — inlined into message content
 *   { kind: 'images', images, source, meta }    — vision-model fallback
 *   { kind: 'failed', reason, meta }            — placeholder message to LLM
 *
 * `source` identifies which extractor produced the text so observability
 * shows up in logs and in the header prepended to the LLM message.
 *
 * Pipeline for PDFs:
 *   1. pdfjs text extraction.
 *   2. Density check — if total chars < max(200, numPages * 100), treat as
 *      "needs OCR". A scanned PDF with a sprinkle of text from a broken
 *      source layer would otherwise escape the fallback.
 *   3. Azure Document Intelligence (when `use_azure_doc_processing` flag +
 *      endpoint + key are set).
 *   4. Mistral OCR (when `mistralOcrApiKey` is set).
 *   5. Render pages to PNG and return `kind: 'images'` (when the chat model
 *      supports vision). Capped at 20 pages.
 *   6. `kind: 'failed'` — the caller inlines a clear "could not extract"
 *      placeholder for the LLM.
 *
 * Pipeline for DOCX / XLSX / PPTX:
 *   1. Azure Document Intelligence (preferred — preserves tables/headings).
 *   2. documentParser fallback (mammoth for DOCX, xlsx lib for sheets,
 *      pptxExtractor for decks — slide text + speaker notes per slide).
 */

const configStore = require('../../stores/configStore');
const { extractTextFromPDFWithStats } = require('./pdfExtractor');
const { renderPdfPagesToImages } = require('./pdfToImages');
const { extractCad } = require('../cad/cadMetadata');
const { isCadMime } = require('../cad/cadTypes');
// Hoisted DELIBERATELY. Both renderers used to be required inside the try/catch
// below, so when cadRender.js moved into core/cad/ the stale path became a
// MODULE_NOT_FOUND that the catch reported as "this file could not be
// rendered" — every STEP file silently degraded to its header for as long as
// nobody read the warning. A require at the top fails at boot, where a failure
// belongs.
const { renderCadSheet } = require('../cad/cadRender');
const { renderDxfSheet } = require('../cad/dxfRender');
const log = require('../../telemetry/log');

// ─── MIME / extension detection ─────────────────────────────
function isPdf(att) {
    return (att.type && att.type.includes('pdf')) || /\.pdf$/i.test(att.name || '');
}
function isDocx(att) {
    return (att.type && att.type.includes('wordprocessingml')) || /\.docx$/i.test(att.name || '');
}
function isPptx(att) {
    return (att.type && att.type.includes('presentationml')) || /\.pptx$/i.test(att.name || '');
}
function isSpreadsheet(att) {
    return (att.type && (att.type.includes('spreadsheetml') || att.type.includes('ms-excel') || att.type === 'text/csv' || att.type === 'application/csv'))
        || /\.(xlsx|xls|csv)$/i.test(att.name || '');
}
function isImage(att) {
    return (att.type && att.type.startsWith('image/'))
        || /\.(png|jpe?g|gif|webp|tiff?|bmp|heic|heif)$/i.test(att.name || '');
}
// CAD interchange formats (STEP / DXF / DWG / IGES). Extension FIRST: mailed
// CAD is routinely declared text/plain or application/octet-stream, so the
// filename is the more honest signal; canonical + alias mimes catch the rest.
function isCad(att) {
    if (/\.(step|stp|p21|dxf|dwg|iges|igs)$/i.test(att.name || '')) return true;
    return isCadMime(att.type);
}
// Plain-text-ish formats we can decode directly. csv / xls* are handled as
// spreadsheets above, so this is text / markdown / json / code / xml.
function isPlainText(att) {
    return (att.type && (att.type.startsWith('text/') || att.type === 'application/json' || att.type === 'application/xml'))
        || /\.(txt|md|markdown|json|log|ya?ml|xml|html?|tsv|rtf)$/i.test(att.name || '');
}

function decodeBase64(content) {
    const b64 = content.includes(',') ? content.split(',')[1] : content;
    return Buffer.from(b64, 'base64');
}

// ─── Azure helpers ──────────────────────────────────────────
async function tryAzure(buffer, filename) {
    try {
        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        if (!useAzure) return null;
        const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('./azureDocIntelligence');
        if (!(await isAzureDocIntelligenceConfigured())) return null;
        const text = await extractWithAzure(buffer, filename);
        return text || null;
    } catch (err) {
        // Wrap every path (config read, Azure client, timeout) so a failure
        // here falls through to the next extractor instead of crashing the
        // whole attachment flow.
        log.warn(`[AttachmentExtractor] Azure Document Intelligence step failed for ${filename}: ${err.message}`);
        return null;
    }
}

async function tryMistralOcr(base64, mimeType, filename) {
    try {
        const { mistralOCR } = require('./ocr');
        const text = await mistralOCR(base64, mimeType, filename);
        return text || null;
    } catch (err) {
        log.warn(`[AttachmentExtractor] Mistral OCR failed for ${filename}: ${err.message}`);
        return null;
    }
}

// ─── Density heuristic ──────────────────────────────────────
// A scanned PDF's pdfjs text layer is usually empty, but some OCR-processed
// or hybrid PDFs have a sprinkle of glyphs that isn't enough to understand
// the content. Treat any PDF with an avg of <100 chars/page as "needs OCR".
function isTextInsufficient(text, numPages) {
    const totalChars = (text || '').trim().length;
    if (totalChars === 0) return true;
    if (numPages <= 0) return totalChars < 200;
    const threshold = Math.max(200, numPages * 100);
    return totalChars < threshold;
}

// Some invoice PDFs (notably fuel-card / logistics PDFs) embed fonts with no
// usable ToUnicode CMap, so pdfjs returns long strings of CID-mapped glyphs
// — enough characters to pass `isTextInsufficient` but visually unreadable.
// Detect that case so we fall through to Azure/Mistral OCR instead of shipping
// junk to the LLM.
function isTextLikelyGarbage(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 200) return false; // not enough sample to judge — let other checks decide
    const sample = trimmed.slice(0, 4000);
    let letters = 0;
    let asciiLikePrintable = 0;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        // Letters (incl. accented latin)
        if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0xff)) letters++;
        // Printable ASCII + common whitespace
        if ((code >= 0x20 && code <= 0x7e) || code === 0x0a || code === 0x0d || code === 0x09) asciiLikePrintable++;
    }
    const letterRatio = letters / sample.length;
    const printableRatio = asciiLikePrintable / sample.length;
    // Real-world prose hits letterRatio ≈ 0.6+, printableRatio ≈ 0.95+.
    // Junk CID streams come out at letterRatio <0.25 with lots of control
    // chars / high-codepoint glyphs that fail the printable check too.
    return letterRatio < 0.25 || printableRatio < 0.75;
}

// ─── PDF pipeline ───────────────────────────────────────────
// Render target for forced-images mode: Claude downsamples to ~1568 px on the
// long edge, so asking pdfToImages for exactly that is the readable maximum.
const VISION_TARGET_LONG_EDGE = 1568;

async function extractPdf(buffer, att, opts) {
    const documentMode = (opts.documentMode === 'text' || opts.documentMode === 'images') ? opts.documentMode : 'auto';
    const { text, numPages, pageCharCounts, pages } = await extractTextFromPDFWithStats(buffer, att.name);
    const baseMeta = { numPages, pageCharCounts, totalChars: text.length };

    // documentMode 'images': skip the sufficient-text early return AND the
    // Azure/Mistral OCR tiers and rasterise straight away. A vector technical
    // drawing has a DENSE text layer, so the insufficient-text trigger never
    // fires and the model never sees the geometry — this mode exists for
    // exactly that. The pdfjs text still rides along so the caller can inline
    // the title-block text alongside the pictures. Needs a vision model — if
    // the model can't see, fall back to the normal text path below.
    if (documentMode === 'images' && opts.modelSupportsVision) {
        const rendered = await renderPdfPagesToImages(buffer, { filename: att.name, targetLongEdge: VISION_TARGET_LONG_EDGE });
        if (rendered && rendered.images.length) {
            return {
                kind: 'images',
                images: rendered.images,
                text,
                source: 'vision-forced',
                meta: { ...baseMeta, renderedPages: rendered.images.length, truncated: rendered.truncated },
            };
        }
    }

    const insufficient = isTextInsufficient(text, numPages);
    const garbage = !insufficient && isTextLikelyGarbage(text);
    if (garbage) {
        log.warn(`[AttachmentExtractor] pdfjs returned ${text.length} chars but the content looks like CID/font junk for ${att.name} — falling through to OCR.`);
    }
    if (!insufficient && !garbage) {
        return { kind: 'text', text, pages, source: 'pdfjs', meta: baseMeta };
    }

    // Step 2: Azure Document Intelligence
    const azureText = await tryAzure(buffer, att.name);
    if (azureText) {
        return { kind: 'text', text: azureText, source: 'azure', meta: { ...baseMeta, extractedChars: azureText.length } };
    }

    // Step 3: Mistral OCR
    const base64 = att.content.includes(',') ? att.content.split(',')[1] : att.content;
    const mistralText = await tryMistralOcr(base64, att.type || 'application/pdf', att.name);
    if (mistralText) {
        return { kind: 'text', text: mistralText, source: 'mistral', meta: { ...baseMeta, extractedChars: mistralText.length } };
    }

    // Step 4: vision fallback — render pages as images. documentMode 'text'
    // never rasterises: this rung of the ladder is skipped entirely.
    if (opts.modelSupportsVision && documentMode !== 'text') {
        const rendered = await renderPdfPagesToImages(buffer, { filename: att.name });
        if (rendered && rendered.images.length) {
            return {
                kind: 'images',
                images: rendered.images,
                source: 'vision-fallback',
                meta: { ...baseMeta, renderedPages: rendered.images.length, truncated: rendered.truncated },
            };
        }
    }

    return { kind: 'failed', reason: 'image-only PDF, no OCR provider configured', meta: baseMeta };
}

// ─── Office-doc pipeline ────────────────────────────────────
async function extractOfficeDoc(buffer, att) {
    // Prefer Azure for tables/headings quality.
    const azureText = await tryAzure(buffer, att.name);
    if (azureText) {
        return { kind: 'text', text: azureText, source: 'azure', meta: { extractedChars: azureText.length } };
    }

    try {
        const { parseDocument } = require('./documentParser');
        const text = await parseDocument(buffer, att.type || 'application/octet-stream', att.name);
        if (text && !text.startsWith('[Document:') && !text.startsWith('[Presentation:')) {
            return { kind: 'text', text, source: 'documentParser', meta: { extractedChars: text.length } };
        }
    } catch (err) {
        log.warn(`[AttachmentExtractor] documentParser failed for ${att.name}: ${err.message}`);
    }
    return { kind: 'failed', reason: 'Office document extraction failed', meta: {} };
}

// ─── Image pipeline ─────────────────────────────────────────
// Two kinds of caller arrive here with an image, and they want opposite things.
//
// Connectors (Gmail, Drive, Nextcloud) want TEXT: a scan of a receipt is a
// document that happens to be stored as pixels, and the caller has no model to
// show it to. They pass no vision flag, and they still get exactly what they
// always got — OCR, or an honest failure.
//
// A model-facing caller that CAN see wants the picture. Replacing it with OCR
// text was a silent, total loss of content: a photograph of a meter cupboard
// came back as `# 1` — the one digit OCR could make of it — and the model then
// answered, correctly for what it had been given, that it saw "the digit 1 on
// an empty background". Twelve characters stood in for two megapixels.
//
// So: hand over the picture whenever the caller can look and did not ask for
// text only. OCR text rides ALONGSIDE it on 'auto' — a dense scan is still read
// more reliably from its text layer than from pixels, the same reason the PDF
// path sends both — but never INSTEAD of it. `documentMode: 'images'` is the
// caller stating that the picture is the point, so OCR is skipped entirely
// there and the photo is not held up by a round-trip that cannot help it.
async function extractImage(buffer, att, opts = {}) {
    const wantsPicture = !!opts.modelSupportsVision && opts.documentMode !== 'text';
    const base64 = att.content.includes(',') ? att.content.split(',')[1] : att.content;

    if (wantsPicture && opts.documentMode === 'images') {
        return {
            kind: 'images',
            images: [{ mimeType: att.type || 'image/png', base64 }],
            source: 'image',
            meta: { type: att.type, ocr: 'skipped' },
        };
    }

    const azureText = await tryAzure(buffer, att.name);
    const mistralText = azureText ? null : await tryMistralOcr(base64, att.type || 'image/png', att.name);
    const text = azureText || mistralText || '';
    const source = azureText ? 'azure' : (mistralText ? 'mistral' : null);

    if (wantsPicture) {
        return {
            kind: 'images',
            // Empty text is dropped by every consumer, so no empty block appears.
            text,
            images: [{ mimeType: att.type || 'image/png', base64 }],
            source: source || 'image',
            meta: { type: att.type, extractedChars: text.length },
        };
    }
    if (text) {
        return { kind: 'text', text, source, meta: { extractedChars: text.length } };
    }
    return { kind: 'failed', reason: 'image attachment, no OCR provider configured', meta: { type: att.type } };
}

// ─── Plain-text pipeline ────────────────────────────────────
function extractPlainText(buffer, _att) {
    const text = buffer.toString('utf-8');
    return { kind: 'text', text, source: 'utf8', meta: { extractedChars: text.length } };
}

// Strip control characters that don't belong in extracted text. NUL (\u0000)
// in particular is fatal downstream: PostgreSQL rejects it in text / jsonb
// columns ("unsupported Unicode escape sequence"), so a single CID-font NUL
// in a PDF would otherwise blow up run-step persistence. Keep tab / newline /
// carriage-return; drop the rest of the C0 range.
function stripControlChars(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ─── Public API ─────────────────────────────────────────────
/**
 * @param {{ name: string, type: string, content: string }} att
 * @param {{ modelSupportsVision?: boolean, documentMode?: 'auto'|'text'|'images' }} [opts]
 *   documentMode (PDFs only): 'images' forces page rendering for a vision
 *   model even when the text layer is dense (technical drawings); 'text'
 *   never rasterises; 'auto' (default) keeps the existing ladder.
 * @returns {Promise<object>} one of the three result shapes above
 */
/**
 * A CAD file, as both text and picture.
 *
 * The header alone (format, schema, description) told a model what KIND of file
 * it was and nothing about the part — so a question like "does this plate have
 * counterbored holes" could only ever be answered from the 2D drawing, and when
 * the drawing was ambiguous there was nowhere else to look. The solid model is
 * the one source that is never ambiguous; it just needed rendering into
 * something a model can see.
 *
 * The header STAYS. It is exact where the render is interpretive — schema, AP
 * version and the part description are read straight out of the file — and it
 * still speaks for the formats no kernel here can tesselate (DWG, SAT).
 *
 * Rendering is best-effort by design: a file the kernel refuses falls back to
 * exactly the text-only result this used to return, so nothing that worked
 * before can start failing because a picture could not be drawn.
 */
async function extractCadWithViews(buffer, att, opts = {}) {
    const base = extractCad(buffer, att.name);
    // No point rendering for a model that cannot look at it.
    if (!opts.modelSupportsVision || opts.documentMode === 'text') return base;

    const family = cadRenderFamily(att);
    if (!family) return base;

    try {
        const { text, images, meta } = family === 'dxf'
            ? await renderFlatSheet(buffer, att)
            : await renderSolidSheet(buffer, family);
        return {
            kind: 'images',
            // The header text rides along with the views, exactly as the forced
            // PDF rasterisation path does — it is the cheapest half of the file.
            text: `${base.text || ''}\n${text}`.trim(),
            images,
            meta: { ...(base.meta || {}), rendered: true, ...meta },
        };
    } catch (err) {
        log.warn(`[attachmentExtractor/cad] ${att.name}: ${err.message}`);
        return base;
    }
}

/**
 * Which renderer can draw this file — or null for the formats no kernel here
 * can open (DWG, Parasolid, ACIS), which keep the header-only result.
 */
function cadRenderFamily(att) {
    const name = att.name || '';
    if (/\.(step|stp|p21)$/i.test(name) || att.type === 'model/step') return 'step';
    if (/\.(iges|igs)$/i.test(name) || att.type === 'model/iges') return 'iges';
    if (/\.dxf$/i.test(name) || att.type === 'image/vnd.dxf') return 'dxf';
    return null;
}

/** STEP / IGES: four shaded views of the solid. */
async function renderSolidSheet(buffer, format) {
    const { png, stats } = await renderCadSheet(buffer, { format });
    return {
        text: `Afmetingen bounding box (mm): ${stats.sizeMm.join(' x ')}.`,
        images: [{ mimeType: 'image/png', base64: png.toString('base64') }],
        meta: { triangles: stats.triangles },
    };
}

/**
 * DXF: the flat cut sheet, drawn 1:1.
 *
 * A DXF is not a solid and never was — handing it to the 3D kernel produced a
 * refusal, and the catch above turned that refusal into "no picture". A mailed
 * order of twenty cut files therefore reached the model as twenty header
 * lines. The 2D renderer draws what the machine will actually cut, and states
 * the sheet size in millimetres because that is the number an estimator checks
 * first.
 */
async function renderFlatSheet(buffer, att) {
    const { png, stats } = await renderDxfSheet(buffer, { name: att.name || '' });
    const [w, h] = stats.size;
    return {
        text: `2D-snijcontour, buitenmaat ${w} x ${h} mm (${stats.paths} elementen).`
            + (stats.truncated ? ' LET OP: de tekening is te groot en is afgekapt weergegeven.' : ''),
        images: [{ mimeType: 'image/png', base64: png.toString('base64') }],
        meta: { paths: stats.paths, segments: stats.segments },
    };
}

async function extractAttachment(att, opts = {}) {
    if (!att || !att.content) {
        return { kind: 'failed', reason: 'missing content', meta: {} };
    }
    const buffer = decodeBase64(att.content);

    let result;
    if (isPdf(att)) result = await extractPdf(buffer, att, opts);
    else if (isDocx(att) || isSpreadsheet(att) || isPptx(att)) result = await extractOfficeDoc(buffer, att);
    // CAD BEFORE the image and plain-text branches. This ordering fixes a
    // LIVE bug: a mailed DXF labelled text/plain matched isPlainText and
    // dumped the entire raw CAD body into the prompt. (And the canonical
    // DXF/DWG mimes live under image/*, which would otherwise route geometry
    // into OCR.) cadMetadata reads only the header and states honestly what
    // it did not read.
    else if (isCad(att)) result = await extractCadWithViews(buffer, att, opts);
    else if (isImage(att)) result = await extractImage(buffer, att, opts);
    else if (isPlainText(att)) result = extractPlainText(buffer, att);
    else result = { kind: 'failed', reason: 'unsupported type for this extractor', meta: { type: att.type } };

    // Strip control chars from ANY extracted text — including the pdfjs text
    // that rides along with a forced-images result (same NUL/Postgres hazard).
    if (result && typeof result.text === 'string') {
        result.text = stripControlChars(result.text);
    }
    return result;
}

/**
 * Build a human-readable header for a successful text extraction so the LLM
 * knows what was done and logs are debuggable.
 */
function formatTextHeader(att, result) {
    const sourceLabel = {
        pdfjs: 'PDF text layer',
        azure: 'Azure Document Intelligence',
        mistral: 'Mistral OCR',
        documentParser: 'document parser',
        utf8: 'plain text',
        cad: 'CAD file header',
    }[result.source] || result.source;
    const pages = result.meta?.numPages ? `, ${result.meta.numPages} pages` : '';
    const chars = result.meta?.extractedChars || result.meta?.totalChars;
    const charsStr = chars ? `, ${chars} chars` : '';
    return `[${att.name} — extracted via ${sourceLabel}${pages}${charsStr}]`;
}

function formatImagesHeader(att, result) {
    // A photograph has no pages to render, and saying "0 pages rendered" ahead
    // of a picture the model can plainly see is worse than saying nothing: it
    // invites the model to report an empty attachment.
    if (isImage(att) && !isCad(att)) {
        const ocrNote = result.meta?.extractedChars ? `, plus ${result.meta.extractedChars} characters of OCR text` : '';
        return `[${att.name} — the image itself follows${ocrNote}]`;
    }
    const truncNote = result.meta?.truncated ? ` (truncated; only first ${result.meta.renderedPages} of ${result.meta.numPages} pages)` : '';
    return `[${att.name} — ${result.meta?.renderedPages || 0} page${result.meta?.renderedPages === 1 ? '' : 's'} rendered as images for vision model${truncNote}]`;
}

function formatFailureNote(att, result) {
    return `[${att.name} — could not extract text: ${result.reason}. The document may be scanned or image-based and no OCR provider is configured for this environment.]`;
}

module.exports = {
    extractAttachment,
    formatTextHeader,
    formatImagesHeader,
    formatFailureNote,
    // exposed for tests
    isTextInsufficient,
    isTextLikelyGarbage,
    isPdf,
    isDocx,
    isPptx,
    isSpreadsheet,
    isImage,
    isCad,
    isPlainText,
};

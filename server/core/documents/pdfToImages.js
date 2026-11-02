// @typecheck
/**
 * PDF → PNG page images — last-resort fallback for scanned PDFs when
 * Azure Document Intelligence and Mistral OCR are both unavailable.
 *
 * Renders with pdfjs-dist's built-in page.render() against an off-screen
 * canvas from @napi-rs/canvas (prebuilt native Rust binary, no system deps).
 * If @napi-rs/canvas isn't installed, we return null — the caller should
 * degrade gracefully rather than crash.
 *
 * Cap at 20 pages because a single 100-page scanned manual rendered as
 * high-resolution images is a context-window and cost disaster. The
 * 'truncated' flag lets the caller warn the user.
 */
const log = require('../../telemetry/log');

/**
 * @type {typeof import("@napi-rs/canvas") | null}
 */
let _canvasMod = null;
let _canvasImportAttempted = false;

function loadCanvas() {
    if (_canvasMod) return _canvasMod;
    if (_canvasImportAttempted) return null;
    _canvasImportAttempted = true;
    try {
        _canvasMod = require('@napi-rs/canvas');
        return _canvasMod;
    } catch (err) {
        log.warn('[PdfToImages] @napi-rs/canvas is not installed — vision fallback for scanned PDFs disabled. To enable: `npm install @napi-rs/canvas` in server/.');
        return null;
    }
}

let _getDocument = null;
async function loadGetDocument() {
    if (_getDocument) return _getDocument;
    const mod = await Promise.race([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('pdfjs-dist import timed out after 10s')), 10000)),
    ]);
    _getDocument = mod.getDocument;
    return _getDocument;
}

/**
 * Pick the render scale for ONE page. Claude downsamples anything past
 * ~1568 px on the long edge and image tokens cost (w×h)/750, so rendering past
 * the target is pure waste — while the old fixed 1.5 (≈108 DPI) made the
 * dimension text on an A4/A3 technical drawing unreadable. `targetLongEdge`
 * computes a per-page scale from the unscaled viewport so the longer edge
 * lands at ~target px, clamped to [1.0, 4.0]; an explicit `scale` keeps the
 * legacy fixed behaviour; neither → the historical 1.5.
 * @param {{ width?: number, height?: number, scale?: number|null, targetLongEdge?: number|null }} [opts]
 */
function computeRenderScale({ width, height, scale = null, targetLongEdge = null } = {}) {
    if (scale) return scale;
    const longEdge = Math.max(Number(width) || 0, Number(height) || 0);
    if (targetLongEdge && longEdge > 0) {
        return Math.min(4.0, Math.max(1.0, targetLongEdge / longEdge));
    }
    return 1.5;
}

/**
 * Render PDF pages to PNG images.
 *
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {{ maxPages?: number, scale?: number, targetLongEdge?: number, filename?: string }} [opts]
 *   `maxPages`: hard cap on page count to avoid runaway cost/context; `scale`: fixed render scale; wins
 *   when given (legacy behaviour); `targetLongEdge`: px; per-page scale so the longer edge lands here
 *   (clamped 1.0–4.0)
 * @returns {Promise<{ images: Array<{ base64: string, mimeType: 'image/png' }>, totalPages: number, truncated: boolean } | null>}
 *          Returns null if canvas is unavailable or rendering fails outright.
 */
async function renderPdfPagesToImages(pdfBuffer, { maxPages = 20, scale = null, targetLongEdge = null, filename = 'unknown' } = {}) {
    const canvasMod = loadCanvas();
    if (!canvasMod) return null;

    try {
        const getDocument = await loadGetDocument();
        const data = new Uint8Array(pdfBuffer);
        const doc = await getDocument({ data, useSystemFonts: true }).promise;

        const totalPages = doc.numPages;
        const pageCount = Math.min(totalPages, maxPages);
        const truncated = totalPages > maxPages;
        /** @type {Array<{ base64: string, mimeType: 'image/png' }>} */
        const images = [];

        for (let i = 1; i <= pageCount; i++) {
            const page = await doc.getPage(i);
            const base = page.getViewport({ scale: 1 });
            const pageScale = computeRenderScale({ width: base.width, height: base.height, scale, targetLongEdge });
            const viewport = page.getViewport({ scale: pageScale });

            // Create an off-screen canvas sized to the viewport.
            const canvas = canvasMod.createCanvas(
                Math.ceil(viewport.width),
                Math.ceil(viewport.height),
            );
            const ctx = canvas.getContext('2d');

            // pdfjs uses DOMMatrix on the transform; @napi-rs/canvas is DOM-compatible.
            await page.render({ canvasContext: ctx, viewport }).promise;

            // Encode to PNG base64.
            const pngBuffer = canvas.toBuffer('image/png');
            images.push({ base64: pngBuffer.toString('base64'), mimeType: 'image/png' });
        }

        log.info(`[PdfToImages] ${log.nameForLog(filename)}: rendered ${images.length}/${totalPages} pages to PNG${truncated ? ' (truncated)' : ''}`);
        return { images, totalPages, truncated };
    } catch (err) {
        log.warn(`[PdfToImages] Failed to render ${log.nameForLog(filename)}:`, /** @type {Error} */ (err).message);
        return null;
    }
}

/**
 * A rectangle of a page, as fractions (0..1) of the page measured from the
 * top-left of the page as displayed.
 * @typedef {{ pageNumber: number, label: string, x: number, y: number, w: number, h: number }} PdfRegionRequest
 */

/**
 * Render clipped regions of the first `maxPages` pages, each so that ITS long
 * edge lands at `targetLongEdge` px (scale clamped to [1, 6]). The caller sees
 * every page's size first (`plan`), so it can budget before anything is drawn.
 * Regions are rendered strictly one at a time: the canvas is dropped before
 * the next one is allocated, so memory stays at one region's bitmap.
 *
 * pdf.js clips by viewport: `offsetX/offsetY` shift the page so the region
 * starts at the canvas origin, and the canvas is only as big as the region.
 *
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {{ maxPages: number, targetLongEdge: number, filename?: string,
 *   plan: (pages: Array<{ pageNumber: number, width: number, height: number }>) => PdfRegionRequest[] }} opts
 * @returns {Promise<Array<{ pageNumber: number, label: string, base64: string, mimeType: 'image/png', width: number, height: number }> | null>}
 */
async function renderPdfRegions(pdfBuffer, { maxPages, targetLongEdge, filename = 'unknown', plan }) {
    const canvasMod = loadCanvas();
    if (!canvasMod) return null;
    /** @type {{ destroy?: () => Promise<void> } | null} */
    let task = null;
    try {
        const getDocument = await loadGetDocument();
        const loading = getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true });
        task = loading;
        const doc = await loading.promise;
        const sizes = [];
        for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
            const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
            sizes.push({ pageNumber: i, width: vp.width, height: vp.height });
        }
        const out = [];
        for (const req of plan(sizes)) {
            const size = sizes[req.pageNumber - 1];
            if (!size) continue;
            const page = await doc.getPage(req.pageNumber);
            const regionLong = Math.max(req.w * size.width, req.h * size.height);
            const s = Math.min(6, Math.max(1, targetLongEdge / regionLong));
            const viewport = page.getViewport({ scale: s, offsetX: -req.x * size.width * s, offsetY: -req.y * size.height * s });
            const width = Math.ceil(req.w * size.width * s);
            const height = Math.ceil(req.h * size.height * s);
            let canvas = canvasMod.createCanvas(width, height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            const png = canvas.toBuffer('image/png');
            canvas = canvasMod.createCanvas(1, 1); // drop the big bitmap before the next region
            page.cleanup();
            out.push({ pageNumber: req.pageNumber, label: req.label, base64: png.toString('base64'), mimeType: /** @type {const} */ ('image/png'), width, height });
        }
        return out;
    } catch (err) {
        log.warn(`[PdfToImages] Region render failed for ${log.nameForLog(filename)}:`, /** @type {Error} */ (err).message);
        return null;
    } finally {
        // The document is opened a second time for the crops; let its worker state go.
        if (task && typeof task.destroy === 'function') {
            await task.destroy().catch((e) => log.debug(`[PdfToImages] destroy after regions: ${/** @type {Error} */ (e).message}`));
        }
    }
}

module.exports = { renderPdfPagesToImages, renderPdfRegions, computeRenderScale };

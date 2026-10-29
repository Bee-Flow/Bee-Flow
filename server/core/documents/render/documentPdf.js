/** @typedef {import('./documentRenderer').AiMarking} AiMarking */
const { featureModule } = require('../../featureModules');
const { escapeHtml } = require('../../../templates/exportTemplate');
const log = require('../../../telemetry/log');
const { AI_MARK_SUBJECT, AI_MARK_PRODUCER, markingText, markingKeywords } = require('./documentMarking');
const { deckToSlidesHtml, deckToPlainText } = require('./deckHtml');

const CONTENT_TYPES = Object.freeze({
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

// A generated document is a person-sized artefact, not a data dump. The cap is
// on the SOURCE text: 2 MB of markdown is already a book, and it bounds both
// the browser render and the docx build.
const MAX_CONTENT_CHARS = 2_000_000;

/**
 * Render a normalised deck to a landscape PDF. Same two paths and the same
 * marking contract as renderDocument: Chromium when reachable, pdfkit (plain,
 * `degraded:true`) when not.
 */
async function renderDeckPdf({ deck, theme = null, title = '', marking = null, date = '' } = {}) {
    if (!deck || !Array.isArray(deck.slides)) throw Object.assign(new Error('There are no slides to put in the presentation.'), { errorClass: 'document_empty' });
    const mark = marking && marking.enabled !== false && markingText(marking) ? marking : null;
    const html = deckToSlidesHtml(deck, { theme, marking: mark, date, title });
    let rendered;
    try {
        rendered = await renderPdfViaBrowser(html, { layout: 'slides', marking: mark });
    } catch (e) {
        log.warn(`[documentRenderer] browser PDF unavailable, falling back to pdfkit: ${/** @type {Error} */ (e).message}`);
        const buffer = await renderPdfViaPdfkit(deckToPlainText(deck), { title: title || deck.title, marking: mark });
        return {
            buffer, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: true,
            marking: mark ? { visible: true, metadata: true } : null,
        };
    }
    if (!mark) {
        return { buffer: rendered, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: false, marking: null };
    }
    const stamped = await applyPdfMarkingMetadata(rendered, mark, { title: title || deck.title });
    return {
        buffer: stamped.buffer, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: false,
        marking: { visible: true, metadata: stamped.metadata },
    };
}

/**
 * The PDF a browser would print. Rejects rather than hangs: a wedged render
 * must surface as a step error, not eat the run's whole deadline.
 */
/**
 * Chromium's per-page footer: the page counter on the right and, for a marked
 * document, the marking line on the left of the same 8px row.
 * @param {AiMarking | null} marking
 */
function browserFooterTemplate(marking) {
    const text = markingText(marking);
    const left = text ? `<span style="flex:1;text-align:left">${escapeHtml(text)}</span>` : '';
    return '<div style="font-size:8px;color:#999;width:100%;padding:0 18mm;display:flex;justify-content:space-between">'
        + left
        + '<span style="text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
}

/**
 * Stamp the Art. 50(2) metadata into a finished PDF (the browser path — the
 * pdfkit path writes its Info dictionary at creation). Returns the buffer and
 * whether the metadata landed; `require('pdf-lib')` failing is a documented
 * degraded state, not an error: the visible line has already been printed.
 * pdf-lib has no XMP API, so the Info dictionary is what carries the marking.
 */
async function applyPdfMarkingMetadata(buffer, marking, { title = '' } = {}) {
    if (!marking) return { buffer, metadata: false };
    let PDFDocument;
    try {
        ({ PDFDocument } = require('pdf-lib'));
    } catch (e) {
        log.warn(`[documentRenderer] pdf-lib unavailable, PDF metadata not written: ${/** @type {Error} */ (e).message}`);
        return { buffer, metadata: false };
    }
    try {
        // updateMetadata:false keeps pdf-lib from overwriting Producer/dates
        // with its own defaults before we set ours.
        const doc = await PDFDocument.load(buffer, { updateMetadata: false });
        doc.setTitle(String(title || 'Document'));
        doc.setAuthor(String(marking.org_name || ''));
        doc.setSubject(AI_MARK_SUBJECT);
        doc.setKeywords(markingKeywords(marking));
        doc.setProducer(AI_MARK_PRODUCER);
        doc.setCreator(AI_MARK_PRODUCER);
        const when = marking.generated_at ? new Date(marking.generated_at) : new Date();
        if (!Number.isNaN(when.getTime())) { doc.setCreationDate(when); doc.setModificationDate(when); }
        const out = Buffer.from(await doc.save({ useObjectStreams: false }));
        return { buffer: out, metadata: true };
    } catch (e) {
        log.warn(`[documentRenderer] PDF metadata pass failed, keeping the unmarked bytes: ${/** @type {Error} */ (e).message}`);
        return { buffer, metadata: false };
    }
}

/**
 * @param {string} html
 */
async function renderPdfViaBrowser(html, { timeoutMs = 60_000, layout = 'document', marking = null } = {}) {
    const browserProvider = featureModule('services/browserProvider');
    return browserProvider.withContext({}, async (context) => {
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        // 'load', not 'networkidle': every remote src has already been blanked
        // by the sanitiser, so there is no network to go idle — waiting for it
        // only buys a guaranteed timeout.
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        if (layout === 'slides') {
            // Landscape, zero margin, no header/footer chrome: the slide's own
            // band is the header, and Chromium draws header/footer INSIDE the
            // margin box, which at zero margin would render nothing anyway.
            return page.pdf({
                format: 'A4',
                landscape: true,
                margin: { top: '0', right: '0', bottom: '0', left: '0' },
                printBackground: true,
                displayHeaderFooter: false,
            });
        }
        return page.pdf({
            format: 'A4',
            margin: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: browserFooterTemplate(marking),
        });
    });
}

/**
 * Render a COMPLETE, already-composed HTML document to PDF.
 *
 * The difference from renderPdfViaBrowser above is who owns the paper.
 * renderDocument's own pipeline wraps text in buildPrintHtml and then asks
 * Chromium for A4 with 20/18mm margins, because there the caller supplied
 * prose and somebody has to decide the geometry. A Documents document arrives
 * with its own stylesheet, including its own `@page` rule — an invoice whose
 * header bleeds to the paper edge is a normal invoice — so Chromium is given
 * ZERO margins and the document's CSS decides. Overriding it here would mean
 * every document silently gains an 18mm frame it never asked for, and no
 * amount of CSS in the document could take it back off.
 *
 * `preferCSSPageSize` is the other half of that: without it Chromium keeps the
 * `format` it was handed and treats @page size as advice.
 *
 * Falls back to pdfkit on the same terms as renderDocument — only when the
 * BROWSER is unreachable, never to paper over a bad document — so a self-host
 * without the pwt-runner container still gets a (plainer) PDF. The caller is
 * told which one it got via `degraded`.
 *
 * @param {{ html: string, title?: string, marking?: import('./documentRenderer').AiMarking | null, timeoutMs?: number, allowFallback?: boolean }} args
 *   `html`: a full <!DOCTYPE html> document (see services/documentCompose.js); `marking`: AI Act Art.
 *   50 marking, as resolveMarking returns it; `allowFallback`: false = throw instead of degrading to
 *   the plain PDF
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string, degraded: boolean, marking: object|null}>}
 */
async function renderStyledHtmlToPdf({ html, title = '', marking = null, timeoutMs = 60_000, allowFallback = true } = {}) {
    const source = String(html || '');
    if (!source.trim()) {
        throw Object.assign(new Error('There is no content to put in the document.'), { errorClass: 'document_empty' });
    }
    if (source.length > MAX_CONTENT_CHARS) {
        throw Object.assign(
            new Error(`The document is ${source.length} characters; the limit is ${MAX_CONTENT_CHARS}.`),
            { errorClass: 'document_too_large' },
        );
    }
    const mark = marking && marking.enabled !== false && markingText(marking) ? marking : null;

    let rendered;
    try {
        const browserProvider = featureModule('services/browserProvider');
        rendered = await browserProvider.withContext({}, async (context) => {
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            // 'load', not 'networkidle': documentCompose has already stripped
            // every remote url, so there is no network to go idle and waiting
            // for it only buys a guaranteed timeout.
            await page.setContent(source, { waitUntil: 'load', timeout: timeoutMs });
            return page.pdf({
                preferCSSPageSize: true,
                margin: { top: '0', right: '0', bottom: '0', left: '0' },
                printBackground: true,
                displayHeaderFooter: false,
            });
        });
    } catch (e) {
        if (!allowFallback) throw Object.assign(new Error('Styled PDF rendering is unavailable. Please retry when the renderer is available.'), {
            status:503, errorClass:'document_renderer_unavailable', cause:e,
        });
        log.warn(`[documentRenderer] browser PDF unavailable, falling back to pdfkit: ${/** @type {Error} */ (e).message}`);
        const buffer = await renderPdfViaPdfkit(htmlToPlainish(source), { title, marking: mark });
        return {
            buffer, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: true,
            marking: mark ? { visible: true, metadata: true } : null,
        };
    }

    if (!mark) {
        return { buffer: rendered, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: false, marking: null };
    }
    const stamped = await applyPdfMarkingMetadata(rendered, mark, { title });
    return {
        buffer: stamped.buffer, contentType: CONTENT_TYPES.pdf, format: 'pdf', extension: 'pdf', degraded: false,
        marking: { visible: true, metadata: stamped.metadata },
    };
}

/**
 * The no-browser PDF. Deliberately plain: headings, paragraphs and bullets in
 * one typeface. It exists so the step keeps its promise on a stack without the
 * pwt-runner container, not to compete with the browser render.
 *
 * Takes the ORIGINAL text rather than the HTML — pdfkit cannot lay out markup,
 * and stripping tags back out of generated HTML is a worse job than reading the
 * source lines.
 * @param {string} text
 */
function renderPdfViaPdfkit(text, { title = '', marking = null } = {}) {
    const PDFDocument = require('pdfkit');
    return new Promise((resolve, reject) => {
        // pdfkit writes the Info dictionary from `info` and accepts custom keys
        // on doc.info — AIGenerated rides along as its own entry.
        /** @type {{ Title: string; Producer: string; Creator: string; Author?: string; Subject?: string; Keywords?: string }} */
        const info = { Title: String(title || 'Document'), Producer: AI_MARK_PRODUCER, Creator: AI_MARK_PRODUCER };
        if (marking) {
            info.Author = String(marking.org_name || '');
            info.Subject = AI_MARK_SUBJECT;
            info.Keywords = markingKeywords(marking).join('; ');
        }
        const doc = new PDFDocument({ size: 'A4', margin: 56, info });
        if (marking) {
            doc.info.AIGenerated = 'true';
            doc.info.AIProvider = String(marking.provider || 'unknown');
            doc.info.GeneratedAt = String(marking.generated_at || '');
            doc.info.BeeFlowAutomation = String(marking.automation_id || '');
        }
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        if (title) doc.font('Helvetica-Bold').fontSize(20).text(String(title)).moveDown(1);

        for (const rawLine of String(text ?? '').split(/\r?\n/)) {
            const line = rawLine.replace(/\s+$/, '');
            if (!line.trim()) { doc.moveDown(0.5); continue; }
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
                const size = Math.max(11, 20 - heading[1].length * 2);
                doc.moveDown(0.4).font('Helvetica-Bold').fontSize(size).text(stripInline(heading[2])).moveDown(0.2);
                continue;
            }
            const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
            if (bullet) {
                doc.font('Helvetica').fontSize(11).text(`• ${stripInline(bullet[1])}`, { indent: 12 });
                continue;
            }
            doc.font('Helvetica').fontSize(11).text(stripInline(line));
        }
        const mark = markingText(marking);
        if (mark) {
            // The visible line: trailing, grey, 8 pt — the plain-PDF twin of the
            // browser footer.
            doc.moveDown(1.5).font('Helvetica').fontSize(8).fillColor('#6b6b6b').text(mark).fillColor('#000000');
        }
        doc.end();
    });
}

/**
 * Drop the markdown emphasis/link syntax pdfkit would otherwise print literally.
 * @param {string} s
 */
function stripInline(s) {
    return String(s)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')     // images → alt text
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)') // links keep their target
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
}

/**
 * Crude tags-out for the pdfkit fallback when the author supplied HTML.
 * @param {string} html
 */
function htmlToPlainish(html) {
    return String(html)
        .replace(/<\s*(h[1-6])[^>]*>/gi, (m, tag) => `\n${'#'.repeat(Number(tag[1]))} `)
        .replace(/<\s*li[^>]*>/gi, '\n- ')
        .replace(/<\s*\/?(p|div|br|tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n{3,}/g, '\n\n');
}

module.exports = { CONTENT_TYPES, MAX_CONTENT_CHARS, renderDeckPdf, browserFooterTemplate, applyPdfMarkingMetadata, renderPdfViaBrowser, renderStyledHtmlToPdf, renderPdfViaPdfkit, stripInline, htmlToPlainish };

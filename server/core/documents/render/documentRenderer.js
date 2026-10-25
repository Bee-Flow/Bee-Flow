/**
 * Document Renderer — text in, a real PDF or Word file out.
 *
 * One HTML source feeds both formats, so a PDF and a .docx produced by the same
 * run look like the same document rather than two unrelated exports:
 *
 *     markdown/html
 *       → marked (markdown only)
 *       → sanitizeContentForExport()   ← inert markup, no remote fetches
 *       → buildPrintHtml()             ← self-contained print CSS (see below)
 *       ├→ pdf  : headless Chromium (browserProvider) — or pdfkit, see below
 *       └→ docx : html-to-docx
 *
 * WHY NOT templates/exportTemplate.js's buildExportHTML. That wrapper loads
 * mermaid from jsdelivr and carries an inline bootstrap script, which is right
 * for the notebook editor's diagrams and wrong here: it would make the server
 * fetch a CDN script every time an automation produces a document, hang on an
 * air-gapped self-host, and put remote script into a render whose whole input
 * is untrusted. The wrapper below has no network dependency at all. Its
 * `sanitizeContentForExport` is reused, because that part is exactly right.
 *
 * WHY THE PDF HAS TWO PATHS. The server image deliberately bakes in no Chromium
 * (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the Dockerfile); browserProvider
 * drives a separate pwt-runner container. That container is not part of every
 * deployment — a self-hoster who never set it up would otherwise find that a
 * automation which promises a PDF simply fails. So when no browser can be reached
 * we fall back to pdfkit, which is pure JS and always present. The fallback is
 * plainer (no CSS, no page background, a fixed typeface) and says so in its
 * return value, but the visitor still gets a PDF.
 *
 * The DOCX path never needs a browser.
 *
 * SANITISING IS NOT OPTIONAL HERE. The content is whatever an upstream step
 * produced — model output, a web page, a form answer — and it is about to be
 * loaded into a real browser on the server. sanitizeContentForExport strips
 * script/iframe/event handlers/javascript: URLs and blanks remote image srcs,
 * so rendering cannot be turned into "fetch this URL for me" or worse.
 */

const { sanitizeContentForExport, escapeHtml } = require('../../../templates/exportTemplate');
const log = require('../../../telemetry/log');
const { AI_MARK_SUBJECT, AI_MARK_PRODUCER, markingText, markingFooterHtml, markingKeywords } = require('./documentMarking');
const { deckThemeCss, slidesCss } = require('./deckThemeCss');
const { buildSlidesHtml, deckToSlidesHtml, deckToPlainText, toHtml } = require('./deckHtml');
const { CONTENT_TYPES, MAX_CONTENT_CHARS, renderDeckPdf, browserFooterTemplate, applyPdfMarkingMetadata, renderPdfViaBrowser, renderStyledHtmlToPdf, renderPdfViaPdfkit, stripInline, htmlToPlainish } = require('./documentPdf');

const FORMATS = Object.freeze(['pdf', 'docx']);
const CONTENT_FORMATS = Object.freeze(['markdown', 'html']);
// 'document' is the linear print layout; 'slides' is the landscape deck (PDF
// only — see renderDocument). Unknown values fall back to 'document'.
const LAYOUTS = Object.freeze(['document', 'slides']);

function buildPrintHtml(bodyHtml, { title = '', author = '', date = '', marking = null, extraCss = '' } = {}) {
    const stamp = date || new Date().toISOString().slice(0, 10);
    const heading = title
        ? `<header class="doc-head"><h1 class="doc-title">${escapeHtml(title)}</h1>`
          + `<p class="doc-meta">${escapeHtml([author, stamp].filter(Boolean).join(' · '))}</p></header>`
        : '';
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         font-size: 11pt; line-height: 1.55; color: #1a1a1a; }
  .doc-head { border-bottom: 1px solid #d8d8d8; margin-bottom: 18pt; padding-bottom: 8pt; }
  .doc-title { font-size: 22pt; line-height: 1.2; margin: 0 0 4pt; }
  .doc-meta { font-size: 9pt; color: #6b6b6b; margin: 0; }
  .ai-mark { border-top: 1px solid #d8d8d8; margin-top: 18pt; padding-top: 6pt; font-size: 8pt; color: #6b6b6b; }
  .ai-mark p { margin: 0; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 18pt 0 6pt; break-after: avoid; page-break-after: avoid; }
  h1 { font-size: 17pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; } h4 { font-size: 11pt; }
  p, ul, ol, blockquote, table { margin: 0 0 9pt; }
  li { margin: 0 0 3pt; }
  p, li { orphans: 3; widows: 3; }
  a { color: #14532d; text-decoration: underline; word-break: break-word; }
  code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 9.5pt; }
  pre { background: #f5f5f5; padding: 8pt; border-radius: 3pt; white-space: pre-wrap; break-inside: avoid; }
  blockquote { border-left: 3pt solid #d8d8d8; padding-left: 10pt; color: #4a4a4a; margin-left: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  th, td { border: 1px solid #d8d8d8; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  thead { display: table-header-group; }
  tr, img { break-inside: avoid; page-break-inside: avoid; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid #d8d8d8; margin: 14pt 0; }
</style>${extraCss ? `\n<style>${String(extraCss).replace(/<\/style/gi, '')}</style>` : ''}</head>
<body>${heading}<main>${bodyHtml}</main>${markingFooterHtml(marking)}</body></html>`;
}

/**
 * The DECK document: landscape pages that read as slides.
 *
 * Built for the shape a corporate-finance memorandum actually has — the
 * PowerPoint every Dutch deal advisor sends a bank: a cover, then one page per
 * section with a title band across the top. The transformation is
 * deliberately dumb and deterministic: the `<h1>` becomes the cover, every
 * `<h2>` starts a new slide whose text becomes the band, everything between
 * two h2s is that slide's body. The AUTHOR controls the deck by controlling
 * the headings, which is exactly the control a markdown writer already has.
 *
 * The COLOURS AND THE BRAND come from a deck theme (the org's document house
 * style, see core/documents/documentHouseStyle.js houseStyleDeckTheme), never
 * from this file: the band is `theme.accent`, the brand mark in the band is
 * `theme.brandName` (absent when the org has none), the cover carries the
 * logo when there is one. The neutral default is what an org without a house
 * style gets.
 *
 * A section longer than one page flows onto continuation pages rather than
 * being clipped — a deck with an overfull slide is ugly, a deck with a slide
 * whose bottom half is silently missing is wrong. Tables are kept whole.
 *
 * PDF only. The docx path keeps the linear document layout regardless of
 * `layout`: html-to-docx honours too little CSS to fake pages, and a Word file
 * exists to be edited as a document anyway.
 */

/**
 * html-to-docx writes the core properties it is given (title, subject,
 * creator, keywords, description); custom properties such as a bespoke
 * AIGenerated field are not supported by the library, so the marking rides in
 * keywords + description. Documented limitation. The visible line is the
 * trailing `<p class="ai-mark">` buildPrintHtml already put in the HTML.
 */
function docxOptions({ title = '', marking = null, style = null } = {}) {
    const opts = {
        table: { row: { cantSplit: true } },
        footer: true,
        pageNumber: true,
        // House style (core/documents/docxHouseStyle.js): margin, font,
        // fontSize, header/footer HTML. The marking keys below always win.
        ...(style && typeof style === 'object' ? style : {}),
        title: String(title || ''),
    };
    if (marking) {
        opts.subject = AI_MARK_SUBJECT;
        opts.creator = String(marking.org_name || '');
        opts.keywords = markingKeywords(marking);
        opts.description = markingText(marking) || AI_MARK_SUBJECT;
    }
    return opts;
}

async function renderDocx(html, { title = '', marking = null, style = null } = {}) {
    let HTMLtoDOCX = require('@turbodocx/html-to-docx');
    if (HTMLtoDOCX.default) HTMLtoDOCX = HTMLtoDOCX.default;
    // html-to-docx takes the header and footer HTML as POSITIONAL arguments
    // (html, header, options, footer); as option keys they are ignored.
    const { headerHTML = null, footerHTML = null, ...styleOpts } = (style && typeof style === 'object') ? style : {};
    const out = await HTMLtoDOCX(html, headerHTML, docxOptions({ title, marking, style: styleOpts }), footerHTML);
    return Buffer.from(out);
}

/**
 * Render `content` to a document.
 *
 * `docxStyle` ({ css, opts, inline } from core/documents/docxHouseStyle.js
 * buildDocxStylingFromHouseStyle) dresses a .docx in the org's Word house style: `inline` (heading
 * fonts, sizes, colours) goes onto the heading tags, the opts (margin, font, header, footer) go to
 * html-to-docx. The CSS joins the print stylesheet, but html-to-docx does not read <style>, so it is
 * not what styles the .docx. Ignored for a PDF.
 *
 * @param {import('./documentRenderer.types').RenderInput} [input]
 * @returns {Promise<{buffer: Buffer, contentType: string, format: string,
 *                    extension: string, degraded: boolean,
 *                    marking: null | {visible: boolean, metadata: boolean}}>}
 *   `degraded` is true when the PDF came from the pdfkit fallback — the caller records it so
 *   "why does this PDF look plain?" has an answer in the run log.
 *   `marking` is null for an unmarked document; for a marked one it says
 *   whether the visible line and the file metadata made it into the output.
 */
async function renderDocument({
    content,
    contentFormat = 'markdown',
    title = '',
    author = '',
    format = 'pdf',
    layout = 'document',
    marking = null,
    theme = null,
    docxStyle = null,
} = {}) {
    const fmt = FORMATS.includes(format) ? format : 'pdf';
    const cFmt = CONTENT_FORMATS.includes(contentFormat) ? contentFormat : 'markdown';
    const lay = LAYOUTS.includes(layout) ? layout : 'document';
    const mark = marking && marking.enabled !== false && markingText(marking) ? marking : null;
    const text = String(content ?? '');
    if (!text.trim()) throw Object.assign(new Error('There is no content to put in the document.'), { errorClass: 'document_empty' });
    if (text.length > MAX_CONTENT_CHARS) {
        throw Object.assign(
            new Error(`The content is ${text.length} characters; the limit is ${MAX_CONTENT_CHARS}.`),
            { errorClass: 'document_too_large' },
        );
    }

    const body = sanitizeContentForExport(toHtml(text, cFmt));
    // The deck layout is a PDF idea: pages you present. Word gets the linear
    // document whatever `layout` says — html-to-docx honours too little CSS to
    // fake slides, and a .docx exists to be edited as a document.
    const slides = lay === 'slides' && fmt === 'pdf';
    const html = slides
        ? buildSlidesHtml(body, { title, author, marking: mark, theme })
        : buildPrintHtml(body, { title, author, marking: mark, extraCss: fmt === 'docx' && docxStyle ? docxStyle.css : '' });

    if (fmt === 'docx') {
        // html-to-docx ignores <style> blocks: the house style's heading
        // fonts, sizes and colours only reach the file as inline attributes.
        const docxHtml = docxStyle && docxStyle.inline
            ? require('../docxHouseStyle').applyInlineStyles(html, docxStyle.inline)
            : html;
        return {
            buffer: await renderDocx(docxHtml, { title, marking: mark, style: docxStyle ? docxStyle.opts : null }),
            contentType: CONTENT_TYPES.docx, format: 'docx', extension: 'docx', degraded: false,
            marking: mark ? { visible: true, metadata: true } : null,
        };
    }

    let rendered;
    try {
        rendered = await renderPdfViaBrowser(html, { layout: slides ? 'slides' : 'document', marking: mark });
    } catch (e) {
        // Only the BROWSER being unavailable earns the fallback. A malformed
        // document is a real error and must not be quietly downgraded into a
        // plain-looking PDF nobody knows is wrong.
        log.warn(`[documentRenderer] browser PDF unavailable, falling back to pdfkit: ${e.message}`);
        const buffer = await renderPdfViaPdfkit(cFmt === 'html' ? htmlToPlainish(text) : text, { title, marking: mark });
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

module.exports = {
    renderDocument,
    renderStyledHtmlToPdf,
    renderDeckPdf,
    deckToSlidesHtml,
    markingKeywords,
    markingText,
    FORMATS,
    CONTENT_FORMATS,
    LAYOUTS,
    CONTENT_TYPES,
    MAX_CONTENT_CHARS,
    AI_MARK_SUBJECT,
    AI_MARK_PRODUCER,
    _test: {
        toHtml, buildPrintHtml, buildSlidesHtml, renderPdfViaPdfkit, stripInline, htmlToPlainish,
        markingText, markingFooterHtml, browserFooterTemplate, markingKeywords, applyPdfMarkingMetadata, docxOptions,
        deckToSlidesHtml, deckToPlainText, deckThemeCss, slidesCss,
    },
};

/**
 * An AI content marking as compliance/marking.js resolveMarking returns it.
 * @typedef {{ enabled?: boolean, footer_text?: string, provider?: string, generated_at?: string, automation_id?: string, org_name?: string }} AiMarking
 */

/** @typedef {import('../office/officegen').DeckThemeInput} DeckThemeInput */

/** @typedef {import('../office/officegen').DeckSlide} DeckSlide */

/** @typedef {ReturnType<typeof deckThemeCss>} DeckThemeCss */

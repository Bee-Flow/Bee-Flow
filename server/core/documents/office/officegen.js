/**
 * officegen — generate REAL binary office files (spreadsheets, word docs and
 * presentations) so automations can save proper `.xlsx`/`.ods`/
 * `.docx`/`.odt`/`.pptx` to Nextcloud (and elsewhere), not just CSV/plain text.
 *
 * Spreadsheets and ODF documents are built directly as their ZIP packages with
 * `jszip` (already a dependency) — no spreadsheet library needed. DOCX uses the
 * `docx` library (already a dependency); PPTX uses `pptxgenjs` (pure JS, also
 * on jszip). A PUT of these bytes to Nextcloud WebDAV opens straight in
 * Nextcloud Office / Collabora / Excel / Word / PowerPoint — the mimetype is
 * recognised from the extension + bytes (no template endpoint needed). See
 * research: docs.nextcloud.com WebDAV basic + richdocuments.
 *
 * Everything here is pure (no network, no DB) so it is cheap to unit-test.
 * The presentation builder in particular NEVER hands pptxgenjs a `path`: that
 * option is `fs.readFileSync` / `https.get` inside the library, i.e. a local
 * file read or a server-side fetch driven by untrusted deck content. Images
 * arrive as data: URLs or not at all.
 */

const JSZip = require('jszip');
const { coerceCell, rowsToMatrix } = require('./rowsMatrix');
const { xmlEscape, colLetter, sanitizeSheetName, buildXlsxWorkbook } = require('./xlsxWorkbook');
const { FOOTER_Y, BODY_BOTTOM, pptxHex, ensureResolvedTheme, deckTheme, fitBox, bodyTop, addBulletsBody, footerLineFor, chromeObjects, defineMasters } = require('./officegenPptxBase');
const { addTitle, addCover, addTableSlide, addImageSlide, addQuoteSlide, addTwoColumnSlide, addSectionSlide, addClosingSlide, addChartSlide, addStatsSlide, addCardsSlide, addTimelineSlide } = require('./officegenPptxSlides');
const { CONTENT_TYPES, buildOds, buildOdt, parseBlocks } = require('./officegenOdf');

// ── Small helpers ───────────────────────────────────────────────────────
/** Pick the output format from an explicit arg, else the path extension, else fallback. */
function resolveOfficeFormat(explicit, path, allowed, fallback) {
    const e = explicit ? String(explicit).toLowerCase().replace(/^\./, '') : '';
    if (allowed.includes(e)) return e;
    const ext = (String(path || '').split('.').pop() || '').toLowerCase();
    if (allowed.includes(ext)) return ext;
    return fallback;
}

/** Ensure `path` ends with `.ext` (appends if the extension differs/absent). */
function ensureExt(path, ext) {
    const p = String(path || '').replace(/\/+$/, '');
    const cur = (p.split('.').pop() || '').toLowerCase();
    return cur === ext ? p : `${p}.${ext}`;
}

// ── DOCX (via the `docx` library) ───────────────────────────────────────
async function buildDocx(content, title) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const blocks = parseBlocks(content);
    /** @type {Paragraph[]} */
    const children = [];
    if (title && String(title).trim()) {
        children.push(new Paragraph({ text: String(title).trim(), heading: HeadingLevel.TITLE }));
    }
    /** @type {Record<string, string>} */
    const HEAD = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
    for (const b of blocks) {
        if (b.type === 'blank') children.push(new Paragraph({}));
        else if (b.type === 'heading') children.push(new Paragraph({ text: b.text, heading: HEAD[b.level] || HeadingLevel.HEADING_3 }));
        else if (b.type === 'bullet') children.push(new Paragraph({ text: b.text, bullet: { level: 0 } }));
        else children.push(new Paragraph({ children: [new TextRun(b.text)] }));
    }
    if (!children.length) children.push(new Paragraph({}));
    const doc = new Document({ sections: [{ children }] });
    return Packer.toBuffer(doc);
}

// ── CSV (RFC 4180 text — the one non-ZIP format in this module) ─────────
/** Delimiters we accept; anything else falls back to `;` (Dutch Excel's default). */
const CSV_DELIMITERS = [';', ',', '\t'];

function csvCell(val, delimiter) {
    const v = coerceCell(val);
    // Numbers and booleans can never contain a delimiter/quote/formula trigger,
    // so they are written bare — a NUMBER -5 stays `-5`, never prefixed/quoted.
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    let s = String(v);
    // Formula-injection neutralisation FIRST (before quoting): cell values come
    // from customer e-mail and from a model, and the file gets double-clicked
    // into Excel — a `=cmd|...` cell there is code execution on the operator's
    // machine. Excel treats a leading `=` `+` `-` `@` TAB or CR as a formula,
    // so those STRING cells get a literal `'` prefix (rendered as plain text).
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    // RFC 4180 quoting: wrap cells containing the delimiter, quotes or line
    // breaks in `"…"`, doubling any embedded quote.
    if (s.includes(delimiter) || s.includes('"') || s.includes('\r') || s.includes('\n')) {
        s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

// ── PPTX (via pptxgenjs) ────────────────────────────────────────────────
//
// Geometry is LAYOUT_16x9: 10in × 5.625in. Everything below is in inches.
// Three masters carry the look so a slide only says what it holds: BF_COVER
// (the cover and the closing slide), BF_CONTENT (every content slide) and
// BF_SECTION (a divider). The LOOK is a RESOLVED deck theme —
// core/documents/deckThemeOptions.js resolveDeckTheme: preset, colours with
// contrast already enforced, typefaces, cover/table style, logo placement —
// so this module never chooses a colour, only places what it is given. The
// neutral theme is what a caller that passes nothing gets.

const { resolveDeckTheme, slideVariant } = require('../deckThemeOptions');

/**
 * Stamp keywords + description into docProps/core.xml — pptxgenjs writes only
 * title/subject/creator/revision, and the Art. 50(2) marking wants the same
 * keyword list the PDF and DOCX paths carry. Idempotent: existing elements are
 * replaced, not duplicated.
 */
async function stampPptxCoreProperties(buffer, { keywords = [], description = '' } = {}) {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file('docProps/core.xml');
    if (!entry) return buffer;
    let xml = await entry.async('string');
    xml = xml.replace(/<cp:keywords>[\s\S]*?<\/cp:keywords>/g, '').replace(/<dc:description>[\s\S]*?<\/dc:description>/g, '');
    const extra = (keywords.length ? `<cp:keywords>${xmlEscape(keywords.join('; '))}</cp:keywords>` : '')
        + (description ? `<dc:description>${xmlEscape(description)}</dc:description>` : '');
    xml = xml.replace('</cp:coreProperties>', `${extra}</cp:coreProperties>`);
    zip.file('docProps/core.xml', xml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** pptxgenjs' write() has returned different binary types across majors. */
async function toBuffer(out) {
    if (Buffer.isBuffer(out)) return out;
    if (out instanceof Uint8Array) return Buffer.from(out);
    if (out instanceof ArrayBuffer) return Buffer.from(out);
    if (out && typeof out.arrayBuffer === 'function') return Buffer.from(await out.arrayBuffer());
    if (typeof out === 'string') return Buffer.from(out, 'binary');
    throw new Error('pptxgenjs returned an unexpected output type');
}

/**
 * Build a .pptx from a NORMALISED deck (core/documents/deckModel.js).
 *
 * @param {object} args
 * @param {object} args.deck      normalizeDeck() output; slide images must already be PNG/JPEG data: URLs
 * @param {object} [args.theme]   a RESOLVED deck theme (deckThemeOptions.resolveDeckTheme); neutral when absent
 * @param {string} [args.title]   overrides deck.title on the cover and in the file properties
 * @param {string} [args.author]
 * @param {string} [args.date]
 * @param {object} [args.marking] FLAT: { subject, creator, keywords:[], description, footerLine } or null
 * @returns {Promise<{buffer: Buffer, contentType: string, format: 'pptx', slideCount: number}>}
 */
async function buildPresentation({ deck, theme = null, title = null, author = null, date = null, marking = null } = {}) {
    if (!deck || !Array.isArray(deck.slides)) throw new Error('buildPresentation needs a normalised deck');
    const PptxGenJS = require('pptxgenjs');
    const th = deckTheme(theme);
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    pptx.theme = { headFontFace: th.titleFont, bodyFontFace: th.bodyFont };
    pptx.title = String(title || deck.title || 'Presentation').slice(0, 200);
    pptx.author = String((marking && marking.creator) || author || th.brandName || 'Bee Flow').slice(0, 120);
    pptx.company = String(th.brandName || 'Bee Flow').slice(0, 120);
    pptx.subject = String((marking && marking.subject) || '').slice(0, 200);
    pptx.revision = '1';

    defineMasters(pptx, th, marking);
    addCover(pptx, deck, th, { title, author, date, notes: deck.coverNotes });

    // An emphasis slide (style accent/dark) paints on its own master, defined
    // the first time one is needed, with the theme re-resolved on that surface.
    const variants = {};
    const themeFor = (style) => {
        if (!style || style === th.variant || th.template) return { th, master: 'BF_CONTENT' };
        if (!variants[style]) {
            const vt = deckTheme(slideVariant(theme && typeof theme.titleStyle === 'string' ? theme : ensureResolvedTheme(theme) || resolveDeckTheme(null), style));
            const master = `BF_CONTENT_${style.toUpperCase()}`;
            pptx.defineSlideMaster({
                title: master,
                background: { color: vt.background },
                objects: chromeObjects(vt, marking, { onDark: true }),
                slideNumber: vt.slideNumbers ? { x: 9.2, y: FOOTER_Y, w: 0.5, h: 0.3, fontSize: 9, color: vt.muted, fontFace: vt.bodyFont, align: 'right' } : undefined,
            });
            variants[style] = { th: vt, master };
        }
        return variants[style];
    };

    let count = 1;
    for (const s of deck.slides) {
        const { th: st, master } = themeFor(s.style);
        const top = bodyTop(st);
        let slide;
        switch (s.layout) {
            case 'section':
                slide = addSectionSlide(pptx, s, th);
                break;
            case 'closing':
                slide = addClosingSlide(pptx, s, th);
                break;
            case 'title':
                slide = addCover(pptx, { title: s.title, subtitle: s.body || s.bullets.map((b) => b.text).join(' · ') || null }, th, { title: s.title });
                break;
            default: {
                slide = pptx.addSlide({ masterName: master });
                addTitle(slide, s.title, st);
                const box = { x: 0.5, y: top, w: 9, h: BODY_BOTTOM - top };
                if (s.layout === 'chart' && s.chart) addChartSlide(pptx, slide, s, st, top);
                else if (s.layout === 'stats' && s.stats) addStatsSlide(slide, s, st, top);
                else if (s.layout === 'timeline' && s.steps) addTimelineSlide(slide, s, st, top);
                else if (s.layout === 'table' && s.table) addTableSlide(slide, s, st, top);
                else if (s.layout === 'image' && s.image && s.image.dataUrl) addImageSlide(slide, s, st, top);
                else if (s.layout === 'quote' && s.quote) addQuoteSlide(slide, s, st, top);
                else if (s.layout === 'two_column' && s.columns) addTwoColumnSlide(slide, s, st, top);
                else if (s.layout === 'cards' && s.cards) addCardsSlide(slide, s, st, top);
                else addBulletsBody(slide, s, st, box);
            }
        }
        if (s.notes) slide.addNotes(String(s.notes));
        count += 1;
    }

    let buffer = await toBuffer(await pptx.write({ outputType: 'nodebuffer', compression: true }));
    if (marking && ((marking.keywords && marking.keywords.length) || marking.description)) {
        buffer = await stampPptxCoreProperties(buffer, { keywords: marking.keywords || [], description: marking.description || '' });
    }
    return { buffer, contentType: CONTENT_TYPES.pptx, format: 'pptx', slideCount: count };
}

// ── Public builders ─────────────────────────────────────────────────────
/**
 * Build a spreadsheet from a row matrix.
 * @returns {Promise<{buffer: Buffer, contentType: string, format: string}>}
 */
async function buildSpreadsheet({ matrix, sheetName, format = 'xlsx' }) {
    const fmt = format === 'ods' ? 'ods' : 'xlsx';
    const m = Array.isArray(matrix) ? matrix : [];
    const buffer = fmt === 'ods' ? await buildOds(m, sheetName) : await buildXlsxWorkbook([{ name: sheetName, matrix: m }]);
    return { buffer, contentType: CONTENT_TYPES[fmt], format: fmt };
}

/**
 * Build a CSV file from a row matrix (same matrix shape as `buildSpreadsheet`,
 * produced by `rowsToMatrix`). Synchronous — plain string work, no ZIP. The
 * UTF-8 BOM is on by default: Dutch Excel renders `Ø`/`é` as mojibake without
 * it. Every row (including the last) ends in `eol` — RFC 4180 allows either,
 * and a final line break is what Excel itself writes + makes appending safe.
 * @returns {{buffer: Buffer, contentType: string, format: string}}
 */
function buildCsv({ matrix, delimiter = ';', bom = true, eol = '\r\n' }) {
    const delim = CSV_DELIMITERS.includes(delimiter) ? delimiter : ';';
    const m = Array.isArray(matrix) ? matrix : [];
    const body = m.map((row) => row.map((v) => csvCell(v, delim)).join(delim) + eol).join('');
    const buffer = Buffer.from((bom ? '\uFEFF' : '') + body, 'utf8');
    return { buffer, contentType: CONTENT_TYPES.csv, format: 'csv' };
}

/**
 * Build a word-processor document from text/Markdown.
 * @returns {Promise<{buffer: Buffer, contentType: string, format: string}>}
 */
async function buildDocument({ content, title, format = 'docx' }) {
    const fmt = format === 'odt' ? 'odt' : 'docx';
    const buffer = fmt === 'odt' ? await buildOdt(content, title) : await buildDocx(content, title);
    return { buffer, contentType: CONTENT_TYPES[fmt], format: fmt };
}

module.exports = {
    buildSpreadsheet,
    buildCsv,
    buildDocument,
    buildPresentation,
    rowsToMatrix,
    coerceCell,
    resolveOfficeFormat,
    ensureExt,
    CONTENT_TYPES,
    // exported for tests
    _internal: { colLetter, parseBlocks, sanitizeSheetName, stampPptxCoreProperties, deckTheme, pptxHex, footerLineFor, fitBox },
};

/** @typedef {Parameters<typeof coerceCell>[0]} CellValue */

/** @typedef {ReturnType<typeof deckTheme>} DeckTheme */

/** @typedef {ReturnType<typeof resolveDeckTheme>} ResolvedDeckTheme */

/**
 * A resolved theme, or a bare palette (accent/ink/font/logo/brand) as tests and older callers hand it.
 * @typedef {Partial<ResolvedDeckTheme> & { ink?: string, fontFace?: string, deck?: unknown, logoAspect?: number }} DeckThemeInput
 */

/** @typedef {{ image: import('pptxgenjs').default.ImageProps, text?: undefined } | { text: import('pptxgenjs').default.TextProps, image?: undefined }} ChromeObject */

/** @typedef {{ align?: string, valign?: string }} FitOptions */

/** @typedef {NonNullable<import('pptxgenjs').default.SlideMasterProps['objects']>[number]} MasterObject */

/** @typedef {{ subject?: string, creator?: string, keywords?: string[], description?: string, footerLine?: string }} DeckMarking */

/** @typedef {{ text: string, level?: number }} DeckBullet */

/** @typedef {{ dataUrl: string, aspect?: number, alt?: string }} DeckImage */

/** @typedef {{ type: string, title: string, unit: string, stacked: boolean, showValues: boolean, labels: string[], series: Array<{ name: string, values: number[] }> }} DeckChart */

/**
 * A slide of a normalised deck (core/documents/deckModel.js).
 * @typedef {object} DeckSlide
 * @property {string} [layout]
 * @property {string} [style]
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [notes]
 * @property {DeckBullet[]} bullets
 * @property {{ columns: string[], rows: unknown[][] }} [table]
 * @property {DeckImage} [image]
 * @property {{ text: string, attribution?: string }} [quote]
 * @property {Array<{ title?: string, bullets: DeckBullet[] }>} [columns]
 * @property {DeckChart} [chart]
 * @property {Array<{ value: string, label?: string, delta?: string, icon?: string, iconDataUrl?: string }>} [stats]
 * @property {Array<{ title?: string, text?: string, icon?: string, iconDataUrl?: string, image?: DeckImage }>} [cards]
 * @property {Array<{ title: string, text?: string }>} [steps]
 */

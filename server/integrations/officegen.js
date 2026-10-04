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

// ── MIME types (match Nextcloud's mimetypemapping.json) ─────────────────
const CONTENT_TYPES = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    csv: 'text/csv',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ── Small helpers ───────────────────────────────────────────────────────
function xmlEscape(v) {
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function isNumericCell(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/** 0-based column index → spreadsheet column letter (0→A, 26→AA). */
function colLetter(n) {
    let s = '';
    n += 1;
    while (n > 0) {
        const m = (n - 1) % 26;
        s = String.fromCharCode(65 + m) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** Coerce an arbitrary value into a spreadsheet/document-safe cell value. */
function coerceCell(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Normalise `rows` into a 2D matrix of cell values (first row = header).
 *  - rows of OBJECTS: columns come from `columns` (if given) else the union of
 *    keys in first-seen order; header row = the column names.
 *  - rows of ARRAYS: used verbatim; `columns` (if given) is prepended as header.
 */
function rowsToMatrix(rows, columns) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length && list.every((r) => Array.isArray(r))) {
        const m = list.map((r) => r.map(coerceCell));
        if (Array.isArray(columns) && columns.length) m.unshift(columns.map(coerceCell));
        return m;
    }
    let cols = Array.isArray(columns) && columns.length ? columns.slice() : [];
    if (!cols.length) {
        const seen = new Set();
        for (const r of list) {
            if (r && typeof r === 'object') {
                for (const k of Object.keys(r)) {
                    if (!seen.has(k)) { seen.add(k); cols.push(k); }
                }
            }
        }
    }
    const matrix = [cols.map(coerceCell)];
    for (const r of list) {
        matrix.push(cols.map((c) => coerceCell(r && typeof r === 'object' ? r[c] : undefined)));
    }
    return matrix;
}

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

function sanitizeSheetName(name) {
    const s = String(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
    return s || 'Sheet1';
}

// ── XLSX (OOXML, minimal, inline strings — no shared-strings table) ──────
async function buildXlsx(matrix, sheetName) {
    const name = sanitizeSheetName(sheetName);
    const rowsXml = matrix.map((row, ri) => {
        const cells = row.map((val, ci) => {
            if (val === null || val === undefined || val === '') return '';
            const ref = `${colLetter(ci)}${ri + 1}`;
            if (isNumericCell(val)) return `<c r="${ref}"><v>${val}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');

    const zip = new JSZip();
    zip.file('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '</Types>');
    zip.file('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>');
    zip.file('xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>');
    zip.file('xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>');
    zip.file('xl/worksheets/sheet1.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rowsXml}</sheetData></worksheet>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── ODS (ODF spreadsheet) ───────────────────────────────────────────────
function odsCell(val) {
    if (val === null || val === undefined || val === '') return '<table:table-cell/>';
    if (isNumericCell(val)) {
        return `<table:table-cell office:value-type="float" office:value="${val}"><text:p>${xmlEscape(val)}</text:p></table:table-cell>`;
    }
    return `<table:table-cell office:value-type="string"><text:p>${xmlEscape(val)}</text:p></table:table-cell>`;
}

async function buildOds(matrix, sheetName) {
    const name = sanitizeSheetName(sheetName);
    const rows = matrix.map((row) => `<table:table-row>${row.map(odsCell).join('')}</table:table-row>`).join('');
    const content =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
        '<office:body><office:spreadsheet>' +
        `<table:table table:name="${xmlEscape(name)}">${rows}</table:table>` +
        '</office:spreadsheet></office:body></office:document-content>';
    return packOdf(CONTENT_TYPES.ods, content);
}

// ── DOCX (via the `docx` library) ───────────────────────────────────────
async function buildDocx(content, title) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const blocks = parseBlocks(content);
    const children = [];
    if (title && String(title).trim()) {
        children.push(new Paragraph({ text: String(title).trim(), heading: HeadingLevel.TITLE }));
    }
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

// ── ODT (ODF text) ──────────────────────────────────────────────────────
async function buildOdt(content, title) {
    const blocks = parseBlocks(content);
    const body = [];
    if (title && String(title).trim()) body.push(`<text:h text:outline-level="1">${xmlEscape(String(title).trim())}</text:h>`);
    for (const b of blocks) {
        if (b.type === 'blank') body.push('<text:p/>');
        else if (b.type === 'heading') body.push(`<text:h text:outline-level="${b.level}">${xmlEscape(b.text)}</text:h>`);
        else if (b.type === 'bullet') body.push(`<text:p>• ${xmlEscape(b.text)}</text:p>`);
        else body.push(`<text:p>${xmlEscape(b.text)}</text:p>`);
    }
    const contentXml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">' +
        `<office:body><office:text>${body.join('')}</office:text></office:body></office:document-content>`;
    return packOdf(CONTENT_TYPES.odt, contentXml);
}

/**
 * Pack an ODF document. ODF requires the `mimetype` entry FIRST and STORED
 * (uncompressed) so the type can be sniffed from a fixed offset.
 */
async function packOdf(mimetype, contentXml) {
    const zip = new JSZip();
    zip.file('mimetype', mimetype, { compression: 'STORE' });
    zip.file('META-INF/manifest.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
        `<manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        '</manifest:manifest>');
    zip.file('content.xml', contentXml);
    // An (empty) styles.xml is part of every real ODF package, and SheetJS
    // refuses to READ an .ods without one. Without it the ledger this tool
    // created on run 1 could not be appended to on run 2
    // (nextcloud_create_spreadsheet ifExists:"append").
    zip.file('styles.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>');
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Parse plain text / light Markdown into blocks for docx/odt rendering. */
function parseBlocks(content) {
    const lines = String(content == null ? '' : content).replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { blocks.push({ type: 'blank' }); continue; }
        let m;
        if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, text: stripInline(m[2]) }); continue; }
        if ((m = /^[-*]\s+(.*)$/.exec(line))) { blocks.push({ type: 'bullet', text: stripInline(m[1]) }); continue; }
        blocks.push({ type: 'para', text: stripInline(line) });
    }
    return blocks;
}

/** Strip light Markdown emphasis markers so they don't render literally. */
function stripInline(text) {
    return String(text)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\*)\*(?!\*)(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1');
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

const { resolveDeckTheme, slideVariant, readableOn, mix: mixHex } = require('../core/documents/deckThemeOptions');
const NEUTRAL_DECK_THEME = Object.freeze(resolveDeckTheme(null));

const SLIDE_W = 10;
const SLIDE_H = 5.625;
const BAND_H = 0.85;
const FOOTER_Y = 5.15;
const BODY_BOTTOM = 5.0;

const DATA_IMAGE_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** pptxgenjs wants `RRGGBB`; the theme carries CSS `#rgb`/`#rrggbb`. */
function pptxHex(value, fallback) {
    const raw = String(value ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return raw.split('').map((c) => c + c).join('').toUpperCase();
    return fallback;
}

/**
 * A theme that is not yet RESOLVED (no `titleStyle`) is a bare palette —
 * accent/ink/font/logo/brand — as tests and older callers hand it. Resolve
 * it through the same rules the house style goes through, so contrast and
 * derived colours are never skipped just because the caller was terse.
 */
function ensureResolvedTheme(theme) {
    if (!theme || typeof theme !== 'object') return null;
    if (typeof theme.titleStyle === 'string') return theme;
    const base = {
        enabled: true,
        accent: theme.accent,
        ink: theme.ink || theme.text,
        muted: theme.muted,
        font: 'sans',
        companyName: theme.brandName,
        companyTagline: theme.tagline,
        footerText: theme.footerText,
        logoDataUrl: theme.logoDataUrl,
        logoWidthMm: theme.logoWidthIn ? Number(theme.logoWidthIn) * 25.4 : undefined,
    };
    const face = theme.fontFace || theme.bodyFont;
    return resolveDeckTheme(base, theme.deck || null, {
        ...(face ? { bodyFont: face } : {}),
        ...(theme.preset ? { preset: theme.preset } : {}),
        ...(theme.logoPlacement ? { logoPlacement: theme.logoPlacement } : {}),
    });
}

/** A complete theme with every colour valid for pptxgenjs and every field present. */
function deckTheme(theme) {
    // Measured by the renderer on the theme as given; a bare palette loses
    // it in ensureResolvedTheme, so read it before.
    const measuredAspect = theme && Number(theme.logoAspect) > 0 ? Number(theme.logoAspect) : null;
    theme = ensureResolvedTheme(theme);
    const t = { ...NEUTRAL_DECK_THEME, ...(theme && typeof theme === 'object' ? theme : {}) };
    const hex = (k) => pptxHex(t[k], pptxHex(NEUTRAL_DECK_THEME[k], '1A1D21'));
    return {
        preset: t.preset,
        accent: hex('accent'),
        accent2: hex('accent2'),
        background: hex('background'),
        text: hex('text'),
        muted: hex('muted'),
        onAccent: hex('onAccent'),
        accentOnSlide: hex('accentOnSlide'),
        titleStyle: ['band', 'rule', 'plain'].includes(t.titleStyle) ? t.titleStyle : 'band',
        bandColor: t.bandColor ? pptxHex(t.bandColor, hex('accent')) : null,
        titleColor: hex('titleColor'),
        titleFont: String(t.titleFont || t.fontFace || 'Calibri').slice(0, 60),
        bodyFont: String(t.bodyFont || t.fontFace || 'Calibri').slice(0, 60),
        coverStyle: ['accent', 'light', 'split'].includes(t.coverStyle) ? t.coverStyle : 'accent',
        tableStyle: ['banded', 'lines', 'minimal'].includes(t.tableStyle) ? t.tableStyle : 'banded',
        tableHeaderFill: hex('tableHeaderFill'),
        tableHeaderText: hex('tableHeaderText'),
        tableBand: hex('tableBand'),
        tableLine: hex('tableLine'),
        logoDataUrl: DATA_IMAGE_RE.test(String(t.logoDataUrl || '').replace(/\s+/g, '')) ? String(t.logoDataUrl).replace(/\s+/g, '') : '',
        // A partial theme that brings a logo but no placement gets the footer,
        // not the neutral theme's 'none' (which only means "it had no logo").
        logoPlacement: ['footer', 'corner', 'cover', 'none'].includes(theme && theme.logoPlacement) ? theme.logoPlacement : 'footer',
        logoWidthIn: Math.min(Math.max(Number(t.logoWidthIn) || 0.95, 0.3), 2.5),
        // Measured by the renderer; 2.5 (a wide wordmark) when it could not be.
        logoAspect: measuredAspect || (Number(t.logoAspect) > 0 ? Number(t.logoAspect) : 2.5),
        slideNumbers: t.slideNumbers !== false,
        brandOnSlides: t.brandOnSlides !== false,
        chartColors: (Array.isArray(t.chartColors) && t.chartColors.length ? t.chartColors : NEUTRAL_DECK_THEME.chartColors || []).map((c) => pptxHex(c, hex('accent'))),
        statFill: pptxHex(t.statFill, hex('tableBand')),
        // A template deck's pictures (already validated by the theme model).
        template: t.template && typeof t.template === 'object' && t.template.cover && t.template.content ? t.template : null,
        titleInset: Math.min(Math.max(Number(t.titleInset) || 0, 0), 0.5),
        glass: !!t.glass,
        brandName: String(t.brandName || '').slice(0, 80),
        tagline: String(t.tagline || '').slice(0, 120),
        footerText: String(t.footerText || '').slice(0, 200),
    };
}

/**
 * Only inline PNG/JPEG bytes reach pptxgenjs. SVG would be written as a broken
 * "png preview" and WebP is not a PowerPoint image type — the renderer
 * rasterises both before calling this; here anything else is refused.
 */
function assertDataImage(dataUrl, what) {
    const s = String(dataUrl || '').replace(/\s+/g, '');
    if (!DATA_IMAGE_RE.test(s)) {
        throw Object.assign(new Error(`${what}: only PNG or JPEG data: URLs can be placed in a presentation.`), { errorClass: 'deck_image_unsupported' });
    }
    return s;
}

/** The fill of a card (a KPI tile, a column): a tint on a plain slide, frosted on a picture. */
function cardFill(th) {
    return th.glass ? { color: th.text, transparency: 84 } : { color: th.statFill };
}

/** The template's overlay pictures (a logo) as master objects, boxes as fractions of the slide. */
function templateOverlayObjects(side) {
    return (side && Array.isArray(side.overlays) ? side.overlays : []).map((o) => ({
        image: { x: o.x * SLIDE_W, y: o.y * SLIDE_H, w: o.w * SLIDE_W, h: o.h * SLIDE_H, data: o.image },
    }));
}

/**
 * A box of the image's own proportions that fits inside maxW × maxH,
 * anchored at (x, y) with `align` deciding where the slack goes. NEVER
 * pptxgenjs' `sizing:'contain'`: it fits with a negative srcRect crop that
 * Collabora ignores, and the picture comes out stretched to the box.
 */
function fitBox(aspect, x, y, maxW, maxH, { align = 'left', valign = 'middle' } = {}) {
    const a = Number(aspect) > 0 ? Number(aspect) : 1;
    let w = maxW; let h = w / a;
    if (h > maxH) { h = maxH; w = h * a; }
    const dx = align === 'center' ? (maxW - w) / 2 : (align === 'right' ? maxW - w : 0);
    const dy = valign === 'middle' ? (maxH - h) / 2 : (valign === 'bottom' ? maxH - h : 0);
    return { x: x + dx, y: y + dy, w, h };
}

/** The logo box for a placement: its width capped, its height by aspect. */
function logoBox(th, x, y, maxW, maxH, opts) {
    return fitBox(th.logoAspect, x, y, maxW, maxH, opts);
}

/** Where the body of a content slide starts: under the band, or under a rule/plain title. */
function bodyTop(th) {
    return th.titleStyle === 'band' ? 1.1 : 1.35;
}

function bulletRuns(bullets, th, { fontSize = 20, subSize = 16 } = {}) {
    return bullets.map((b) => ({
        text: String(b.text),
        options: {
            bullet: b.level ? { indent: 18 } : true,
            indentLevel: b.level ? 1 : 0,
            fontSize: b.level ? subSize : fontSize,
            color: th.text,
            fontFace: th.bodyFont,
            breakLine: true,
            paraSpaceAfter: b.level ? 2 : 6,
        },
    }));
}

/** The body of a bullets slide: an optional paragraph, then the bullets. */
function addBulletsBody(slide, s, th, box) {
    const runs = [];
    if (s.body) {
        runs.push({ text: s.body, options: { fontSize: 16, color: th.text, fontFace: th.bodyFont, breakLine: true, paraSpaceAfter: 10 } });
    }
    runs.push(...bulletRuns(s.bullets, th));
    if (!runs.length) return;
    slide.addText(runs, { ...box, valign: 'top', fontFace: th.bodyFont, color: th.text, fit: 'shrink' });
}

function footerLineFor(th, marking) {
    const parts = [th.footerText || th.brandName, marking && marking.footerLine].filter(Boolean);
    return parts.join('  ·  ');
}

/** The footer strip and the logo, as master objects, for a slide on `bg`. */
function chromeObjects(th, marking, { onDark = false } = {}) {
    const objects = [];
    const color = onDark ? th.onAccent : th.muted;
    const logo = th.logoDataUrl && (th.logoPlacement === 'footer' || th.logoPlacement === 'corner');
    const logoW = th.logoWidthIn;
    let footerX = 0.4;
    if (logo && th.logoPlacement === 'footer') {
        const box = logoBox(th, 0.4, FOOTER_Y - 0.05, logoW, 0.4);
        objects.push({ image: { ...box, data: th.logoDataUrl } });
        footerX = 0.4 + box.w + 0.15;
    }
    if (logo && th.logoPlacement === 'corner') {
        const y = th.titleStyle === 'band' ? BAND_H + 0.12 : 0.15;
        objects.push({ image: { ...logoBox(th, SLIDE_W - 0.4 - logoW, y, logoW, 0.4, { align: 'right', valign: 'top' }), data: th.logoDataUrl } });
    }
    const footer = footerLineFor(th, marking);
    if (footer) {
        objects.push({ text: { text: footer, options: { x: footerX, y: FOOTER_Y, w: 9.2 - footerX, h: 0.3, fontSize: 9, color, fontFace: th.bodyFont, valign: 'middle' } } });
    }
    return objects;
}

function defineMasters(pptx, th, marking) {
    const slideNumber = th.slideNumbers
        ? { x: 9.2, y: FOOTER_Y, w: 0.5, h: 0.3, fontSize: 9, color: th.muted, fontFace: th.bodyFont, align: 'right' }
        : undefined;

    // A template deck: its pictures ARE the masters — the cover's under the
    // cover, the content's under everything else — with its overlays (a
    // logo) at their own places and only the footer line as chrome.
    if (th.template) {
        const t = th.template;
        const chrome = chromeObjects(th, marking, { onDark: false }).filter((o) => !o.image);
        pptx.defineSlideMaster({ title: 'BF_COVER', background: t.cover.image ? { data: t.cover.image } : { color: th.background }, objects: [...templateOverlayObjects(t.cover), ...chrome] });
        pptx.defineSlideMaster({ title: 'BF_CONTENT', background: t.content.image ? { data: t.content.image } : { color: th.background }, objects: [...templateOverlayObjects(t.content), ...chrome], slideNumber });
        pptx.defineSlideMaster({
            title: 'BF_SECTION',
            background: t.content.image ? { data: t.content.image } : { color: th.background },
            objects: [...templateOverlayObjects(t.content), { rect: { x: 0.6, y: 2.95, w: 1.6, h: 0.06, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } } }, ...chrome],
            slideNumber,
        });
        return;
    }

    // ── Cover ──
    const coverObjects = [];
    let coverBg = th.background;
    const showCoverLogo = th.logoDataUrl && th.logoPlacement !== 'none';
    const logoW = th.logoWidthIn;
    if (th.coverStyle === 'accent') {
        coverBg = th.accent;
        if (showCoverLogo) coverObjects.push({ image: { ...logoBox(th, 0.5, 4.6, logoW * 1.2, 0.55), data: th.logoDataUrl } });
        const footer = footerLineFor(th, marking);
        if (footer) coverObjects.push({ text: { text: footer, options: { x: showCoverLogo ? 0.5 + logoW * 1.2 + 0.2 : 0.5, y: 4.7, w: 8.5, h: 0.35, fontSize: 9, color: th.onAccent, fontFace: th.bodyFont, valign: 'middle', transparency: 25 } } });
    } else if (th.coverStyle === 'light') {
        if (showCoverLogo) coverObjects.push({ image: { ...logoBox(th, 0.6, 0.5, logoW * 1.8, 0.9, { valign: 'top' }), data: th.logoDataUrl } });
        coverObjects.push({ rect: { x: 0, y: SLIDE_H - 0.3, w: SLIDE_W, h: 0.3, fill: { color: th.accent }, line: { color: th.accent, width: 0 } } });
        const footer = footerLineFor(th, marking);
        if (footer) coverObjects.push({ text: { text: footer, options: { x: 0.6, y: 4.8, w: 8.8, h: 0.35, fontSize: 9, color: th.muted, fontFace: th.bodyFont, valign: 'middle' } } });
    } else { // split
        coverObjects.push({ rect: { x: 0, y: 0, w: 3.6, h: SLIDE_H, fill: { color: th.accent }, line: { color: th.accent, width: 0 } } });
        if (showCoverLogo) coverObjects.push({ image: { ...logoBox(th, 0.5, 2.3, 2.6, 1.0), data: th.logoDataUrl } });
        const footer = footerLineFor(th, marking);
        if (footer) coverObjects.push({ text: { text: footer, options: { x: 4.0, y: 4.8, w: 5.6, h: 0.35, fontSize: 9, color: th.muted, fontFace: th.bodyFont, valign: 'middle' } } });
    }
    pptx.defineSlideMaster({ title: 'BF_COVER', background: { color: coverBg }, objects: coverObjects });

    // ── Content ──
    const contentObjects = [];
    if (th.titleStyle === 'band') {
        contentObjects.push({ rect: { x: 0, y: 0, w: SLIDE_W, h: BAND_H, fill: { color: th.bandColor }, line: { color: th.bandColor, width: 0 } } });
        if (th.brandOnSlides && th.brandName) {
            contentObjects.push({ text: { text: th.brandName, options: { x: 7.6, y: 0.22, w: 2.1, h: 0.4, fontSize: 10, color: th.titleColor, fontFace: th.bodyFont, align: 'right', valign: 'middle', charSpacing: 2, transparency: 15 } } });
        }
    } else if (th.brandOnSlides && th.brandName && !(th.logoDataUrl && th.logoPlacement === 'corner')) {
        contentObjects.push({ text: { text: th.brandName, options: { x: 7.4, y: 0.18, w: 2.3, h: 0.3, fontSize: 9, color: th.muted, fontFace: th.bodyFont, align: 'right', valign: 'middle', charSpacing: 2 } } });
    }
    contentObjects.push(...chromeObjects(th, marking));
    pptx.defineSlideMaster({ title: 'BF_CONTENT', background: { color: th.background }, objects: contentObjects, slideNumber });

    // ── Section ──
    pptx.defineSlideMaster({
        title: 'BF_SECTION',
        background: { color: th.background },
        objects: [
            { rect: { x: 0.6, y: 2.95, w: 1.6, h: 0.06, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } } },
            ...chromeObjects(th, marking),
        ],
        slideNumber,
    });
}

/** The title of a content slide, set the way the preset says. */
function addTitle(slide, title, th) {
    if (!title) return;
    if (th.titleStyle === 'band') {
        slide.addText(title, {
            x: 0.4, y: 0.1, w: th.brandOnSlides && th.brandName ? 7.1 : 9.2, h: BAND_H - 0.2,
            fontSize: 24, bold: true, color: th.titleColor, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
        });
        return;
    }
    // A template's corner logo pushes the title to its right.
    const x = Math.max(0.5, th.titleInset * SLIDE_W + 0.25);
    slide.addText(title, {
        x, y: 0.3, w: 9.5 - x, h: 0.8,
        fontSize: 26, bold: true, color: th.titleColor, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
    });
    if (th.titleStyle === 'rule') {
        slide.addShape('rect', { x, y: 1.12, w: 1.4, h: 0.05, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
    }
}

function addCover(pptx, deck, th, { title, author, date, notes } = {}) {
    const slide = pptx.addSlide({ masterName: 'BF_COVER' });
    const templ = !!th.template;
    const split = !templ && th.coverStyle === 'split';
    const light = !templ && th.coverStyle === 'light';
    // On a template's picture the words wear the text colour resolved
    // against it; the preset's accent block/light/split does not apply.
    const titleColor = templ ? th.text : (light ? th.accentOnSlide : (split ? th.accentOnSlide : th.onAccent));
    const subColor = templ ? th.text : (light || split ? th.text : th.onAccent);
    const metaColor = templ ? th.muted : (light || split ? th.muted : th.onAccent);
    const x = split ? 4.0 : 0.6;
    const w = split ? 5.6 : 8.8;
    slide.addText(title || deck.title || 'Presentation', {
        x, y: light ? 1.7 : 1.35, w, h: 1.7, fontSize: 36, bold: true, color: titleColor, fontFace: th.titleFont, valign: 'bottom', fit: 'shrink',
    });
    if (deck.subtitle) {
        slide.addText(deck.subtitle, { x, y: light ? 3.5 : 3.15, w, h: 0.8, fontSize: 18, color: subColor, fontFace: th.bodyFont, valign: 'top', transparency: light || split || templ ? 0 : 10, fit: 'shrink' });
    }
    const meta = [author || deck.author, date || deck.date].filter(Boolean).join('  ·  ');
    if (meta) {
        slide.addText(meta, { x, y: light ? 4.3 : 3.95, w, h: 0.4, fontSize: 12, color: metaColor, fontFace: th.bodyFont, transparency: light || split || templ ? 0 : 20 });
    }
    if (notes) slide.addNotes(String(notes));
    return slide;
}

function tableCellOptions(th, { header = false, rowIndex = 0, numeric = false } = {}) {
    const base = { fontFace: th.bodyFont, align: numeric ? 'right' : 'left', valign: 'middle' };
    const none = { type: 'none' };
    const line = { type: 'solid', pt: 0.75, color: th.tableLine };
    if (th.tableStyle === 'banded') {
        if (header) return { ...base, bold: true, color: th.tableHeaderText, fill: { color: th.tableHeaderFill }, border: { type: 'solid', pt: 0.5, color: th.tableLine } };
        return { ...base, color: th.text, fill: { color: rowIndex % 2 === 1 ? th.tableBand : th.background }, border: { type: 'solid', pt: 0.5, color: th.tableLine } };
    }
    if (th.tableStyle === 'lines') {
        if (header) return { ...base, bold: true, color: th.accentOnSlide, border: [none, none, { type: 'solid', pt: 1.5, color: th.accentOnSlide }, none] };
        return { ...base, color: th.text, border: [none, none, line, none] };
    }
    // minimal
    if (header) return { ...base, bold: true, color: th.accentOnSlide, border: none };
    return { ...base, color: th.text, border: none };
}

function addTableSlide(slide, s, th, top) {
    const t = s.table;
    const cols = t.columns.length;
    const header = t.columns.map((c) => ({ text: String(c), options: tableCellOptions(th, { header: true }) }));
    const rows = t.rows.map((r, ri) => r.map((v) => ({
        text: typeof v === 'number' ? String(v) : String(v ?? ''),
        options: tableCellOptions(th, { rowIndex: ri, numeric: typeof v === 'number' }),
    })));
    const bodyH = BODY_BOTTOM - top;
    const tableH = s.bullets.length || s.body ? Math.min(2.4, bodyH) : bodyH;
    slide.addTable([header, ...rows], {
        x: 0.5, y: top, w: 9, colW: Array(cols).fill(9 / cols),
        fontSize: rows.length > 8 ? 10 : 12, fontFace: th.bodyFont, color: th.text,
        autoPage: false, rowH: Math.min(0.4, tableH / (rows.length + 1)), valign: 'middle',
    });
    if (s.bullets.length || s.body) addBulletsBody(slide, s, th, { x: 0.5, y: top + tableH + 0.1, w: 9, h: bodyH - tableH - 0.1 });
}

function addImageSlide(slide, s, th, top) {
    const data = assertDataImage(s.image.dataUrl, `slide "${s.title || '?'}" image`);
    const h = BODY_BOTTOM - top;
    // The box follows the picture's own proportions (measured by the renderer;
    // 4:3 when unknown) — see fitBox for why not `sizing`.
    const aspect = s.image.aspect || 4 / 3;
    if (s.bullets.length || s.body) {
        addBulletsBody(slide, s, th, { x: 0.5, y: top, w: 4.5, h });
        slide.addImage({ data, ...fitBox(aspect, 5.2, top, 4.3, h, { align: 'center' }) });
    } else {
        slide.addImage({ data, ...fitBox(aspect, 0.5, top, 9, h, { align: 'center' }) });
    }
}

function addQuoteSlide(slide, s, th, top) {
    // A large quote mark in the accent tint sets the tone; the words stay in
    // the text colour and read on their own.
    if (th.glass) slide.addShape('roundRect', { x: 0.5, y: top + 0.15, w: 9, h: 3.4, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
    slide.addText('“', { x: 0.6, y: top - 0.1, w: 1.2, h: 1.2, fontSize: 96, bold: true, color: th.glass ? th.text : th.statFill, transparency: th.glass ? 60 : 0, fontFace: th.titleFont, valign: 'top', margin: 0 });
    slide.addText(s.quote.text, {
        x: 1.2, y: top + 0.5, w: 7.8, h: 2.4, fontSize: 26, italic: true, color: th.text, fontFace: th.titleFont, valign: 'middle', fit: 'shrink',
    });
    if (s.quote.attribution) {
        slide.addShape('rect', { x: 1.2, y: top + 3.05, w: 0.5, h: 0.04, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        slide.addText(s.quote.attribution, { x: 1.85, y: top + 2.85, w: 7.1, h: 0.45, fontSize: 13, color: th.muted, fontFace: th.bodyFont, valign: 'middle' });
    }
    if (s.bullets.length || s.body) addBulletsBody(slide, s, th, { x: 0.8, y: top + 3.4, w: 8.4, h: BODY_BOTTOM - top - 3.4 });
}

function addTwoColumnSlide(slide, s, th, top) {
    const boxes = [{ x: 0.5, w: 4.4 }, { x: 5.1, w: 4.4 }];
    const cardH = (s.body ? 4.4 : BODY_BOTTOM) - top;
    s.columns.forEach((col, i) => {
        const b = boxes[i];
        // Each column on a soft card, its heading on an accent tab.
        slide.addShape('roundRect', { x: b.x, y: top, w: b.w, h: cardH, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        let y = top + 0.2;
        if (col.title) {
            slide.addShape('rect', { x: b.x + 0.3, y: y + 0.12, w: 0.06, h: 0.3, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
            slide.addText(col.title, { x: b.x + 0.45, y, w: b.w - 0.7, h: 0.5, fontSize: 17, bold: true, color: th.text, fontFace: th.titleFont, valign: 'middle' });
            y += 0.6;
        }
        if (col.bullets.length) {
            slide.addText(bulletRuns(col.bullets, th, { fontSize: 16, subSize: 14 }), { x: b.x + 0.3, y, w: b.w - 0.5, h: top + cardH - y - 0.15, valign: 'top', fontFace: th.bodyFont, fit: 'shrink' });
        }
    });
    if (s.body) slide.addText(s.body, { x: 0.5, y: 4.55, w: 9, h: 0.45, fontSize: 14, color: th.muted, fontFace: th.bodyFont, fit: 'shrink' });
}

function addSectionSlide(pptx, s, th) {
    const slide = pptx.addSlide({ masterName: 'BF_SECTION' });
    slide.addText(s.title || '', { x: 0.6, y: 1.7, w: 8.8, h: 1.15, fontSize: 32, bold: true, color: th.accentOnSlide, fontFace: th.titleFont, valign: 'bottom', fit: 'shrink' });
    const sub = s.body || s.bullets.map((b) => b.text).join('  ·  ');
    if (sub) slide.addText(sub, { x: 0.6, y: 3.15, w: 8.8, h: 1.0, fontSize: 16, color: th.muted, fontFace: th.bodyFont, valign: 'top', fit: 'shrink' });
    return slide;
}

function addClosingSlide(pptx, s, th) {
    const lines = [s.body, ...s.bullets.map((b) => b.text)].filter(Boolean).join('\n');
    return addCover(pptx, { title: s.title || 'Thank you', subtitle: lines || null }, th, { title: s.title || 'Thank you' });
}

const PPTX_CHART_TYPE = Object.freeze({ column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', donut: 'doughnut' });

/**
 * A NATIVE chart — editable in PowerPoint and Collabora, its data a real
 * sheet inside the file. Colours, fonts and grid come from the theme so a
 * chart sits in the deck like a table does.
 */
function addChartSlide(pptx, slide, s, th, top) {
    const c = s.chart;
    const h = BODY_BOTTOM - top;
    const withText = s.bullets.length || s.body;
    const box = withText ? { x: 5.0, y: top, w: 4.6, h } : { x: 0.5, y: top, w: 9, h };
    if (withText) addBulletsBody(slide, s, th, { x: 0.5, y: top, w: 4.3, h });
    const circular = c.type === 'pie' || c.type === 'donut';
    // An UNSTACKED area chart paints every series from the axis up, later
    // series on top: an opaque big series hides a small one completely.
    // So the biggest is drawn first and the fills are translucent.
    const overlapArea = c.type === 'area' && !c.stacked && c.series.length > 1;
    const order = overlapArea
        ? c.series.map((ser, i) => ({ i, peak: Math.max(...ser.values.filter((v) => typeof v === 'number'), 0) })).sort((a, b) => b.peak - a.peak).map((x) => x.i)
        : c.series.map((_, i) => i);
    const data = order.map((i) => ({ name: c.series[i].name || `Series ${i + 1}`, labels: c.labels, values: c.series[i].values.map((v) => (typeof v === 'number' ? v : 0)) }));
    const colours = order.map((i) => th.chartColors[i % th.chartColors.length]);
    const font = th.bodyFont;
    // The marks follow the data-viz spec: recessive hairline grid, no axis
    // lines, thin bars with a surface gap between neighbours, 2pt lines with
    // ringed markers, value labels only where they stay sparse.
    const grid = pptxHex(mixHex(`#${th.background}`, `#${th.text}`, 0.12), th.tableLine);
    const points = c.labels.length * c.series.length;
    const sparse = points <= 12;
    const opts = {
        ...box,
        chartColors: colours,
        // On a template's picture the chart has no plate of its own.
        chartArea: { ...(th.template ? {} : { fill: { color: th.background } }), roundedCorners: false },
        plotArea: th.template ? {} : { fill: { color: th.background } },
        showLegend: c.series.length > 1 || circular,
        legendPos: circular ? 'r' : 'b', legendColor: th.muted, legendFontFace: font, legendFontSize: 10,
        showTitle: !!c.title, title: c.title || undefined, titleColor: th.text, titleFontFace: font, titleFontSize: 13,
        dataLabelColor: th.text, dataLabelFontFace: font, dataLabelFontSize: 10,
    };
    if (circular) {
        Object.assign(opts, {
            showPercent: c.showValues, showValue: false, showLabel: false, showLeaderLines: false,
            dataLabelPosition: c.type === 'donut' ? 'ctr' : 'bestFit',
            dataBorder: { pt: 2, color: th.background },
            ...(c.type === 'donut' ? { holeSize: 62 } : {}),
        });
        opts.dataLabelColor = pptxHex(readableOn(`#${th.chartColors[0]}`, null, 3), th.text);
    } else {
        Object.assign(opts, {
            showValue: c.showValues && sparse, dataLabelFormatCode: '#,##0.##',
            catAxisLabelColor: th.muted, catAxisLabelFontFace: font, catAxisLabelFontSize: 10, catAxisLineShow: false, catGridLine: { style: 'none' },
            valAxisLabelColor: th.muted, valAxisLabelFontFace: font, valAxisLabelFontSize: 9, valAxisLineShow: false,
            valGridLine: { color: grid, style: 'solid', size: 0.5 }, valAxisLabelFormatCode: '#,##0.##',
            ...(c.unit ? { showValAxisTitle: true, valAxisTitle: c.unit, valAxisTitleColor: th.muted, valAxisTitleFontFace: font, valAxisTitleFontSize: 9 } : {}),
        });
        if (c.type === 'column' || c.type === 'bar') {
            Object.assign(opts, {
                barDir: c.type === 'bar' ? 'bar' : 'col',
                barGrouping: c.stacked ? 'stacked' : 'clustered',
                // Thin marks: the gap is wider than the bar; neighbours in a
                // cluster and segments in a stack are parted by the surface.
                barGapWidthPct: c.stacked ? 150 : 110,
                ...(c.stacked ? { dataBorder: { pt: 1.5, color: th.background } } : { barOverlapPct: -8 }),
                dataLabelPosition: c.stacked ? 'ctr' : 'outEnd',
            });
        } else {
            Object.assign(opts, {
                lineSize: 2, lineDataSymbol: 'circle', lineDataSymbolSize: 8,
                lineDataSymbolLineColor: th.background, lineDataSymbolLineSize: 1.5,
                dataLabelPosition: 't',
                ...(c.type === 'area' ? { chartColorsOpacity: c.series.length > 1 ? 22 : 30 } : {}),
                ...(c.type === 'area' && c.stacked ? { barGrouping: 'stacked' } : {}),
            });
        }
    }
    slide.addChart(pptx.ChartType[PPTX_CHART_TYPE[c.type] || 'bar'], data, opts);
}

/**
 * KPI tiles: up to four soft cards, each with an accent bar on the left, the
 * value in the text colour (text never wears the data colour), a quiet
 * label and the change beneath it.
 */
function addStatsSlide(slide, s, th, top) {
    const tiles = s.stats;
    const n = tiles.length;
    const gap = 0.25;
    const w = (9 - gap * (n - 1)) / n;
    const withText = s.bullets.length || s.body;
    const h = withText ? 1.7 : Math.min(2.1, BODY_BOTTOM - top - 0.2);
    const y = withText ? top : top + (BODY_BOTTOM - top - h) / 2;
    tiles.forEach((t, i) => {
        const x = 0.5 + i * (w + gap);
        slide.addShape('roundRect', { x, y, w, h, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        if (t.iconDataUrl) slide.addImage({ data: t.iconDataUrl, x: x + w - 0.6, y: y + 0.18, w: 0.36, h: 0.36 });
        slide.addShape('rect', { x: x + 0.14, y: y + 0.3, w: 0.06, h: h - 0.6, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        const runs = [
            { text: t.value, options: { fontSize: n > 3 ? 26 : 32, bold: true, color: th.text, fontFace: th.titleFont, breakLine: true, paraSpaceAfter: 4 } },
            { text: t.label || ' ', options: { fontSize: 11, color: th.muted, fontFace: th.bodyFont, charSpacing: 1, breakLine: !!t.delta } },
        ];
        if (t.delta) runs.push({ text: t.delta, options: { fontSize: 11, bold: true, color: th.accentOnSlide, fontFace: th.bodyFont } });
        slide.addText(runs, { x: x + 0.32, y, w: w - 0.44, h, align: 'left', valign: 'middle', margin: 4, fit: 'shrink' });
    });
    if (withText) addBulletsBody(slide, s, th, { x: 0.5, y: y + h + 0.2, w: 9, h: BODY_BOTTOM - y - h - 0.2 });
}

/**
 * Cards: two to six titled texts on soft cards — in a row up to three, a
 * grid beyond that. A card may carry an icon (rasterised Lucide, in the
 * accent) at its top or a picture across its top.
 */
function addCardsSlide(slide, s, th, top) {
    const cards = s.cards;
    const n = cards.length;
    let y = top;
    if (s.body) {
        slide.addText(s.body, { x: 0.5, y, w: 9, h: 0.85, fontSize: 15, color: th.text, fontFace: th.bodyFont, valign: 'top', fit: 'shrink' });
        y += 0.95;
    }
    const cols = n <= 3 ? n : (n === 4 ? (s.body ? 2 : 4) : 3);
    const rows = Math.ceil(n / cols);
    const gap = 0.22;
    const w = (9 - gap * (cols - 1)) / cols;
    const h = (BODY_BOTTOM - y - gap * (rows - 1)) / rows;
    const small = n > 3;
    cards.forEach((c, i) => {
        const x = 0.5 + (i % cols) * (w + gap);
        const cy = y + Math.floor(i / cols) * (h + gap);
        slide.addShape('roundRect', { x, y: cy, w, h, rectRadius: 0.1, fill: cardFill(th), line: { color: th.statFill, width: 0, transparency: 100 } });
        let textY = cy + 0.22;
        if (c.image && c.image.dataUrl) {
            const imgH = Math.min(h * 0.45, 1.3);
            slide.addImage({ data: c.image.dataUrl, ...fitBox(c.image.aspect || 4 / 3, x + 0.18, cy + 0.18, w - 0.36, imgH, { align: 'left', valign: 'top' }) });
            textY = cy + 0.18 + imgH + 0.12;
        } else if (c.iconDataUrl) {
            const size = small ? 0.34 : 0.42;
            slide.addImage({ data: c.iconDataUrl, x: x + 0.22, y: cy + 0.22, w: size, h: size });
            textY = cy + 0.22 + size + 0.1;
        } else {
            slide.addShape('rect', { x: x + 0.22, y: cy + 0.3, w: 0.05, h: 0.34, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        }
        const runs = [];
        if (c.title) runs.push({ text: c.title, options: { fontSize: small ? 13 : 16, bold: true, color: th.text, fontFace: th.titleFont, breakLine: !!c.text, paraSpaceAfter: 5 } });
        if (c.text) runs.push({ text: c.text, options: { fontSize: small ? 10.5 : 12.5, color: th.text, fontFace: th.bodyFont } });
        const indent = c.image || c.iconDataUrl ? 0.22 : 0.38;
        slide.addText(runs, { x: x + indent, y: textY, w: w - indent - 0.18, h: cy + h - textY - 0.15, valign: 'top', margin: 0, fit: 'shrink' });
    });
}

/** A process / timeline: a line across the slide, numbered circles, a title and a line of text under each. */
function addTimelineSlide(slide, s, th, top) {
    const steps = s.steps;
    const n = steps.length;
    const withText = s.body;
    const lineY = top + 0.8;
    const r = 0.26;
    const slot = 9 / n;
    slide.addShape('line', { x: 0.5 + slot / 2, y: lineY, w: 9 - slot, h: 0, line: { color: th.statFill, width: 4 } });
    steps.forEach((st, i) => {
        const cx = 0.5 + slot * i + slot / 2;
        // A surface ring around each node, so it reads on the connector.
        slide.addShape('ellipse', { x: cx - r - 0.05, y: lineY - r - 0.05, w: r * 2 + 0.1, h: r * 2 + 0.1, fill: { color: th.background }, line: { color: th.background, width: 0 } });
        slide.addShape('ellipse', { x: cx - r, y: lineY - r, w: r * 2, h: r * 2, fill: { color: th.accentOnSlide }, line: { color: th.accentOnSlide, width: 0 } });
        slide.addText(String(i + 1), { x: cx - r, y: lineY - r, w: r * 2, h: r * 2, fontSize: 13, bold: true, color: pptxHex(readableOn(`#${th.accentOnSlide}`, null, 3), th.background), fontFace: th.bodyFont, align: 'center', valign: 'middle', margin: 0 });
        slide.addText(st.title, { x: cx - slot / 2 + 0.05, y: lineY + r + 0.15, w: slot - 0.1, h: 0.55, fontSize: n > 4 ? 13 : 15, bold: true, color: th.text, fontFace: th.titleFont, align: 'center', valign: 'top', fit: 'shrink' });
        if (st.text) slide.addText(st.text, { x: cx - slot / 2 + 0.05, y: lineY + r + 0.7, w: slot - 0.1, h: 1.1, fontSize: n > 4 ? 10 : 12, color: th.muted, fontFace: th.bodyFont, align: 'center', valign: 'top', fit: 'shrink' });
    });
    if (withText) slide.addText(s.body, { x: 0.5, y: 4.2, w: 9, h: BODY_BOTTOM - 4.2, fontSize: 13, color: th.muted, fontFace: th.bodyFont, fit: 'shrink' });
}

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
    const buffer = fmt === 'ods' ? await buildOds(m, sheetName) : await buildXlsx(m, sheetName);
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

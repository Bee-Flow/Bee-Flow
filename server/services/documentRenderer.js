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

const { sanitizeContentForExport, escapeHtml } = require('../templates/exportTemplate');
const log = require('../telemetry/log');

/*
 * AI CONTENT MARKING (EU AI Act Art. 50(2)). When the caller passes a
 * `marking` object (compliance/marking.js resolveMarking — only for a document
 * that carries model output, and only when the org switched marking on), every
 * output path gets two things: a VISIBLE footer line ("Generated with AI —
 * <org>") and machine-readable METADATA (PDF Info dictionary / DOCX core
 * properties) saying the content is AI-generated, by which provider, when and
 * from which automation. Full C2PA provenance is out of scope; this is the
 * "marked in a machine-readable format and detectable as artificially
 * generated" the article asks of a deployer. The Chromium PDF gets its
 * metadata in a post-processing pass with pdf-lib; when that package cannot be
 * loaded the visible line still ships and the result says `metadata:false`.
 */
const AI_MARK_SUBJECT = 'AI-generated content — EU AI Act Art. 50(2)';
const AI_MARK_PRODUCER = 'Bee Flow';

const FORMATS = Object.freeze(['pdf', 'docx']);
const CONTENT_FORMATS = Object.freeze(['markdown', 'html']);
// 'document' is the linear print layout; 'slides' is the landscape deck (PDF
// only — see renderDocument). Unknown values fall back to 'document'.
const LAYOUTS = Object.freeze(['document', 'slides']);

const CONTENT_TYPES = Object.freeze({
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

// A generated document is a person-sized artefact, not a data dump. The cap is
// on the SOURCE text: 2 MB of markdown is already a book, and it bounds both
// the browser render and the docx build.
const MAX_CONTENT_CHARS = 2_000_000;

/**
 * The print document: system fonts, no scripts, no external anything.
 *
 * Every rule here is about paper. `h1..h3` avoid a page break right after a
 * heading, tables repeat their header row, and long URLs wrap instead of
 * running off the right edge — all things that only show up once someone
 * prints a real twelve-page report.
 */
/** The footer text of a marking object, or '' — the one place the line is read out of it. */
function markingText(marking) {
    if (!marking || marking.enabled === false) return '';
    return String(marking.footer_text || '').trim();
}

/**
 * The visible marking line as body HTML: a trailing footer the browser prints
 * on the last page, Word keeps as the closing paragraph, and the reader of a
 * plain-text dump still sees. Empty when the document is not marked.
 */
function markingFooterHtml(marking) {
    const text = markingText(marking);
    return text ? `<footer class="ai-mark"><p class="ai-mark">${escapeHtml(text)}</p></footer>` : '';
}

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
const { resolveDeckTheme, slideVariant } = require('../core/documents/deckThemeOptions');
const { chartSvg } = require('../core/documents/deckChartSvg');
const { iconSvg } = require('../core/documents/deckIcons');
const NEUTRAL_DECK_THEME = Object.freeze(resolveDeckTheme(null));

function cssHex(value, fallback) {
    const t = String(value ?? '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t : fallback;
}

/**
 * A complete theme with every colour safe inside a stylesheet. Takes a
 * RESOLVED deck theme (core/documents/deckThemeOptions.js) — the same object
 * officegen reads for the .pptx — so the PDF deck and the PowerPoint agree
 * on every colour, typeface and style choice.
 */
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

function deckThemeCss(theme) {
    theme = ensureResolvedTheme(theme);
    const t = { ...NEUTRAL_DECK_THEME, ...(theme && typeof theme === 'object' ? theme : {}) };
    const hex = (k) => cssHex(t[k], NEUTRAL_DECK_THEME[k]);
    return {
        preset: t.preset,
        accent: hex('accent'),
        background: hex('background'),
        text: hex('text'),
        muted: hex('muted'),
        onAccent: hex('onAccent'),
        accentOnSlide: hex('accentOnSlide'),
        titleStyle: ['band', 'rule', 'plain'].includes(t.titleStyle) ? t.titleStyle : 'band',
        bandColor: t.bandColor ? cssHex(t.bandColor, hex('accent')) : hex('accent'),
        titleColor: hex('titleColor'),
        fontStack: String(t.fontStack || NEUTRAL_DECK_THEME.fontStack).replace(/[<>{};]/g, ''),
        titleFontStack: String(t.titleFontStack || t.fontStack || NEUTRAL_DECK_THEME.fontStack).replace(/[<>{};]/g, ''),
        coverStyle: ['accent', 'light', 'split'].includes(t.coverStyle) ? t.coverStyle : 'accent',
        tableStyle: ['banded', 'lines', 'minimal'].includes(t.tableStyle) ? t.tableStyle : 'banded',
        tableHeaderFill: hex('tableHeaderFill'),
        tableHeaderText: hex('tableHeaderText'),
        tableBand: hex('tableBand'),
        tableLine: hex('tableLine'),
        logoDataUrl: /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(String(t.logoDataUrl || '').replace(/\s+/g, ''))
            ? String(t.logoDataUrl).replace(/\s+/g, '') : '',
        // A partial theme that brings a logo but no placement gets the footer,
        // not the neutral theme's 'none' (which only means "it had no logo").
        logoPlacement: ['footer', 'corner', 'cover', 'none'].includes(theme && theme.logoPlacement) ? theme.logoPlacement : 'footer',
        logoWidthIn: Math.min(Math.max(Number(t.logoWidthIn) || 0.95, 0.3), 2.5),
        logoAspect: Number(t.logoAspect) > 0 ? Math.min(Math.max(Number(t.logoAspect), 0.2), 8) : 0,
        slideNumbers: t.slideNumbers !== false,
        brandOnSlides: t.brandOnSlides !== false,
        chartColors: (Array.isArray(t.chartColors) && t.chartColors.length ? t.chartColors : NEUTRAL_DECK_THEME.chartColors).map((c) => cssHex(c, hex('accent'))),
        statFill: cssHex(t.statFill, hex('tableBand')),
        variant: t.variant === 'accent' || t.variant === 'dark' ? t.variant : null,
        template: t.template && typeof t.template === 'object' && t.template.cover && t.template.content ? t.template : null,
        titleInset: Math.min(Math.max(Number(t.titleInset) || 0, 0), 0.5),
        glass: !!t.glass,
        brandName: String(t.brandName || '').slice(0, 80),
        footerText: String(t.footerText || '').slice(0, 200),
    };
}

/** The CSS custom properties one slide overrides when it is painted differently. */
function slideVariantStyle(theme, style) {
    if (style !== 'accent' && style !== 'dark') return '';
    const v = deckThemeCss(slideVariant(ensureResolvedTheme(theme) || resolveDeckTheme(null), style));
    return ` style="--deck-bg:${v.background};--deck-ink:${v.text};--deck-muted:${v.muted};--deck-title:${v.titleColor};--deck-accent-on-slide:${v.accentOnSlide};--deck-band:transparent;--deck-line:${v.tableLine};--deck-stat:${v.statFill};--deck-th-fill:${v.tableHeaderFill};--deck-th-text:${v.tableHeaderText};--deck-band-row:${v.tableBand}"`;
}

function slidesCss(theme) {
    const t = deckThemeCss(theme);
    const bandTitle = t.titleStyle === 'band';
    const coverBg = t.template ? t.background : (t.coverStyle === 'accent' ? t.accent : t.background);
    const coverTitle = t.template ? t.text : (t.coverStyle === 'accent' ? t.onAccent : t.accentOnSlide);
    const coverText = t.template ? t.text : (t.coverStyle === 'accent' ? t.onAccent : t.text);
    const tableCss = t.tableStyle === 'banded'
        ? `  th { background: var(--deck-th-fill); color: var(--deck-th-text); }
  th, td { border: 1px solid var(--deck-line); }
  tbody tr:nth-child(even) td { background: var(--deck-band-row); }`
        : t.tableStyle === 'lines'
            ? `  th { color: var(--deck-accent-on-slide); border-bottom: 2pt solid var(--deck-accent-on-slide); }
  td { border-bottom: 1px solid var(--deck-line); }`
            : `  th { color: var(--deck-accent-on-slide); }
  th, td { border: 0; }`;
    return `
  /* Page geometry comes from page.pdf (A4 landscape, zero margin) — the zero
     margin is what lets the band run edge to edge. Every colour is the
     resolved deck theme's, the same one the .pptx is built from. */
  :root { --deck-accent: ${t.accent}; --deck-accent-on-slide: ${t.accentOnSlide}; --deck-bg: ${t.background};
          --deck-ink: ${t.text}; --deck-muted: ${t.muted}; --deck-title: ${t.titleColor}; --deck-band: ${t.bandColor};
          --deck-line: ${t.tableLine}; --deck-stat: ${t.statFill}; --deck-th-fill: ${t.tableHeaderFill}; --deck-th-text: ${t.tableHeaderText}; --deck-band-row: ${t.tableBand}; }
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${t.fontStack};
         font-size: 10pt; line-height: 1.5; color: var(--deck-ink); background: var(--deck-bg); }

  .slide { page-break-after: always; min-height: 206mm; box-sizing: border-box; position: relative; background: var(--deck-bg); }
  .slide:last-child { page-break-after: auto; }

  .band { ${bandTitle ? 'background: var(--deck-band);' : 'background: transparent;'} color: var(--deck-title); padding: ${bandTitle ? '7mm 14mm 6mm' : '10mm 14mm 2mm'};
          display: flex; justify-content: space-between; align-items: baseline;
          page-break-after: avoid; break-after: avoid; }
  .band-title { font-family: ${t.titleFontStack}; font-size: ${bandTitle ? '17pt' : '19pt'}; font-weight: 700; letter-spacing: .2px; color: var(--deck-title); }
  .band-title em, .band-title strong { color: inherit; }
  ${t.titleStyle === 'rule' ? '.band-title::after { content: ""; display: block; width: 24mm; height: 1.2mm; background: var(--deck-accent-on-slide); margin-top: 3mm; }' : ''}
  .brand { font-size: ${bandTitle ? '12pt' : '9pt'}; font-weight: 300; letter-spacing: 5px; white-space: nowrap; color: ${bandTitle ? 'var(--deck-title)' : 'var(--deck-muted)'}; }

  .slide-body { padding: 8mm 14mm 14mm; }
  .slide-body h3 { color: var(--deck-accent-on-slide); font-family: ${t.titleFontStack}; font-size: 12pt; margin: 10pt 0 4pt; break-after: avoid; }
  .slide-body h4 { font-size: 10.5pt; margin: 8pt 0 3pt; break-after: avoid; }
  p, ul, ol, blockquote, table { margin: 0 0 7pt; }
  li { margin: 0 0 2pt; }
  p, li { orphans: 3; widows: 3; }
  a { color: var(--deck-accent-on-slide); text-decoration: none; word-break: break-word; }
  blockquote { border-left: 3pt solid var(--deck-accent-on-slide); padding-left: 8pt; color: var(--deck-muted); margin-left: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 8.5pt;
          break-inside: avoid; page-break-inside: avoid; }
  th, td { padding: 2.5pt 5pt; text-align: left; vertical-align: top; }
${tableCss}
  td:not(:first-child), th:not(:first-child) { text-align: right; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  img { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid ${t.tableLine}; margin: 8pt 0; }
  code, pre { font-family: Consolas, "Liberation Mono", monospace; font-size: 8.5pt; }

  .cover { background: ${coverBg}; color: ${coverText}; }
  .cover-canvas { height: 130mm; position: relative; overflow: hidden; }
  .cover-logo { position: absolute; left: 14mm; top: 14mm; width: ${(t.logoWidthIn * 25.4 * 1.6).toFixed(1)}mm; max-height: 40mm; object-fit: contain; }
  .cover-block { position: absolute; right: 0; bottom: 26mm; width: 62%; padding: 9mm 14mm; box-sizing: border-box;
                 ${t.coverStyle === 'accent' ? 'background: transparent;' : t.coverStyle === 'split' ? 'background: transparent;' : 'background: transparent;'} }
  ${t.coverStyle === 'split' && !t.template ? '.cover::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 36%; background: var(--deck-accent); }' : ''}
  ${t.coverStyle === 'light' && !t.template ? '.cover::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 8mm; background: var(--deck-accent); }' : ''}
  .cover-title { font-family: ${t.titleFontStack}; font-size: 22pt; font-weight: 700; line-height: 1.2; color: ${coverTitle}; }
  .cover-title h1 { font-size: inherit; margin: 0; }
  .cover-sub { font-size: 12pt; margin-top: 3mm; font-weight: 300; }
  .cover-date { font-size: 10pt; margin-top: 2mm; font-weight: 300; opacity: .85; }
  .deck-columns { display: flex; gap: 10mm; }
  .deck-columns > div { flex: 1 1 0; min-width: 0; }
  .deck-quote { font-family: ${t.titleFontStack}; font-size: 17pt; font-style: italic; color: var(--deck-ink); border: 0; padding: 2mm 0 4mm 12mm; margin: 0; }
  .deck-quote-by { font-size: 10pt; color: var(--deck-muted); padding-left: 12mm; }
  .deck-quote-by::before { content: ""; display: inline-block; width: 6mm; border-top: 0.5mm solid var(--deck-accent-on-slide); vertical-align: middle; margin-right: 3mm; }
  .deck-image { display: block; max-height: 150mm; margin: 0 auto; }
  .deck-split { display: flex; gap: 8mm; align-items: flex-start; }
  .deck-split > .deck-side { flex: 0 0 38%; min-width: 0; }
  .deck-split > .deck-chart { flex: 1 1 0; min-width: 0; }
  .deck-chart { margin: 0; height: 135mm; }
  .deck-chart svg { width: 100%; height: 100%; }
  .deck-stats { display: flex; gap: 6mm; margin: 4mm 0 8mm; }
  .deck-stat { flex: 1 1 0; min-width: 0; background: var(--deck-stat); border-radius: 3mm; padding: 8mm 6mm 8mm 9mm; text-align: left; position: relative; }
  .deck-stat::before { content: ""; position: absolute; left: 4mm; top: 8mm; bottom: 8mm; width: 1.2mm; border-radius: 1mm; background: var(--deck-accent-on-slide); }
  .deck-stat-value { font-family: ${t.titleFontStack}; font-size: 24pt; font-weight: 700; color: var(--deck-ink); line-height: 1.1; }
  .deck-stat-label { font-size: 9.5pt; color: var(--deck-muted); letter-spacing: .4px; margin-top: 2mm; }
  .deck-stat-delta { font-size: 9.5pt; font-weight: 700; color: var(--deck-accent-on-slide); margin-top: 1.5mm; }
  .deck-columns > div { background: var(--deck-stat); border-radius: 3mm; padding: 6mm 7mm; }
  .deck-cards { display: grid; gap: 6mm; margin: 4mm 0; grid-template-columns: repeat(3, 1fr); }
  .deck-cards-2 { grid-template-columns: repeat(2, 1fr); }
  .deck-cards-4 { grid-template-columns: repeat(4, 1fr); }
  .deck-cards-5, .deck-cards-6 { grid-template-columns: repeat(3, 1fr); }
  .deck-card-media::before { display: none; }
  .deck-card-media { padding-left: 7mm; }
  .deck-card-icon { margin-bottom: 3mm; }
  .deck-card-icon svg { width: 9mm; height: 9mm; }
  .deck-card-image { display: block; width: 100%; max-height: 32mm; object-fit: contain; object-position: left; margin-bottom: 3mm; }
  .deck-stat-icon { position: absolute; right: 5mm; top: 5mm; }
  .deck-stat-icon svg { width: 7mm; height: 7mm; }
  .deck-card { background: var(--deck-stat); border-radius: 3mm; padding: 6mm 7mm 6mm 9mm; position: relative; }
  .deck-card::before { content: ""; position: absolute; left: 5mm; top: 7mm; width: 1.2mm; height: 7mm; border-radius: 1mm; background: var(--deck-accent-on-slide); }
  .deck-card-title { font-family: ${t.titleFontStack}; font-weight: 700; font-size: 12pt; margin-bottom: 2mm; }
  .deck-card-text { font-size: 9.5pt; line-height: 1.45; }
  .deck-columns h3 { border-left: 1.2mm solid var(--deck-accent-on-slide); padding-left: 3mm; color: var(--deck-ink); margin-top: 0; }
  .deck-quote-mark { font-family: ${t.titleFontStack}; font-size: 72pt; line-height: .6; color: var(--deck-stat); margin: 6mm 0 0; }
  .deck-timeline { display: flex; list-style: none; margin: 10mm 0 6mm; padding: 0; position: relative; }
  .deck-timeline::before { content: ""; position: absolute; left: 8%; right: 8%; top: 4.6mm; border-top: 1.4mm solid var(--deck-stat); }
  .deck-timeline li { flex: 1 1 0; min-width: 0; text-align: center; padding: 0 2mm; position: relative; }
  .deck-step-n { display: inline-flex; width: 10mm; height: 10mm; border-radius: 50%; background: var(--deck-accent-on-slide); color: var(--deck-bg); font-weight: 700; align-items: center; justify-content: center; font-size: 10pt; position: relative; box-shadow: 0 0 0 1.2mm var(--deck-bg); }
  .deck-step-title { font-family: ${t.titleFontStack}; font-weight: 700; font-size: 11pt; margin-top: 3mm; }
  .deck-step-text { font-size: 9pt; color: var(--deck-muted); margin-top: 1.5mm; }
  .slide-accent .band, .slide-dark .band { background: transparent; padding: 10mm 14mm 2mm; }
  ${t.template ? `
  /* A template deck: its pictures under every slide, its overlays (a logo) in place. */
  .slide, .cover { background-image: url("${t.template.content.image}"); background-size: 100% 100%; background-repeat: no-repeat; }
  .cover { background-image: url("${t.template.cover.image || t.template.content.image}"); }
  .band { background: transparent; padding: 10mm 14mm 2mm ${t.titleInset ? `max(14mm, ${(t.titleInset * 100 + 2).toFixed(1)}%)` : '14mm'}; }
  .band-title::after { display: none; }
  .brand { display: none; }
  .deck-overlay { position: absolute; object-fit: contain; }
  .cover .cover-logo { display: none; }` : ''}
  ${t.glass ? `
  .deck-stat, .deck-columns > div, .deck-card { background: color-mix(in srgb, var(--deck-ink) 16%, transparent); }
  .deck-timeline::before { border-top-color: color-mix(in srgb, var(--deck-ink) 30%, transparent); }
  .deck-quote-mark { color: color-mix(in srgb, var(--deck-ink) 45%, transparent); }` : ''}
  .slide-accent .band-title::after, .slide-dark .band-title::after { display: none; }
  .slide-accent .brand, .slide-dark .brand { color: var(--deck-muted); }
  .deck-footer { position: fixed; right: 14mm; bottom: 5mm; font-size: 8pt; color: var(--deck-muted); }
  .deck-logo { position: fixed; ${t.logoPlacement === 'corner' ? 'right: 14mm; top: 5mm;' : 'left: 14mm; bottom: 4mm;'} height: 7mm; width: auto; }
  .ai-mark { position: fixed; left: ${t.logoPlacement === 'footer' && t.logoDataUrl ? '40mm' : '14mm'}; bottom: 5mm; font-size: 8pt; color: var(--deck-muted); }
  .ai-mark p { margin: 0; }
`;
}

/** A template's overlay pictures, positioned by their slide fractions. */
function templateOverlaysHtml(side) {
    return (side && Array.isArray(side.overlays) ? side.overlays : [])
        .map((o) => `<img class="deck-overlay" src="${o.image}" alt="" style="left:${(o.x * 100).toFixed(2)}%;top:${(o.y * 100).toFixed(2)}%;width:${(o.w * 100).toFixed(2)}%;height:${(o.h * 100).toFixed(2)}%">`)
        .join('');
}

function slideSectionHtml({ bandTitle, body, style = null }, theme) {
    const t = deckThemeCss(theme);
    const brand = t.brandOnSlides && t.brandName ? `<div class="brand">${escapeHtml(t.brandName)}</div>` : '';
    const cls = style === 'accent' || style === 'dark' ? ` slide-${style}` : '';
    const overlays = t.template ? templateOverlaysHtml(t.template.content) : '';
    return `
<section class="slide${cls}"${slideVariantStyle(theme, style)}>${overlays}
  <header class="band"><div class="band-title">${bandTitle}</div>${brand}</header>
  <div class="slide-body">${body}</div>
</section>`;
}

function coverSectionHtml({ titleHtml, subtitle = '', date = '' }, theme) {
    const t = deckThemeCss(theme);
    const logo = t.logoDataUrl && t.logoPlacement !== 'none' ? `<img class="cover-logo" src="${t.logoDataUrl}" alt="">` : '';
    const overlays = t.template ? templateOverlaysHtml(t.template.cover) : '';
    return `
<section class="slide cover">${overlays}
  <div class="cover-canvas">${logo}</div>
  <div class="cover-block">
    <div class="cover-title">${titleHtml}</div>
    ${subtitle ? `<div class="cover-sub">${escapeHtml(subtitle)}</div>` : ''}
    <div class="cover-date">${escapeHtml(date)}</div>
  </div>
</section>`;
}

/** The per-page chrome: footer text, and the logo when it sits on every slide. */
function deckFooterHtml(theme) {
    const t = deckThemeCss(theme);
    const parts = [];
    if (t.logoDataUrl && (t.logoPlacement === 'footer' || t.logoPlacement === 'corner')) parts.push(`<img class="deck-logo" src="${t.logoDataUrl}" alt="">`);
    if (t.footerText) parts.push(`<div class="deck-footer">${escapeHtml(t.footerText)}</div>`);
    return parts.join('');
}

function slidesDocument({ title, css, body }) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title>
<style>${css}</style></head>
<body>${body}</body></html>`;
}

function buildSlidesHtml(bodyHtml, { title = '', author = '', date = '', marking = null, theme = null } = {}) {
    const stamp = date || new Date().toISOString().slice(0, 10);
    const html = String(bodyHtml);
    // Zero page margin means Chromium draws no footer chrome, so the marking
    // line lives in the slide itself: position:fixed repeats it on every page.
    const mark = markingFooterHtml(marking);

    // Split on every h2; what precedes the first one is cover material.
    const parts = html.split(/(?=<h2[\s>])/i);
    let head = parts.shift() ?? '';
    let coverTitle = '';
    head = head.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (m, t) => { coverTitle = t; return ''; });
    const intro = head.trim();

    const slides = [];
    for (const part of parts) {
        let bandTitle = '';
        const body = part.replace(/^<h2[^>]*>([\s\S]*?)<\/h2>/i, (m, t) => { bandTitle = t; return ''; });
        slides.push({ bandTitle, body: body.trim() });
    }

    const cover = coverSectionHtml({ titleHtml: coverTitle || escapeHtml(title || 'Document'), subtitle: author, date: stamp }, theme);

    // Cover material that is not the title (a preamble paragraph) gets its own
    // page under the document title, so nothing an author wrote is dropped.
    const introSlide = intro
        ? slideSectionHtml({ bandTitle: coverTitle || escapeHtml(title || 'Inleiding'), body: intro }, theme)
        : '';

    return slidesDocument({
        title,
        css: slidesCss(theme),
        body: `${cover}${introSlide}${slides.map((s) => slideSectionHtml(s, theme)).join('')}${deckFooterHtml(theme)}${mark}`,
    });
}

/** `## Slide N` body HTML from a normalised deck slide (core/documents/deckModel.js). */
function deckSlideBodyHtml(s, theme = null) {
    const bullets = (list) => (list && list.length
        ? `<ul>${list.map((b) => `<li${b.level ? ' style="margin-left:6mm"' : ''}>${escapeHtml(b.text)}</li>`).join('')}</ul>`
        : '');
    const body = s.body ? sanitizeContentForExport(toHtml(s.body, 'markdown')) : '';
    const parts = [];
    // Visuals: the chart is an inline SVG drawn from the same theme the .pptx
    // chart is coloured with; text sits beside it when the slide has any.
    if (s.layout === 'chart' && s.chart) {
        const th = s.style ? slideVariant(ensureResolvedTheme(theme) || resolveDeckTheme(null), s.style) : (ensureResolvedTheme(theme) || resolveDeckTheme(null));
        const fig = `<figure class="deck-chart">${chartSvg(s.chart, th)}</figure>`;
        const text = `${body}${bullets(s.bullets)}`;
        return text ? `<div class="deck-split"><div class="deck-side">${text}</div>${fig}</div>` : fig;
    }
    if (s.layout === 'stats' && s.stats) {
        const sth = ensureResolvedTheme(theme) || resolveDeckTheme(null);
        const sAccent = (s.style ? slideVariant(sth, s.style) : sth).accentOnSlide;
        parts.push(`<div class="deck-stats">${s.stats.map((t) => `<div class="deck-stat">${t.icon ? `<div class="deck-stat-icon">${iconSvg(t.icon, sAccent, { size: 22 })}</div>` : ''}<div class="deck-stat-value">${escapeHtml(t.value)}</div>`
            + `${t.label ? `<div class="deck-stat-label">${escapeHtml(t.label)}</div>` : ''}${t.delta ? `<div class="deck-stat-delta">${escapeHtml(t.delta)}</div>` : ''}</div>`).join('')}</div>`);
        if (body) parts.push(body);
        parts.push(bullets(s.bullets));
        return parts.join('');
    }
    if (s.layout === 'cards' && s.cards) {
        if (body) parts.push(body);
        const th = ensureResolvedTheme(theme) || resolveDeckTheme(null);
        const accent = (s.style ? slideVariant(th, s.style) : th).accentOnSlide;
        parts.push(`<div class="deck-cards deck-cards-${s.cards.length}">${s.cards.map((c) => `<div class="deck-card${c.image || c.icon ? ' deck-card-media' : ''}">`
            + (c.image && c.image.dataUrl ? `<img class="deck-card-image" src="${c.image.dataUrl}" alt="${escapeHtml(c.image.alt || '')}">` : (c.icon ? `<div class="deck-card-icon">${iconSvg(c.icon, accent, { size: 28 })}</div>` : ''))
            + `${c.title ? `<div class="deck-card-title">${escapeHtml(c.title)}</div>` : ''}${c.text ? `<div class="deck-card-text">${escapeHtml(c.text).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('')}</div>`);
        return parts.join('');
    }
    if (s.layout === 'timeline' && s.steps) {
        parts.push(`<ol class="deck-timeline">${s.steps.map((st, i) => `<li><span class="deck-step-n">${i + 1}</span><div class="deck-step-title">${escapeHtml(st.title)}</div>`
            + `${st.text ? `<div class="deck-step-text">${escapeHtml(st.text)}</div>` : ''}</li>`).join('')}</ol>`);
        if (body) parts.push(body);
        return parts.join('');
    }
    if (s.layout === 'quote' && s.quote) {
        parts.push(`<div class="deck-quote-mark">“</div><blockquote class="deck-quote">${escapeHtml(s.quote.text)}</blockquote>`);
        if (s.quote.attribution) parts.push(`<p class="deck-quote-by">${escapeHtml(s.quote.attribution)}</p>`);
    }
    if (s.layout === 'two_column' && s.columns) {
        parts.push(`<div class="deck-columns">${s.columns.map((c) => `<div>${c.title ? `<h3>${escapeHtml(c.title)}</h3>` : ''}${bullets(c.bullets)}</div>`).join('')}</div>`);
        if (body) parts.push(body);
        return parts.join('');
    }
    if (s.table) {
        const t = s.table;
        parts.push(`<table><thead><tr>${t.columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join('')}</tr></thead>`
            + `<tbody>${t.rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(String(v ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    // Only inline bytes survive: the sanitiser blanks every remote src, and
    // the deck model has already refused http(s) references.
    if (s.image && s.image.dataUrl) parts.push(`<img class="deck-image" src="${s.image.dataUrl}" alt="${escapeHtml(s.image.alt || '')}">`);
    if (body) parts.push(body);
    if (s.layout !== 'quote' || !s.quote) parts.push(bullets(s.bullets));
    return parts.join('');
}

/**
 * The on-screen viewer's extra layer: the same slides, laid out as scaled
 * cards on a dark desk instead of as pages. Everything print mode positions
 * with `position: fixed` (the footer, the logo, the marking line) is placed
 * INSIDE each slide here, because fixed means "once, on the viewport" on a
 * screen and "on every page" only on paper.
 */
const SCREEN_DECK_CSS = `
  html { background: #23262b; }
  body { background: transparent; }
  .deck-viewer { padding: 18px 16px 48px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .deck-frame { position: relative; overflow: hidden; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.35); background: var(--deck-bg); flex: none; }
  .deck-frame > .slide { transform-origin: top left; }
  .deck-frame:focus { outline: 2px solid rgba(255,255,255,.6); outline-offset: 2px; }
  .slide, .cover { width: 297mm; height: 210mm; min-height: 0; overflow: hidden; page-break-after: auto; }
  .deck-footer, .deck-logo, .ai-mark { position: absolute; }
  .deck-footer { left: 14mm; right: auto; bottom: 5mm; max-width: 200mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .deck-number { position: absolute; right: 14mm; bottom: 5mm; font-size: 8pt; color: var(--deck-muted); }
  .deck-count { color: rgba(255,255,255,.55); font: 12px/1.4 system-ui, sans-serif; letter-spacing: .3px; }
`;

/**
 * The viewer's script: fit every slide to the width it has (an iframe beside a
 * chat, a full screen), step through them with the keyboard, and tell the
 * parent frame it is up. Inline, because the preview route's CSP allows no
 * external script — and there is nothing here worth a file.
 */
const SCREEN_DECK_SCRIPT = `<script>(function(){
  var W = 297 / 25.4 * 96, H = 210 / 25.4 * 96;
  var frames = Array.prototype.slice.call(document.querySelectorAll('.deck-frame'));
  function fit() {
    var avail = Math.max(120, document.documentElement.clientWidth - 32);
    var s = Math.min(1, avail / W);
    frames.forEach(function (f) {
      f.style.width = (W * s) + 'px'; f.style.height = (H * s) + 'px';
      var slide = f.firstElementChild; if (slide) slide.style.transform = 'scale(' + s + ')';
    });
  }
  function go(delta) {
    var top = document.documentElement.scrollTop || document.body.scrollTop;
    var i = 0;
    for (var k = 0; k < frames.length; k++) { if (frames[k].offsetTop - 24 <= top) i = k; }
    var next = frames[Math.max(0, Math.min(frames.length - 1, i + delta))];
    if (next) { next.scrollIntoView({ behavior: 'smooth', block: 'start' }); try { next.focus({ preventScroll: true }); } catch (_) {} }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); go(-frames.length); }
    else if (e.key === 'End') { e.preventDefault(); go(frames.length); }
  });
  window.addEventListener('resize', fit);
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e && e.data;
    if (d && d.__beeflowDeckGoto === true && typeof d.index === 'number' && frames[d.index]) frames[d.index].scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  fit();
  try { parent.postMessage({ __beeflowDeckReady: true, slideCount: frames.length }, '*'); } catch (_) {}
})();<\/script>`;

/** The per-slide chrome of the viewer: logo, footer line, marking, the number. */
function screenChromeHtml(theme, marking, index, _total) {
    const t = deckThemeCss(theme);
    const parts = [];
    const logo = t.logoDataUrl && (t.logoPlacement === 'footer' || t.logoPlacement === 'corner');
    if (logo) parts.push(`<img class="deck-logo" src="${t.logoDataUrl}" alt="">`);
    const line = [t.footerText || t.brandName, markingText(marking)].filter(Boolean).join('  ·  ');
    // The footer line starts after the logo when the logo sits in the footer:
    // its width follows from its aspect (7mm high), 2.5:1 when unmeasured.
    const left = logo && t.logoPlacement === 'footer' ? `left:${(14 + 7 * (t.logoAspect || 2.5) + 3).toFixed(1)}mm;` : '';
    // On an accent-block cover the line is written in the on-accent colour,
    // as the .pptx cover master does; a template cover keeps its own text.
    const onAccent = index === 0 && !t.template && t.coverStyle === 'accent' ? `color:${t.onAccent};opacity:.75;` : '';
    const style = left || onAccent ? ` style="${left}${onAccent}"` : '';
    if (line) parts.push(`<div class="deck-footer"${style}>${escapeHtml(line)}</div>`);
    if (t.slideNumbers && index > 0) parts.push(`<div class="deck-number">${index + 1}</div>`);
    return parts.join('');
}

/**
 * The PDF deck for a NORMALISED deck — the same structure officegen turns into
 * a .pptx, so `format:'pdf'` on the presentation step is the same deck on
 * paper. Speaker notes are not printed (a PDF has no notes pane).
 *
 * `mode: 'screen'` is the viewer the Documents editor and the chat's side
 * panel show: the same sections, each wrapped as a scaled card, so what a
 * person sees on screen is the PDF's page and the .pptx's slide.
 */
function deckToSlidesHtml(deck, { theme = null, marking = null, date = '', title = '', mode = 'print' } = {}) {
    const screen = mode === 'screen';
    const stamp = date || deck.date || new Date().toISOString().slice(0, 10);
    const cover = coverSectionHtml({
        titleHtml: escapeHtml(title || deck.title || 'Presentation'),
        subtitle: [deck.subtitle, deck.author].filter(Boolean).join(' · '),
        date: stamp,
    }, theme);
    const t = deckThemeCss(theme);
    const slides = deck.slides.map((s) => {
        if (s.layout === 'section') {
            return `<section class="slide"><div class="slide-body" style="padding-top:70mm"><h2 style="color:var(--deck-accent);font-size:26pt;margin:0 0 4mm">${escapeHtml(s.title)}</h2>`
                + `${s.body ? `<p style="color:var(--deck-muted);font-size:13pt">${escapeHtml(s.body)}</p>` : ''}</div></section>`;
        }
        if (s.layout === 'closing' || s.layout === 'title') {
            return coverSectionHtml({ titleHtml: escapeHtml(s.title || 'Thank you'), subtitle: [s.body, ...s.bullets.map((b) => b.text)].filter(Boolean).join(' · '), date: '' }, theme);
        }
        return slideSectionHtml({ bandTitle: escapeHtml(s.title || ''), body: deckSlideBodyHtml(s, theme), style: s.style }, theme);
    });
    if (!screen) {
        return slidesDocument({
            title: title || deck.title,
            css: slidesCss(t),
            body: `${cover}${slides.join('')}${deckFooterHtml(t)}${markingFooterHtml(marking)}`,
        });
    }
    const all = [cover, ...slides];
    // The chrome goes INSIDE each section (before its closing tag) so it is
    // positioned against the slide, not the desk.
    const framed = all.map((html, i) => {
        const withChrome = html.replace(/<\/section>\s*$/, `${screenChromeHtml(t, marking, i, all.length)}</section>`);
        return `<div class="deck-frame" tabindex="0" data-slide="${i + 1}" aria-label="Slide ${i + 1} of ${all.length}">${withChrome}</div>`;
    });
    return slidesDocument({
        title: title || deck.title,
        css: slidesCss(t) + SCREEN_DECK_CSS,
        body: `<div class="deck-viewer">${framed.join('')}<div class="deck-count">${all.length} ${all.length === 1 ? 'slide' : 'slides'}</div></div>${SCREEN_DECK_SCRIPT}`,
    });
}

/** Plain lines for the pdfkit fallback of a deck. */
function deckToPlainText(deck) {
    const lines = [];
    for (const s of deck.slides) {
        lines.push(`## ${s.title || ''}`);
        if (s.body) lines.push(s.body);
        for (const b of s.bullets) lines.push(`${b.level ? '  ' : ''}- ${b.text}`);
        if (s.quote) lines.push(`> ${s.quote.text}${s.quote.attribution ? ` — ${s.quote.attribution}` : ''}`);
        if (s.table) { lines.push(s.table.columns.join(' | ')); for (const r of s.table.rows) lines.push(r.join(' | ')); }
        if (s.chart) {
            lines.push(`Chart (${s.chart.type}):`);
            for (const ser of s.chart.series) lines.push(`${ser.name ? `${ser.name}: ` : ''}${s.chart.labels.map((l, i) => `${l} = ${ser.values[i] ?? '–'}`).join(', ')}`);
        }
        if (s.stats) for (const t of s.stats) lines.push(`${t.value} ${t.label}${t.delta ? ` (${t.delta})` : ''}`);
        if (s.steps) s.steps.forEach((st, i) => lines.push(`${i + 1}. ${st.title}${st.text ? ` — ${st.text}` : ''}`));
        if (s.cards) for (const c of s.cards) lines.push(`${c.title || ''}${c.title && c.text ? ': ' : ''}${c.text || ''}`);
        lines.push('');
    }
    return lines.join('\n');
}

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
        log.warn(`[documentRenderer] browser PDF unavailable, falling back to pdfkit: ${e.message}`);
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

/** markdown → HTML. Already-HTML content passes through untouched. */
function toHtml(content, contentFormat) {
    const text = String(content ?? '');
    if (contentFormat === 'html') return text;
    const { marked } = require('marked');
    // No `mangle`/`headerIds` extras: the output is print material, not a page
    // with anchors, and gfm gives tables + strikethrough which authors expect.
    return marked.parse(text, { gfm: true, breaks: false, async: false });
}

/**
 * The PDF a browser would print. Rejects rather than hangs: a wedged render
 * must surface as a step error, not eat the run's whole deadline.
 */
/**
 * Chromium's per-page footer: the page counter on the right and, for a marked
 * document, the marking line on the left of the same 8px row.
 */
function browserFooterTemplate(marking) {
    const text = markingText(marking);
    const left = text ? `<span style="flex:1;text-align:left">${escapeHtml(text)}</span>` : '';
    return '<div style="font-size:8px;color:#999;width:100%;padding:0 18mm;display:flex;justify-content:space-between">'
        + left
        + '<span style="text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
}

/** The PDF keyword list every path writes — one spelling for the whole product. */
function markingKeywords(marking) {
    return [
        'AIGenerated=true',
        `AIProvider=${marking.provider || 'unknown'}`,
        `GeneratedAt=${marking.generated_at || new Date().toISOString()}`,
        `BeeFlowAutomation=${marking.automation_id || ''}`,
    ];
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
        log.warn(`[documentRenderer] pdf-lib unavailable, PDF metadata not written: ${e.message}`);
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
        log.warn(`[documentRenderer] PDF metadata pass failed, keeping the unmarked bytes: ${e.message}`);
        return { buffer, metadata: false };
    }
}

async function renderPdfViaBrowser(html, { timeoutMs = 60_000, layout = 'document', marking = null } = {}) {
    const browserProvider = require('./browserProvider');
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
 * @param {object} args
 * @param {string} args.html   a full <!DOCTYPE html> document (see services/documentCompose.js)
 * @param {string} [args.title]
 * @param {object} [args.marking]  AI Act Art. 50 marking, as resolveMarking returns it
 * @param {number} [args.timeoutMs]
 * @param {boolean} [args.allowFallback]  false = throw instead of degrading to the plain PDF
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
        const browserProvider = require('./browserProvider');
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
        log.warn(`[documentRenderer] browser PDF unavailable, falling back to pdfkit: ${e.message}`);
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
 */
function renderPdfViaPdfkit(text, { title = '', marking = null } = {}) {
    const PDFDocument = require('pdfkit');
    return new Promise((resolve, reject) => {
        // pdfkit writes the Info dictionary from `info` and accepts custom keys
        // on doc.info — AIGenerated rides along as its own entry.
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

/** Drop the markdown emphasis/link syntax pdfkit would otherwise print literally. */
function stripInline(s) {
    return String(s)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')     // images → alt text
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)') // links keep their target
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
}

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
    let HTMLtoDOCX = require('html-to-docx');
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
 * buildDocxStylingFromHouseStyle) dresses a .docx in the org's Word house
 * style: `inline` (heading fonts, sizes, colours) goes onto the heading tags,
 * the opts (margin, font, header, footer) go to html-to-docx. The CSS joins
 * the print stylesheet, but html-to-docx does not read <style>, so it is not
 * what styles the .docx. Ignored for a PDF.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string, format: string,
 *                    extension: string, degraded: boolean,
 *                    marking: null | {visible: boolean, metadata: boolean}}>}
 *   `degraded` is true when the PDF came from the pdfkit fallback — the caller
 *   records it so "why does this PDF look plain?" has an answer in the run log.
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
            ? require('../core/documents/docxHouseStyle').applyInlineStyles(html, docxStyle.inline)
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

/** Crude tags-out for the pdfkit fallback when the author supplied HTML. */
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

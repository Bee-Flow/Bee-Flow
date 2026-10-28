// @typecheck
const { resolveDeckTheme, slideVariant } = require('../deckThemeOptions');

const NEUTRAL_DECK_THEME = Object.freeze(resolveDeckTheme(null));

function cssHex(value, fallback) {
    const t = String(value ?? '').trim(); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored fixed-length hex colour pattern: linear
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
    /**
     * @param {string} k
     */
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

module.exports = { ensureResolvedTheme, deckThemeCss, slideVariantStyle, slidesCss };

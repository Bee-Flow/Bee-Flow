const { resolveDeckTheme } = require('../deckThemeOptions');

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
        // Set by slideVariant on an emphasis surface; themeFor compares it.
        variant: t.variant === 'accent' || t.variant === 'dark' ? t.variant : null,
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

module.exports = { SLIDE_W, BAND_H, FOOTER_Y, BODY_BOTTOM, pptxHex, ensureResolvedTheme, deckTheme, assertDataImage, cardFill, fitBox, bodyTop, bulletRuns, addBulletsBody, footerLineFor, chromeObjects, defineMasters };

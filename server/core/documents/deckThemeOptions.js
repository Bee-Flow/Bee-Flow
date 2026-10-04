// @typecheck
/**
 * Deck theme options — how a presentation LOOKS, as data.
 *
 * The document house style says what an organisation's paper looks like:
 * one accent, ink, muted, a font stack, a logo. A deck needs more decisions
 * than a letter does — is the title in a band or plain, is the slide light
 * or dark, how does a table read, where does the logo sit — and it needs
 * them as choices a person can make and see, not as CSS the model invents.
 * So the deck has its own small vocabulary here, stored under `deck` in the
 * house style and overridable per call (a chat argument, an automation node's
 * "Look" section, an App Studio step) for the deck in somebody else's brand.
 *
 * TWO INVARIANTS THIS MODULE OWNS:
 *
 *  1. CONTRAST IS ENFORCED, NEVER TRUSTED. `resolveDeckTheme` derives every
 *     text colour from the surface it sits on: a house style whose "ink" is
 *     near-white (it happens — a letterhead designed against a dark panel)
 *     must not produce a deck whose table reads white-on-white. A preferred
 *     colour is kept only when it clears WCAG's 4.5:1; otherwise the darker
 *     or lighter of two safe inks wins.
 *  2. THE RESOLVED THEME IS COMPLETE. Both renderers (officegen for .pptx,
 *     documentRenderer for the PDF deck) read the same resolved object and
 *     never fall back on their own defaults, so the two formats agree.
 *
 * Pure: no I/O, no dependencies. The house style module normalises and
 * stores; the renderers consume.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────

/**
 * The visual families. Each one fixes what the others leave open: the slide
 * surface, how a title is set, and what colour body text wants. A person
 * picks a preset first and adjusts from there.
 */
const DECK_PRESETS = Object.freeze({
    band: {
        label: 'Title band',
        description: 'White slides with the title in a coloured band across the top.',
        background: '#FFFFFF', titleStyle: 'band', text: null, titleColor: null,
    },
    clean: {
        label: 'Clean',
        description: 'White slides, the title in the accent colour with a thin rule under it.',
        background: '#FFFFFF', titleStyle: 'rule', text: null, titleColor: 'accent',
    },
    bold: {
        label: 'Bold',
        description: 'Every slide in the accent colour, white titles and text.',
        background: 'accent', titleStyle: 'plain', text: null, titleColor: null,
    },
    dark: {
        label: 'Dark',
        description: 'Charcoal slides, titles in the accent colour, light text.',
        background: '#16191F', titleStyle: 'rule', text: null, titleColor: 'accent',
    },
});
const DECK_PRESET_IDS = Object.freeze(Object.keys(DECK_PRESETS));

/** Typefaces PowerPoint, Keynote and Collabora all carry (or substitute metrically). */
const DECK_FONTS = Object.freeze([
    'Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic',
    'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas',
]);
/** The document font KEY → a deck typeface, when the deck does not choose its own. */
const FONT_KEY_TO_FACE = Object.freeze({ sans: 'Calibri', serif: 'Cambria', mono: 'Consolas' });
/** A deck typeface → the CSS stack the PDF deck uses. */
const FACE_TO_STACK = Object.freeze({
    Calibri: 'Calibri, Carlito, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    Arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
    Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif',
    Verdana: 'Verdana, "DejaVu Sans", Geneva, sans-serif',
    'Segoe UI': '"Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    'Trebuchet MS': '"Trebuchet MS", "Fira Sans", Helvetica, sans-serif',
    'Century Gothic': '"Century Gothic", "URW Gothic", Futura, sans-serif',
    Georgia: 'Georgia, "DejaVu Serif", serif',
    Cambria: 'Cambria, Caladea, Georgia, serif',
    'Times New Roman': '"Times New Roman", "Liberation Serif", Times, serif',
    Garamond: 'Garamond, "EB Garamond", Georgia, serif',
    Consolas: 'Consolas, "Liberation Mono", Menlo, monospace',
});

const COVER_STYLES = Object.freeze({
    accent: { label: 'Accent block', description: 'A full accent-colour cover with the title in white.' },
    light: { label: 'Light', description: 'A white cover with the title in the accent colour and the logo large.' },
    split: { label: 'Split', description: 'An accent panel on the left with the logo, the title on the right.' },
});
const TABLE_STYLES = Object.freeze({
    banded: { label: 'Banded', description: 'A coloured header row and alternating row shading.' },
    lines: { label: 'Lines', description: 'A coloured header, thin horizontal lines between rows.' },
    minimal: { label: 'Minimal', description: 'No borders; a bold header in the accent colour.' },
});
const LOGO_PLACEMENTS = Object.freeze({
    footer: { label: 'Footer', description: 'Small, bottom-left of every slide, and on the cover.' },
    corner: { label: 'Top corner', description: 'Small, top-right of every slide, and on the cover.' },
    cover: { label: 'Cover only', description: 'Only on the cover and closing slides.' },
    none: { label: 'Nowhere', description: 'Never placed.' },
});

/** What is stored under `deck` in the house style. '' means "inherit / preset default". */
const DEFAULT_DECK_STYLE = Object.freeze({
    preset: 'band',
    accent: '',
    background: '',
    text: '',
    titleFont: '',
    bodyFont: '',
    coverStyle: 'accent',
    tableStyle: 'banded',
    logoPlacement: 'footer',
    slideNumbers: true,
    brandOnSlides: true,
    footerText: '',
    // A template deck's extracted look (core/documents/pptxTemplate.js), or null.
    template: null,
});

const DATA_IMAGE_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_TEMPLATE_OVERLAYS = 8;

/**
 * A stored or per-call template deck: the shape pptxTemplate.extractDeckTemplate
 * produces, checked field by field (inline PNG/JPEG only, overlay boxes as
 * fractions). Anything else is null — a template never fails a deck, it is
 * simply not applied.
 */
function normaliseTemplate(input) {
    if (!input || typeof input !== 'object') return null;
    const side = (v) => {
        if (!v || typeof v !== 'object') return null;
        const image = typeof v.image === 'string' && DATA_IMAGE_RE.test(v.image.replace(/\s+/g, '')) ? v.image.replace(/\s+/g, '') : '';
        const overlays = (Array.isArray(v.overlays) ? v.overlays : []).slice(0, MAX_TEMPLATE_OVERLAYS).map((o) => {
            if (!o || typeof o !== 'object' || typeof o.image !== 'string' || !DATA_IMAGE_RE.test(o.image.replace(/\s+/g, ''))) return null;
            const n = (k) => Math.max(-1, Math.min(2, Number(o[k]) || 0));
            const w = n('w'); const h = n('h');
            return w > 0 && h > 0 ? { image: o.image.replace(/\s+/g, ''), x: n('x'), y: n('y'), w, h } : null;
        }).filter(Boolean);
        return image || overlays.length ? { image, overlays } : null;
    };
    const cover = side(input.cover);
    const content = side(input.content);
    if (!cover && !content) return null;
    return {
        name: String(input.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80),
        aspect: Number(input.aspect) > 0 ? Number(input.aspect) : 16 / 9,
        cover: cover || content,
        content: content || cover,
        background: normHex(input.background, null) || normHex(input.coverBackground, null) || '#1A1D21',
        coverBackground: normHex(input.coverBackground, null) || normHex(input.background, null) || '#1A1D21',
        text: normHex(input.text, null) || '',
        accent: normHex(input.accent, null) || '',
        fonts: { title: pickFont(input.fonts && input.fonts.title) || '', body: pickFont(input.fonts && input.fonts.body) || '' },
    };
}

/**
 * Where a content slide's title may start so it clears the template's
 * overlays (a logo in the top-left corner): the right edge of every overlay
 * that reaches into the title strip, as a fraction of the slide width.
 */
function templateTitleInset(template) {
    if (!template) return 0;
    let inset = 0;
    for (const o of template.content.overlays) {
        if (o.y < 0.28 && o.x < 0.5) inset = Math.max(inset, o.x + o.w);
    }
    return Math.min(inset, 0.5);
}

// ── Colour maths ────────────────────────────────────────────────────────

function isHex(value) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value ?? '').trim());
}

/** `#abc` / `#AABBCC` → `#AABBCC`; anything else → fallback. */
function normHex(value, fallback = null) {
    const t = String(value ?? '').trim();
    if (!isHex(t)) return fallback;
    const h = t.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return `#${full.toUpperCase()}`;
}

function hexToRgb(hex) {
    const h = normHex(hex, '#000000').slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** @param {number[]} rgb */
function rgbToHex([r, g, b]) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 … 21. */
function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

function isDark(hex) {
    return luminance(hex) < 0.35;
}

/** Mix `hex` towards `towards` by `amount` (0..1). */
function mix(hex, towards, amount) {
    const a = hexToRgb(hex);
    const b = hexToRgb(towards);
    return rgbToHex(a.map((v, i) => v + (b[i] - v) * amount));
}

/** RGB (0..255) → HSL (h 0..360, s/l 0..1). */
/** @param {number[]} rgb */
function rgbToHsl([r, g, b]) {
    const rr = r / 255; const gg = g / 255; const bb = b / 255;
    const max = Math.max(rr, gg, bb); const min = Math.min(rr, gg, bb);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0));
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    return [h * 60, s, l];
}

/** @param {number[]} hsl */
function hslToRgb([h, s, l]) {
    const hh = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
        let tt = t; if (tt < 0) tt += 1; if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/** Rotate a colour's hue by `degrees`, keeping saturation and lightness. */
function rotateHue(hex, degrees) {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    return rgbToHex(hslToRgb([h + degrees, Math.max(s, 0.35), Math.min(Math.max(l, 0.3), 0.65)]));
}

const SAFE_DARK = '#1A1D21';
const SAFE_LIGHT = '#FFFFFF';
const MIN_CONTRAST = 4.5;

/**
 * A text colour that READS on `background`: the preferred colour when it
 * clears 4.5:1, otherwise whichever safe ink contrasts more.
 */
function readableOn(background, preferred = null, minimum = MIN_CONTRAST) {
    const bg = normHex(background, SAFE_LIGHT);
    const pref = normHex(preferred, null);
    if (pref && contrastRatio(pref, bg) >= minimum) return pref;
    return contrastRatio(SAFE_DARK, bg) >= contrastRatio(SAFE_LIGHT, bg) ? SAFE_DARK : SAFE_LIGHT;
}

// ── OKLab (for the chart palette's lightness band) ─────────────────────

function srgbToLinear(c) { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(v) { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * (v ** (1 / 2.4)) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); }

function hexToOklab(hex) {
    const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

function oklabToHex([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return rgbToHex([
        linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ]);
}

/** OKLCH hue (degrees) and chroma of a colour. */
function oklch(hex) {
    const [L, a, b] = hexToOklab(hex);
    return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/**
 * The colour with its hue kept and its OKLCH lightness moved inside the
 * band a categorical mark needs (light surface ≈ 0.43–0.77, dark ≈ 0.48–0.67)
 * — the "snap to passing" step of the data-viz colour formula.
 */
function snapToBand(hex, dark) {
    const [lo, hi] = dark ? [0.5, 0.66] : [0.45, 0.72];
    const [L, a, b] = hexToOklab(hex);
    const C = Math.hypot(a, b);
    // A brand colour with little chroma (a navy, a slate) reads as grey next
    // to the other series; lift it to the floor, hue kept.
    const lift = C > 0.005 && C < 0.1 ? 0.11 / C : 1;
    if (L >= lo && L <= hi && lift === 1) return normHex(hex);
    const target = L < lo ? lo : (L > hi ? hi : L);
    const k = Math.min(1, 0.85 + (1 - Math.abs(L - target))) * lift;
    return oklabToHex([target, a * k, b * k]);
}

/**
 * The categorical hue families (blue, orange, aqua, yellow, magenta, green,
 * violet, red) in a light and a dark stepping, and — per family the brand
 * accent belongs to — the ORDER of the five slots that follow it. Every order
 * was searched with the data-viz palette validator (CVD ΔE ≥ 8 on adjacent
 * pairs, normal-vision ΔE ≥ 15, with the family's own hue standing in as
 * slot 1), so a chart never puts two look-alike series side by side. Order
 * is the safety mechanism: slots are assigned in sequence, never cycled.
 */
const CATEGORICAL_LIGHT = Object.freeze(['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#4A3AA7', '#E34948']);
const CATEGORICAL_DARK = Object.freeze(['#3987E5', '#D95926', '#199E70', '#C98500', '#D55181', '#008300', '#9085E9', '#E66767']);
const CATEGORICAL_ORDERS = Object.freeze({
    light: { 0: [1, 6, 3, 4, 5], 1: [0, 2, 6, 4, 5], 2: [0, 1, 6, 4, 5], 3: [0, 1, 6, 4, 5], 4: [5, 0, 1, 6, 2], 5: [4, 6, 1, 0, 2], 6: [1, 0, 3, 4, 5], 7: [0, 1, 6, 4, 5], grey: [1, 6, 3, 0, 5] },
    dark: { 0: [1, 6, 3, 4, 5], 1: [0, 2, 6, 3, 4], 2: [0, 1, 6, 3, 4], 3: [0, 1, 6, 4, 5], 4: [3, 0, 1, 6, 2], 5: [0, 1, 6, 3, 4], 6: [1, 0, 3, 4, 5], 7: [0, 1, 6, 3, 4], grey: [1, 0, 3, 6, 5] },
});

/** Which of the eight families a colour belongs to (nearest OKLCH hue), or 'grey'. */
function hueFamily(hex, dark) {
    const { h, C } = oklch(hex);
    if (C < 0.04) return 'grey';
    const pal = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
    let best = 0; let bestGap = 361;
    pal.forEach((c, i) => {
        const gap = Math.abs(oklch(c).h - h);
        const d = Math.min(gap, 360 - gap);
        if (d < bestGap) { bestGap = d; best = i; }
    });
    return best;
}

/**
 * Six series colours for a chart on `background`: the brand accent first
 * (its hue kept, lightness and chroma snapped into the categorical band),
 * then the validated order for its hue family. Each is checked to show on
 * the surface; the sub-3:1 ones rely on the value labels the charts carry.
 */
function chartColorsFor(accent, background, text) {
    const bg = normHex(background, SAFE_LIGHT);
    const dark = isDark(bg);
    const first = snapToBand(normHex(accent, '#123A5E'), dark);
    const pal = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
    const order = CATEGORICAL_ORDERS[dark ? 'dark' : 'light'][hueFamily(first, dark)];
    const base = [first, ...order.map((i) => pal[i])];
    // A mid-tone surface (a brand blue, a photo) swallows most of the band;
    // charts there are drawn in the text colour and light tints of the same
    // ordered hues — the "on colour" variant of the palette.
    if (base.filter((c) => contrastRatio(c, bg) >= 1.5).length < 3) {
        const ink = normHex(text, SAFE_LIGHT);
        return [ink, ...order.map((i) => mix(pal[i], ink, 0.55))].map((c) => (contrastRatio(c, bg) < 1.5 ? mix(c, ink, 0.5) : c));
    }
    return base.map((c) => (contrastRatio(c, bg) < 1.5 ? mix(c, text, 0.5) : c));
}

/** A muted variant of `text` that still reads on `background` (≥ 3:1). */
function mutedOn(background, text) {
    const bg = normHex(background, SAFE_LIGHT);
    const ink = normHex(text, SAFE_DARK);
    let candidate = mix(ink, bg, 0.45);
    if (contrastRatio(candidate, bg) < 3) candidate = mix(ink, bg, 0.25);
    return contrastRatio(candidate, bg) >= 3 ? candidate : ink;
}

// ── Normalisation ───────────────────────────────────────────────────────

function pickEnum(value, table, fallback) {
    const v = typeof value === 'string' ? value.trim() : '';
    return Object.prototype.hasOwnProperty.call(table, v) ? v : fallback;
}

function pickFont(value) {
    const v = typeof value === 'string' ? value.trim() : '';
    const hit = DECK_FONTS.find((f) => f.toLowerCase() === v.toLowerCase());
    return hit || '';
}

/**
 * Coerce whatever was stored or sent into a complete, valid `deck` style.
 * Unknown keys are dropped; '' keeps "inherit". Used for the house style
 * AND for per-call overrides (where every key is optional).
 */
function normaliseDeckStyle(input = {}) {
    const s = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {}); // untrusted input, any shape
    return {
        preset: pickEnum(s.preset, DECK_PRESETS, DEFAULT_DECK_STYLE.preset),
        accent: normHex(s.accent, '') || '',
        background: normHex(s.background, '') || '',
        text: normHex(s.text, '') || '',
        titleFont: pickFont(s.titleFont),
        bodyFont: pickFont(s.bodyFont ?? s.font),
        coverStyle: pickEnum(s.coverStyle, COVER_STYLES, DEFAULT_DECK_STYLE.coverStyle),
        tableStyle: pickEnum(s.tableStyle, TABLE_STYLES, DEFAULT_DECK_STYLE.tableStyle),
        logoPlacement: pickEnum(s.logoPlacement, LOGO_PLACEMENTS, DEFAULT_DECK_STYLE.logoPlacement),
        slideNumbers: s.slideNumbers === undefined ? DEFAULT_DECK_STYLE.slideNumbers : s.slideNumbers !== false && s.slideNumbers !== 'false',
        brandOnSlides: s.brandOnSlides === undefined ? DEFAULT_DECK_STYLE.brandOnSlides : s.brandOnSlides !== false && s.brandOnSlides !== 'false',
        footerText: String(s.footerText ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200),
        template: normaliseTemplate(s.template),
    };
}

/**
 * Per-call overrides: only the keys that were actually given, each validated
 * the same way the stored style is. An invalid value is dropped, never an
 * error — a wrong colour in an automation binding must not fail the run.
 */
function normaliseDeckOverrides(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    if (input.preset !== undefined) { const v = pickEnum(input.preset, DECK_PRESETS, null); if (v) out.preset = v; }
    for (const k of ['accent', 'background', 'text']) {
        if (input[k] !== undefined) { const v = normHex(input[k], null); if (v) out[k] = v; }
    }
    if (input.titleFont !== undefined) { const v = pickFont(input.titleFont); if (v) out.titleFont = v; }
    const body = input.bodyFont !== undefined ? input.bodyFont : input.font;
    if (body !== undefined) { const v = pickFont(body); if (v) out.bodyFont = v; }
    if (input.coverStyle !== undefined) { const v = pickEnum(input.coverStyle, COVER_STYLES, null); if (v) out.coverStyle = v; }
    if (input.tableStyle !== undefined) { const v = pickEnum(input.tableStyle, TABLE_STYLES, null); if (v) out.tableStyle = v; }
    if (input.logoPlacement !== undefined) { const v = pickEnum(input.logoPlacement, LOGO_PLACEMENTS, null); if (v) out.logoPlacement = v; }
    if (input.slideNumbers !== undefined) out.slideNumbers = input.slideNumbers !== false && input.slideNumbers !== 'false';
    if (input.brandOnSlides !== undefined) out.brandOnSlides = input.brandOnSlides !== false && input.brandOnSlides !== 'false';
    if (typeof input.footerText === 'string') out.footerText = input.footerText.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
    // The template deck: 'none' leaves the house-style template off for this
    // deck; an object (extracted from a .pptx the caller read) replaces it.
    if (input.template === 'none' || input.template === false) out.template = 'none';
    else if (input.template && typeof input.template === 'object') { const t = normaliseTemplate(input.template); if (t) out.template = t; }
    // The deck's own logo: 'none' switches the letterhead logo off; anything
    // else is an image REFERENCE (data: URL, storage key, proxy URL) the
    // renderer resolves — never fetched here, never trusted as bytes.
    if (typeof input.logo === 'string' && input.logo.trim()) {
        const v = input.logo.trim();
        out.logo = /^(none|off|false|no|geen)$/i.test(v) ? 'none' : v.slice(0, 4 * 1024 * 1024);
    }
    return out;
}

// ── Resolution ──────────────────────────────────────────────────────────

/**
 * The COMPLETE theme both renderers read.
 *
 * @param {object} base      the document house style (accent, ink, muted, font, logo…, enabled) or null
 * @param {object} [deck]    the stored deck style (normaliseDeckStyle output) — defaults when absent
 * @param {object} [overrides] per-call overrides (normaliseDeckOverrides output)
 */
function resolveDeckTheme(base, deck = null, overrides = null) {
    const style = base && typeof base === 'object' ? base : {};
    const enabled = !!style.enabled;
    const d = { ...normaliseDeckStyle(deck || {}), ...(overrides || {}) };
    const preset = DECK_PRESETS[d.preset] || DECK_PRESETS.band;

    // A template deck paints the slides with its own pictures: the surface
    // is then the picture's mean colour, the title never sits in a band, and
    // the template's logo replaces the letterhead's.
    const template = d.template === 'none' ? null : (d.template && typeof d.template === 'object' ? d.template : null);

    // Under a template the template's brand colour is the accent, unless the
    // deck (or its house-style deck settings) chose one.
    const accent = d.accent || (template && template.accent) || (enabled ? normHex(style.accent, '#123A5E') : '#123A5E');
    const background = template ? template.background : (d.background || (preset.background === 'accent' ? accent : preset.background));
    const onAccent = readableOn(accent);
    // Body text: the deck's own choice, else the document ink — but only if it
    // reads; a near-white ink on a white slide is exactly what this refuses.
    // On a template's picture the template's own text colour comes first —
    // slide text is large, so the 3:1 bar is the honest one there.
    const text = template
        ? readableOn(background, d.text || template.text || null, 3)
        : readableOn(background, d.text || (enabled ? style.ink : null));
    const muted = mutedOn(background, text);

    const titleStyle = template ? 'plain' : preset.titleStyle;
    const bandColor = titleStyle === 'band' ? accent : null;
    // A title in a band reads on the band; a plain/rule title reads on the slide
    // and prefers the accent, unless the slide IS the accent.
    let titleColor;
    if (titleStyle === 'band') titleColor = readableOn(bandColor);
    else if (!template && preset.titleColor === 'accent' && contrastRatio(accent, background) >= 3) titleColor = accent;
    else titleColor = text;
    const accentOnSlide = contrastRatio(accent, background) >= 3 ? accent : text;

    const docFontFace = FONT_KEY_TO_FACE[style.font] || 'Calibri';
    const bodyFont = d.bodyFont || (template && template.fonts.body) || docFontFace;
    const titleFont = d.titleFont || (template && template.fonts.title) || bodyFont;

    let logoDataUrl = enabled && typeof style.logoDataUrl === 'string' ? style.logoDataUrl : '';
    const logoWidthMm = Number(style.logoWidthMm) || 24;
    // A per-deck logo: 'none' removes it; a data: URL replaces it here; any
    // other reference rides along as `logoRef` for the renderer to resolve.
    let logoRef = null;
    if (d.logo === 'none') logoDataUrl = '';
    else if (typeof d.logo === 'string' && d.logo) {
        if (/^data:image\//i.test(d.logo)) logoDataUrl = d.logo;
        else { logoRef = d.logo; logoDataUrl = ''; }
    }
    // With a template that brings its own overlays (a logo), the letterhead
    // logo stays off unless the deck asked for a placement explicitly.
    const templateHasLogo = !!(template && (template.cover.overlays.length || template.content.overlays.length));
    const hasLogo = !!(logoDataUrl || logoRef) && !(templateHasLogo && !(overrides && overrides.logoPlacement));

    return {
        enabled,
        preset: d.preset,
        accent,
        accent2: mix(accent, isDark(background) ? '#FFFFFF' : '#000000', 0.25),
        background,
        text,
        muted,
        onAccent,
        accentOnSlide,
        titleStyle,
        bandColor,
        titleColor,
        bodyFont,
        titleFont,
        fontFace: bodyFont,
        fontStack: FACE_TO_STACK[bodyFont] || FACE_TO_STACK.Calibri,
        titleFontStack: FACE_TO_STACK[titleFont] || FACE_TO_STACK.Calibri,
        coverStyle: d.coverStyle,
        tableStyle: d.tableStyle,
        // On a template's picture the table is frosted like the cards: a
        // header in the text tint, never a solid block of the brand colour.
        tableHeaderFill: template ? mix(background, text, 0.24) : accent,
        tableHeaderText: template ? text : onAccent,
        tableBand: template ? mix(background, text, 0.08) : mix(background, accent, isDark(background) ? 0.18 : 0.08),
        tableLine: template ? mix(background, text, 0.3) : mix(background, text, 0.18),
        logoPlacement: hasLogo ? d.logoPlacement : 'none',
        logoDataUrl,
        logoRef,
        logoWidthIn: Math.min(Math.max(logoWidthMm / 25.4, 0.3), 2.5),
        chartColors: chartColorsFor(accent, background, text),
        statFill: mix(background, accent, isDark(background) ? 0.22 : 0.09),
        slideNumbers: d.slideNumbers,
        brandOnSlides: template ? false : d.brandOnSlides,
        template,
        titleInset: templateTitleInset(template),
        // Cards on a picture are frosted (translucent), not flat patches.
        glass: !!template,
        brandName: enabled ? String(style.companyName || '') : '',
        tagline: enabled ? String(style.companyTagline || '') : '',
        footerText: d.footerText || (enabled ? String(style.footerText || '') : ''),
    };
}

/**
 * The same theme re-resolved for ONE slide painted differently: 'accent'
 * (the accent colour as the surface) or 'dark' (charcoal). Every colour a
 * renderer reads for that slide — text, muted, title, table, chart palette,
 * stat fill — is recomputed on the new surface, so an emphasis slide keeps
 * the contrast guarantee the deck has.
 */
function slideVariant(theme, style) {
    if (!theme || (style !== 'accent' && style !== 'dark')) return theme;
    const background = style === 'accent' ? theme.accent : '#16191F';
    const text = readableOn(background, style === 'dark' ? '#F3F4F6' : null);
    const muted = mutedOn(background, text);
    const accentOnSlide = style === 'accent' ? text : (contrastRatio(theme.accent, background) >= 3 ? theme.accent : text);
    return {
        ...theme,
        variant: style,
        background,
        text,
        muted,
        onAccent: theme.onAccent,
        accentOnSlide,
        titleStyle: 'plain',
        bandColor: null,
        titleColor: style === 'accent' ? text : accentOnSlide,
        tableHeaderFill: style === 'accent' ? mix(background, text, 0.18) : theme.accent,
        tableHeaderText: style === 'accent' ? text : theme.onAccent,
        tableBand: mix(background, text, 0.08),
        tableLine: mix(background, text, 0.25),
        chartColors: style === 'accent'
            ? [text, mix(text, background, 0.3), mix(text, background, 0.5), rotateHue(theme.accent, 150), mix(text, background, 0.65), rotateHue(theme.accent, 60)].map((c) => (contrastRatio(c, background) < 1.5 ? mix(text, background, 0.4) : c))
            : chartColorsFor(theme.accent, background, text),
        statFill: mix(background, text, 0.1),
    };
}

/** The JSON-schema fragment every tool/node that takes a per-deck look spreads in. */
const DECK_THEME_INPUT_SCHEMA = Object.freeze({
    type: 'object',
    description: 'Optional look overrides for THIS deck — only when the user asks for a specific style or another brand; the organisation\'s house style is the default.',
    properties: {
        preset: { type: 'string', enum: [...DECK_PRESET_IDS], description: 'band = white slides with a coloured title band; clean = white, accent titles; bold = accent-coloured slides; dark = charcoal slides.' },
        accent: { type: 'string', description: 'Accent colour as #RRGGBB.' },
        background: { type: 'string', description: 'Slide background as #RRGGBB (text colours adapt for contrast).' },
        font: { type: 'string', enum: [...DECK_FONTS], description: 'Typeface for the whole deck.' },
        coverStyle: { type: 'string', enum: Object.keys(COVER_STYLES) },
        tableStyle: { type: 'string', enum: Object.keys(TABLE_STYLES) },
        logo: { type: 'string', description: 'A logo for this deck: a Bee Flow storage URL or data: URL, or "none" to leave the house-style logo off.' },
        template: { type: 'string', enum: ['none'], description: '"none" builds this deck without the house-style template deck (plain slides).' },
        logoPlacement: { type: 'string', enum: Object.keys(LOGO_PLACEMENTS) },
        footerText: { type: 'string', description: 'A line in every slide footer (e.g. "Vertrouwelijk · Q3 2026").' },
    },
});

/** What the house-style editor needs to draw its selects. */
function deckOptionCatalog() {
    const entries = (table) => Object.entries(table).map(([id, v]) => ({ id, label: v.label, description: v.description }));
    return {
        presets: entries(DECK_PRESETS),
        fonts: [...DECK_FONTS],
        coverStyles: entries(COVER_STYLES),
        tableStyles: entries(TABLE_STYLES),
        logoPlacements: entries(LOGO_PLACEMENTS),
    };
}

module.exports = {
    DECK_PRESETS,
    DECK_PRESET_IDS,
    DECK_FONTS,
    COVER_STYLES,
    TABLE_STYLES,
    LOGO_PLACEMENTS,
    DEFAULT_DECK_STYLE,
    DECK_THEME_INPUT_SCHEMA,
    normaliseDeckStyle,
    normaliseDeckOverrides,
    normaliseTemplate,
    templateTitleInset,
    resolveDeckTheme,
    slideVariant,
    chartColorsFor,
    snapToBand,
    oklch,
    rotateHue,
    deckOptionCatalog,
    readableOn,
    mutedOn,
    contrastRatio,
    luminance,
    isDark,
    mix,
    normHex,
};

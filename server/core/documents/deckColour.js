// @typecheck strict
/**
 * Colour maths for deck themes: hex parsing, WCAG luminance and contrast,
 * mixing, HSL hue rotation and the OKLab lightness band the chart palette
 * snaps to. Split out of deckThemeOptions.js, which re-exports what callers
 * used from it.
 *
 * Pure: no I/O, no dependencies.
 */

/**
 * @param {string} value
 */
function isHex(value) {
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value ?? '').trim());
}

/**
 * `#abc` / `#AABBCC` → `#AABBCC`; anything else → fallback.
 * @param {string | null} [fallback]
 * @param {string | null} value
 */
function normHex(value, fallback = null) {
    const t = String(value ?? '').trim();
    if (!isHex(t)) return fallback;
    const h = t.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return `#${full.toUpperCase()}`;
}

/**
 * @param {string | null} hex
 */
function hexToRgb(hex) {
    const h = (normHex(hex, '#000000') ?? '#000000').slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** @param {number[]} rgb */
function rgbToHex([r, g, b]) {
    return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * WCAG relative luminance, 0 (black) … 1 (white).
 * @param {string | null} hex
 */
function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours, 1 … 21.
 * @param {string} a
 * @param {string | null} b
 */
function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {string | null} hex
 */
function isDark(hex) {
    return luminance(hex) < 0.35;
}

/**
 * Mix `hex` towards `towards` by `amount` (0..1).
 * @param {string | null} hex
 * @param {string | null} towards
 * @param {number} amount
 */
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
    /** @type {number} */
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
    /**
     * @param {number} t
     */
    const f = (t) => {
        let tt = t; if (tt < 0) tt += 1; if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}

/**
 * Rotate a colour's hue by `degrees`, keeping saturation and lightness.
 * @param {number} degrees
 * @param {string | null} hex
 */
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
 * @param {string} background
 * @param {string | null} [preferred]
 * @param {number} [minimum]
 */
function readableOn(background, preferred = null, minimum = MIN_CONTRAST) {
    const bg = normHex(background, SAFE_LIGHT);
    const pref = normHex(preferred, null);
    if (pref && contrastRatio(pref, bg) >= minimum) return pref;
    return contrastRatio(SAFE_DARK, bg) >= contrastRatio(SAFE_LIGHT, bg) ? SAFE_DARK : SAFE_LIGHT;
}

// ── OKLab (for the chart palette's lightness band) ─────────────────────

/**
 * @param {number} c
 */
function srgbToLinear(c) { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
/**
 * @param {number} v
 */
function linearToSrgb(v) { const c = v <= 0.0031308 ? v * 12.92 : 1.055 * (v ** (1 / 2.4)) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); }

/**
 * @param {string | null} hex
 */
function hexToOklab(hex) {
    const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/**
 * @param {number[]} lab
 */
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

/**
 * OKLCH hue (degrees) and chroma of a colour.
 * @param {string} hex
 */
function oklch(hex) {
    const [L, a, b] = hexToOklab(hex);
    return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/**
 * The colour with its hue kept and its OKLCH lightness moved inside the
 * band a categorical mark needs (light surface ≈ 0.43–0.77, dark ≈ 0.48–0.67)
 * — the "snap to passing" step of the data-viz colour formula.
 * @param {string | null} hex
 * @param {boolean} dark
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

module.exports = { isHex, normHex, hexToRgb, rgbToHex, luminance, contrastRatio, isDark, mix, rgbToHsl, hslToRgb, rotateHue, SAFE_DARK, SAFE_LIGHT, MIN_CONTRAST, readableOn, srgbToLinear, linearToSrgb, hexToOklab, oklabToHex, oklch, snapToBand };

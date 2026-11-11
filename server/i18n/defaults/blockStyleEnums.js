// @typecheck strict
// The design values a CMS block's `style` may carry for its background image
// and the built-in brand motif, and the one function that cleans them. This
// file is the source of record: agent-hub gets a byte-for-byte GENERATED copy
// (scripts/shared-mirror.manifest.json), so the server store, the AI/MCP tool
// validator and the public renderer cannot disagree about what is legal.
//
// Nothing here is ever free CSS. Every value is an enum member, a boolean, or
// a whole number of pixels inside a fixed range; the renderer turns them into
// class names (and, for the pixel width, one custom property whose value is
// rebuilt from the number, never copied from the input).

'use strict';

const BG_SIZES = ['cover', 'contain', 'auto'];
// A fixed width in pixels ("480px"), the one non-enum size.
const BG_SIZE_PX_MIN = 16;
const BG_SIZE_PX_MAX = 2400;
// Nine anchors, written like the CSS pair (vertical first, then horizontal).
const BG_POSITIONS = [
    'top-left', 'top', 'top-right',
    'left', 'center', 'right',
    'bottom-left', 'bottom', 'bottom-right',
];
const BG_REPEATS = ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'];
// The built-in decorative pattern. 'none' is the identity value.
const MOTIFS = ['none', 'honeycomb'];
const MOTIF_SIDES = ['right', 'left', 'center'];
// Hero blur blobs: 'default' keeps them, 'none' switches them off.
const DECORS = ['default', 'none'];
// Fill of the cards inside a block: 'tint' (the theme's card tint) is the identity value.
const CARD_FILLS = ['tint', 'white', 'none'];
// Trust-band chip labels: 'mono' (monospace, uppercase, tracked) is the identity value.
const LABEL_STYLES = ['mono', 'plain'];

// Bento feature cards: the height box and the fit of an item's media
// (`items[].mediaHeight` / `items[].mediaFit`). 'auto' / 'natural' are the
// identity values: the whole image at its own aspect ratio, never cropped.
const MEDIA_HEIGHTS = ['auto', 'sm', 'md', 'lg', 'xl'];
const MEDIA_FITS = ['natural', 'contain', 'cover'];

/**
 * Normalise a background size: an enum member, or "<n>px" with n a whole
 * number in range. Returns the clean string, or null when it is not legal.
 * @param {unknown} v
 * @returns {string | null}
 */
function cleanBackgroundSize(v) {
    if (typeof v === 'number' && Number.isInteger(v)) v = `${v}px`;
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (BG_SIZES.includes(s)) return s;
    const m = /^(\d{2,4})px$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= BG_SIZE_PX_MIN && n <= BG_SIZE_PX_MAX ? `${n}px` : null;
}

/** The pixel width of a clean "<n>px" size, or null for the enum sizes. */
/** @param {unknown} clean */
function backgroundSizePx(clean) {
    const m = typeof clean === 'string' ? /^(\d+)px$/.exec(clean) : null;
    return m ? Number(m[1]) : null;
}

// Colour overrides (`style.colorOverrides`): the forms a value may have. The
// renderer writes the value into a style rule, so a value is one of these
// forms or it is not written: "#" plus 3, 4, 6 or 8 hex digits, a functional
// notation from COLOR_FUNCTIONS with plain arguments, "var(--name)", or a
// colour keyword (letters only).
const COLOR_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch'];
const COLOR_MAX_LENGTH = 64;
const HEX_DIGITS = '0123456789abcdef';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const NAME_CHARS = `${LETTERS}0123456789-_`;
const ARGUMENT_CHARS = `${LETTERS}0123456789 ,.%/+-`;

/**
 * @param {string} s
 * @param {string} allowed
 */
function onlyChars(s, allowed) {
    if (!s) return false;
    for (const ch of s) if (!allowed.includes(ch)) return false;
    return true;
}

/**
 * Is `v` a colour in one of the forms above? Case and outer spaces do not matter.
 * @param {unknown} v
 * @returns {v is string}
 */
function isCssColor(v) {
    if (typeof v !== 'string' || v.length > COLOR_MAX_LENGTH) return false;
    const s = v.trim().toLowerCase();
    if (s.startsWith('#')) return [3, 4, 6, 8].includes(s.length - 1) && onlyChars(s.slice(1), HEX_DIGITS);
    const open = s.indexOf('(');
    if (open === -1) return onlyChars(s, LETTERS);
    if (!s.endsWith(')')) return false;
    const name = s.slice(0, open);
    const inner = s.slice(open + 1, -1);
    if (name === 'var') return inner.startsWith('--') && onlyChars(inner.slice(2), NAME_CHARS);
    return COLOR_FUNCTIONS.includes(name) && onlyChars(inner, ARGUMENT_CHARS);
}

/**
 * Copy of a colour override map with only the values that are a colour (or
 * the empty string, which means "no override"). Anything that is not a map
 * gives an empty one.
 * @param {unknown} overrides
 * @returns {Record<string, string>}
 */
function cleanColorOverrides(overrides) {
    /** @type {Record<string, string>} */
    const out = {};
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return out;
    for (const [key, value] of Object.entries(overrides)) {
        if (value === '' || isCssColor(value)) out[key] = value;
    }
    return out;
}

/**
 * Copy of `style` in which every design key of this file is either legal or
 * gone, and `colorOverrides` (when present) holds colours only. Other keys
 * pass through untouched (they have their own validators).
 * @param {Record<string, unknown>} style
 * @returns {Record<string, unknown>}
 */
function sanitizeBlockDesignStyle(style) {
    const out = { ...style };
    const size = 'backgroundSize' in out ? cleanBackgroundSize(out.backgroundSize) : null;
    if (size) out.backgroundSize = size; else delete out.backgroundSize;
    const enums = {
        backgroundPosition: BG_POSITIONS,
        backgroundRepeat: BG_REPEATS,
        motif: MOTIFS,
        motifSide: MOTIF_SIDES,
        decor: DECORS,
        cardFill: CARD_FILLS,
        labelStyle: LABEL_STYLES,
    };
    for (const [key, allowed] of Object.entries(enums)) {
        if (key in out && !allowed.includes(/** @type {string} */ (out[key]))) delete out[key];
    }
    for (const key of ['backgroundHideMobile', 'motifTiles']) {
        if (key in out && typeof out[key] !== 'boolean') delete out[key];
    }
    if ('colorOverrides' in out) out.colorOverrides = cleanColorOverrides(out.colorOverrides);
    return out;
}

const BLOCK_DESIGN_STYLE_KEYS = [
    'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundHideMobile',
    'motif', 'motifSide', 'motifTiles', 'decor', 'cardFill', 'labelStyle',
];

module.exports = {
    BG_SIZES, BG_SIZE_PX_MIN, BG_SIZE_PX_MAX, BG_POSITIONS, BG_REPEATS, MOTIFS, MOTIF_SIDES,
    DECORS, CARD_FILLS, LABEL_STYLES,
    MEDIA_HEIGHTS, MEDIA_FITS,
    BLOCK_DESIGN_STYLE_KEYS, cleanBackgroundSize, backgroundSizePx, sanitizeBlockDesignStyle,
    COLOR_FUNCTIONS, isCssColor, cleanColorOverrides,
};

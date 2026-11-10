// @typecheck
// The block style wrapper a cms_update_block stylePatch may carry: the closed
// key set (v1 plus the style v2 keys the renderer reads in blockWrapClasses /
// blockWrapStyle) and the validator that turns a patch into a clean one.

'use strict';

const {
    BG_POSITIONS, BG_REPEATS, BG_SIZES, BG_SIZE_PX_MIN, BG_SIZE_PX_MAX, MOTIFS, MOTIF_SIDES, DECORS, CARD_FILLS, LABEL_STYLES,
    BLOCK_DESIGN_STYLE_KEYS, cleanBackgroundSize, isCssColor, COLOR_FUNCTIONS,
} = require('../i18n/defaults/blockStyleEnums');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const STYLE_MAX_WIDTHS = ['narrow', 'medium', 'wide', 'full'];
const STYLE_ALIGNS = ['left', 'center', 'right'];
// The renderer (marketing/ProductWebsite buildBlockOverrideCss) reads `text`, not
// `textPrimary`; `textPrimary` stays accepted as the design colour's name and is stored as `text`.
const COLOR_TOKENS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'textSecondary'];
const COLOR_TOKEN_ALIASES = { textPrimary: 'text' };
const SPACING_KEYS = ['paddingTop', 'paddingBottom'];
// Style v2 (the renderer's blockWrapClasses / blockWrapStyle): closed enums.
/** @type {Record<string, string[]>} */
const STYLE_ENUMS = {
    band: ['default', 'surface', 'tint', 'dark', 'primary'],
    rhythm: ['tight', 'compact', 'default', 'spacious'],
    reveal: ['on', 'off'],
};
const STYLE_COLUMNS = [2, 3, 4];
const STYLE_KEYS = [
    'colorOverrides', 'spacing', 'backgroundImage', 'backgroundOverlay', 'maxWidth', 'align', 'cssClass',
    'band', 'rhythm', 'reveal', 'glow', 'columns',
    ...BLOCK_DESIGN_STYLE_KEYS,
];
// Design keys with a closed enum: the key, its legal values, and the label of the fix hint.
/** @type {Record<string, string[]>} */
const DESIGN_ENUMS = {
    backgroundPosition: BG_POSITIONS,
    backgroundRepeat: BG_REPEATS,
    motif: MOTIFS,
    motifSide: MOTIF_SIDES,
    decor: DECORS,
    cardFill: CARD_FILLS,
    labelStyle: LABEL_STYLES,
};

/**
 * Shallow-validate a stylePatch against the block style wrapper shape.
 * Returns { style, hints } (validated patch + repair notes) or { error, _fixHint }.
 */
function validateStylePatch(patch) {
    if (!isPlainObject(patch)) return { error: 'stylePatch must be an object.' };
    const out = {};
    /** @type {string[]} */
    const hints = [];
    for (const [key, value] of Object.entries(patch)) {
        if (!STYLE_KEYS.includes(key)) {
            hints.push(`stylePatch.${key}: unknown style key, dropped. Valid keys: ${STYLE_KEYS.join(', ')}.`);
            continue;
        }
        if (key === 'maxWidth') {
            if (!STYLE_MAX_WIDTHS.includes(value)) {
                return { error: `stylePatch.maxWidth ${JSON.stringify(value)} is invalid.`, _fixHint: `Valid maxWidth values: ${STYLE_MAX_WIDTHS.join(', ')}.` };
            }
            out.maxWidth = value;
        } else if (key === 'align') {
            if (!STYLE_ALIGNS.includes(value)) {
                return { error: `stylePatch.align ${JSON.stringify(value)} is invalid.`, _fixHint: `Valid align values: ${STYLE_ALIGNS.join(', ')}.` };
            }
            out.align = value;
        } else if (key === 'colorOverrides') {
            if (!isPlainObject(value)) {
                return { error: 'stylePatch.colorOverrides must be an object of color tokens.', _fixHint: `Valid tokens: ${COLOR_TOKENS.join(', ')}.` };
            }
            /** @type {Record<string, string>} */
            const colors = {};
            for (const [tok, col] of Object.entries(value)) {
                const token = Object.hasOwn(COLOR_TOKEN_ALIASES, tok) ? COLOR_TOKEN_ALIASES[/** @type {keyof typeof COLOR_TOKEN_ALIASES} */ (tok)] : tok;
                if (!COLOR_TOKENS.includes(token)) { hints.push(`colorOverrides.${tok}: unknown token, dropped. Valid tokens: ${COLOR_TOKENS.join(', ')}.`); continue; }
                if (typeof col !== 'string') { hints.push(`colorOverrides.${tok}: must be a color string, dropped.`); continue; }
                // '' clears an override; anything else is a colour in one of the stored forms.
                if (col !== '' && !isCssColor(col)) { hints.push(`colorOverrides.${tok}: not a color, dropped. Use "#rrggbb" (also #rgb, #rrggbbaa), ${COLOR_FUNCTIONS.join('() / ')}() with plain numbers, var(--name) or a color keyword.`); continue; }
                colors[token] = col;
            }
            out.colorOverrides = colors;
        } else if (key === 'spacing') {
            if (!isPlainObject(value)) {
                return { error: 'stylePatch.spacing must be an object.', _fixHint: `Valid spacing keys: ${SPACING_KEYS.join(', ')} (numbers).` };
            }
            // The renderer takes CSS-value strings only (a number is ignored), so a number is stored as pixels.
            /** @type {Record<string, string>} */
            const spacing = {};
            for (const [sk, sv] of Object.entries(value)) {
                if (!SPACING_KEYS.includes(sk)) { hints.push(`spacing.${sk}: unknown key, dropped. Valid keys: ${SPACING_KEYS.join(', ')}.`); continue; }
                if (typeof sv !== 'number' || !Number.isFinite(sv)) { hints.push(`spacing.${sk}: must be a number, dropped.`); continue; }
                spacing[sk] = `${sv}px`;
            }
            out.spacing = spacing;
        } else if (key === 'band' || key === 'rhythm' || key === 'reveal') {
            const allowed = STYLE_ENUMS[key];
            if (!allowed.includes(value)) {
                return { error: `stylePatch.${key} ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `Valid ${key} values: ${allowed.join(', ')}.` };
            }
            out[key] = value;
        } else if (key === 'glow') {
            if (typeof value !== 'boolean') {
                return { error: `stylePatch.glow ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: 'glow is true or false.' };
            }
            out.glow = value;
        } else if (key === 'columns') {
            const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
            if (!STYLE_COLUMNS.includes(n)) {
                return { error: `stylePatch.columns ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `Valid columns values (a number): ${STYLE_COLUMNS.join(', ')}.` };
            }
            out.columns = n;
        } else if (key === 'backgroundSize') {
            const size = cleanBackgroundSize(value);
            if (!size) {
                return { error: `stylePatch.backgroundSize ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `Valid backgroundSize values: ${BG_SIZES.join(', ')}, or a width in pixels such as "480px" (${BG_SIZE_PX_MIN} to ${BG_SIZE_PX_MAX}). No other CSS.` };
            }
            out.backgroundSize = size;
        } else if (key in DESIGN_ENUMS) {
            const allowed = DESIGN_ENUMS[/** @type {keyof typeof DESIGN_ENUMS} */ (key)];
            if (!allowed.includes(value)) {
                return { error: `stylePatch.${key} ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `Valid ${key} values: ${allowed.join(', ')}.` };
            }
            out[key] = value;
        } else if (key === 'backgroundHideMobile' || key === 'motifTiles') {
            if (typeof value !== 'boolean') {
                return { error: `stylePatch.${key} ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `${key} is true or false.` };
            }
            out[key] = value;
        } else if (key === 'backgroundImage' || key === 'cssClass') {
            if (typeof value !== 'string') { hints.push(`stylePatch.${key}: must be a string, dropped.`); continue; }
            out[key] = value;
        } else if (key === 'backgroundOverlay') {
            if (typeof value !== 'number' && typeof value !== 'string') { hints.push('stylePatch.backgroundOverlay: must be a number or color string, dropped.'); continue; }
            out.backgroundOverlay = value;
        }
    }
    return { style: out, hints };
}

module.exports = { validateStylePatch, STYLE_KEYS };

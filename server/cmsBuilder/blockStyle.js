// @typecheck
// The block style wrapper a cms_update_block stylePatch may carry: the closed
// key set (v1 plus the style v2 keys the renderer reads in blockWrapClasses /
// blockWrapStyle) and the validator that turns a patch into a clean one.

'use strict';

const {
    BG_POSITIONS, BG_REPEATS, BG_SIZES, BG_SIZE_PX_MIN, BG_SIZE_PX_MAX, MOTIFS, MOTIF_SIDES, DECORS, CARD_FILLS, LABEL_STYLES,
    TILE_SHAPES, TILE_FILLS, TILE_SIZES, TILE_ICON_COLORS,
    BLOCK_DESIGN_STYLE_KEYS, ANCHOR_MAX, cleanAnchor, cleanBackgroundSize,
} = require('../i18n/defaults/blockStyleEnums');

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const STYLE_MAX_WIDTHS = ['narrow', 'medium', 'wide', 'full'];
const STYLE_ALIGNS = ['left', 'center', 'right'];
const COLOR_TOKENS = ['primary', 'secondary', 'accent', 'background', 'surface', 'textPrimary', 'textSecondary'];
const SPACING_KEYS = ['paddingTop', 'paddingBottom'];
// Style v2 (the renderer's blockWrapClasses / blockWrapStyle): closed enums.
const STYLE_ENUMS = {
    band: ['default', 'surface', 'tint', 'dark', 'primary'],
    rhythm: ['tight', 'compact', 'default', 'spacious'],
    reveal: ['on', 'off'],
};
const STYLE_COLUMNS = [2, 3, 4];
const STYLE_KEYS = [
    'colorOverrides', 'spacing', 'backgroundImage', 'backgroundOverlay', 'maxWidth', 'align', 'cssClass',
    'band', 'rhythm', 'reveal', 'glow', 'columns', 'anchor',
    ...BLOCK_DESIGN_STYLE_KEYS,
];
// Design keys with a closed enum: the key, its legal values, and the label of the fix hint.
const DESIGN_ENUMS = {
    backgroundPosition: BG_POSITIONS,
    backgroundRepeat: BG_REPEATS,
    motif: MOTIFS,
    motifSide: MOTIF_SIDES,
    decor: DECORS,
    cardFill: CARD_FILLS,
    labelStyle: LABEL_STYLES,
    tileShape: TILE_SHAPES,
    tileFill: TILE_FILLS,
    tileSize: TILE_SIZES,
    tileIconColor: TILE_ICON_COLORS,
};

/**
 * Shallow-validate a stylePatch against the block style wrapper shape.
 * Returns { style, hints } (validated patch + repair notes) or { error, _fixHint }.
 */
function validateStylePatch(patch) {
    if (!isPlainObject(patch)) return { error: 'stylePatch must be an object.' };
    const out = {};
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
            const colors = {};
            for (const [tok, col] of Object.entries(value)) {
                if (!COLOR_TOKENS.includes(tok)) { hints.push(`colorOverrides.${tok}: unknown token, dropped. Valid tokens: ${COLOR_TOKENS.join(', ')}.`); continue; }
                if (typeof col !== 'string') { hints.push(`colorOverrides.${tok}: must be a color string, dropped.`); continue; }
                colors[tok] = col;
            }
            out.colorOverrides = colors;
        } else if (key === 'spacing') {
            if (!isPlainObject(value)) {
                return { error: 'stylePatch.spacing must be an object.', _fixHint: `Valid spacing keys: ${SPACING_KEYS.join(', ')} (numbers).` };
            }
            const spacing = {};
            for (const [sk, sv] of Object.entries(value)) {
                if (!SPACING_KEYS.includes(sk)) { hints.push(`spacing.${sk}: unknown key, dropped. Valid keys: ${SPACING_KEYS.join(', ')}.`); continue; }
                if (typeof sv !== 'number' || !Number.isFinite(sv)) { hints.push(`spacing.${sk}: must be a number, dropped.`); continue; }
                spacing[sk] = sv;
            }
            out.spacing = spacing;
        } else if (key === 'band' || key === 'rhythm' || key === 'reveal') {
            const allowed = STYLE_ENUMS[key];
            if (!allowed.includes(value)) {
                return { error: `stylePatch.${key} ${JSON.stringify(value ?? null)} is invalid.`, _fixHint: `Valid ${key} values: ${allowed.join(', ')}.` };
            }
            out[key] = value;
        } else if (key === 'anchor') {
            const anchor = cleanAnchor(value);
            if (!anchor) {
                return {
                    error: `stylePatch.anchor ${JSON.stringify(value ?? null)} is invalid.`,
                    _fixHint: `anchor is a slug: lowercase letters, digits and single hyphens, starting with a letter, at most ${ANCHOR_MAX} characters ("install", "get-started"). "main" is reserved.`,
                };
            }
            out.anchor = anchor;
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

/**
 * Why `anchor` cannot go on a block: another block on the page already has it.
 * Returns the problem and its fix hint, or null when the anchor is free.
 * @param {Array<{ id?: string, style?: { anchor?: unknown } }>} blocks
 * @param {string | null} ownId the block being edited (may keep its own anchor)
 * @param {unknown} anchor
 * @returns {{ error: string, _fixHint: string } | null}
 */
function anchorConflict(blocks, ownId, anchor) {
    if (!anchor) return null;
    const hit = (blocks || []).find((b) => b && b.id !== ownId && b.style && b.style.anchor === anchor);
    if (!hit) return null;
    return {
        error: `style.anchor ${JSON.stringify(anchor)} is already used by block ${hit.id} on this page.`,
        _fixHint: 'Anchors are unique per page: pick another slug.',
    };
}

module.exports = { validateStylePatch, anchorConflict, STYLE_KEYS };

// @typecheck
/**
 * CMS builder validation: authoring mistakes that render silently wrong
 * (called from ./validate.js). Warnings only; every renderer copes with what
 * these report, they exist so the author finds out.
 *
 *   unknown_element_kind    content element the renderer drops
 *   style_key_in_content    a style key (labelStyle, band, ...) written into content
 *   placeholder_content     list items still holding the seeded default text
 *   style_columns_unused    style.columns on a block that has no column grid
 *   integration_without_logo integration tile with no brand mark
 *   unknown_content_key     content key the block type does not have
 */

'use strict';

const { BLOCK_DEFAULTS } = require('../i18n/defaults/cmsDefaults');

/** Element kinds the Content block renders (button and link are cta aliases). */
const CONTENT_ELEMENT_KINDS = ['text', 'image', 'video', 'iframe', 'cta', 'button', 'link'];

/** Style keys that an author may mistake for a content option. */
const MISPLACED_STYLE_KEYS = [
    'labelStyle', 'band', 'rhythm', 'motif', 'motifSide', 'motifTiles', 'decor', 'cardFill',
    'tileShape', 'tileFill', 'tileSize', 'tileIconColor', 'glow', 'reveal', 'columns',
];

/** Content keys every block may carry besides its type's own (design and chrome keys). */
const COMMON_CONTENT_KEYS = ['enabled', 'backgroundVariant', 'variant', 'align', 'anchor'];

/** Keys like titleStyle / leadAlign are per-text design overrides on every block. */
const TEXT_DESIGN_KEY = /(Style|Align)$/;

/** Block types whose renderer reads style.columns (--cms-cols). */
const COLUMN_GRID_TYPES = ['features', 'steps', 'security', 'techStats'];

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Seeded default text of the list items of a block type, per list key.
 * @param {string} type
 * @param {string} listKey
 * @returns {Set<string>}
 */
function seededTexts(type, listKey) {
    const defaults = /** @type {Record<string, any>} */ (BLOCK_DEFAULTS)[type];
    const list = defaults && Array.isArray(defaults[listKey]) ? defaults[listKey] : [];
    const out = new Set();
    for (const item of list) {
        for (const v of Object.values(item || {})) if (typeof v === 'string' && v) out.add(v);
    }
    return out;
}

/** Fields of a list item whose seeded text marks it unfinished. */
const PLACEHOLDER_LISTS = [
    { type: 'steps', listKey: 'items', fields: ['title', 'body'] },
    { type: 'security', listKey: 'cards', fields: ['summary'] },
];

/**
 * @param {Record<string, any>} block
 * @param {string} path  `pages.<id>.blocks[<i>]`
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkBlockQuality(block, path, warnings) {
    const content = isPlainObject(block?.content) ? block.content : {};
    const type = String(block?.type || '');

    if (type === 'content' && Array.isArray(content.columns)) {
        content.columns.forEach((/** @type {any} */ col, /** @type {number} */ ci) => {
            const elements = isPlainObject(col) && Array.isArray(col.elements) ? col.elements : [];
            elements.forEach((/** @type {any} */ el, /** @type {number} */ ei) => {
                if (isPlainObject(el) && CONTENT_ELEMENT_KINDS.includes(String(el.kind))) return;
                warnings.push({
                    code: 'unknown_element_kind',
                    path: `${path}.content.columns[${ci}].elements[${ei}].kind`,
                    message: `Element kind ${JSON.stringify(isPlainObject(el) ? el.kind : el)} is not rendered, so the element is dropped.`,
                    hint: `Supported kinds: ${CONTENT_ELEMENT_KINDS.slice(0, 5).join(', ')} (button and link are accepted as cta).`,
                });
            });
        });
    }

    const defaults = /** @type {Record<string, any>} */ (BLOCK_DEFAULTS)[type] || {};
    if (Object.keys(defaults).length) {
        for (const key of Object.keys(content)) {
            if (key in defaults || COMMON_CONTENT_KEYS.includes(key) || TEXT_DESIGN_KEY.test(key)) continue;
            if (MISPLACED_STYLE_KEYS.includes(key)) continue;
            warnings.push({
                code: 'unknown_content_key',
                path: `${path}.content.${key}`,
                message: `"${key}" is not a content field of a "${type}" block, so it does nothing.`,
                hint: `Content fields of ${type}: ${Object.keys(defaults).join(', ')}.`,
            });
        }
    }
    for (const key of MISPLACED_STYLE_KEYS) {
        if (!(key in content) || key in defaults) continue;
        warnings.push({
            code: 'style_key_in_content',
            path: `${path}.content.${key}`,
            message: `"${key}" is a block style key; in content it does nothing.`,
            hint: `Move it to style.${key} (cms_update_block with stylePatch).`,
        });
    }

    for (const { type: t, listKey, fields } of PLACEHOLDER_LISTS) {
        if (type !== t || !Array.isArray(content[listKey])) continue;
        const seeded = seededTexts(t, listKey);
        content[listKey].forEach((/** @type {any} */ item, /** @type {number} */ idx) => {
            const left = fields.filter((f) => isPlainObject(item) && seeded.has(String(item[f])));
            if (!left.length) return;
            warnings.push({
                code: 'placeholder_content',
                path: `${path}.content.${listKey}[${idx}]`,
                message: `${listKey}[${idx}] still holds the seeded placeholder text (${left.join(', ')}).`,
                hint: `Send the complete ${listKey} array with real text; cms_add_blocks seeds example items when none are given.`,
            });
        });
    }

    const st = isPlainObject(block?.style) ? block.style : {};
    if (st.columns !== undefined && !COLUMN_GRID_TYPES.includes(type)) {
        warnings.push({
            code: 'style_columns_unused',
            path: `${path}.style.columns`,
            message: `style.columns has no effect on a "${type}" block.`,
            hint: `Only ${COLUMN_GRID_TYPES.join(', ')} read it. Remove it.`,
        });
    }

    if (type === 'integrations' && Array.isArray(content.categories)) {
        content.categories.forEach((/** @type {any} */ cat, /** @type {number} */ ci) => {
            const items = isPlainObject(cat) && Array.isArray(cat.items) ? cat.items : [];
            items.forEach((/** @type {any} */ item, /** @type {number} */ ii) => {
                if (isPlainObject(item) && (item.logoId || item.logoSrc)) return;
                warnings.push({
                    code: 'integration_without_logo',
                    path: `${path}.content.categories[${ci}].items[${ii}]`,
                    message: 'This integration tile has no logoId or logoSrc, so it shows a neutral icon tile.',
                    hint: 'Set logoId (an id from the integration logo registry) or upload a logo as logoSrc.',
                });
            });
        });
    }
}

module.exports = { checkBlockQuality, CONTENT_ELEMENT_KINDS };

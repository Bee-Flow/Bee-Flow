// @typecheck strict
/**
 * CMS builder validation of single block types (called from ./validate.js).
 * Warnings only: every renderer copes with what these report.
 */

'use strict';

const { TABS_MIN, TABS_MAX, MATRIX_COLUMNS_MIN, MATRIX_COLUMNS_MAX, STORY_METRICS_MIN, STORY_METRICS_MAX } = require('../i18n/defaults/cmsDefaults');

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Tabs block: 2-6 tabs, each with a label (the tab button), and unique
 * `tabId`s (the `?tab=` deep link). Warnings only; the renderer copes with
 * every one of these (a missing id falls back to the 1-based position).
 * @param {unknown} content
 * @param {string} path
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkTabs(content, path, warnings) {
    const items = isPlainObject(content) && Array.isArray(content.items) ? content.items : [];
    if (items.length < TABS_MIN || items.length > TABS_MAX) {
        warnings.push({
            code: 'tabs_count',
            path: `${path}.items`,
            message: `A tabs block has ${items.length} tab(s); it is designed for ${TABS_MIN}-${TABS_MAX}.`,
            hint: items.length < TABS_MIN
                ? 'With one tab there is nothing to switch between: use a media-text block, or add a second tab (send the complete items array).'
                : `Split the content over two tabs blocks or drop tabs: more than ${TABS_MAX} tab buttons do not fit on a phone.`,
        });
    }
    const seen = new Set();
    items.forEach((item, idx) => {
        const label = isPlainObject(item) && typeof item.label === 'string' ? item.label.trim() : '';
        if (!label) {
            warnings.push({
                code: 'tabs_empty_label',
                path: `${path}.items[${idx}].label`,
                message: `Tab ${idx + 1} has no label, so its tab button is empty.`,
                hint: 'Give every tab a short label (one or two words), e.g. "IT" or "Legal".',
            });
        }
        const id = isPlainObject(item) && typeof item.tabId === 'string' ? item.tabId.trim() : '';
        if (id && seen.has(id)) {
            warnings.push({
                code: 'tabs_duplicate_id',
                path: `${path}.items[${idx}].tabId`,
                message: `tabId ${JSON.stringify(id)} is used by more than one tab, so ?tab= can only reach the first.`,
                hint: 'Give each tab its own tabId (lowercase letters, digits and dashes), e.g. "it", "legal".',
            });
        }
        if (id) seen.add(id);
    });
}

/** @param {unknown} v */
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

const MATRIX_CELL_KINDS = ['included', 'excluded', 'text'];

/**
 * The ids of `list` (entries with a non-empty `id`), reporting missing ids and repeats.
 * @param {unknown[]} list
 * @param {string} path
 * @param {string} what  singular noun for the messages ("Column")
 * @param {Array<Record<string, unknown>>} warnings
 * @returns {Set<string>}
 */
function collectIds(list, path, what, warnings) {
    const seen = new Set();
    list.forEach((entry, idx) => {
        const id = isPlainObject(entry) ? trimmed(entry.id) : '';
        if (!id) {
            warnings.push({
                code: 'matrix_missing_id',
                path: `${path}[${idx}].id`,
                message: `${what} ${idx + 1} has no id, so its translations and its cells cannot be matched to it.`,
                hint: `Give every ${what.toLowerCase()} a short stable id (lowercase letters, digits and dashes), e.g. "col-free". Never change it later.`,
            });
            return;
        }
        if (seen.has(id)) {
            warnings.push({
                code: 'matrix_duplicate_id',
                path: `${path}[${idx}].id`,
                message: `id ${JSON.stringify(id)} is used by more than one ${what.toLowerCase()}.`,
                hint: 'Ids must be unique within the list: translations and cells are matched on them.',
            });
        }
        seen.add(id);
    });
    return seen;
}

/**
 * feature-matrix: 2-6 value columns (each with a label and a unique id), at
 * most one highlighted; groups of rows whose `cells` are { id: <column id>,
 * kind: included|excluded|text, text }. Warnings only: the renderer copes with
 * all of these (a cell for an unknown column is ignored, a missing cell shows
 * empty).
 * @param {unknown} content
 * @param {string} path
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkFeatureMatrix(content, path, warnings) {
    const c = isPlainObject(content) ? content : {};
    const columns = Array.isArray(c.columns) ? c.columns : [];
    if (columns.length < MATRIX_COLUMNS_MIN || columns.length > MATRIX_COLUMNS_MAX) {
        warnings.push({
            code: 'matrix_columns_count',
            path: `${path}.columns`,
            message: `A feature matrix has ${columns.length} column(s); it is designed for ${MATRIX_COLUMNS_MIN}-${MATRIX_COLUMNS_MAX}.`,
            hint: columns.length < MATRIX_COLUMNS_MIN
                ? 'With one column there is nothing to compare: add another licence column (send the complete columns array).'
                : `Split the matrix over two blocks: more than ${MATRIX_COLUMNS_MAX} columns do not fit on a laptop and a phone.`,
        });
    }
    const columnIds = collectIds(columns, `${path}.columns`, 'Column', warnings);
    columns.forEach((col, idx) => {
        if (trimmed(isPlainObject(col) ? col.label : '')) return;
        warnings.push({
            code: 'matrix_empty_label',
            path: `${path}.columns[${idx}].label`,
            message: `Column ${idx + 1} has no label, so its heading and its phone button are empty.`,
            hint: 'Give every column a short label, e.g. "Free" or "Enterprise".',
        });
    });
    const highlighted = columns.filter((col) => isPlainObject(col) && col.highlight === true).length;
    if (highlighted > 1) {
        warnings.push({
            code: 'matrix_many_highlights',
            path: `${path}.columns`,
            message: `${highlighted} columns are highlighted; the highlight is meant to draw the eye to one.`,
            hint: 'Set highlight:true on a single column and false on the others.',
        });
    }
    const groups = Array.isArray(c.groups) ? c.groups : [];
    collectIds(groups, `${path}.groups`, 'Group', warnings);
    groups.forEach((group, gi) => {
        const rows = isPlainObject(group) && Array.isArray(group.rows) ? group.rows : [];
        collectIds(rows, `${path}.groups[${gi}].rows`, 'Row', warnings);
        rows.forEach((row, ri) => {
            const cells = isPlainObject(row) && Array.isArray(row.cells) ? row.cells : [];
            cells.forEach((cell, ci) => {
                const id = isPlainObject(cell) ? trimmed(cell.id) : '';
                const at = `${path}.groups[${gi}].rows[${ri}].cells[${ci}]`;
                if (!columnIds.has(id)) {
                    warnings.push({
                        code: 'matrix_unknown_column',
                        path: `${at}.id`,
                        message: `Cell ${ci + 1} of row ${ri + 1} names column ${JSON.stringify(id)}, which does not exist, so it is not shown.`,
                        hint: `A cell's id is the id of its column: one of ${[...columnIds].map((x) => JSON.stringify(x)).join(', ') || '(none yet)'}.`,
                    });
                }
                const kind = isPlainObject(cell) ? cell.kind : undefined;
                if (kind !== undefined && !MATRIX_CELL_KINDS.includes(String(kind))) {
                    warnings.push({
                        code: 'matrix_cell_kind',
                        path: `${at}.kind`,
                        message: `Cell kind ${JSON.stringify(kind)} is not known; it renders as text.`,
                        hint: `kind is one of: ${MATRIX_CELL_KINDS.join(', ')}. "text" shows content.text, the others a check or a dash.`,
                    });
                }
            });
        });
    });
}

/**
 * Story header: the card of the Customer stories grid is built from it, so a
 * header without a customer, or with a metrics list outside 2-4 entries,
 * produces a thin card. Warnings only.
 * @param {unknown} content
 * @param {string} path
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkStoryHeader(content, path, warnings) {
    const c = isPlainObject(content) ? content : {};
    if (typeof c.customer !== 'string' || !c.customer.trim()) {
        warnings.push({
            code: 'story_missing_customer',
            path: `${path}.customer`,
            message: 'This customer story has no customer name, so its card in the grid has no heading.',
            hint: 'Set content.customer (and content.sector, content.logo) with cms_update_block.',
        });
    }
    const metrics = Array.isArray(c.metrics) ? c.metrics : [];
    if (metrics.length < STORY_METRICS_MIN || metrics.length > STORY_METRICS_MAX) {
        warnings.push({
            code: 'story_metrics_count',
            path: `${path}.metrics`,
            message: `A story header has ${metrics.length} metric(s); it is designed for ${STORY_METRICS_MIN}-${STORY_METRICS_MAX} { stat, label } pairs.`,
            hint: 'Send the complete metrics array, e.g. [{"stat":"60%","label":"less time on review"}, …]. Use real figures from the customer; never invent numbers.',
        });
    }
}

/**
 * scrollStory: the sticky panel is inert and hidden from assistive technology,
 * so the renderer only shows images; a clip or video step is dropped.
 * @param {unknown} content
 * @param {string} path
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkScrollStory(content, path, warnings) {
    const steps = isPlainObject(content) && Array.isArray(content.steps) ? content.steps : [];
    steps.forEach((step, idx) => {
        const media = isPlainObject(step) ? step.media : null;
        if (!isPlainObject(media) || !media.kind || media.kind === 'image') return;
        warnings.push({
            code: 'scroll_story_media',
            path: `${path}.steps[${idx}].media`,
            message: `Step ${idx + 1} uses ${JSON.stringify(media.kind)} media; a scroll story shows images only.`,
            hint: 'Use kind "image" (a screenshot or still). Clips and videos have controls and sound that cannot be reached in the sticky panel, so they are not shown.',
        });
    });
}

/**
 * feature-demo: the poster (an uploaded image URL) and the caption are plain
 * text. The renderer ignores anything else, so the block would silently show
 * no still image.
 * @param {unknown} content
 * @param {string} path
 * @param {Array<Record<string, unknown>>} warnings
 */
function checkFeatureDemo(content, path, warnings) {
    const c = isPlainObject(content) ? content : {};
    for (const key of ['poster', 'caption']) {
        if (c[key] === undefined || typeof c[key] === 'string') continue;
        warnings.push({
            code: `demo_${key}_not_text`,
            path: `${path}.${key}`,
            message: `content.${key} must be a string; the renderer ignores anything else.`,
            hint: key === 'poster'
                ? 'Upload the still with cms_request_upload and pass its asset url as content.poster.'
                : 'Send one short line, e.g. "Drag a step onto the canvas".',
        });
    }
}

module.exports = { checkTabs, checkFeatureMatrix, checkStoryHeader, checkScrollStory, checkFeatureDemo };

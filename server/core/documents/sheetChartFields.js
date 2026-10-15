/**
 * The fields of a sheet chart and their checks, shared by the chat's
 * document_write `charts` (sheetChartSpec.js), the spreadsheet assistant's
 * add_chart and the .xlsx export (sheetExport.js). Mirrors agent-hub's
 * spreadsheet/sheetCharts.ts.
 *
 * bar = vertical columns, hbar = horizontal bars, stacked = stacked columns.
 * pie and doughnut read the first data column; scatter needs categoriesRange
 * (the numeric x values); kpi is a tile with ONE value cell (dataRange), an
 * optional compareRange cell (shows the change) and a `label`.
 */

'use strict';

const { parseRange } = require('./sheetAssist/sheetRefs');

const CHART_TYPES = ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'stacked', 'kpi'];
const CHART_TYPES_TEXT = CHART_TYPES.join(', ');
const FORMATS = ['number', 'currency', 'percent'];

/** Same categorical palette as the editor (agent-hub sheetCharts.ts CHART_PALETTE). */
const CHART_PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7'];

/** The grid's cell size in px (SheetCell: w-28 h-7), what `size: { cols, rows }` is measured in. */
const COL_PX = 112;
const ROW_PX = 28;
const DEFAULT_SIZE = { cols: 6, rows: 14 };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The px size of a request: `size` in cells, else `width`/`height` px, else 6 x 14 cells; clamped. */
function sizeInPx(c) {
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const cols = num(c?.size?.cols);
    const rows = num(c?.size?.rows);
    return {
        width: clamp(Math.round(num(c?.width) ?? (cols ?? DEFAULT_SIZE.cols) * COL_PX), 120, 1400),
        height: clamp(Math.round(num(c?.height) ?? (rows ?? DEFAULT_SIZE.rows) * ROW_PX), 80, 900),
    };
}

const single = (r) => !!r && r.c0 === r.c1 && r.r0 === r.r1;

/**
 * What is wrong with a chart's type, ranges, anchor and style, or null.
 * @param {any} c
 * @returns {string | null}
 */
function chartProblem(c) {
    const type = String(c?.type || '');
    if (!CHART_TYPES.includes(type)) return `type must be one of ${CHART_TYPES_TEXT}.`;
    const data = parseRange(String(c?.dataRange || ''));
    if (!data) return 'dataRange must be a range of numbers on the same tab as the chart, like "B2:B10" (several columns = several series).';
    if (c?.categoriesRange && !parseRange(String(c.categoriesRange))) return 'categoriesRange must be a range like "A2:A10".';
    if (type === 'scatter' && !c.categoriesRange) return 'a scatter chart needs categoriesRange: the numeric x values, like "A2:A10".';
    if (type === 'kpi' && !single(data)) return 'a kpi takes ONE cell as dataRange, like "B2".';
    if (c?.compareRange && !single(parseRange(String(c.compareRange)))) return 'compareRange must be one cell, like "C2".';
    if (!single(parseRange(String(c?.anchor || '')))) return 'anchor must be one empty cell beside the data, like "E2".';
    if (c?.format && !FORMATS.includes(c.format)) return `format must be one of ${FORMATS.join(', ')}.`;
    if (c?.colors && !(Array.isArray(c.colors) && c.colors.length <= 12 && c.colors.every((x) => /^#[0-9a-f]{6}$/i.test(String(x))))) return 'colors must be a list of hex colours like "#4e79a7".';
    return null;
}

/**
 * The stored fields of a chart; each is present only when the request had it.
 * @typedef {object} ChartFields
 * @property {string} [type]
 * @property {string} [dataRange]
 * @property {string} [categoriesRange]
 * @property {string} [compareRange]
 * @property {string} [anchor]
 * @property {string} [title]
 * @property {string} [label]
 * @property {string} [format]
 * @property {string} [currency]
 * @property {string[]} [colors]
 * @property {boolean} [showValues]
 * @property {boolean} [colorByCategory]
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * The stored fields of a request (ranges upper-cased, style checked, size in px).
 * Only what is present is returned, so it can also be a patch.
 * @param {any} c
 * @returns {ChartFields}
 */
function chartFieldsOf(c) {
    const up = (v) => String(v).trim().toUpperCase();
    /** @type {ChartFields} */
    const out = {};
    if (c.type !== undefined) out.type = String(c.type);
    for (const k of ['dataRange', 'categoriesRange', 'compareRange', 'anchor']) if (c[k]) out[k] = up(c[k]);
    if (c.title) out.title = String(c.title).slice(0, 120);
    if (c.label) out.label = String(c.label).slice(0, 60);
    if (c.format) out.format = c.format;
    if (c.currency) out.currency = up(c.currency).slice(0, 3);
    if (Array.isArray(c.colors) && c.colors.length) out.colors = c.colors.map(String);
    if (typeof c.showValues === 'boolean') out.showValues = c.showValues;
    if (typeof c.colorByCategory === 'boolean') out.colorByCategory = c.colorByCategory;
    if (c.size || c.width || c.height) Object.assign(out, sizeInPx(c));
    return out;
}

/** The optional style / size properties of a chart in a tool schema (add_chart). */
const CHART_STYLE_PROPERTIES = {
    compareRange: { type: 'string', description: 'kpi only: one cell with the value to compare against' },
    label: { type: 'string', description: 'kpi only' },
    format: { type: 'string', enum: FORMATS },
    currency: { type: 'string', description: 'ISO code, default EUR' },
    colors: { type: 'array', items: { type: 'string' }, description: 'hex colours, one per series' },
    showValues: { type: 'boolean' },
    colorByCategory: { type: 'boolean' },
    size: { type: 'object', properties: { cols: { type: 'number' }, rows: { type: 'number' } }, description: 'in grid cells, default 6 x 14' },
};

module.exports = { CHART_STYLE_PROPERTIES, CHART_TYPES, CHART_TYPES_TEXT, FORMATS, CHART_PALETTE, COL_PX, ROW_PX, sizeInPx, chartProblem, chartFieldsOf };

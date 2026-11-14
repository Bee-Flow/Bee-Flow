// @typecheck strict
/**
 * The sheet assistant's `create_pivot` tool: a small SUM / COUNT / AVERAGE
 * summary of one column per label of another, read from the staged sheet,
 * as the cells to write (header row, then one row per label, sorted).
 * PURE: the assistant stages what this returns.
 */

'use strict';

const { parseRange, colName } = require('./sheetRefs');

const AGGREGATIONS = Object.freeze(['SUM', 'COUNT', 'AVERAGE']);

/** @typedef {{ staged: Record<string, string>, shown: Record<string, { display?: unknown, value?: unknown }> }} PivotSheet */
/** @typedef {{ sourceRange?: string, targetCell?: string, rowField?: unknown, valuesField?: unknown, aggregation?: unknown } | undefined} PivotArgs */
/** @typedef {NonNullable<ReturnType<typeof parseRange>>} CellRange */

/**
 * What a cell reads as for a header or a label: its typed content, else its shown value.
 * @param {PivotSheet} sheet
 * @param {string} name
 */
function cellText(sheet, name) {
    return String(sheet.staged[name] ?? sheet.shown[name]?.display ?? '');
}

/**
 * The columns of the header row whose text is `rowField` and `valuesField`
 * (case-insensitive; the last match wins), -1 when absent.
 * @param {PivotSheet} sheet
 * @param {{ c0: number, c1: number, r0: number }} src
 * @param {string} rowField
 * @param {string} valuesField
 */
function fieldColumns(sheet, src, rowField, valuesField) {
    let rowCol = -1;
    let valCol = -1;
    for (let c = src.c0; c <= src.c1; c++) {
        const header = cellText(sheet, `${colName(c)}${src.r0 + 1}`).toLowerCase();
        if (header === rowField.toLowerCase()) rowCol = c;
        if (header === valuesField.toLowerCase()) valCol = c;
    }
    return { rowCol, valCol };
}

/**
 * Per label: the sum (or the row count for COUNT) and the number of numeric
 * values. Rows without a label, and non-numeric values, are skipped.
 * @param {PivotSheet} sheet
 * @param {{ r0: number, r1: number }} src
 * @param {{ rowCol: number, valCol: number }} cols
 * @param {string} aggregation
 */
function aggregate(sheet, src, { rowCol, valCol }, aggregation) {
    /** @type {Record<string, number>} */
    const byLabel = {};
    /** @type {Record<string, number>} */
    const counts = {};
    for (let r = src.r0 + 1; r <= src.r1; r++) {
        const label = cellText(sheet, `${colName(rowCol)}${r + 1}`);
        if (label === '') continue;
        if (aggregation === 'COUNT') {
            byLabel[label] = (byLabel[label] || 0) + 1;
            continue;
        }
        const v = sheet.shown[`${colName(valCol)}${r + 1}`]?.value;
        const n = typeof v === 'number' ? v : Number.NaN;
        if (Number.isNaN(n)) continue;
        byLabel[label] = (byLabel[label] || 0) + n;
        counts[label] = (counts[label] || 0) + 1;
    }
    return { byLabel, counts };
}

/**
 * `create_pivot`'s arguments, checked: the source range, the single target
 * cell, the two header names and the aggregation, or the reason they fail.
 * @param {PivotArgs} args
 * @returns {{ error: string } | { src: CellRange, target: CellRange, aggregation: string, rowField: string, valuesField: string }}
 */
function pivotArgs(args) {
    const src = parseRange(args?.sourceRange);
    if (!src) return { error: 'sourceRange must be a range like "A1:C20".' };
    const target = parseRange(args?.targetCell);
    if (!target || target.c0 !== target.c1 || target.r0 !== target.r1) return { error: 'targetCell must be a single cell.' };
    const aggregation = String(args?.aggregation || 'SUM').toUpperCase();
    if (!AGGREGATIONS.includes(aggregation)) return { error: 'aggregation must be SUM, COUNT or AVERAGE.' };
    return {
        src, target, aggregation,
        rowField: String(args?.rowField || '').trim(),
        valuesField: String(args?.valuesField || '').trim(),
    };
}

/**
 * The pivot's cells for `create_pivot`'s arguments, or the reason it cannot
 * be made (said back to the model as `Error: <reason>`).
 * @param {PivotSheet} sheet
 * @param {PivotArgs} args
 * @returns {{ error: string } | { writes: Record<string, string> }}
 */
function pivotWrites(sheet, args) {
    const p = pivotArgs(args);
    if ('error' in p) return { error: p.error };
    const { src, target, aggregation, rowField, valuesField } = p;
    const cols = fieldColumns(sheet, src, rowField, valuesField);
    if (cols.rowCol === -1) return { error: `rowField "${rowField}" not found in header row.` };
    if (cols.valCol === -1) return { error: `valuesField "${valuesField}" not found in header row.` };
    const { byLabel, counts } = aggregate(sheet, src, cols, aggregation);
    const labels = Object.keys(byLabel).sort();
    if (!labels.length) return { error: 'no rows to aggregate.' };
    const t = { c: target.c0, r: target.r0 };
    /** @type {Record<string, string>} */
    const writes = {};
    writes[`${colName(t.c)}${t.r + 1}`] = rowField;
    writes[`${colName(t.c + 1)}${t.r + 1}`] = `${aggregation} ${valuesField}`;
    labels.forEach((label, i) => {
        const row = t.r + 1 + i;
        let value = byLabel[label];
        if (aggregation === 'AVERAGE') value = value / (counts[label] || 1);
        writes[`${colName(t.c)}${row + 1}`] = label;
        writes[`${colName(t.c + 1)}${row + 1}`] = String(value);
    });
    return { writes };
}

module.exports = { pivotWrites };

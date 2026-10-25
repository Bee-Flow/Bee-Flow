// @typecheck noImplicitAny
'use strict';
/**
 * bucket: sort a column into labelled groups: numeric bands (lowest value
 * included, highest excluded), equal parts (quantiles), or listed values.
 * Bands and listed values are lazy; equal parts need one pass first to find
 * the cut points.
 */

const { tableError, requireColumn, toNumber, foldText, isBlankCell, makeColumn } = require('./values');

/** @typedef {import('./index').TableOp & ReturnType<typeof import('../../../automationModel/tableOps/normalize').byOp.bucket>} BucketOp */

/** @param {BucketOp} op */
function bandLabeller(op) {
    const bands = op.bands.map((b) => ({ ...b, lo: b.min ?? -Infinity, hi: b.max ?? Infinity }));
    return (/** @type {unknown} */ cell) => {
        const x = toNumber(cell);
        if (x === null) return op.otherLabel;
        const hit = bands.find((b) => x >= b.lo && x < b.hi);
        return hit ? hit.label : op.otherLabel;
    };
}

/** @param {BucketOp} op */
function valueLabeller(op) {
    const byText = new Map();
    const byNumber = new Map();
    for (const m of op.map) {
        for (const v of m.values) {
            if (!byText.has(foldText(v))) byText.set(foldText(v), m.label);
            const n = typeof v === 'number' ? v : toNumber(v);
            if (n !== null && !byNumber.has(n)) byNumber.set(n, m.label);
        }
    }
    return (/** @type {unknown} */ cell) => {
        const t = byText.get(foldText(cell));
        if (t !== undefined) return t;
        const n = toNumber(cell);
        return n !== null && byNumber.has(n) ? byNumber.get(n) : op.otherLabel;
    };
}

/**
 * Linear-interpolated quantile of a sorted array.
 * @param {number} q
 * @param {number[]} sorted
 */
function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param {BucketOp} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 */
function apply(op, input, ctx) {
    const where = { opId: op.id, field: 'column' };
    const col = requireColumn(input.columns, op.column, where);
    if (!op.output) throw tableError('table_op_invalid', 'Give the new column a name.', { opId: op.id, field: 'output' });
    if (op.mode === 'bands' && !op.bands.length) throw tableError('table_op_invalid', 'Add at least one band.', { opId: op.id, field: 'bands' });
    if (op.mode === 'values' && !op.map.length) throw tableError('table_op_invalid', 'Add at least one group of values.', { opId: op.id, field: 'map' });
    const labels = op.labels || Array.from({ length: op.quantiles }, (_, i) => `Q${i + 1}`);
    if (op.mode === 'quantiles' && labels.length !== op.quantiles) {
        throw tableError('table_op_invalid', `Give ${op.quantiles} labels, one for each part.`, { opId: op.id, field: 'labels' });
    }

    const at = input.columns.findIndex((c) => c.key === op.output);
    const out = makeColumn(op.output, 'text');
    const columns = at >= 0 ? input.columns.map((c, i) => (i === at ? out : c)) : [...input.columns, out];

    /** @type {number[] | null} */
    let cuts = null;
    async function cutPoints() {
        if (cuts) return cuts;
        /** @type {number[]} */
        const numbers = [];
        for await (const row of input.rows()) {
            await ctx.tick();
            const x = toNumber(row[col.key]);
            if (x !== null) numbers.push(x);
        }
        numbers.sort((a, b) => a - b);
        cuts = numbers.length ? Array.from({ length: op.quantiles - 1 }, (_, i) => quantile(numbers, (i + 1) / op.quantiles)) : [];
        return cuts;
    }

    const simple = op.mode === 'bands' ? bandLabeller(op) : op.mode === 'values' ? valueLabeller(op) : null;
    async function* rows() {
        const cut = op.mode === 'quantiles' ? await cutPoints() : null;
        for await (const row of input.rows()) {
            await ctx.tick();
            const cell = row[col.key];
            let label = null;
            if (!isBlankCell(cell)) {
                if (simple) label = simple(cell);
                else {
                    const x = toNumber(cell);
                    let k = 0;
                    while (x !== null && k < cut.length && x >= cut[k]) k++;
                    label = x === null ? null : labels[k];
                }
            }
            yield { ...row, [op.output]: label === undefined ? null : label };
        }
    }
    return { columns, rows };
}

module.exports = { apply };

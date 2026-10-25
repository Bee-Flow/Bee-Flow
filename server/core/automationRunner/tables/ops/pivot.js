// @typecheck noImplicitAny
'use strict';
/**
 * pivot: rows by columns, each cell a count, a sum or an average, optionally
 * weighted and shown as a percentage. Cells that cover only a few rows are
 * blanked, and so are the totals that would give them away. The output
 * columns depend on the data, so the pass happens when the operation is set up.
 */

const { effectiveMinN } = require('../groupPolicy');
const { tableError, requireColumn, toNumber, foldText, isBlankCell, makeColumn, roundTo, uniqueKey } = require('./values');

/** @typedef {import('./index').TableOp & ReturnType<typeof import('../../../automationModel/tableOps/normalize').byOp.pivot>} PivotOp */
/** @typedef {{ n: number, sw: number, swv: number, swx: number }} Cell */
/** @typedef {{ fold: string, label: string, n: number }} ColEntry */
/** @typedef {{ label: string, cells: Map<string, Cell> }} RowEntry */

const newCell = () => ({ n: 0, sw: 0, swv: 0, swx: 0 });
/**
 * @param {{ n: number; sw: number; swv: number; swx: number; }} to
 * @param {{ n: number; sw: number; swv: number; swx: number; }} from
 */
const addInto = (to, from) => { to.n += from.n; to.sw += from.sw; to.swv += from.swv; to.swx += from.swx; return to; };

/**
 * @param {{n: number;sw: number;swv: number;swx: number;}} c
 * @param {string} fn
 */
function baseValue(fn, c) {
    if (fn === 'count') return c.sw;
    if (fn === 'sum') return c.swx;
    return c.swv > 0 ? c.swx / c.swv : null;
}

/**
 * Column order: the listed ones first (in that order), then first-seen.
 * @param {ColEntry[]} all
 * @param {string[]} columnOrder
 */
function orderColumns(all, columnOrder) {
    if (!columnOrder || !columnOrder.length) return all;
    const rank = new Map(columnOrder.map((v, i) => [foldText(v), i]));
    const listed = all.filter((/** @type {{ fold: string; }} */ c) => rank.has(c.fold)).sort((/** @type {{ fold: string; }} */ a, /** @type {{ fold: string; }} */ b) => rank.get(a.fold) - rank.get(b.fold));
    return [...listed, ...all.filter((/** @type {{ fold: string; }} */ c) => !rank.has(c.fold))];
}

/**
 * @param {PivotOp} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 * @param {{ rowCol: { key: string }, colCol: { key: string }, valCol: { key: string }|null, weight: { key: string }|null }} cols
 */
async function accumulate(op, input, ctx, cols) {
    const { rowCol, colCol, valCol, weight } = cols;
    /** @type {Map<string, RowEntry>} */
    const rowsMap = new Map();
    /** @type {Map<string, ColEntry>} */
    const colsMap = new Map();
    let badWeights = 0;
    const cap = ctx.limits.maxGroups;
    /**
     * @param {string} what
     */
    const tooMany = (what) => tableError('table_too_many_groups', `The pivot has more than ${cap} different ${what}. Pick a column with fewer values, or raise AUTOMATION_TABLE_MAX_GROUPS.`, { opId: op.id, field: what === 'rows' ? 'rows' : 'columns' });
    for await (const row of input.rows()) {
        await ctx.tick();
        let w = 1;
        if (weight) {
            const x = toNumber(row[weight.key]);
            if (x === null || x < 0) { w = 0; badWeights++; } else w = x;
        }
        const rv = row[rowCol.key];
        const cv = row[colCol.key];
        const rk = foldText(rv);
        const ck = foldText(cv);
        let r = rowsMap.get(rk);
        if (!r) {
            if (cap > 0 && rowsMap.size >= cap) throw tooMany('rows');
            r = { label: isBlankCell(rv) ? op.missingLabel : String(rv).trim(), cells: new Map() };
            rowsMap.set(rk, r);
        }
        let c = colsMap.get(ck);
        if (!c) {
            if (cap > 0 && colsMap.size >= cap) throw tooMany('columns');
            c = { fold: ck, label: isBlankCell(cv) ? op.missingLabel : String(cv).trim(), n: 0 };
            colsMap.set(ck, c);
        }
        c.n++;
        let cell = r.cells.get(ck);
        if (!cell) { cell = newCell(); r.cells.set(ck, cell); }
        cell.n++;
        cell.sw += w;
        const x = valCol ? toNumber(row[valCol.key]) : null;
        if (x !== null) { cell.swv += w; cell.swx += w * x; }
    }
    if (badWeights) ctx.warn(`${badWeights} row${badWeights === 1 ? ' has' : 's have'} no usable weight and count${badWeights === 1 ? 's' : ''} as 0.`, 'weight_unusable');
    return { rowsMap, colsMap };
}

/** Which distinct column values get a column of their own; the rest go under 'Other'.
 * @param {PivotOp} op
 * @param {Map<string, ColEntry>} colsMap
 * @param {import('./index').OpCtx['limits']} limits
 */
function chooseColumns(op, colsMap, limits) {
    const all = orderColumns([...colsMap.values()], op.columnOrder);
    const cap = limits.pivotMaxColumns;
    if (!(cap > 0) || all.length <= cap) return { shown: all, other: new Set() };
    const keepCount = Math.max(1, cap - 1);
    const byFrequency = all.slice().sort((/** @type {{ n: number; }} */ a, /** @type {{ n: number; }} */ b) => b.n - a.n);
    const keep = new Set(byFrequency.slice(0, keepCount).map((c) => c.fold));
    return { shown: all.filter((c) => keep.has(c.fold)), other: new Set(all.filter((c) => !keep.has(c.fold)).map((c) => c.fold)) };
}

/**
 * @param {PivotOp} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 */
async function apply(op, input, ctx) {
    /**
     * @param {string} field
     */
    const where = (field) => ({ opId: op.id, field });
    if (!op.rows) throw tableError('table_op_invalid', 'Pick the column that makes the rows.', where('rows'));
    if (!op.columns) throw tableError('table_op_invalid', 'Pick the column that makes the columns.', where('columns'));
    const rowCol = requireColumn(input.columns, op.rows, where('rows'));
    const colCol = requireColumn(input.columns, op.columns, where('columns'));
    if (rowCol.key === colCol.key) throw tableError('table_op_invalid', 'Rows and columns must be different columns.', where('columns'));
    if (op.value.fn !== 'count' && !op.value.column) throw tableError('table_op_invalid', 'Pick the column to calculate on.', where('value.column'));
    const valCol = op.value.column ? requireColumn(input.columns, op.value.column, where('value.column')) : null;
    const weight = op.weight ? requireColumn(input.columns, op.weight, where('weight')) : null;

    const fn = op.value.fn;
    const percent = fn === 'mean' ? 'none' : op.percent;
    const minN = effectiveMinN(op.minN, ctx.minGroupFloor);
    /**
     * @param {number} n
     */
    const small = (n) => minN > 0 && n > 0 && n < minN;

    const { rowsMap, colsMap } = await accumulate(op, input, ctx, { rowCol, colCol, valCol, weight });
    const { shown, other } = chooseColumns(op, colsMap, ctx.limits);
    const hasOther = other.size > 0;

    // Per row: the shown cells, the merged 'Other' cell, the row total.
    const colTotals = shown.map(() => newCell());
    const otherTotal = newCell();
    const grand = newCell();
    const prepared = [...rowsMap.values()].map((r) => {
        const cells = shown.map((c) => r.cells.get(c.fold) || newCell());
        const otherCell = newCell();
        const total = newCell();
        for (const [fold, cell] of r.cells) { addInto(total, cell); if (other.has(fold)) addInto(otherCell, cell); }
        cells.forEach((/** @type {{ n: number; sw: number; swv: number; swx: number; }} */ cell, /** @type {number} */ i) => addInto(colTotals[i], cell));
        addInto(otherTotal, otherCell);
        addInto(grand, total);
        return { label: r.label, cells, otherCell, total };
    });

    const headerKeys = new Set([rowCol.key, 'Total', 'Other']);
    const headers = shown.map((c) => { const k = uniqueKey(c.label, headerKeys); headerKeys.add(k); return k; });
    const columns = [
        { ...rowCol },
        ...headers.map((h) => makeColumn(h, 'number')),
        ...(hasOther ? [makeColumn('Other', 'number')] : []),
        ...(op.totals ? [makeColumn('Total', 'number')] : []),
    ];

    let hidden = 0;
    /**
     * @param {{ n: number; sw: number; swv: number; swx: number; }} cell
     * @param {boolean} hideAlso
     * @param {number} denominator
     */
    const show = (cell, denominator, hideAlso) => {
        const isSmall = small(cell.n);
        if (isSmall || hideAlso) { if (isSmall) hidden++; return null; }
        let v = baseValue(fn, cell);
        if (v === null) return null;
        if (percent !== 'none') v = denominator > 0 ? (100 * v) / denominator : null;
        return v === null ? null : roundTo(v, op.decimals);
    };
    /**
     * @param {{ n: number; sw: number; swv: number; swx: number; }} cell
     */
    const num = (cell) => baseValue(fn, cell) ?? 0;
    const rowDen = (/** @type {{ total: Cell }} */ r) => (percent === 'row' ? num(r.total) : percent === 'total' ? num(grand) : 0);
    const colDen = (/** @type {number} */ i) => (percent === 'column' ? num(colTotals[i]) : percent === 'total' ? num(grand) : 0);

    /** @type {(Record<string, string | number>)[]} */
    const out = [];
    for (const r of prepared) {
        /** @type {Record<string, string|number>} */
        /** @type {Record<string, any>} */
        const row = { [rowCol.key]: r.label };
        const rowSmall = r.cells.some((c) => small(c.n)) || small(r.otherCell.n);
        r.cells.forEach((/** @type {{ n: number; sw: number; swv: number; swx: number; }} */ cell, /** @type {number} */ i) => {
            row[headers[i]] = show(cell, percent === 'column' ? colDen(i) : rowDen(r), false);
        });
        if (hasOther) row.Other = show(r.otherCell, percent === 'column' ? num(otherTotal) : rowDen(r), false);
        if (op.totals) row.Total = show(r.total, percent === 'row' ? num(r.total) : num(grand), rowSmall);
        out.push(row);
    }
    if (op.totals) {
        /** @type {Record<string, string|number>} */
        /** @type {Record<string, any>} */
        const row = { [rowCol.key]: 'Total' };
        const colSmall = (/** @type {number} */ i) => prepared.some((r) => small(r.cells[i].n));
        colTotals.forEach((/** @type {{ n: number; sw: number; swv: number; swx: number; }} */ cell, /** @type {number} */ i) => {
            row[headers[i]] = show(cell, percent === 'column' ? num(cell) : num(grand), colSmall(i));
        });
        if (hasOther) row.Other = show(otherTotal, percent === 'column' ? num(otherTotal) : num(grand), prepared.some((r) => small(r.otherCell.n)));
        row.Total = show(grand, num(grand), false);
        out.push(row);
    }
    if (hidden) ctx.warn(`${hidden} cell${hidden === 1 ? ' covers' : 's cover'} fewer than ${minN} rows and ${hidden === 1 ? 'was' : 'were'} left empty, together with the totals that would reveal ${hidden === 1 ? 'it' : 'them'}.`, 'pivot_suppressed');
    if (op.percent !== 'none' && fn === 'mean') ctx.warn('Percentages of an average are not meaningful; the averages are shown as they are.', 'pivot_percent_ignored');
    if (hasOther) ctx.warn(`The pivot has more than ${ctx.limits.pivotMaxColumns} columns; the least frequent ones are added up under "Other".`, 'pivot_columns_capped');

    return { columns, rows: async function* rows() { for (const r of out) { await ctx.tick(); yield r; } } };
}

module.exports = { apply };

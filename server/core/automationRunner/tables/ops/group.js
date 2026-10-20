'use strict';
/**
 * group: one row per combination of the `by` columns with counts, sums,
 * averages ... of the others. Optionally weighted, and groups smaller than the
 * minimum size are blanked (their size too) so a small group cannot point at
 * a person. Consumes its input; the result is small.
 */

const { parseIsoUtc } = require('../../../dataEngine/sources/spreadsheetFile/cells');
const { AGG_FNS } = require('../../../automationModel/tableOps/normalize');
const { effectiveMinN } = require('../groupPolicy');
const { tableError, requireColumn, toNumber, foldText, isBlankCell, makeColumn, resolveColumn, compareCells } = require('./values');

function newAcc(fn) {
    switch (fn) {
        case 'median': return { values: [] };
        case 'count_distinct': return { set: new Set() };
        case 'min': case 'max': return { num: null, text: null };
        default: return { sw: 0, swx: 0, any: false };
    }
}

function feed(fn, acc, cell, w, hasColumn) {
    if (fn === 'share') return;
    if (fn === 'count') {
        if (!hasColumn || !isBlankCell(cell)) acc.sw += w;
        return;
    }
    if (isBlankCell(cell)) return;
    if (fn === 'count_distinct') { acc.set.add(foldText(cell)); return; }
    const x = toNumber(cell);
    if (fn === 'min' || fn === 'max') {
        const better = (a, b) => (fn === 'min' ? a < b : a > b);
        if (x !== null) { if (acc.num === null || better(x, acc.num)) acc.num = x; return; }
        const d = typeof cell === 'string' && parseIsoUtc(cell) ? cell.trim() : null;
        if (d !== null && (acc.text === null || better(d, acc.text))) acc.text = d;
        return;
    }
    if (x === null) return;
    if (fn === 'median') { acc.values.push(x); return; }
    acc.any = true;
    acc.swx += w * x;
    acc.sw += w;
}

function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function result(fn, acc, g, totalW) {
    switch (fn) {
        case 'count': return acc.sw;
        case 'sum': return acc.any ? acc.swx : null;
        case 'mean': return acc.sw > 0 ? acc.swx / acc.sw : null;
        case 'median': return median(acc.values);
        case 'min': case 'max': return acc.num !== null ? acc.num : acc.text;
        case 'count_distinct': return acc.set.size;
        case 'share': return totalW > 0 ? (100 * g.w) / totalW : null;
        default: return null;
    }
}

function plan(op, input) {
    const by = op.by.map((name, i) => requireColumn(input.columns, name, { opId: op.id, field: `by[${i}]` }));
    if (by.length > 5) throw tableError('table_op_invalid', 'Group by at most 5 columns.', { opId: op.id, field: 'by' });
    if (!op.aggregates.length) throw tableError('table_op_invalid', 'Pick at least one value to calculate.', { opId: op.id, field: 'aggregates' });
    const taken = new Set([...by.map((c) => c.key.toLowerCase()), 'n', 'suppressed']);
    const aggs = op.aggregates.map((a, i) => {
        const field = `aggregates[${i}]`;
        if (!AGG_FNS.includes(a.fn)) throw tableError('table_op_invalid', `Value ${i + 1}: pick what to calculate.`, { opId: op.id, field: `${field}.fn` });
        const needsColumn = a.fn !== 'count' && a.fn !== 'share';
        if (needsColumn && !a.column) throw tableError('table_op_invalid', `Value ${i + 1}: pick the column to calculate on.`, { opId: op.id, field: `${field}.column` });
        if (taken.has(a.as.toLowerCase())) throw tableError('table_op_invalid', `The name "${a.as}" is used twice in the result.`, { opId: op.id, field: `${field}.as` });
        taken.add(a.as.toLowerCase());
        return { fn: a.fn, as: a.as, col: a.column ? requireColumn(input.columns, a.column, { opId: op.id, field: `${field}.column` }) : null };
    });
    const weight = op.weight ? requireColumn(input.columns, op.weight, { opId: op.id, field: 'weight' }) : null;
    return { by, aggs, weight };
}

function apply(op, input, ctx) {
    const { by, aggs, weight } = plan(op, input);
    const minN = effectiveMinN(op.minN, ctx.minGroupFloor);
    const outColumns = [
        ...by,
        ...aggs.map((a) => makeColumn(a.as, a.fn === 'min' || a.fn === 'max' ? 'mixed' : 'number')),
        makeColumn('n', 'number'),
        ...(minN > 0 ? [makeColumn('suppressed', 'boolean')] : []),
    ];
    const sorts = op.sort.map((s, i) => {
        const col = resolveColumn(outColumns, s.column);
        if (!col) throw tableError('table_op_invalid', `Sort on one of the columns the result has (not "${s.column}").`, { opId: op.id, field: `sort[${i}].column` });
        return { key: col.key, sign: s.dir === 'desc' ? -1 : 1 };
    });

    let done = null;
    async function build() {
        const groups = new Map();
        let totalW = 0;
        let badWeights = 0;
        for await (const row of input.rows()) {
            await ctx.tick();
            let w = 1;
            if (weight) {
                const x = toNumber(row[weight.key]);
                if (x === null || x < 0) { w = 0; badWeights++; } else w = x;
            }
            totalW += w;
            const key = by.map((c) => foldText(row[c.key])).join('\u001f');
            let g = groups.get(key);
            if (!g) {
                if (ctx.limits.maxGroups > 0 && groups.size >= ctx.limits.maxGroups) {
                    throw tableError('table_too_many_groups', `The grouping makes more than ${ctx.limits.maxGroups} groups. Group by fewer or coarser columns, or raise AUTOMATION_TABLE_MAX_GROUPS.`, { opId: op.id, field: 'by' });
                }
                g = { vals: by.map((c) => (isBlankCell(row[c.key]) ? null : row[c.key])), n: 0, w: 0, accs: aggs.map((a) => newAcc(a.fn)) };
                groups.set(key, g);
            }
            g.n++;
            g.w += w;
            aggs.forEach((a, i) => feed(a.fn, g.accs[i], a.col ? row[a.col.key] : null, w, !!a.col));
        }
        if (badWeights) ctx.warn(`${badWeights} row${badWeights === 1 ? ' has' : 's have'} no usable weight and count${badWeights === 1 ? 's' : ''} as 0.`, 'weight_unusable');
        if (!groups.size && !by.length) groups.set('', { vals: [], n: 0, w: 0, accs: aggs.map((a) => newAcc(a.fn)) });
        let suppressed = 0;
        const out = [];
        for (const g of groups.values()) {
            const hide = minN > 0 && g.n < minN;
            if (hide) suppressed++;
            const row = {};
            by.forEach((c, i) => { row[c.key] = g.vals[i]; });
            aggs.forEach((a, i) => { row[a.as] = hide ? null : result(a.fn, g.accs[i], g, totalW); });
            row.n = hide ? null : g.n;
            if (minN > 0) row.suppressed = hide;
            out.push(row);
        }
        if (suppressed) ctx.warn(`${suppressed} group${suppressed === 1 ? ' has' : 's have'} fewer than ${minN} rows; their values are left empty.`, 'group_suppressed');
        if (sorts.length) {
            out.sort((a, b) => {
                for (const s of sorts) {
                    const ab = isBlankCell(a[s.key]);
                    const bb = isBlankCell(b[s.key]);
                    if (ab || bb) { if (ab !== bb) return ab ? 1 : -1; continue; }
                    const c = compareCells(a[s.key], b[s.key]);
                    if (c) return c * s.sign;
                }
                return 0;
            });
        }
        return out;
    }
    async function* rows() {
        done = done || build();
        yield* await done;
    }
    return { columns: outColumns, rows };
}

module.exports = { apply };

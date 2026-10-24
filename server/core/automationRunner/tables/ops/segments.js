// @typecheck
'use strict';
/**
 * groups: how many rows fall in each answer of the chosen columns. The table
 * lists every segment; sizes below the minimum are shown as "suppressed" with
 * no number. `segments` lists the usable ones, each with the rules that select
 * its rows, so a loop can run one filter per segment. The minimum is the
 * higher of the step's and the organisation's floor.
 */

const { effectiveMinN } = require('../groupPolicy');
const { DEFAULT_SEPARATOR } = require('../../../automationModel/tableOps/rules');
const { GROUPS_COLUMNS } = require('../../../automationModel/tableOps/planColumns');
const { tableError, requireColumn, foldText, isBlankCell } = require('./values');

/** A stable id from `column=value`. */
function slug(text) {
    const s = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return s || 'segment';
}

const splitItems = (cell, sep) => [...new Set(String(cell).split(sep).map((s) => s.trim()).filter(Boolean))];

async function count(op, input, ctx, splits) {
    const counters = splits.map(() => new Map());
    const wanted = splits.map((s) => (s.def.values ? new Map(s.def.values.map((v) => [foldText(v), v])) : null));
    let total = 0;
    for await (const row of input.rows()) {
        await ctx.tick();
        total++;
        splits.forEach((s, i) => {
            const cell = row[s.col.key];
            if (isBlankCell(cell)) return;
            const values = s.def.separator ? splitItems(cell, s.def.separator) : [String(cell).trim()];
            for (const v of values) {
                const key = foldText(v);
                if (wanted[i] && !wanted[i].has(key)) continue;
                let entry = counters[i].get(key);
                if (!entry) {
                    if (ctx.limits.maxGroups > 0 && counters[i].size >= ctx.limits.maxGroups) {
                        throw tableError('table_too_many_groups', `Column "${s.col.key}" has more than ${ctx.limits.maxGroups} different values. Split on a column with fewer values, or raise AUTOMATION_TABLE_MAX_GROUPS.`, { opId: op.id, field: 'splits' });
                    }
                    entry = { value: wanted[i] ? wanted[i].get(key) : v, n: 0 };
                    counters[i].set(key, entry);
                }
                entry.n++;
            }
        });
    }
    return { counters, total, wanted };
}

async function apply(op, input, ctx) {
    if (!op.splits.length) throw tableError('table_op_invalid', 'Pick at least one column to split on.', { opId: op.id, field: 'splits' });
    if (op.splits.length > 10) throw tableError('table_op_invalid', 'Split on at most 10 columns.', { opId: op.id, field: 'splits' });
    const splits = op.splits.map((def, i) => ({ def, col: requireColumn(input.columns, def.column, { opId: op.id, field: `splits[${i}].column` }) }));
    const minN = effectiveMinN(op.minN, ctx.minGroupFloor);
    const { counters, total } = await count(op, input, ctx, splits);

    const used = new Set();
    const idFor = (base) => {
        let id = base;
        for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
        used.add(id);
        return id;
    };
    const table = [];
    const segments = [];
    const consider = (segment, label, column, value, n, rules) => {
        const hidden = n < minN;
        table.push({ segment, label, column, value, n: hidden ? null : n, suppressed: hidden });
        if (!hidden) segments.push({ id: segment, label, column, value, n, rules });
    };
    if (op.includeTotal) {
        used.add('all');
        consider('all', op.totalLabel, null, null, total, []);
    }
    splits.forEach((s, i) => {
        let entries = [...counters[i].values()];
        if (s.def.values) {
            const order = new Map(s.def.values.map((v, k) => [foldText(v), k]));
            entries.sort((a, b) => order.get(foldText(a.value)) - order.get(foldText(b.value)));
        } else entries = entries.sort((a, b) => b.n - a.n);
        const heading = s.def.label || s.col.label || s.col.key;
        for (const e of entries) {
            const rule = s.def.separator
                ? { column: s.col.key, test: 'contains_item', value: e.value, separator: s.def.separator || DEFAULT_SEPARATOR }
                : { column: s.col.key, test: 'equals', value: e.value };
            consider(idFor(slug(`${s.col.key}=${e.value}`)), `${heading}: ${e.value}`, s.col.key, e.value, e.n, [rule]);
        }
    });
    const cap = ctx.limits.maxSegments;
    let usable = segments;
    if (cap > 0 && segments.length > cap) {
        usable = segments.slice(0, cap);
        ctx.warn(`There are ${segments.length} usable segments; only the first ${cap} are listed in the segments output (AUTOMATION_TABLE_MAX_SEGMENTS).`, 'segments_capped');
    }
    const hiddenCount = table.filter((t) => t.suppressed).length;
    if (hiddenCount) ctx.warn(`${hiddenCount} segment${hiddenCount === 1 ? ' has' : 's have'} fewer than ${minN} rows; the size is not shown and the segment is not listed for further steps.`, 'groups_suppressed');

    return { columns: GROUPS_COLUMNS.map((c) => ({ ...c })), rows: async function* rows() { for (const r of table) yield r; }, segments: usable };
}

module.exports = { apply, slug };

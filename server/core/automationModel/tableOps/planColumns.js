// @typecheck
'use strict';
/**
 * Static column planning: the columns a table step produces, derived from the
 * columns it receives and its (normalised) operations, plus a finding for every
 * column an operation names that is not there at that point. Pure.
 *
 * `columns` in the result is null when the output depends on the data (after a
 * pivot, or a join that takes every column of the other table).
 */

const { OP_LABELS } = require('./constants');
const { resolveColumn, uniqueKey, makeColumn } = require('./columns');

/** @typedef {typeof import('./normalize').byOp} ByOp */
/**
 * A normalised operation: its `op` name plus the fields its normaliser fills.
 * @typedef {{ [K in keyof ByOp]: { op: K } & ReturnType<ByOp[K]> }[keyof ByOp]} NormalizedOp
 */
/**
 * Looks a column up (recording a finding when it is missing).
 * @typedef {(name: string, sub: string, alternatives?: string[]) => { label: string; key: string; type?: string } | null} NeedColumn
 */

const GROUPS_COLUMNS = Object.freeze([
    makeColumn('segment', 'text'), makeColumn('label', 'text'), makeColumn('column', 'text'),
    makeColumn('value', 'text'), makeColumn('n', 'number'), makeColumn('suppressed', 'boolean'),
]);

/**
 * Put `col` in place of a column with the same key, or at the end.
 * @param {{ label: string; key: string; type?: string; }[]} cols
 * @param {{ key: string; label: string; type: string; }} col
 */
function upsert(cols, col) {
    const at = cols.findIndex((c) => c.key === col.key);
    if (at >= 0) { const next = cols.slice(); next[at] = col; return next; }
    return [...cols, col];
}

/**
 * @param {NormalizedOp} op
 * @param {{ label: string; key: string; type?: string; }[]} cols
 * @param {NeedColumn} need
 */
function planOp(op, cols, need) {
    switch (op.op) {
        case 'join': {
            op.on.forEach((k, j) => need(k.left, `.on[${j}].left`, k.alternatives));
            if (!op.columns) return null;
            const taken = new Set(cols.map((c) => c.key));
            const added = op.columns.map((name) => {
                const key = uniqueKey(op.prefix + name, taken);
                taken.add(key);
                return makeColumn(key);
            });
            return [...cols, ...added];
        }
        case 'pseudonymise': {
            const sources = op.columns.map((name, j) => need(name, `.columns[${j}]`));
            const dropped = op.dropColumns.map((name, j) => need(name, `.dropColumns[${j}]`));
            const gone = new Set([...(op.keepColumns ? [] : sources), ...dropped].filter(Boolean).map((c) => c.key));
            return upsert(cols.filter((c) => !gone.has(c.key) || c.key === op.output), makeColumn(op.output, 'text'));
        }
        case 'derive': return op.columns.reduce((acc, c) => (c.name ? upsert(acc, makeColumn(c.name)) : acc), cols);
        case 'bucket':
            need(op.column, '.column');
            return op.output ? upsert(cols, makeColumn(op.output, 'text')) : cols;
        case 'group': {
            const by = op.by.map((name, j) => need(name, `.by[${j}]`));
            op.aggregates.forEach((a, j) => { if (a.column) need(a.column, `.aggregates[${j}].column`); });
            if (op.weight) need(op.weight, '.weight');
            const aggs = op.aggregates.map((a) => makeColumn(a.as, a.fn === 'min' || a.fn === 'max' ? 'mixed' : 'number'));
            return [
                ...by.map((c, j) => c || makeColumn(op.by[j])), ...aggs, makeColumn('n', 'number'),
                // The organisation's minimum group size applies to every group, so the column is planned
                // for every group (a step cannot know the floor); at run time it is absent only when the floor is off.
                makeColumn('suppressed', 'boolean'),
            ];
        }
        case 'pivot':
            need(op.rows, '.rows'); need(op.columns, '.columns');
            if (op.value.column) need(op.value.column, '.value.column');
            if (op.weight) need(op.weight, '.weight');
            return null;
        case 'filter':
            op.rules.forEach((r, j) => { if (r && typeof r.column === 'string' && r.column.trim()) need(r.column, `.rules[${j}].column`); });
            return cols;
        case 'select': return planSelect(op, cols, need);
        case 'groups':
            op.splits.forEach((s, j) => { if (s.column) need(s.column, `.splits[${j}].column`); });
            return GROUPS_COLUMNS.slice();
        case 'describe':
            (op.columns || []).forEach((name, j) => need(name, `.columns[${j}]`));
            return cols;
        default: return cols;
    }
}

/**
 * @param {Extract<NormalizedOp, { op: 'select' }>} op
 * @param {{ label: string; key: string; type?: string; }[]} cols
 * @param {NeedColumn} need
 */
function planSelect(op, cols, need) {
    let out = cols;
    if (op.keep) {
        out = op.keep.map((name, j) => need(name, `.keep[${j}]`)).filter(Boolean);
    } else if (op.drop) {
        const gone = new Set(op.drop.map((name, j) => need(name, `.drop[${j}]`)).filter(Boolean).map((c) => c.key));
        out = cols.filter((c) => !gone.has(c.key));
    }
    for (const [j, r] of op.rename.entries()) {
        const col = r.from ? need(r.from, `.rename[${j}].from`) : null;
        if (col && r.to) out = out.map((c) => (c.key === col.key ? { ...c, key: r.to, label: r.to } : c));
    }
    return out;
}

/**
 * @param {{ key: string, label?: string, type?: string }[] | null | undefined} columns
 * @param {any[]} ops normalised operations (spec.normalizeTableStep)
 * @returns {{ columns: { key: string, label: string, type?: string }[] | null, findings: any[] }}
 */
function planColumns(columns, ops) {
    /** @type {({ hint?: string | undefined; code: string; severity: string; path: string; message: string; })[]} */
    const findings = [];
    let cols = Array.isArray(columns) ? columns.map((c) => ({ ...c, label: c.label ?? c.key })) : null;
    (Array.isArray(ops) ? ops : []).forEach((op, i) => {
        if (!cols || !op || op.unknown || op.enabled === false) return;
        const label = `Step ${i + 1} (${/** @type {Record<string, string>} */ (OP_LABELS)[op.op] || op.op})`;
        /**
         * @param {string} name
         * @param {string} sub
         * @param {string[]} [alternatives]
         */
        const need = (name, sub, alternatives) => {
            const hit = /** @type {{ label: string; key: string; type?: string } | null} */ (resolveColumn(cols, name, alternatives));
            if (!hit) {
                const names = cols.slice(0, 12).map((c) => c.key).join(', ');
                findings.push({
                    code: 'table.column_missing', severity: 'error', path: `ops[${i}]${sub}`,
                    message: `${label}: the column "${name}" is not in the table at this point.`,
                    ...(names ? { hint: `Available columns: ${names}${cols.length > 12 ? ', ...' : ''}.` } : {}),
                });
            }
            return hit;
        };
        cols = planOp(op, cols, need);
    });
    return { columns: cols, findings };
}

module.exports = { planColumns, GROUPS_COLUMNS };

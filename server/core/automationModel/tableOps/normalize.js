'use strict';
/**
 * Per-operation normalisation: fills defaults and coerces shapes so the
 * validator, the planner and the engine all read the same object. It never
 * throws and never drops what the validator needs to complain about.
 */

const { isRecord, str, strList, strListOrNull, intIn, numOrNull } = require('./constants');

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const objects = (v) => (Array.isArray(v) ? v.filter(isRecord) : []);

function join(op) {
    return {
        with: op.with === undefined ? null : op.with,
        how: pick(op.how, ['left', 'inner'], 'left'),
        on: objects(op.on).map((k) => {
            const alternatives = strList(k.alternatives);
            return { left: str(k.left), right: str(k.right), ...(alternatives.length ? { alternatives } : {}) };
        }),
        caseInsensitive: op.caseInsensitive !== false,
        trim: op.trim !== false,
        columns: strListOrNull(op.columns),
        prefix: typeof op.prefix === 'string' ? op.prefix : '',
        onDuplicate: pick(op.onDuplicate, ['first', 'all'], 'first'),
    };
}

function pseudonymise(op) {
    return {
        columns: strList(op.columns),
        saltVar: str(op.saltVar),
        output: str(op.output) || 'pseudonym',
        length: intIn(op.length, 8, 64, 16),
        keepColumns: op.keepColumns === true,
        dropColumns: strList(op.dropColumns),
    };
}

function derive(op) {
    return { columns: objects(op.columns).map((c) => ({ name: str(c.name), value: c.value === undefined ? null : c.value })) };
}

function bucket(op) {
    const column = str(op.column);
    const mode = pick(op.mode, ['bands', 'quantiles', 'values'], 'bands');
    return {
        column,
        output: str(op.output) || (column ? `${column} (group)` : ''),
        mode,
        bands: objects(op.bands).map((b) => ({ label: str(b.label), min: numOrNull(b.min), max: numOrNull(b.max) })),
        quantiles: intIn(op.quantiles, 2, 20, 4),
        labels: strListOrNull(op.labels),
        map: objects(op.map).map((m) => ({
            values: (Array.isArray(m.values) ? m.values : []).filter((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))),
            label: str(m.label),
        })),
        otherLabel: op.otherLabel === undefined ? 'Other' : (str(op.otherLabel) || null),
    };
}

const AGG_FNS = ['count', 'sum', 'mean', 'median', 'min', 'max', 'count_distinct', 'share'];
const aggDefaultName = (fn, column) => {
    if (fn === 'count') return 'Count';
    if (fn === 'share') return 'Share (%)';
    const word = String(fn).replace('_', ' ');
    return column ? `${word.charAt(0).toUpperCase()}${word.slice(1)} of ${column}` : word;
};

function group(op) {
    return {
        by: strList(op.by),
        aggregates: objects(op.aggregates).map((a) => {
            const fn = str(a.fn);
            const column = str(a.column);
            return { fn, ...(column ? { column } : {}), as: str(a.as) || aggDefaultName(fn, column) };
        }),
        weight: str(op.weight) || null,
        minN: intIn(op.minN, 0, Number.MAX_SAFE_INTEGER, 0),
        sort: objects(op.sort).map((s) => ({ column: str(s.column), dir: s.dir === 'desc' ? 'desc' : 'asc' })),
    };
}

function pivot(op) {
    const value = isRecord(op.value) ? op.value : {};
    const column = str(value.column);
    return {
        rows: str(op.rows),
        columns: str(op.columns),
        value: { fn: pick(value.fn, ['count', 'sum', 'mean'], 'count'), ...(column ? { column } : {}) },
        weight: str(op.weight) || null,
        percent: pick(op.percent, ['none', 'row', 'column', 'total'], 'none'),
        totals: op.totals !== false,
        minN: intIn(op.minN, 0, Number.MAX_SAFE_INTEGER, 0),
        decimals: intIn(op.decimals, 0, 6, 1),
        columnOrder: strListOrNull(op.columnOrder),
        missingLabel: typeof op.missingLabel === 'string' && op.missingLabel.trim() ? op.missingLabel.trim() : '(empty)',
    };
}

function filter(op) {
    return {
        match: pick(op.match, ['all', 'any'], 'all'),
        rules: Array.isArray(op.rules) ? op.rules : [],
        rulesFrom: op.rulesFrom === undefined || op.rulesFrom === null ? null : op.rulesFrom,
        rulesFromMatch: pick(op.rulesFromMatch, ['all', 'any'], 'all'),
        expr: str(op.expr) || null,
    };
}

function select(op) {
    return {
        keep: strListOrNull(op.keep),
        drop: strListOrNull(op.drop),
        rename: objects(op.rename).map((r) => ({ from: str(r.from), to: str(r.to) })),
    };
}

function sample(op) {
    const n = numOrNull(op.n);
    const percent = numOrNull(op.percent);
    return {
        mode: pick(op.mode, ['first', 'random'], 'first'),
        n: n !== null && n >= 1 ? Math.floor(n) : null,
        percent: percent !== null && percent > 0 && percent <= 100 ? percent : null,
        seed: str(op.seed) || 'sample',
        // What was typed, so the validator can say "exactly one of the two".
        _given: { n: op.n !== undefined && op.n !== null && op.n !== '', percent: op.percent !== undefined && op.percent !== null && op.percent !== '' },
    };
}

function groups(op) {
    return {
        splits: objects(op.splits).map((s) => ({
            column: str(s.column),
            values: strListOrNull(s.values),
            separator: typeof s.separator === 'string' && s.separator !== '' ? s.separator : null,
            label: str(s.label) || null,
        })),
        includeTotal: op.includeTotal !== false,
        totalLabel: str(op.totalLabel) || 'All',
        minN: intIn(op.minN, 0, Number.MAX_SAFE_INTEGER, 30),
    };
}

function describe(op) {
    return {
        columns: strListOrNull(op.columns),
        maxOptions: intIn(op.maxOptions, 2, 200, 50),
        separator: typeof op.separator === 'string' && op.separator !== '' ? op.separator : null,
        sampleValues: intIn(op.sampleValues, 0, 10, 5),
    };
}

module.exports = {
    AGG_FNS,
    byOp: { join, pseudonymise, derive, bucket, group, pivot, filter, select, sample, groups, describe },
};

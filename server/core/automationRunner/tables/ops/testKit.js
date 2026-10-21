'use strict';
/** Helpers for the table operation tests: synthetic tables and a one-call runner. Not used at run time. */

const { normalizeOp } = require('../../../automationModel/tableOps/spec');
const { runTableOps } = require('./index');

const LIMITS = Object.freeze({
    maxRows: 1_000_000, maxBytes: 512 * 1024 * 1024, maxColumns: 1000, previewRows: 20, inlineRows: 200,
    maxOps: 50, maxGroups: 100_000, joinMaxRightRows: 500_000, pivotMaxColumns: 200, maxSegments: 500,
    minGroupFloor: 10, previewInputRows: 1000,
});

const cols = (...keys) => keys.map((key) => ({ key, label: key, type: 'text' }));

/** A source table from plain row objects (columns from the first row's keys unless given). */
function table(rows, columnKeys) {
    const keys = columnKeys || [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { columns: cols(...keys), rows: () => (async function* gen() { for (const r of rows) yield { ...r }; })() };
}

async function collect(rowsFn) {
    const out = [];
    for await (const r of rowsFn()) out.push(r);
    return out;
}

/**
 * Run raw op configs over `rows`. Returns { result, rows, columns, keys }.
 * `extra` overrides runTableOps arguments (runState, limits, mode, resolveTable ...).
 */
async function run(rawOps, rows, extra = {}) {
    const src = table(rows, extra.columnKeys);
    const ops = rawOps.map((o, i) => normalizeOp(o, i));
    const result = await runTableOps({
        source: { columns: src.columns, rows: src.rows, provenance: extra.provenance },
        ops, runState: { vars: {}, ...(extra.runState || {}) }, limits: { ...LIMITS, ...(extra.limits || {}) },
        minGroupFloor: 0, mode: 'run', ...extra,
    });
    const out = await collect(result.rows);
    return { result, rows: out, columns: result.columns, keys: result.columns.map((c) => c.key) };
}

module.exports = { LIMITS, cols, table, collect, run };

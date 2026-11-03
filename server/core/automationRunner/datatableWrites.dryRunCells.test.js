// @typecheck
/**
 * RM-5(b): a dry run types the cells of a datatable write the way a live run
 * does (the dry-run honesty rule, ./execCode.js header). A value that cannot
 * be its column's type fails the step, naming the column, before the preview
 * is synthesised; only a cell read from data the dry run made up itself (a
 * simulated step, a synthetic trigger) keeps its untyped sample.
 *
 * Driven with injected stores, no module mocking.
 * Run: node --test core/automationRunner/datatableWrites.dryRunCells.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const queryCompiler = require('../dataEngine/queryCompiler');
const { runDatatableWrite: write } = require('./datatableWrites');
/** Hand-made stores and results are read loosely: each case asserts the fields it is about. */
const runDatatableWrite = async (/** @type {any} */ t, /** @type {any} */ s) => /** @type {any} */ (await write(t, s));

const META = {
    id: 'tbl_aaaaaa', key: 'orders',
    fields: [
        { id: 'f1', key: 'email', type: 'text' },
        { id: 'f2', key: 'qty', type: 'number' },
        { id: 'f3', key: 'done', type: 'bool' },
    ],
};
const FILTER = { where: '1=1', params: [] };

/** Stores that record every statement; a dry run must send none. */
function stores() {
    /** @type {Array<{ sql: string }>} */
    const calls = [];
    const record = async (/** @type {unknown} */ _a, /** @type {unknown} */ _b, /** @type {string} */ sql) => { calls.push({ sql }); return { rows: [], changes: 0 }; };
    return {
        calls,
        queryCompiler,
        accessFilter: { assertCanWrite() {} },
        assertQuota: async () => {},
        datatableDbStore: { query: record, exec: record, batch: async () => [] },
        datatableStore: { bumpAfterWrite: async () => {} },
    };
}

/**
 * @param {string} op
 * @param {Record<string, unknown>} values
 * @param {{ runState?: object, ctx?: object }} [extra]
 */
function dryRun(op, values, extra = {}) {
    return /** @type {any} */ ({
        step: { id: 's1', type: 'datatable', op, matchColumn: 'email', values, filters: [] },
        ctx: { userId: 'u1' }, runState: { steps: {}, trigger: { output: {} } }, op, mode: 'dry_run',
        table: { id: 'tbl_aaaaaa', name: 'Orders' }, scope: { kind: 'org', id: 'o1' }, scopeKey: 'org:o1', orgId: 'o1',
        grade: 'owner', tableMeta: META, declared: new Set(['email', 'qty', 'done']),
        filters: [{ field: 'email', op: 'eq', value: 'a@x.com' }], match: 'all',
        readFilter: FILTER, writeFilter: FILTER, accessAction: op === 'update_rows' ? 'update' : 'create', ...extra,
    });
}
const lit = (/** @type {unknown} */ value) => ({ kind: 'literal', value });
const ref = (/** @type {string} */ path) => ({ kind: 'ref', path });
const mismatch = (/** @type {any} */ e) => e.errorClass === 'datatable_type_mismatch' && /"qty"/.test(e.message) && !/n\/a/.test(e.message);

test('dry run: a literal that is not its column\'s type fails as live, naming the column', async () => {
    const s = stores();
    await assert.rejects(() => runDatatableWrite(dryRun('add_row', { qty: lit('n/a') }), s), mismatch);
    assert.equal(s.calls.length, 0);
});

test('dry run: a cell read from REAL upstream data is typed too', async () => {
    const runState = { steps: { read: { output: { qty: 'n/a' }, status: 'success' } }, trigger: { output: {} } };
    await assert.rejects(() => runDatatableWrite(dryRun('save_row', { email: lit('a@x.com'), qty: ref('steps.read.output.qty') }, { runState }), stores()), mismatch);
});

test('dry run: update_rows types its cells as live', async () => {
    await assert.rejects(() => runDatatableWrite(dryRun('update_rows', { qty: lit('n/a') }), stores()), mismatch);
});

test('dry run: a valid row is previewed with the types a live run writes', async () => {
    const s = stores();
    const res = await runDatatableWrite(dryRun('add_row', { email: lit('a@x.com'), qty: lit('5'), done: lit('yes') }), s);
    assert.deepEqual(res.output.row, { email: 'a@x.com', qty: 5, done: true });
    assert.equal(res.output._dryRunSynthesised, true);
    assert.equal(s.calls.length, 0, 'a preview writes nothing');
});

test('dry run: a cell read from a simulated step keeps its sample, the other cells are still typed', async () => {
    const runState = {
        steps: {
            sim: { output: { qty: 'sample' }, synthesised: true },
            prev: { output: { qty: 'sample', _dryRunSynthesised: true } },
        },
        trigger: { output: {} },
    };
    const res = await runDatatableWrite(dryRun('add_row', { qty: ref('steps.sim.output.qty'), done: lit('true') }, { runState }), stores());
    assert.deepEqual(res.output.row, { qty: 'sample', done: true });
    const prev = await runDatatableWrite(dryRun('add_row', { qty: { kind: 'template', value: '{{steps.prev.output.qty}}' } }, { runState }), stores());
    assert.equal(prev.output.row.qty, 'sample');
    await assert.rejects(() => runDatatableWrite(dryRun('add_row', { qty: ref('steps.sim.output.qty'), done: lit('maybe') }, { runState }), stores()),
        (/** @type {any} */ e) => e.errorClass === 'datatable_type_mismatch' && /"done"/.test(e.message));
});

test('dry run: a cell read from a synthetic trigger keeps its sample', async () => {
    const runState = { steps: {}, trigger: { output: { qty: 'sample' } } };
    const res = await runDatatableWrite(dryRun('add_row', { qty: ref('trigger.output.qty') }, { runState, ctx: { userId: 'u1', triggerSynthetic: true } }), stores());
    assert.equal(res.output.row.qty, 'sample');
    await assert.rejects(() => runDatatableWrite(dryRun('add_row', { qty: ref('trigger.output.qty') }, { runState }), stores()), mismatch);
});

/**
 * The write half of the datatable step, driven with injected stores (no module
 * mocking): typed cells, one row shape on every branch, and an upsert that
 * ignores capitalisation (#216). Run: node --test core/automationRunner/datatableWrites.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const queryCompiler = require('../dataEngine/queryCompiler');
const { runDatatableWrite } = require('./datatableWrites');

const META = {
    id: 'tbl_aaaaaa', key: 'orders',
    fields: [
        { id: 'f1', key: 'email', type: 'text' },
        { id: 'f2', key: 'qty', type: 'number' },
        { id: 'f3', key: 'done', type: 'bool' },
    ],
};
const FILTER = { where: '1=1', params: [] };

/** Stores that record what is sent; `existing` is what the probe finds. */
function stores(existing = null) {
    const calls = [];
    return {
        calls,
        queryCompiler,
        accessFilter: { assertCanWrite() {} },
        assertQuota: async () => {},
        datatableDbStore: {
            query: async (_a, _b, sql, params) => { calls.push({ kind: 'query', sql, params }); return { rows: existing ? [existing] : [] }; },
            exec: async (_a, _b, sql, params) => { calls.push({ kind: 'exec', sql, params }); return { changes: 1 }; },
        },
        datatableStore: { bumpAfterWrite: async () => {} },
    };
}

function ctxFor(op, values, extra = {}) {
    return {
        step: { id: 's1', type: 'datatable', op, matchColumn: 'email', values },
        ctx: { userId: 'u1' }, runState: {}, op, mode: 'live',
        table: { id: 'tbl_aaaaaa', name: 'Orders' }, scope: { kind: 'org', id: 'o1' }, scopeKey: 'org:o1', orgId: 'o1',
        grade: 'owner', tableMeta: META, declared: new Set(['email', 'qty', 'done']),
        filters: [], match: 'all', readFilter: FILTER, writeFilter: FILTER, accessAction: 'create', ...extra,
    };
}
const lit = (value) => ({ kind: 'literal', value });
const VALUES = { email: lit('a@x.com'), qty: lit('5'), done: lit('true') };

test('add_row, an inserting save_row and an updating save_row return the same typed row', async () => {
    const add = await runDatatableWrite(ctxFor('add_row', VALUES), stores());
    const ins = await runDatatableWrite(ctxFor('save_row', VALUES), stores());
    const upd = await runDatatableWrite(ctxFor('save_row', VALUES), stores({ id: 'r1', email: 'a@x.com', qty: 1, done: false, created_at: 'then' }));
    for (const res of [add, ins, upd]) {
        assert.strictEqual(res.output.row.qty, 5);
        assert.strictEqual(res.output.row.done, true);
        assert.ok(res.output.row.created_at && res.output.row.updated_at);
    }
    assert.deepStrictEqual(Object.keys(add.output.row).sort(), Object.keys(ins.output.row).sort());
    assert.strictEqual(upd.output.created, false);
});

test('the typed number is what reaches the statement', async () => {
    const s = stores();
    await runDatatableWrite(ctxFor('add_row', VALUES), s);
    const bound = s.calls.filter(c => c.kind === 'exec').flatMap(c => c.params);
    assert.ok(bound.includes(5) && !bound.includes('5'));
});

test('save_row looks the match up without regard to capitalisation', async () => {
    const s = stores({ id: 'r1', email: 'a@x.com' });
    const res = await runDatatableWrite(ctxFor('save_row', { email: lit('A@X.COM'), qty: lit(2) }), s);
    assert.strictEqual(res.output.created, false);
    assert.match(s.calls.find(c => c.kind === 'query').sql, /"email" ILIKE \? ESCAPE/);
});

test('a number or yes/no match column is still compared exactly', async () => {
    const s = stores();
    await runDatatableWrite(ctxFor('save_row', { qty: lit(2) }, { step: { id: 's1', type: 'datatable', op: 'save_row', matchColumn: 'qty', values: { qty: lit(2) } } }), s);
    assert.match(s.calls.find(c => c.kind === 'query').sql, /"qty" = \?/);
});

test('a value that is not its column\'s type fails naming the column, before any statement', async () => {
    const s = stores();
    await assert.rejects(
        () => runDatatableWrite(ctxFor('add_row', { qty: lit('abc-private') }), s),
        (e) => e.errorClass === 'datatable_type_mismatch' && /"qty"/.test(e.message) && !/abc-private/.test(e.message),
    );
    assert.strictEqual(s.calls.length, 0);
});

test('a preview keeps its synthetic cells instead of failing on them', async () => {
    const res = await runDatatableWrite(ctxFor('add_row', { qty: lit('sample') }, { mode: 'dry_run' }), stores());
    assert.strictEqual(res.output.row.qty, 'sample');
});

'use strict';

/**
 * A Solution stage's reference table: its model descriptor carries
 * `rowsLocked: true`, and every row writer refuses it in the compiler with
 * RowsLockedError (409, code and errorClass `managed_part`, expose) unless the
 * deploy itself asks with `allowLockedRows: true` (design 5.3). Reads are not
 * affected.
 *
 * Pure: the compiler, plus the writer paths that reach it without a database
 * (the refusal is thrown before any statement runs, so no store is touched):
 *   - the runtime (webpage bridge) insert and update throw it unchanged, with
 *     the `safe` flag its routes pass on;
 *   - the http_request "remember answers" tier reports it, never failing the step.
 * The rows route, the App Studio record steps, the automation datatable step, the
 * form answers write and the store guards run against pglite, through their
 * own entry points, in stores/datatableStore/managedLock.pg.test.js.
 *
 * Run: cd server && node --test core/dataEngine/queryCompiler.rowsLocked.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const { synthesizeAccess } = require('../../auth/datatableAccess');

const PG = { dialect: 'pg' };
const FILTER = { where: '1=1', params: [] };

const FIELDS = [
    { id: 'fld_name', key: 'name', name: 'Name', type: 'text' },
    { id: 'fld_code', key: 'code', name: 'Code', type: 'text', unique: true },
    { id: 'fld_seen', key: 'seen_at', name: 'Seen', type: 'datetime' },
    { id: 'fld_parent', key: 'parent_id', name: 'Parent', type: 'text' },
];
const OPEN = { id: 'tbl_prices', key: 'prices', name: 'Prices', fields: FIELDS };
const LOCKED = { ...OPEN, rowsLocked: true };
const PARENT = { id: 'tbl_parent', key: 'parents', name: 'Parents', fields: [] };
const ROW_ID = 'rec_0123456789abcdef';

/** Every compile writer, as (meta, opts) => compiled. */
const WRITERS = {
    compileInsert: (m, o) => qc.compileInsert(m, { name: 'A' }, { ...PG, ...o }),
    compileUpdate: (m, o) => qc.compileUpdate(m, ROW_ID, { name: 'B' }, FILTER, { ...PG, ...o }),
    compileDelete: (m, o) => qc.compileDelete(m, ROW_ID, FILTER, { ...PG, ...o }),
    compileUpsertByKey: (m, o) => qc.compileUpsertByKey(m, 'code', { code: 'X', name: 'C' }, FILTER, { ...PG, ...o }),
    compileUpsertById: (m, o) => qc.compileUpsertById(m, ROW_ID, { name: 'D' }, FILTER, { ...PG, ...o }),
    compileDeleteAll: (m, o) => qc.compileDeleteAll(m, FILTER, { ...PG, ...o }),
    compileDeleteOlderThan: (m, o) => qc.compileDeleteOlderThan(m, FILTER,
        { field: 'seen_at', cutoffIso: '2026-01-01T00:00:00.000Z', ...PG, ...o }),
    compileDeleteOrphans: (m, o) => qc.compileDeleteOrphans(m, FILTER,
        { relationField: 'parent_id', parentTableMeta: PARENT, ...PG, ...o }),
};

/** The refusal, checked field by field. */
function isRowsLocked(e) {
    assert.ok(e instanceof qc.RowsLockedError, `expected RowsLockedError, got ${e && e.name}: ${e && e.message}`);
    assert.ok(!(e instanceof qc.CompileError), 'a locked table is not a bad descriptor');
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'managed_part');
    assert.strictEqual(e.errorClass, 'managed_part');
    assert.strictEqual(e.expose, true);
    assert.ok(e.message.length > 0);
    return true;
}

for (const [name, write] of Object.entries(WRITERS)) {
    test(`${name} refuses a locked table and compiles with allowLockedRows`, () => {
        assert.throws(() => write(LOCKED, {}), isRowsLocked);
        const out = write(LOCKED, { allowLockedRows: true });
        assert.match(out.sql, /^(INSERT|UPDATE|DELETE)\b/);
        // An unlocked table compiles exactly as before, flag or no flag.
        assert.deepStrictEqual(Object.keys(write(OPEN, {})).sort(), Object.keys(out).sort());
    });
}

test('only `allowLockedRows: true` opens the lock, never a truthy look-alike', () => {
    for (const v of ['true', 1, {}, 'yes']) {
        assert.throws(() => WRITERS.compileInsert(LOCKED, { allowLockedRows: v }), isRowsLocked);
    }
    // rowsLocked must be literally true to lock.
    for (const v of ['true', 1, 'yes']) {
        assert.doesNotThrow(() => WRITERS.compileInsert({ ...OPEN, rowsLocked: v }, {}));
    }
});

test('reads of a locked table are unaffected', () => {
    assert.match(qc.compileRecordList(LOCKED, { limit: 10, ...PG }, FILTER).sql, /^SELECT/);
    assert.match(qc.compileGetById(LOCKED, ROW_ID, FILTER, PG).sql, /^SELECT/);
    assert.match(qc.compileAggregate(LOCKED, {
        aggregates: [{ fn: 'count', field: '*', as: 'total' }], ...PG,
    }, FILTER).sql, /^SELECT/);
    assert.match(qc.compileKeyIndex(LOCKED, 'code', ['X'], FILTER, PG).sql, /^SELECT/);
    assert.match(qc.compileIdList(LOCKED, FILTER, PG).sql, /^SELECT/);
    assert.match(qc.compileKeyValues(LOCKED, 'code', FILTER, PG).sql, /^SELECT/);
    assert.match(qc.compileSelectOlderThan(LOCKED, FILTER,
        { field: 'seen_at', cutoffIso: '2026-01-01T00:00:00.000Z', limit: 5, ...PG }).sql, /^SELECT/);
});

test('assertRowsWritable is the same rule, for a caller that asks before it reads a quota', () => {
    assert.throws(() => qc.assertRowsWritable(LOCKED), isRowsLocked);
    assert.doesNotThrow(() => qc.assertRowsWritable(LOCKED, { allowLockedRows: true }));
    assert.doesNotThrow(() => qc.assertRowsWritable(OPEN));
    assert.doesNotThrow(() => qc.assertRowsWritable(null));
});

// ── The writer paths ────────────────────────────────────────────────────────

const ORG = { kind: 'org', id: 'org1' };
const DT = { id: 'tbl_prices', name: 'Prices', organizationId: 'org1', source: null, row_scope: 'all' };

test('runtime (webpage bridge): insert and update throw it unchanged, marked safe', async () => {
    const runtime = require('./datatableRuntime');
    const resolved = {
        table: DT, scope: ORG, scopeKey: 'org_org1', grade: 'editor',
        principal: { userId: 'u1' },
        meta: { ...LOCKED, access: synthesizeAccess(DT) },
    };
    await assert.rejects(runtime.insertRow(resolved, { allowColumns: ['name'], values: { name: 'A' } }), (e) => {
        isRowsLocked(e);
        assert.strictEqual(e.safe, true, 'the bridge passes on safe refusals only');
        return true;
    });
    await assert.rejects(runtime.updateRow(resolved, {
        allowColumns: ['name'], rowId: ROW_ID, values: { name: 'B' }, expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    }), isRowsLocked);
});

test('http_request cacheInto: a locked table is reported as managed_part, never a failed step', async () => {
    const { storeInto } = require('../automationRunner/httpCache');
    const plan = {
        memoKey: 'k1', parsedOrigin: 'https://api.example.test', parsedPath: '/v1/x', method: 'GET', userId: 'u1',
        into: {
            tableMeta: { ...LOCKED, access: synthesizeAccess(DT) }, table: DT, scope: ORG,
            scopeKey: 'org_org1', orgId: 'org1', readFilter: FILTER, updateFilter: FILTER,
        },
    };
    const out = { ok: true, status: 200, headers: {}, body: '{"a":1}', truncated: false };
    const r = await storeInto(plan, out, out);
    assert.strictEqual(r.stored, false);
    assert.strictEqual(r.reason, 'managed_part');
    assert.strictEqual(r.errorClass, 'managed_part');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createStudioDatatable } = require('./createStudioDatatable');

const FIELDS = [{ key: 'datum', name: 'Datum', type: 'date' }];

function makeDeps({ taken = [], createThrows = null } = {}) {
    const calls = { create: [] };
    return {
        calls,
        deps: {
            db: { withTransaction: async (fn) => fn({}) },
            datatableStore: {
                listDatatablesForScope: async () => taken.map((key) => ({ key })),
                createDatatable: async (row) => {
                    calls.create.push(row);
                    if (createThrows) throw createThrows;
                    return { id: 'tbl_new', key: row.key, name: row.name };
                },
            },
            datatableDbStore: { scopeKey: () => 'scope', invalidate() {}, applyMigration: async () => {} },
            normalizeFields: (f) => ({ ok: true, fields: f }),
            migrationPlan: () => [],
            ddlForTable: () => '',
            assertDatatableQuota: async () => {},
            datatableAccess: { defaultCreateScope: () => ({ kind: 'user', id: 'u1' }) },
        },
    };
}

const base = { ownerUserId: 'u1', principal: { userId: 'u1' }, name: 'Facturen', fields: FIELDS };

test('without exactKey a taken key is made unique', async () => {
    const { deps, calls } = makeDeps({ taken: ['facturen'] });
    const r = await createStudioDatatable({ ...base, key: 'facturen' }, deps);
    assert.strictEqual(r.ok, true);
    assert.notStrictEqual(calls.create[0].key, 'facturen');
});

test('exactKey with a taken key answers key_taken and creates nothing', async () => {
    const { deps, calls } = makeDeps({ taken: ['facturen'] });
    const r = await createStudioDatatable({ ...base, key: 'facturen', exactKey: true }, deps);
    assert.deepStrictEqual([r.ok, r.code], [false, 'key_taken']);
    assert.strictEqual(calls.create.length, 0);
});

test('exactKey with a free key uses exactly that key', async () => {
    const { deps, calls } = makeDeps();
    const r = await createStudioDatatable({ ...base, key: 'facturen_2', exactKey: true }, deps);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.create[0].key, 'facturen_2');
});

test('a quota error keeps its own code', async () => {
    const err = Object.assign(new Error('This workspace already has 50 datatables (the limit is 50).'), { code: 'quota_exceeded' });
    const { deps } = makeDeps({ createThrows: err });
    const r = await createStudioDatatable(base, deps);
    assert.deepStrictEqual([r.ok, r.code], [false, 'quota']);
    assert.match(r.error, /50 datatables/);
});

test('any other failure stays create_failed', async () => {
    const { deps } = makeDeps({ createThrows: new Error('boom') });
    const r = await createStudioDatatable(base, deps);
    assert.strictEqual(r.code, 'create_failed');
});

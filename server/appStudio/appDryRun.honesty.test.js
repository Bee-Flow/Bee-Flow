/**
 * App Studio dry-run: the verdicts must be honest in both directions.
 * Linked (Studio datatable) tables read through the shared read runner, a
 * database error never leaks its relation name, emptyTables ignores filtered
 * reads, an unknown screen is an error, and a capped rowCount says so.
 *
 * Run: node --test appStudio/appDryRun.honesty.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { canonicalizeDataModel } = require('./dataModel');
const { appDryRun, DRY_RUN_LIMIT } = require('./appDryRun');

function appWith(source) {
    return canonicalizeAppDefinition({
        meta: { name: 'Dry app' }, homeScreenId: 'scr_home01', theme: {},
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_table1', type: 'table', props: { source } }] }],
        }],
        actions: {},
    }).def;
}

function model({ linked = false } = {}) {
    const m = canonicalizeDataModel({
        tables: [{
            id: 'tbl_task01', key: 'tasks', name: 'Tasks', access: { default: 'owner' },
            fields: [
                { id: 'fld_ti01', key: 'title', type: 'text' },
                { id: 'fld_st01', key: 'status', type: 'select', options: ['todo', 'done'] },
            ],
        }],
        roles: [{ key: 'member', label: 'Member' }],
        roleMapping: { default: 'member', byGroup: {} },
    }).model;
    if (linked) m.tables[0] = { ...m.tables[0], source: { kind: 'datatable', datatableId: 'dt_synthetic1', mode: 'read' } };
    return m;
}

const OWNER = 'owner-9';
const APP = { id: 'app1', userId: OWNER };

function deps(over = {}) {
    return {
        dbQuery: async () => ({ rows: [] }),
        runDataset: async () => ({ rows: [] }),
        getDataset: async () => null,
        readRecords: async () => ({ records: [], nextCursor: null }),
        readAggregate: async () => ({ rows: [] }),
        ...over,
    };
}

const run = (def, dataModel, d, opts = {}) => appDryRun({ def, dataModel, datasets: [], app: APP, ownerId: OWNER, deps: d }, opts);

test('a linked table is read through the shared read runner, not the per-app database', async () => {
    const calls = [];
    const d = deps({
        dbQuery: async () => { throw new Error('relation "synthetic_linked_rel" does not exist'); },
        readRecords: async (ctx, table, o) => { calls.push({ ctx, table: table.id, o }); return { records: [{ id: 'r1' }], nextCursor: null }; },
    });
    const r = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model({ linked: true }), d);
    assert.strictEqual(r.bindings[0].ok, true, JSON.stringify(r.bindings));
    assert.strictEqual(r.bindings[0].rowCount, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].ctx.ownerScope, OWNER);
    assert.strictEqual(calls[0].o.limit, DRY_RUN_LIMIT);
});

test('a linked aggregate goes through readAggregate', async () => {
    const d = deps({
        dbQuery: async () => { throw new Error('relation "synthetic_linked_rel" does not exist'); },
        readAggregate: async () => ({ rows: [{ n: 4 }] }),
    });
    const src = { kind: 'aggregate', tableId: 'tbl_task01', aggregates: [{ fn: 'count', as: 'n' }] };
    const r = await run(appWith(src), model({ linked: true }), d);
    assert.strictEqual(r.bindings[0].ok, true, JSON.stringify(r.bindings));
    assert.strictEqual(r.bindings[0].rowCount, 1);
});

test('a database error is generic to the client and detailed only in the log', async () => {
    const d = deps({ dbQuery: async () => { throw new Error('relation "synthetic_secret_rel" does not exist'); } });
    const r = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model(), d);
    assert.strictEqual(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('synthetic_secret_rel'), JSON.stringify(r));
    assert.match(r.bindings[0].error, /server log/);
});

test('a compiler complaint about the author\'s own field still reaches the author', async () => {
    const r = await run(appWith({ kind: 'records', tableId: 'tbl_task01', sort: [{ field: 'ghost', dir: 'asc' }] }), model(), deps());
    assert.strictEqual(r.bindings[0].ok, false);
    assert.match(r.bindings[0].error, /unknown field: ghost/);
});

test('emptyTables ignores a filtered read but keeps an unfiltered empty one', async () => {
    const filtered = await run(
        appWith({ kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: 'done' }] }),
        model(), deps(),
    );
    assert.strictEqual(filtered.bindings[0].rowCount, 0);
    assert.strictEqual(filtered.bindings[0].filtered, true);
    assert.deepStrictEqual(filtered.emptyTables, []);
    assert.ok(filtered._hints.some((h) => /with its filter/.test(h)), JSON.stringify(filtered._hints));

    const plain = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model(), deps());
    assert.deepStrictEqual(plain.emptyTables, ['tbl_task01']);
});

test('an unknown screenId is an error, not an ok with no bindings', async () => {
    const r = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model(), deps(), { screenId: 'scr_ghost01' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /screenId/);
    assert.match(r._fixHint, /scr_home01/);
});

test('a capped rowCount says it was sampled', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const r = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model(), deps({ dbQuery: async () => ({ rows }) }));
    assert.strictEqual(r.bindings[0].rowCount, DRY_RUN_LIMIT);
    assert.strictEqual(r.bindings[0].sampled, true);
    assert.strictEqual(r.bindings[0].sampleLimit, DRY_RUN_LIMIT);

    const few = await run(appWith({ kind: 'records', tableId: 'tbl_task01' }), model(), deps({ dbQuery: async () => ({ rows: rows.slice(0, 2) }) }));
    assert.strictEqual(few.bindings[0].sampled, undefined);
});

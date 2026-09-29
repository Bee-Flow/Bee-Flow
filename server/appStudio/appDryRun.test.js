/**
 * Unit tests for the App Studio dry-run (appStudio/appDryRun.js).
 *
 * The DB edge (dbQuery / runDataset / getDataset) is injected, so the four
 * passes run without a database. canonicalize / validate / queryCompiler /
 * rlsGateway / the shared expr engine all run for real.
 *
 * Run: node --test appStudio/appDryRun.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { canonicalizeDataModel } = require('./dataModel');
const { appDryRun, ROLE_PROBE_VIEWER_ID } = require('./appDryRun');

// ── Fixtures ────────────────────────────────────────────────────────

/** A one-screen app whose single component's `source` prop is the given binding. */
function appWith(source, actions = {}) {
    const raw = {
        meta: { name: 'Dry app' }, homeScreenId: 'scr_home01', theme: {},
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_table1', type: 'table', props: { source } }] }],
        }],
        actions,
    };
    return canonicalizeAppDefinition(raw).def;
}

/** An app whose single component is a stat bound to a dataset. */
function appWithDataset(datasetId) {
    const raw = {
        meta: { name: 'Dry app' }, homeScreenId: 'scr_home01', theme: {},
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_stat01', type: 'stat', props: { label: 'Count', value: { kind: 'dataset', datasetId } } }] }],
        }],
        actions: {},
    };
    return canonicalizeAppDefinition(raw).def;
}

/** A model with a `tasks` table (default `owner` access) + a `member` role. */
function tasksModel(access = { default: 'owner' }) {
    return canonicalizeDataModel({
        tables: [{
            id: 'tbl_task01', key: 'tasks', name: 'Tasks', access,
            fields: [
                { id: 'fld_ti01', key: 'title', type: 'text' },
                { id: 'fld_st01', key: 'status', type: 'select', options: ['todo', 'done'] },
            ],
        }],
        roles: [{ key: 'member', label: 'Member' }],
        roleMapping: { default: 'member', byGroup: {} },
    }).model;
}

const OWNER = 'owner-9';
const APP = { id: 'app1', userId: OWNER };

function depsReturning(rows, capture = null) {
    return {
        dbQuery: async (ownerScope, appId, sql, params) => { if (capture) capture.push({ ownerScope, sql, params }); return { rows }; },
        runDataset: async () => ({ rows: [] }),
        getDataset: async () => null,
    };
}

// ── Tests ───────────────────────────────────────────────────────────

test('binding against an empty table → ok, 0-rows hint + emptyTables (never blocks)', async () => {
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, {});
    assert.strictEqual(r.ok, true, 'zero rows is a warning, not a finalize blocker');
    assert.deepStrictEqual(r.static.errors, []);
    assert.strictEqual(r.bindings.length, 1);
    assert.deepStrictEqual(r.bindings[0], { nodeId: 'cmp_table1', prop: 'source', kind: 'records', ok: true, rowCount: 0 });
    assert.deepStrictEqual(r.emptyTables, ['tbl_task01']);
    assert.ok(r._hints.some((h) => /returned 0 rows/.test(h) && h.includes('cmp_table1')), JSON.stringify(r._hints));
});

test('unknown dataset → STATIC error, ok:false; the data pass skips it (unresolved)', async () => {
    const def = appWithDataset('ds_missing');
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, {});
    assert.strictEqual(r.ok, false);
    assert.ok(r.static.errors.some((e) => e.code === 'binding.unknown_dataset'), JSON.stringify(r.static.errors));
    assert.deepStrictEqual(r.bindings[0], { nodeId: 'cmp_stat01', prop: 'value', kind: 'dataset', ok: true, skipped: 'unresolved' });
});

test('a formula filter resolves against the synthetic OWNER scope (currentUser.id → owner)', async () => {
    const capture = [];
    const def = appWith({ kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }] });
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([{ id: 'r1' }], capture) }, {});
    assert.strictEqual(r.bindings[0].ok, true);
    assert.strictEqual(capture.length, 1, 'the resolved filter ran one query');
    assert.ok(capture[0].params.includes(OWNER), `owner id bound into the WHERE params: ${JSON.stringify(capture[0].params)}`);
});

test('a formula referencing an unpopulated root → binding skipped:dynamic (no query)', async () => {
    const capture = [];
    // `item` is a repeater-row root the synthetic screen-level scope cannot populate.
    const def = appWith({ kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'item.status' } }] });
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([{ id: 'r1' }], capture) }, {});
    assert.deepStrictEqual(r.bindings[0], { nodeId: 'cmp_table1', prop: 'source', kind: 'records', ok: true, skipped: 'dynamic' });
    assert.strictEqual(capture.length, 0, 'a dynamic binding is never executed');
    assert.strictEqual(r.ok, true, 'a skipped binding does not block');
});

test('asRole pass surfaces an empty role view for owner-seeded, own-scoped data', async () => {
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    // Owner (read: all) sees the row; a `member` (default owner → read: own) whose
    // created_by is the synthetic probe id sees nothing — the empty-screen signal.
    const deps = {
        dbQuery: async (ownerScope, appId, sql, params) => (params.includes(ROLE_PROBE_VIEWER_ID) ? { rows: [] } : { rows: [{ id: 'r1' }] }),
        runDataset: async () => ({ rows: [] }),
        getDataset: async () => null,
    };
    const r = await appDryRun({ def, dataModel: tasksModel({ default: 'owner' }), datasets: [], app: APP, ownerId: OWNER, deps }, { asRole: 'member' });
    assert.strictEqual(r.bindings[0].rowCount, 1, 'the owner sees the row');
    assert.strictEqual(r.roleFindings.length, 1);
    assert.deepStrictEqual(r.roleFindings[0], { role: 'member', nodeId: 'cmp_table1', prop: 'source', kind: 'records', ok: true, rowCount: 0 });
    assert.ok(r._hints.some((h) => /role "member" sees 0 rows/.test(h)), JSON.stringify(r._hints));
    assert.strictEqual(r.ok, true, 'an empty role view is a warning, never a blocker');
});

test('asRole is ignored when the role does not exist in the model', async () => {
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([{ id: 'r1' }]) }, { asRole: 'ghost_role' });
    assert.deepStrictEqual(r.roleFindings, []);
});

test('a sequence step writing a missing field key is flagged (actions pass)', async () => {
    const def = appWith(
        { kind: 'records', tableId: 'tbl_task01' },
        { act_seq001: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_task01', values: { nope: { kind: 'static', value: 'x' } } }] } },
    );
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, {});
    const finding = r.actions.find((a) => a.step === 'create_record');
    assert.ok(finding, 'the create_record step appears in the actions pass');
    assert.strictEqual(finding.ok, false);
    assert.ok(finding.errors.some((e) => /"nope"/.test(e)), JSON.stringify(finding.errors));
    assert.strictEqual(r.ok, false, 'a bad field key also fails the static pass → not ok');
});

test('a sequence step against a table not in the model is flagged', async () => {
    const def = appWith(
        { kind: 'records', tableId: 'tbl_task01' },
        { act_seq002: { kind: 'sequence', steps: [{ kind: 'delete_record', tableId: 'tbl_ghost1', recordId: { kind: 'formula', expr: 'item.id' } }] } },
    );
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, {});
    const finding = r.actions.find((a) => a.step === 'delete_record');
    assert.ok(finding && finding.ok === false, JSON.stringify(r.actions));
    assert.ok(finding.errors.some((e) => /not in the data model/.test(e)), JSON.stringify(finding.errors));
});

test('screenId narrows the data pass to one screen', async () => {
    // Two screens; only the second holds the (empty) binding.
    const raw = {
        meta: { name: 'Two' }, homeScreenId: 'scr_home01', theme: {},
        screens: [
            { id: 'scr_home01', name: 'Home', sections: [{ id: 'sec_a1', style: {}, children: [{ id: 'cmp_head01', type: 'heading', props: { text: 'Hi' } }] }] },
            { id: 'scr_data01', name: 'Data', sections: [{ id: 'sec_b1', style: {}, children: [{ id: 'cmp_grid01', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_task01' } } }] }] },
        ],
        actions: {},
    };
    const def = canonicalizeAppDefinition(raw).def;
    const home = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, { screenId: 'scr_home01' });
    assert.strictEqual(home.bindings.length, 0, 'home screen has no data bindings');
    const data = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: APP, ownerId: OWNER, deps: depsReturning([]) }, { screenId: 'scr_data01' });
    assert.strictEqual(data.bindings.length, 1);
    assert.strictEqual(data.bindings[0].nodeId, 'cmp_grid01');
});

test('no persisted app row → data pass skips (skipped:no_data), static pass still runs', async () => {
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    const r = await appDryRun({ def, dataModel: tasksModel(), datasets: [], app: null, ownerId: OWNER, deps: depsReturning([]) }, {});
    assert.strictEqual(r.bindings[0].skipped, 'no_data');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.static.errors, []);
});

test('a dataset binding executes via runDataset and reports its row count', async () => {
    const def = appWithDataset('ds_live1');
    const deps = {
        dbQuery: async () => ({ rows: [] }),
        runDataset: async () => ({ rows: [{ status: 'todo', n: 2 }, { status: 'done', n: 1 }] }),
        getDataset: async () => ({ id: 'ds_live1', tableId: 'tbl_task01', descriptor: { groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'n' }] } }),
    };
    const r = await appDryRun({ def, dataModel: tasksModel({ default: 'app' }), datasets: [{ id: 'ds_live1', name: 'By status' }], app: APP, ownerId: OWNER, deps }, {});
    assert.deepStrictEqual(r.static.errors, [], JSON.stringify(r.static.errors));
    assert.deepStrictEqual(r.bindings[0], { nodeId: 'cmp_stat01', prop: 'value', kind: 'dataset', ok: true, rowCount: 2 });
    assert.strictEqual(r.ok, true);
});

/*
 * AGGREGATE BINDINGS COMPILE AS AGGREGATES.
 *
 * They used to be run through compileRecordList like everything else, which
 * resolves sort.field against the table's real columns. An aggregate sorts by
 * its own OUTPUT — `count`, a bucketed `day` — so four working dashboard tiles
 * were reported as `unknown field: count`. False findings are the expensive
 * kind: they teach you to skim the list, and the real one goes by with them.
 */
test('an aggregate binding sorted by its own output alias is not a finding', async () => {
    const def = appWith({
        kind: 'aggregate',
        tableId: 'tbl_task01',
        groupBy: [{ field: 'status' }],
        aggregates: [{ fn: 'count', as: 'count' }],
        sort: [{ field: 'count', dir: 'desc' }],
        limit: 10,
    });
    const capture = [];
    const r = await appDryRun({
        def, dataModel: tasksModel({ default: 'app' }), datasets: [], app: APP, ownerId: OWNER,
        deps: depsReturning([{ status: 'todo', count: 2 }], capture),
    }, {});
    assert.deepStrictEqual(r.bindings[0], { nodeId: 'cmp_table1', prop: 'source', kind: 'aggregate', ok: true, rowCount: 1 });
    // The SQL it checked is the SQL the live /data/query route runs — a GROUP BY,
    // not a row list. Without this the test would still pass on a compiler that
    // silently ignored the aggregate half of the descriptor.
    assert.match(capture[0].sql, /GROUP BY/i, capture[0].sql);
});

test('a bucketed aggregate sorted by its bucket alias is not a finding either', async () => {
    const def = appWith({
        kind: 'aggregate',
        tableId: 'tbl_task01',
        groupBy: [{ field: 'created_at', bucket: 'day', as: 'day' }],
        aggregates: [{ fn: 'count', as: 'count' }],
        sort: [{ field: 'day', dir: 'asc' }],
        limit: 90,
    });
    const r = await appDryRun({
        def, dataModel: tasksModel({ default: 'app' }), datasets: [], app: APP, ownerId: OWNER,
        deps: depsReturning([]),
    }, {});
    assert.strictEqual(r.bindings[0].ok, true, JSON.stringify(r.bindings[0]));
});

test('a genuinely broken aggregate is still reported', async () => {
    const def = appWith({
        kind: 'aggregate',
        tableId: 'tbl_task01',
        groupBy: [{ field: 'nonexistent' }],
        aggregates: [{ fn: 'count', as: 'count' }],
    });
    const r = await appDryRun({
        def, dataModel: tasksModel({ default: 'app' }), datasets: [], app: APP, ownerId: OWNER,
        deps: depsReturning([]),
    }, {});
    assert.strictEqual(r.bindings[0].ok, false, JSON.stringify(r.bindings[0]));
    assert.match(r.bindings[0].error, /unknown field/i);
});

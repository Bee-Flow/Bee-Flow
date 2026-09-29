/**
 * App Studio connector sync job — what one tick does.
 *
 * The job is thin (advisory lock → list due → sync each), so the tests are about
 * the two things that would otherwise rot silently: a connector whose owner
 * removed it must stop being scheduled forever, and one sync failing must not
 * stop the rest of the tick.
 *
 * Stubs the stores via the require-cache trick (same pattern as
 * routes/studioAppConnectors.test.js) — no Postgres, no SQLite, no network.
 *
 * Run: cd server && node --test jobs/studioAppConnectorSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { mountGated } = require('../testUtils/gatedStart');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const apps = new Map();
const models = new Map();
const deleted = [];

stub('../db', { pool: { connect: async () => ({ query: async () => ({ rows: [{ locked: true }] }), release() {} }) } });
stub('../telemetry/metrics', { recordJobRun: () => {} });
stub('../stores/studioAppStore', { getStudioApp: async (id) => apps.get(id) || null });
stub('../stores/studioAppDataStore', {
    getDataModel: async (appId) => (models.has(appId) ? { model: models.get(appId) } : null),
    deleteSyncState: async (appId, connectorId) => { deleted.push(`${appId}:${connectorId}`); },
    listDueSyncs: async () => dueSyncs,
});

const syncCalls = [];
let syncImpl = async () => ({ inserted: 1, updated: 0 });
stub('../appStudio/connectorSync', {
    syncConnector: async (app, model, connector, opts) => {
        syncCalls.push({ appId: app.id, connectorId: connector.id, reason: opts.reason });
        return syncImpl(connector);
    },
});

let dueSyncs = [];
const job = require('./studioAppConnectorSync');

const OWNER = 'owner-1';
function seed(appId, connectors) {
    apps.set(appId, { id: appId, userId: OWNER, organizationId: 'org-1' });
    models.set(appId, { modelVersion: 1, tables: [{ id: 'tbl_a', key: 't', fields: [] }], connectors });
}

test.beforeEach(() => {
    syncCalls.length = 0;
    deleted.length = 0;
    dueSyncs = [];
    syncImpl = async () => ({ inserted: 1, updated: 0 });
});

test('a due sync runs through the engine, tagged as scheduled', async () => {
    seed('app-1', [{ id: 'conn_aaa111', kind: 'integration_tool', tool: 'gmail_search', sync: { tableId: 'tbl_a' } }]);
    dueSyncs = [{ appId: 'app-1', connectorId: 'conn_aaa111' }];

    await job.processDueSyncs();
    assert.deepStrictEqual(syncCalls, [{ appId: 'app-1', connectorId: 'conn_aaa111', reason: 'schedule' }]);
});

test('a connector the owner stopped syncing is UNSCHEDULED, not retried forever', async () => {
    seed('app-2', [{ id: 'conn_bbb222', kind: 'integration_tool', tool: 'gmail_search' }]);   // sync block removed
    dueSyncs = [{ appId: 'app-2', connectorId: 'conn_bbb222' }];

    const before = deleted.length;
    await job.processDueSyncs();
    assert.strictEqual(syncCalls.length, 0, 'nothing ran');
    assert.deepStrictEqual(deleted.slice(before), ['app-2:conn_bbb222']);
});

test('a connector deleted outright is also unscheduled', async () => {
    seed('app-3', []);
    dueSyncs = [{ appId: 'app-3', connectorId: 'conn_gone99' }];

    await job.processDueSyncs();
    assert.strictEqual(syncCalls.length, 0);
    assert.deepStrictEqual(deleted, ['app-3:conn_gone99']);
});

test('a deleted app is skipped without touching the engine', async () => {
    dueSyncs = [{ appId: 'app-vanished', connectorId: 'conn_ccc333' }];
    await job.processDueSyncs();
    assert.strictEqual(syncCalls.length, 0);
    assert.deepStrictEqual(deleted, [], 'the FK cascade takes the row with the app');
});

test('one failing sync does not stop the rest of the tick', async () => {
    seed('app-4', [
        { id: 'conn_ddd444', kind: 'integration_tool', tool: 'a', sync: { tableId: 'tbl_a' } },
        { id: 'conn_eee555', kind: 'integration_tool', tool: 'b', sync: { tableId: 'tbl_a' } },
    ]);
    dueSyncs = [
        { appId: 'app-4', connectorId: 'conn_ddd444' },
        { appId: 'app-4', connectorId: 'conn_eee555' },
    ];
    syncImpl = async (connector) => {
        if (connector.id === 'conn_ddd444') throw new Error('gmail is not connected');
        return { inserted: 2 };
    };

    await job.processDueSyncs();
    assert.deepStrictEqual(syncCalls.map((c) => c.connectorId), ['conn_ddd444', 'conn_eee555']);
});

test('syncOne is reusable on its own and reports the engine result', async () => {
    seed('app-5', [{ id: 'conn_fff666', kind: 'integration_tool', tool: 'a', sync: { tableId: 'tbl_a' } }]);
    const r = await job.syncOne({ appId: 'app-5', connectorId: 'conn_fff666' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.inserted, 1);
});

test('the tick is bounded so a backlog drains instead of stalling every other job', () => {
    assert.ok(job.MAX_PER_TICK > 0 && job.MAX_PER_TICK <= 50);
});

// ── the scheduling deadlock ─────────────────────────────────────────
//
// listDueSyncs selects on next_run_at, and for a while the ONLY thing that
// created a row was a sync actually starting. So a freshly configured schedule
// could never fire on its own: the table stayed empty until someone opened the
// app or pressed "Refresh now" — and silently forever if on-view refresh was
// off. Saving the model now seeds the row as due, which is what breaks the loop.

test('a connector that fills a table is picked up WITHOUT anyone opening the app', async () => {
    seed('app-6', [{ id: 'conn_seed01', kind: 'integration_tool', tool: 'gmail_search', sync: { tableId: 'tbl_a' } }]);
    // What reconcileSyncStates writes on save: idle, due now, never run.
    dueSyncs = [{ appId: 'app-6', connectorId: 'conn_seed01', status: 'idle', lastRunAt: null }];

    await job.processDueSyncs();
    assert.deepStrictEqual(syncCalls, [{ appId: 'app-6', connectorId: 'conn_seed01', reason: 'schedule' }],
        'the very first fill comes from the schedule, not from a manual click');
});

// ── BFSF-438: the runtime module gate ───────────────────────────────
//
// Boot only reads the deploy-time catalog flag. Removing App Studio in the
// admin Modules panel must stop the scheduled syncs on a pod that is already
// running, for the interval AND the boot tick.

test('BFSF-438: both timers go through the apps module gate; inactive means no sync', async () => {
    seed('app-7', [{ id: 'conn_gate01', kind: 'integration_tool', tool: 'a', sync: { tableId: 'tbl_a' } }]);
    dueSyncs = [{ appId: 'app-7', connectorId: 'conn_gate01', status: 'idle', lastRunAt: null }];
    const w = mountGated((opts) => job.start(opts));
    assert.deepStrictEqual(w.state.consulted.map(c => [c.moduleId, c.fn]), [['apps', job.processDueSyncs]]);
    assert.deepStrictEqual(w.timers.map(t => t.kind).sort(), ['interval', 'timeout']);

    w.state.active = false;
    await w.fireAll();
    assert.strictEqual(w.state.passed, 0);
    assert.deepStrictEqual(syncCalls, [], 'a removed App Studio module still synced a connector');

    w.state.active = true;
    await w.fireAll();
    assert.strictEqual(w.state.passed, 2, 'the interval and the boot tick must both pass the gate');
    assert.ok(syncCalls.length >= 1, 'the gated tick no longer reaches the sync');
});

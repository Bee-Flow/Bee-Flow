/**
 * The refresh pass, with Nextcloud and the stores stubbed: the snapshot is
 * taken BEFORE fetching, the upserts are chunked, the deletions are the
 * snapshot minus what came back — and skipped when the cap bit — the counter
 * moves only when rows did, and a failure lands on the state with a backoff.
 *
 * Run: cd server && node --test core/dataEngine/sources/nextcloudTable/sync.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

// ── the world ──────────────────────────────────────────────────────────────
const SCOPE = { kind: 'org', id: 'org_1' };
const META = {
    id: 'tbl_fac', key: 'facturen',
    fields: [
        { id: 'fld_nc2txt', key: 'leverancier', type: 'text' },
        { id: 'fld_nc6num', key: 'totaal', type: 'number' },
    ],
};
function mirror(over = {}) {
    return {
        id: 'tbl_fac', key: 'facturen', name: 'Facturen', scope: SCOPE, scopeKind: 'org', organizationId: 'org_1',
        managedKind: 'nextcloud_table', rowScope: 'all', rowCount: 0, isPublished: false, sharedGroups: [], writeMode: 'grants',
        scope_kind: 'org', scope_id: 'org_1', organization_id: 'org_1', owner_user_id: 'user_1', is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
        source: {
            kind: 'nextcloud_table', ncTableId: 4, ncViewId: null, linkedByUserId: 'user_1',
            schedule: { everyMinutes: 15 }, refreshOnView: true, rowCap: 10000,
            columnMap: { fld_nc2txt: { ncColumnId: 2, ncType: 'text', ncSubtype: 'line', title: 'Leverancier' }, fld_nc6num: { ncColumnId: 6, ncType: 'number', title: 'Totaal' } },
            relations: [],
        },
        syncState: null,
        ...over,
    };
}
const NC_COLUMNS = [
    { id: 2, title: 'Leverancier', type: 'text', subtype: 'line', orderWeight: 0, selectionOptions: [], customSettings: {} },
    { id: 6, title: 'Totaal', type: 'number', subtype: '', orderWeight: 1, selectionOptions: [], customSettings: {} },
];
function ncRow(id, lev, tot) { return { id, tableId: 4, data: [{ columnId: 2, value: lev }, { columnId: 6, value: tot }] }; }

const world = {
    existingIds: [], ncRows: [], listRowsCalls: [], batches: [], queries: [], claimed: true,
    finished: [], rowCounts: [], sources: [], columns: NC_COLUMNS, snapshotTruncated: false,
};
function reset() {
    world.claimRow = mirror();
    Object.assign(world, { existingIds: [], ncRows: [], listRowsCalls: [], batches: [], queries: [], claimed: true, finished: [], rowCounts: [], sources: [], columns: NC_COLUMNS, snapshotTruncated: false });
}

const datatableStore = {
    // The claim hands back the ROW, as the store does: what the test passed in.
    claimSourceSync: async (id) => (world.claimed ? { ...world.claimRow, id } : null),
    finishSourceSync: async (id, patch) => { world.finished.push(patch); return mirror({ syncState: patch }); },
    getTableMeta: async () => META,
    listSourceMirrorsInScope: async () => [mirror()],
    setSource: async (id, scope, source) => { world.sources.push(source); return { ...world.claimRow, source }; },
    setRowCount: async (id, scope, n) => { world.rowCounts.push(n); },
    getDatatable: async () => world.claimRow,
    markSourceStale: async () => {},
};
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: async (a, b, sql) => {
        world.queries.push(sql);
        if (/^SELECT "id" FROM/.test(sql)) return { rows: world.existingIds.map(id => ({ id })), truncated: world.snapshotTruncated };
        return { rows: [] };
    },
    batch: async (a, b, stmts) => { world.batches.push(stmts); return stmts.map(s => ({ changes: /^DELETE/.test(s.sql) ? 1 : 1 })); },
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': datatableStore,
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { synthesizeAccess: () => ({ default: 'app' }), gradeAtLeast: () => true },
    '../../datatableLimits': { assertDatatableQuota: async () => ({}) },
    './linkerAuth': { resolveLinker: async () => ({ auth: { baseUrl: 'http://nc', fetch: async () => ({}) }, userId: 'user_1' }) },
    './ncApi': {
        PAGE: 500,
        forLinker: () => ({
            getColumns: async () => world.columns,
            listRows: async (ref, { limit, offset }) => { world.listRowsCalls.push({ limit, offset }); return world.ncRows.slice(offset, offset + limit); },
        }),
    },
    './schema': { reconcileMirrorSchema: async () => ({ modelVersion: 2 }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map(), labelIndexes: new Map(), warnings: [] }) },
});
const sync = require('./sync');
test.after(() => restore());
test.beforeEach(reset);
/** Run a pass on `m`, with the claim answering that same row. */
function run(m, opts) { world.claimRow = m; return sync.syncRows(m, opts); }

test('a pass snapshots first, upserts every fetched row, deletes what Nextcloud no longer has, and records the state', async () => {
    world.existingIds = ['1', '2', '3'];
    world.ncRows = [ncRow(1, 'Acme', 10), ncRow(2, 'Bee', 20), ncRow(4, 'New', 40)];
    const out = await run(mirror(), { reason: 'manual' });
    assert.equal(out.ok, true, out.error && out.error.message);
    // snapshot before any row was fetched
    const snapAt = world.queries.findIndex(q => /^SELECT "id" FROM/.test(q));
    assert.ok(snapAt >= 0);
    assert.deepEqual(world.listRowsCalls, [{ limit: 500, offset: 0 }]);
    const upserts = world.batches[0];
    assert.equal(upserts.length, 3);
    assert.match(upserts[0].sql, /ON CONFLICT \("id"\) DO UPDATE/);
    assert.equal(upserts[0].params[0], '1');
    assert.deepEqual(upserts[2].params.slice(5, 7), ['New', 40]);
    const deletes = world.batches[1];
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].sql, /^DELETE FROM "facturen"/);
    assert.equal(deletes[0].params[0], '3');
    assert.deepEqual(world.rowCounts, [3]);
    const state = world.finished[0];
    assert.equal(state.status, 'ok');
    assert.equal(state.written, 3);
    assert.equal(state.deleted, 1);
    assert.equal(state.truncated, false);
    assert.equal(state.consecutiveErrors, 0);
    assert.ok(state.nextRunAt);
});

test('when nothing moved the counter and the version stay where they were', async () => {
    world.existingIds = ['1'];
    world.ncRows = [ncRow(1, 'Acme', 10)];
    datatableDbStore.batch = async (a, b, stmts) => { world.batches.push(stmts); return stmts.map(() => ({ changes: 0 })); };
    const out = await run(mirror({ rowCount: 1 }));
    assert.equal(out.ok, true);
    assert.deepEqual(world.rowCounts, []);
    assert.equal(world.finished[0].written, 0);
    datatableDbStore.batch = async (a, b, stmts) => { world.batches.push(stmts); return stmts.map(() => ({ changes: 1 })); };
});

test('pages through Nextcloud and chunks the upserts at 500', async () => {
    world.ncRows = Array.from({ length: 1200 }, (_, i) => ncRow(i + 1, `S${i}`, i));
    const out = await run(mirror());
    assert.equal(out.ok, true);
    assert.deepEqual(world.listRowsCalls.map(c => c.offset), [0, 500, 1000]);
    assert.deepEqual(world.batches.map(b => b.length), [500, 500, 200]);
    assert.equal(world.finished[0].rowCount, 1200);
});

test('the row cap truncates the fetch and SKIPS deletions', async () => {
    world.existingIds = ['999'];
    world.ncRows = Array.from({ length: 30 }, (_, i) => ncRow(i + 1, 'x', i));
    const out = await run(mirror({ source: { ...mirror().source, rowCap: 20 } }));
    assert.equal(out.ok, true);
    assert.equal(out.truncated, true);
    assert.equal(world.batches.some(b => /^DELETE/.test(b[0].sql)), false, 'no deletes under the cap');
    assert.equal(world.finished[0].truncated, true);
    assert.equal(world.finished[0].rowCount, 21);   // the 20 fetched + the one the snapshot still holds
});

test('a running claim elsewhere answers alreadyRunning', async () => {
    world.claimed = false;
    const out = await run(mirror());
    assert.deepEqual(out, { ok: false, alreadyRunning: true, syncState: null });
    assert.equal(world.finished.length, 0);
});

test('a Nextcloud failure lands on the state with a backoff, never throws', async () => {
    world.columns = null;
    const { NextcloudSourceError } = require('./errors');
    const stub = require.cache['stub:./ncApi'].exports;
    const orig = stub.forLinker;
    stub.forLinker = () => ({ getColumns: async () => { throw new NextcloudSourceError(403, 'nextcloud_forbidden', 'no'); } });
    const out = await run(mirror({ syncState: { consecutiveErrors: 2 } }));
    stub.forLinker = orig;
    assert.equal(out.ok, false);
    const state = world.finished[0];
    assert.equal(state.status, 'error');
    assert.equal(state.lastErrorCode, 'nextcloud_forbidden');
    assert.equal(state.consecutiveErrors, 3);
    const ok = sync.nextRunAtFor({}, Date.parse('2026-09-12T10:00:00Z'), 0);
    assert.equal(ok, '2026-09-12T10:01:00.000Z');
    // three errors in a row: 1 min × 2³ = 8 min, not the next minute
    assert.ok(Date.parse(state.nextRunAt) > Date.now() + 7 * 60_000, 'backoff widens the gap');
});

test('isStale: never refreshed, marked, or older than the schedule; never while running or when opted out', () => {
    const src = { schedule: { everyMinutes: 15 }, refreshOnView: true };
    const now = Date.parse('2026-09-12T10:00:00Z');
    assert.equal(sync.isStale(null, src, now), true);
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-12T09:59:57Z' }, src, now), false);
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-12T09:59:50Z' }, src, now), true);
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-12T09:59:00Z', staleReason: 'event' }, src, now), true);
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-12T09:00:00Z', status: 'running' }, src, now), false);
    assert.equal(sync.isStale(null, { ...src, refreshOnView: false }, now), false);
    // whatever an old row stored as its schedule, the ticker comes back in a minute
    assert.equal(sync.nextRunAtFor({ everyMinutes: 0 }, now, 0), '2026-09-12T10:01:00.000Z');
});

test('there is one schedule — live: a minute in the background, five seconds while watched', () => {
    const now = Date.parse('2026-09-13T10:00:00Z');
    assert.deepEqual(sync.scheduleOf({ schedule: { everyMinutes: 1440 } }), { everyMinutes: 1, live: true });
    assert.deepEqual(sync.scheduleOf({}), { everyMinutes: 1, live: true });
    assert.equal(sync.nextRunAtFor({ everyMinutes: 1440 }, now, 0), '2026-09-13T10:01:00.000Z');
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-13T09:59:57Z' }, {}, now), false);
    assert.equal(sync.isStale({ lastSuccessAt: '2026-09-13T09:59:54Z' }, {}, now), true);
    assert.equal(sync.LIVE_STALE_MS, 5000);
});

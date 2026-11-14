/**
 * The shared refresh pass, driven by a FAKE adapter — what the pipeline
 * promises every kind, independent of Nextcloud:
 *   • an `unchanged` answer from open() ends the pass with no snapshot, no
 *     batch and no setRowCount (data_version never moves), yet moves
 *     lastSuccessAt and carries the adapter's statePatch;
 *   • `mustFetch` is true on a forced pass, a never-succeeded copy, a stale
 *     mark, or a copy without columns — so a probe cannot skip those;
 *   • `force` re-reads, it never steals a running claim (the claim is asked
 *     with CLAIM_STALE_MS whatever the caller passes);
 *   • a row the adapter cannot identify (null) is skipped and counted;
 *   • the statePatch of a full pass rides into the finish;
 *   • the cap probe, the sweep and the backoff are the same as before.
 *
 * Run: cd server && node --test core/dataEngine/sources/mirror/syncPipeline.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const { pgDatatableEngine } = require('../../../../testUtils/pgDatatableEngine.testkit');

const SCOPE = { kind: 'org', id: 'org_1' };
const META = { id: 'tbl_s', key: 'sheet', fields: [{ id: 'fld_a', key: 'a', type: 'text' }, { id: 'fld_b', key: 'b', type: 'number' }] };
function table(over = {}) {
    return {
        id: 'tbl_s', key: 'sheet', name: 'Sheet', scope: SCOPE, scopeKind: 'org', organizationId: 'org_1',
        managedKind: 'fake_kind', rowScope: 'all', rowCount: 0, isPublished: false, sharedGroups: [], writeMode: 'grants',
        scope_kind: 'org', scope_id: 'org_1', organization_id: 'org_1', owner_user_id: 'u', is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
        source: { kind: 'fake_kind', linkedByUserId: 'u', rowCap: 10000, columnMap: { fld_a: { col: 0 }, fld_b: { col: 1 } }, relations: [] },
        syncState: null,
        ...over,
    };
}

const world = {};
/** @type {Awaited<ReturnType<typeof pgDatatableEngine>>} */
let dt;
async function reset() {
    Object.assign(world, {
        claimRow: table(), claimed: true, rows: [], columns: [{ col: 0 }, { col: 1 }],
        opens: [], pages: [], finished: [], rowCounts: [], unchanged: false, claims: [],
        statePatch: { marker: { etag: '"1"' } }, metaMissing: false, deriveChanges: [],
    });
    await dt.pg.exec('TRUNCATE "sheet"');
    dt.calls.length = 0;
}
/** Rows the copy already holds. */
const existing = async (ids) => { for (const id of ids) await dt.insert('sheet', { id, org_id: 'org_1', a: `old-${id}` }); };
const copy = async () => (await dt.rows('sheet')).map((r) => [r.id, r.a, r.b == null ? null : Number(r.b)]).sort();
const batchSizes = () => dt.calls.filter((c) => c.fn === 'batch').map((c) => c.statements);
const snapshotTaken = () => dt.calls.some((c) => c.fn === 'query');

const datatableStore = {
    claimSourceSync: async (id, opts) => { world.claims.push(opts); return world.claimed ? { ...world.claimRow, id } : null; },
    finishSourceSync: async (id, patch) => { world.finished.push(patch); return table({ syncState: patch }); },
    getTableMeta: async () => (world.metaMissing ? null : META),
    setSource: async (id, scope, source) => ({ ...world.claimRow, source }),
    setRowCount: async (id, scope, n) => { world.rowCounts.push(n); },
    getDatatable: async () => world.claimRow,
};
// The copy: the planner's table on PGlite (testUtils/pgDatatableEngine.testkit.js).
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: (o, a, sql, params) => dt.store.query(o, a, sql, params),
    batch: (o, a, stmts) => dt.store.batch(o, a, stmts),
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': datatableStore,
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { synthesizeAccess: () => ({ default: 'app' }), gradeAtLeast: () => true },
    '../../datatableLimits': { assertDatatableQuota: async () => ({}) },
    './schema': { reconcileMirrorSchema: async () => ({ modelVersion: 2 }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map(), labelIndexes: new Map(), warnings: [] }) },
});
const { makeSync } = require('./syncPipeline');
const { SourceError } = require('./errors');
test.before(async () => { dt = await pgDatatableEngine([META]); });
test.after(async () => { restore(); await dt.close(); });
test.beforeEach(reset);

const adapter = {
    KIND: 'fake_kind', TAG: '[Fake]', PAGE: 2,
    isMirror: (t) => !!t && t.managedKind === 'fake_kind',
    resolveLinker: async () => ({ auth: { token: 't' }, userId: 'u' }),
    apiFor: (auth) => ({ auth }),
    siblingsOf: async () => ({ byId: new Map() }),
    async open(api, t, opts) {
        world.opens.push(opts);
        if (world.unchanged) return { unchanged: true, statePatch: world.statePatch };
        return {
            columns: world.columns,
            page: async (limit, offset) => { world.pages.push({ limit, offset }); return world.rows.slice(offset, offset + limit); },
            statePatch: world.statePatch,
            warnings: ['opened'],
        };
    },
    deriveFields: (columns, { existingFields }) => ({
        fields: existingFields, columnMap: { fld_a: { col: 0 }, fld_b: { col: 1 } }, relations: [], warnings: [], changes: world.deriveChanges, retyped: [],
    }),
    // A raw row is [id, a, b]; a null id means "no identity" → skipped.
    rowFromSource: (raw) => (raw[0] === null ? null : { id: String(raw[0]), values: { a: raw[1], b: raw[2] } }),
};
const sync = makeSync(adapter);
function run(t, opts) { world.claimRow = t; return sync.syncRows(t, opts); }

test('a full pass: open → columns → snapshot → pages → upsert → sweep → finish, with the statePatch and the counters', async () => {
    await existing(['1', '9']);
    world.rows = [['1', 'x', 1], ['2', 'y', 2], ['3', 'z', 3]];
    const out = await run(table(), { reason: 'manual' });
    assert.equal(out.ok, true, out.error && out.error.message);
    assert.equal(world.opens[0].mustFetch, true, 'a never-succeeded copy must fetch');
    assert.equal(world.opens[0].rowCap, 10000);
    assert.ok(snapshotTaken(), 'snapshot taken');
    assert.deepEqual(world.pages, [{ limit: 2, offset: 0 }, { limit: 2, offset: 2 }], 'paged by the adapter\'s PAGE');
    assert.deepEqual(batchSizes(), [3, 1], 'three upserts, one sweep');
    assert.deepEqual(await copy(), [['1', 'x', 1], ['2', 'y', 2], ['3', 'z', 3]], 'row 1 overwritten, 9 swept');
    assert.deepEqual(world.rowCounts, [3]);
    const state = world.finished[0];
    assert.equal(state.status, 'ok');
    assert.equal(state.written, 3);
    assert.equal(state.deleted, 1);
    assert.deepEqual(state.marker, { etag: '"1"' }, 'the adapter\'s statePatch rides into the finish');
    assert.deepEqual(state.warnings, ['opened']);
    assert.equal(state.skippedRows, undefined, 'no skipped counter when nothing was skipped');
});

test('unchanged: no snapshot, no batch, no setRowCount — but lastSuccessAt moves and the patch lands', async () => {
    world.unchanged = true;
    await existing(['1']);
    world.rows = [['1', 'x', 1]];
    const out = await run(table({ rowCount: 1, syncState: { lastSuccessAt: '2026-01-01T09:00:00.000Z', truncated: false } }));
    assert.equal(out.ok, true);
    assert.equal(out.unchanged, true);
    assert.equal(world.opens[0].mustFetch, false, 'a healthy copy may be probed');
    assert.equal(snapshotTaken(), false, 'no snapshot');
    assert.deepEqual(batchSizes(), [], 'no batch');
    assert.deepEqual(await copy(), [['1', 'old-1', null]], 'the copy is untouched');
    assert.deepEqual(world.rowCounts, [], 'no counter move — data_version stays');
    const state = world.finished[0];
    assert.equal(state.status, 'ok');
    assert.equal(state.skipped, 'unchanged');
    assert.ok(state.lastSuccessAt > '2026-01-01T09:00:00.000Z');
    assert.equal(state.staleReason, null);
    assert.equal(state.consecutiveErrors, 0);
    assert.deepEqual(state.marker, { etag: '"1"' });
    assert.ok(state.nextRunAt);
});

test('mustFetch is true on a forced pass, a stale mark, and a copy without columns', async () => {
    world.rows = [['1', 'x', 1]];
    const healthy = { lastSuccessAt: '2026-09-13T09:00:00.000Z' };
    await run(table({ syncState: healthy }), { force: true });
    assert.equal(world.opens[0].mustFetch, true, 'force');
    await run(table({ syncState: { ...healthy, staleReason: 'write' } }));
    assert.equal(world.opens[1].mustFetch, true, 'staleReason');
    world.metaMissing = true;
    world.deriveChanges = ['added:a'];
    await run(table({ syncState: healthy }));
    assert.equal(world.opens[2].mustFetch, true, 'no columns yet');
    world.metaMissing = false;
    await run(table({ syncState: healthy }));
    assert.equal(world.opens[3].mustFetch, false, 'nothing says the copy is behind');
});

test('force re-reads the source but never takes over a running claim', async () => {
    world.rows = [['1', 'x', 1]];
    const healthy = { lastSuccessAt: '2026-09-13T09:00:00.000Z' };
    // The claim is asked with the ordinary staleness whatever the caller
    // passes: a pass in flight keeps its claim, and the caller gets
    // alreadyRunning — a mark + kick is its road, not a takeover.
    await run(table({ syncState: healthy }), { force: true });
    assert.equal(world.claims.length, 1);
    assert.equal(world.claims[0].staleMs, sync.CLAIM_STALE_MS, 'a forced pass claims like any other');
    assert.ok(sync.CLAIM_STALE_MS > 0, 'CLAIM_STALE_MS is a real age, not "steal now"');
    world.claimed = false;
    const out = await run(table({ syncState: { ...healthy, status: 'running' } }), { force: true, reason: 'write' });
    assert.equal(out.ok, false);
    assert.equal(out.alreadyRunning, true, 'the running pass keeps its claim');
    assert.equal(world.claims[1].staleMs, sync.CLAIM_STALE_MS);
    assert.equal(world.opens.length, 1, 'nothing was opened by the refused pass');
});

test('a row the adapter cannot identify is skipped and counted, never upserted', async () => {
    world.rows = [['1', 'x', 1], [null, 'dup', 2], ['3', 'z', 3]];
    const out = await run(table());
    assert.equal(out.ok, true);
    assert.equal(out.skippedRows, 1);
    assert.deepEqual(batchSizes(), [2]);
    assert.deepEqual(await copy(), [['1', 'x', 1], ['3', 'z', 3]]);
    assert.equal(world.finished[0].skippedRows, 1);
    assert.equal(world.finished[0].rowCount, 2);
});

test('the row cap truncates the fetch, probes once more, and SKIPS the sweep', async () => {
    await existing(['999']);
    world.rows = [['1', 'a', 1], ['2', 'b', 2], ['3', 'c', 3], ['4', 'd', 4]];
    const out = await run(table({ source: { ...table().source, rowCap: 2 } }));
    assert.equal(out.ok, true);
    assert.equal(out.truncated, true);
    assert.deepEqual(world.pages, [{ limit: 2, offset: 0 }, { limit: 1, offset: 2 }]);
    assert.deepEqual((await copy()).map((r) => r[0]), ['1', '2', '999'], 'no sweep under the cap');
    assert.equal(world.finished[0].rowCount, 3, 'the 2 fetched + the one the snapshot still holds');
});

test('a running claim elsewhere answers alreadyRunning; a source refusal lands on the state with a backoff', async () => {
    world.claimed = false;
    assert.deepEqual(await run(table()), { ok: false, alreadyRunning: true, syncState: null });
    world.claimed = true;
    const boom = new SourceError(404, 'file_gone', 'The file is gone', { errorClass: 'datatable_not_found' });
    const orig = adapter.open;
    adapter.open = async () => { throw boom; };
    const out = await run(table({ syncState: { consecutiveErrors: 2 } }));
    adapter.open = orig;
    assert.equal(out.ok, false);
    assert.equal(out.error, boom);
    const state = world.finished[0];
    assert.equal(state.status, 'error');
    assert.equal(state.lastErrorCode, 'file_gone');
    assert.equal(state.consecutiveErrors, 3);
    assert.ok(Date.parse(state.nextRunAt) > Date.now() + 7 * 60_000, 'backoff widens the gap');
});

test('the module exposes the same surface every kind\'s sync module had', async () => {
    for (const k of ['syncRows', 'isStale', 'kickStale', 'nextRunAtFor', 'scheduleOf', 'siblingsOf']) assert.equal(typeof sync[k], 'function', k);
    for (const k of ['DEFAULT_ROW_CAP', 'ENGINE_READ_CAP', 'DEFAULT_MINUTES', 'MIN_MIRROR_MINUTES', 'MAX_MIRROR_MINUTES', 'LIVE_STALE_MS', 'CLAIM_STALE_MS']) assert.equal(typeof sync[k], 'number', k);
    assert.ok(sync._kicks instanceof Map);
    await assert.rejects(() => sync.syncRows({ managedKind: 'other', source: {} }), /not a fake_kind mirror/);
    assert.throws(() => makeSync({}), /open\(\) and isMirror\(\)/);
});

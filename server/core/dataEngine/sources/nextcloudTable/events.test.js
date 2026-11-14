// @typecheck
/**
 * A push event patches the mirror(s) of its table: added/updated re-read the
 * row from Nextcloud and upsert it, deleted removes it, a VIEW mirror is
 * marked stale and kicked, and nothing here ever throws.
 *
 * The mirror's rows live in a real Postgres: the planner's table on PGlite
 * behind the datatableDbStore surface (testUtils/pgDatatableEngine.testkit.js).
 *
 * Run: cd server && node --test core/dataEngine/sources/nextcloudTable/events.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const { pgDatatableEngine } = require('../../../../testUtils/pgDatatableEngine.testkit');

const SCOPE = { kind: 'org', id: 'org_1' };
const META = { id: 'tbl_fac', key: 'facturen', fields: [{ id: 'fld_nc2txt', key: 'leverancier', type: 'text' }] };
function mirror(over = {}) {
    return {
        id: 'tbl_fac', key: 'facturen', scope: SCOPE, organizationId: 'org_1', managedKind: 'nextcloud_table', rowScope: 'all',
        scope_kind: 'org', scope_id: 'org_1', organization_id: 'org_1', owner_user_id: 'u', is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
        source: { kind: 'nextcloud_table', ncTableId: 4, ncViewId: null, linkedByUserId: 'u', columnMap: { fld_nc2txt: { ncColumnId: 2, ncType: 'text', ncSubtype: 'line' } }, relations: [] },
        syncState: { lastSuccessAt: new Date().toISOString() },
        ...over,
    };
}
const world = { mirrors: [], ncRow: null, bumps: [], stale: [], kicked: [], siblings: [] };
/** @type {Awaited<ReturnType<typeof pgDatatableEngine>>} */
let dt;
// The store object is handed out before the engine boots; its methods reach the engine at call time.
const dtStore = {
    scopeKey: (scope) => dt.store.scopeKey(scope),
    query: (o, a, sql, params) => dt.store.query(o, a, sql, params),
    exec: (o, a, sql, params) => dt.store.exec(o, a, sql, params),
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': {
        listNcMirrorsForTable: async (orgId, ncTableId) => world.mirrors.filter(m => Number(m.source.ncTableId) === ncTableId),
        getTableMeta: async () => META,
        bumpAfterWrite: async (id, scope, d) => { world.bumps.push(d); },
        markSourceStale: async (id, reason) => { world.stale.push([id, reason]); },
        getDatatable: async (id) => world.mirrors.find(m => m.id === id) || world.siblings.find(m => m.id === id) || null,
        listSourceMirrorsInScope: async () => [...world.mirrors, ...world.siblings],
    },
    '../../../../stores/datatableDbStore': dtStore,
    '../../../../auth/datatableAccess': { synthesizeAccess: () => ({ default: 'app' }) },
    './linkerAuth': { resolveLinker: async () => ({ auth: { baseUrl: 'http://nc', fetch: async () => ({}) }, userId: 'u' }) },
    './ncApi': { forLinker: () => ({ getRow: async () => { if (!world.ncRow) throw new Error('404'); return world.ncRow; } }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map(), labelIndexes: new Map(), warnings: [] }) },
    './sync': { kickStale: (t, o) => { world.kicked.push([t.id, o && o.reason]); return true; } },
    // mirror/kickStale.js reaches the same module by its own request string
    '../nextcloudTable/sync': { kickStale: (t, o) => { world.kicked.push([t.id, o && o.reason]); return true; } },
});
const events = require('./events');
test.before(async () => { dt = await pgDatatableEngine([META]); });
test.after(async () => { restore(); await dt.close(); });
test.beforeEach(async () => {
    Object.assign(world, { mirrors: [], ncRow: null, bumps: [], stale: [], kicked: [], siblings: [] });
    await dt.pg.exec('TRUNCATE "facturen"');
    dt.calls.length = 0;
});

test('added: the row is re-read from Nextcloud (the payload is partial) and upserted; a new row bumps the count', async () => {
    world.mirrors = [mirror()];
    world.ncRow = { id: 7, tableId: 4, data: [{ columnId: 2, value: 'Acme' }] };
    const out = await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.added', payload: { tableId: 4, rowId: 7, values: { 2: 'partial' } } });
    assert.deepEqual(out, { patched: 1, kicked: 0 });
    const rows = await dt.rows('facturen');
    assert.deepEqual(rows.map((r) => [r.id, r.leverancier]), [['7', 'Acme']], 'the re-read value, not the partial payload');
    assert.ok(dt.calls.every((c) => c.ownerId === 'org:org_1' && c.entityId === 'org:org_1'), 'on the mirror\'s own scope');
    assert.deepEqual(world.bumps, [1]);
});

test('updated: an existing row is overwritten in place, bumps the version but not the count', async () => {
    world.mirrors = [mirror()];
    await dt.insert('facturen', { id: '7', leverancier: 'Old', org_id: 'org_1' });
    world.ncRow = { id: 7, tableId: 4, data: [{ columnId: 2, value: 'New' }] };
    await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.updated', payload: { tableId: 4, rowId: 7 } });
    assert.deepEqual((await dt.rows('facturen')).map((r) => [r.id, r.leverancier]), [['7', 'New']]);
    assert.deepEqual(world.bumps, [0]);
});

test('deleted: the copy loses the row, and only that row', async () => {
    world.mirrors = [mirror()];
    await dt.insert('facturen', { id: '7', leverancier: 'A', org_id: 'org_1' });
    await dt.insert('facturen', { id: '8', leverancier: 'B', org_id: 'org_1' });
    const out = await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.deleted', payload: { tableId: 4, rowId: 7 } });
    assert.equal(out.patched, 1);
    assert.deepEqual((await dt.rows('facturen')).map((r) => r.id), ['8']);
    assert.deepEqual(world.bumps, [-1]);
});

test('deleting a row the copy does not have changes nothing and bumps nothing', async () => {
    world.mirrors = [mirror()];
    await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.deleted', payload: { tableId: 4, rowId: 99 } });
    assert.deepEqual(world.bumps, []);
});

test('a view mirror is marked stale and kicked instead of patched', async () => {
    world.mirrors = [mirror({ id: 'tbl_view', source: { ...mirror().source, ncViewId: 12 } })];
    const out = await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.added', payload: { tableId: 4, rowId: 7 } });
    assert.deepEqual(out, { patched: 0, kicked: 1 });
    assert.deepEqual(world.stale, [['tbl_view', 'event']]);
    assert.deepEqual(world.kicked, [['tbl_view', 'event']]);
    assert.equal(dt.calls.length, 0);
});

test('a row Nextcloud will not hand back falls back to a full refresh, never throws', async () => {
    world.mirrors = [mirror()];
    world.ncRow = null;
    const out = await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.added', payload: { tableId: 4, rowId: 7 } });
    assert.deepEqual(out, { patched: 0, kicked: 1 });
    assert.deepEqual(world.stale, [['tbl_fac', 'event']]);
});

test('a mirror whose relation points at the changed table is marked stale too', async () => {
    world.mirrors = [mirror()];
    world.siblings = [mirror({ id: 'tbl_inv', source: { ...mirror().source, ncTableId: 5, relations: [{ kind: 'match', targetDatatableId: 'tbl_fac' }] } })];
    world.ncRow = { id: 7, tableId: 4, data: [] };
    await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.updated', payload: { tableId: 4, rowId: 7 } });
    assert.ok(world.stale.some(([id, r]) => id === 'tbl_inv' && r === 'relations'));
});

test('an unknown table, an unknown event or a missing org is a no-op', async () => {
    world.mirrors = [mirror()];
    assert.deepEqual(await events.onTablesEvent({ orgId: 'org_1', event: 'tables.row.added', payload: { tableId: 99, rowId: 1 } }), { patched: 0, kicked: 0 });
    assert.deepEqual(await events.onTablesEvent({ orgId: 'org_1', event: 'talk.message', payload: { tableId: 4 } }), { patched: 0, kicked: 0 });
    assert.deepEqual(await events.onTablesEvent({ orgId: null, event: 'tables.row.added', payload: { tableId: 4 } }), { patched: 0, kicked: 0 });
});

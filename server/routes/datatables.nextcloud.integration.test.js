'use strict';

/**
 * A NEXTCLOUD MIRROR, END TO END, against a REAL Postgres.
 *
 * The same harness as routes/datatables.integration.test.js (pglite, the
 * genuine store/engine/planner/compiler, handlers invoked off the route
 * stack) with Nextcloud replaced by an in-memory Tables API: link a table →
 * the physical table gets Nextcloud's columns; the first refresh copies the
 * rows under Nextcloud's ids; a schema save is refused; a row added here
 * lands in Nextcloud first; a stale token is a conflict without a Nextcloud
 * call; a rename in Nextcloud keeps the key; a declared relation fills its
 * `_ref` column; a push event patches one row; an idle refresh moves nothing.
 *
 * Run: cd server && node --test routes/datatables.nextcloud.integration.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.resolve(__dirname, '..');
const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const command = fields.length > 0 ? 'SELECT' : String(sql).trim().split(/\s+/)[0].toUpperCase();
    const rowCount = fields.length > 0 ? rows.length : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adaptResult(await pg.exec(sql), sql);
    return adaptResult(await pg.query(sql), sql);
}
const client = { query: (sql, params) => rawQuery(sql, params), release: () => {} };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock(path.join(SERVER, 'db.js'), {
    pool: { query: rawQuery, connect: async () => client },
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql, []),
    getClient: async () => client,
    withTransaction: async (fn) => {
        await client.query('BEGIN');
        try { const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) { try { await client.query('ROLLBACK'); } catch { /* */ } throw e; }
    },
    makeStoreInit: (tag, schemaFn) => {
        let promise = null;
        return function ensureInit() {
            if (!promise) promise = Promise.resolve().then(schemaFn).catch((err) => { promise = null; throw err; });
            return promise;
        };
    },
    getRedis: () => null, redisHealthy: () => false,
    isSqlStateError: (e) => typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code),
});

const ORG = 'org-nc-a';
const OWNER = 'u-linker';
const USERS = { [OWNER]: { id: OWNER, organizationId: ORG, orgRole: 'member', groups: [], provider: 'nextcloud_connector', nc_uid: 'admin' } };
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => USERS[id] || null,
    getAllGroups: async () => [],
    getOrganization: async () => ({ id: ORG, nc_instance_id: 'inst_1' }),
});
mock(path.join(SERVER, 'stores/projectStore'), {});
const pass = () => (req, res, next) => next();
mock(path.join(SERVER, 'auth'), {
    requirePermission: pass, requireActiveOrgForMutations: pass,
    assertUserCanUseOrg: async () => true, validateSharedGroupsForOrg: async (_r, g) => g || [],
    hasPermission: async () => true, Permissions: { MANAGE_DATATABLES: 'manage_datatables' },
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { requireBetaFeature: pass });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: pass });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: pass });

// ── The fake Nextcloud Tables app ───────────────────────────────────────────
const NC = {
    tables: new Map(),   // id → { id, title, emoji, columns:[], rows: Map<id, {colId: value}> , nextRow }
    calls: [],
};
function ncTable(id, title, columns) {
    NC.tables.set(id, { id, title, emoji: null, columns, rows: new Map(), nextRow: 1, views: [] });
    return NC.tables.get(id);
}
function ncAddRow(tableId, data) {
    const t = NC.tables.get(tableId);
    const id = t.nextRow++;
    t.rows.set(id, { ...data });
    return id;
}
function ncRow(t, id) {
    return { id, tableId: t.id, data: Object.entries(t.rows.get(id)).map(([columnId, value]) => ({ columnId: Number(columnId), value })) };
}
function refTable(ref) {
    const t = NC.tables.get(Number(ref.tableId));
    if (!t) { const e = new Error('no table'); e.status = 404; e.code = 'nextcloud_not_found'; e.safe = true; throw e; }
    return t;
}
const fakeApi = {
    listTables: async () => [...NC.tables.values()].map(t => ({ id: t.id, title: t.title, emoji: t.emoji, rowsCount: t.rows.size, columnsCount: t.columns.length, views: t.views })),
    getTable: async (id) => { const t = refTable({ tableId: id }); return { id: t.id, title: t.title, emoji: t.emoji }; },
    getView: async () => { throw new Error('no views here'); },
    getColumns: async (ref) => refTable(ref).columns.map(c => ({ selectionOptions: [], customSettings: {}, subtype: '', mandatory: false, orderWeight: 0, ...c })),
    listRows: async (ref, { limit, offset }) => { NC.calls.push(['listRows', ref.tableId, offset]); const t = refTable(ref); return [...t.rows.keys()].slice(offset, offset + limit).map(id => ncRow(t, id)); },
    getRow: async (rowId) => { for (const t of NC.tables.values()) if (t.rows.has(Number(rowId))) return ncRow(t, Number(rowId)); const e = new Error('gone'); e.status = 404; e.code = 'nextcloud_not_found'; e.safe = true; throw e; },
    createRow: async (ref, pairs) => { NC.calls.push(['createRow', ref.tableId, pairs]); const t = refTable(ref); const id = ncAddRow(t.id, Object.fromEntries(pairs.map(p => [p.columnId, p.value]))); return ncRow(t, id); },
    updateRow: async (rowId, pairs) => { NC.calls.push(['updateRow', rowId, pairs]); for (const t of NC.tables.values()) if (t.rows.has(Number(rowId))) { for (const p of pairs) t.rows.get(Number(rowId))[p.columnId] = p.value; return ncRow(t, Number(rowId)); } const e = new Error('gone'); e.status = 404; e.code = 'nextcloud_not_found'; e.safe = true; e.name = 'NextcloudSourceError'; throw e; },
    deleteRow: async (rowId) => { NC.calls.push(['deleteRow', rowId]); for (const t of NC.tables.values()) t.rows.delete(Number(rowId)); return {}; },
};
mock(path.join(SERVER, 'core/dataEngine/sources/nextcloudTable/ncApi.js'), { forLinker: () => fakeApi, PAGE: 500, mapTable: (t) => t });
mock(path.join(SERVER, 'core/dataEngine/sources/nextcloudTable/linkerAuth.js'), { resolveLinker: async () => ({ auth: { baseUrl: 'http://nc', fetch: async () => ({}) }, userId: OWNER, session: {} }), forget: () => {} });
mock(path.join(SERVER, 'integrations/nextcloudClient'), { resolveAuth: async () => ({ baseUrl: 'http://nc', fetch: async () => ({}) }), resolveNcBinding: async () => ({ orgId: ORG, ncUid: 'admin' }) });
mock(path.join(SERVER, 'core/integrations/ncScopeGuard'), { guardedNcCall: async (tool, args, ctx, run) => run(), checkToolCall: async () => null });
mock(path.join(SERVER, 'auth/ncAudience'), { isNcOrg: async () => true });
mock(path.join(SERVER, 'core/integrations/integrationTools'), { isIntegrationPermittedForUser: async () => true });
mock(path.join(SERVER, 'jobs/kbSourceRefresh'), { onDatatableChanged: () => {} });
mock(path.join(SERVER, 'core/webpages/webpageShareReconciler'), { onDatatableChanged: () => {} });

const router = require('./datatables');
const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');
require('../core/dataEngine/sources/nextcloudTable/sync');
const events = require('../core/dataEngine/sources/nextcloudTable/events');
const schemaOf = (orgId) => datatableDbStore.schemaNameFor('org', orgId);
const SC = datatableStore.orgScope(ORG);

function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route.stack.map(l => l.handle);
        // the mounted /nextcloud sub-router
        if (!layer.route && layer.handle && layer.handle.stack && routePath.startsWith('/nextcloud')) {
            for (const sub of layer.handle.stack) {
                if (sub.route && `/nextcloud${sub.route.path}` === routePath && sub.route.methods[method]) return sub.route.stack.map(l => l.handle);
            }
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
async function call(method, routePath, req) {
    const res = { statusCode: 200, body: null, sent: false, headers: {}, text: '' };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; return res; };
    res.setHeader = () => res; res.write = () => true; res.end = () => { res.sent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        await handle(full, res, () => { advanced = true; });
        if (res.sent || !advanced) break;
    }
    return res;
}
const as = (userId, over = {}) => ({ session: { user: { id: userId } }, ...over });
async function realRows(key) { return (await rawQuery(`SELECT * FROM "${schemaOf(ORG)}"."${key}" ORDER BY "id"`)).rows; }
const tick = () => new Promise(r => setImmediate(() => setTimeout(r, 20)));
async function settled(id) {
    for (let i = 0; i < 50; i += 1) {
        const t = await datatableStore.getDatatable(id, SC);
        if (t && t.syncState && t.syncState.status && t.syncState.status !== 'running') return t;
        await tick();
    }
    throw new Error('sync never settled');
}

let facturenId = null;
let leveranciersId = null;

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await datatableStore.initDB();
    await pg.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, definition_json JSONB, last_run_at TIMESTAMPTZ)`);
    ncTable(4, 'Facturen', [
        { id: 1, title: 'Datum', type: 'datetime', subtype: 'date' },
        { id: 2, title: 'Leverancier', type: 'text', subtype: 'line' },
        { id: 3, title: 'Factuurnummer', type: 'text', subtype: 'line' },
        { id: 6, title: 'Totaal', type: 'number' },
    ]);
    ncAddRow(4, { 1: '2026-09-12', 2: 'Acme', 3: 'F-1', 6: 121 });
    ncAddRow(4, { 1: '2026-09-13', 2: 'Bee', 3: 'F-2', 6: 50 });
    ncTable(6, 'Leveranciers', [{ id: 20, title: 'Naam', type: 'text', subtype: 'line' }, { id: 21, title: 'Stad', type: 'text', subtype: 'line' }]);
    ncAddRow(6, { 20: 'Acme', 21: 'Delft' });
});
after(async () => { await pg.close(); });

test('GET /nextcloud/linkable lists the tables the caller can see', async () => {
    const res = await call('get', '/nextcloud/linkable', as(OWNER));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.connected, true);
    assert.deepStrictEqual(res.body.tables.map(t => [t.ncTableId, t.title, t.rowsCount, t.linkedAs]), [[4, 'Facturen', 2, []], [6, 'Leveranciers', 1, []]]);
});

test('POST /nextcloud/link creates the mirror with Nextcloud\'s columns and copies the rows under Nextcloud\'s ids', async () => {
    const res = await call('post', '/nextcloud/link', as(OWNER, { body: { scope: 'organisation', tables: [{ ncTableId: 4, name: 'Facturen', key: 'facturen' }] } }));
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    const dt = res.body.datatables[0];
    facturenId = dt.id;
    assert.strictEqual(dt.managedKind, 'nextcloud_table');
    assert.strictEqual(dt.source.ncTableId, 4);
    assert.strictEqual(dt.source.linkedByUserId, OWNER);
    assert.strictEqual(dt.source.columnMap, undefined, 'the column map stays server-side');

    const cols = await rawQuery(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'facturen' ORDER BY ordinal_position`, [schemaOf(ORG)]);
    assert.deepStrictEqual(cols.rows.map(r => r.column_name), ['id', 'created_at', 'updated_at', 'created_by', 'org_id', 'datum', 'leverancier', 'factuurnummer', 'totaal']);

    const settledT = await settled(facturenId);
    assert.strictEqual(settledT.syncState.status, 'ok', JSON.stringify(settledT.syncState));
    assert.strictEqual(settledT.syncState.written, 2);
    assert.strictEqual(settledT.rowCount, 2);
    const rows = await realRows('facturen');
    assert.deepStrictEqual(rows.map(r => [r.id, r.leverancier, Number(r.totaal)]), [['1', 'Acme', 121], ['2', 'Bee', 50]]);
    // pglite hands DATE back as a Date; the API answers the ISO day.
    assert.strictEqual(new Date(rows[0].datum).toISOString().slice(0, 10), '2026-09-12');
});

test('linking the same table again is refused as already_linked', async () => {
    const res = await call('post', '/nextcloud/link', as(OWNER, { body: { tables: [{ ncTableId: 4, key: 'again' }] } }));
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'already_linked');
    assert.strictEqual(res.body.datatableId, facturenId);
});

test('an idle refresh writes nothing and leaves updated_at alone', async () => {
    const before = (await realRows('facturen')).map(r => String(r.updated_at));
    const res = await call('post', '/:id/nextcloud/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.sync.written, 0);
    assert.strictEqual(res.body.sync.deleted, 0);
    assert.deepStrictEqual((await realRows('facturen')).map(r => String(r.updated_at)), before);
});

test('PUT /:id/schema is refused outright; PATCH retentionDays too', async () => {
    const schema = await call('put', '/:id/schema', as(OWNER, { params: { id: facturenId }, body: { fields: [], expectedVersion: 1 } }));
    assert.strictEqual(schema.statusCode, 409);
    assert.strictEqual(schema.body.code, 'schema_from_source');
    const patch = await call('patch', '/:id', as(OWNER, { params: { id: facturenId }, body: { retentionDays: 30, retentionField: 'datum' } }));
    assert.strictEqual(patch.statusCode, 400);
    assert.strictEqual(patch.body.code, 'mirror_no_retention');
    const own = await call('patch', '/:id', as(OWNER, { params: { id: facturenId }, body: { rowScope: 'own' } }));
    assert.strictEqual(own.body.code, 'mirror_row_scope');
    const name = await call('patch', '/:id', as(OWNER, { params: { id: facturenId }, body: { name: 'Invoices' } }));
    assert.strictEqual(name.statusCode, 200);
});

test('POST /:id/rows goes to Nextcloud first and lands in the copy under Nextcloud\'s row id', async () => {
    NC.calls.length = 0;
    const res = await call('post', '/:id/rows', as(OWNER, { params: { id: facturenId }, body: { values: { leverancier: 'Cee', totaal: '7', datum: '2026-09-14' } } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.id, '3');
    assert.deepStrictEqual(NC.calls[0][0], 'createRow');
    assert.deepStrictEqual(NC.calls[0][2], [{ columnId: 2, value: 'Cee' }, { columnId: 6, value: 7 }, { columnId: 1, value: '2026-09-14' }]);
    const rows = await realRows('facturen');
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[2].leverancier, 'Cee');
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).rowCount, 3);
});

test('PUT /:id/rows/:rowId: a stale token is a 409 with no Nextcloud call; a fresh one writes through', async () => {
    NC.calls.length = 0;
    const stale = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' }, body: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', values: { totaal: 9 } } }));
    assert.strictEqual(stale.statusCode, 409);
    assert.strictEqual(stale.body.code, 'row_conflict');
    assert.strictEqual(NC.calls.length, 0);

    const current = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' } }))).body.row;
    const fresh = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' }, body: { expectedUpdatedAt: new Date(current.updated_at).toISOString(), values: { totaal: 9 } } }));
    assert.strictEqual(fresh.statusCode, 200, JSON.stringify(fresh.body));
    assert.strictEqual(Number(fresh.body.row.totaal), 9);
    assert.deepStrictEqual(NC.calls[0], ['updateRow', 3, [{ columnId: 6, value: 9 }]]);
    assert.strictEqual(NC.tables.get(4).rows.get(3)[6], 9);
});

test('a rejected value is a 422 naming the column, and nothing changed on either side', async () => {
    const current = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' } }))).body.row;
    const res = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' }, body: { expectedUpdatedAt: new Date(current.updated_at).toISOString(), values: { totaal: 'abc' } } }));
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.code, 'nextcloud_rejected');
    assert.match(res.body.error, /Totaal/);
    assert.strictEqual(NC.tables.get(4).rows.get(3)[6], 9);
});

test('DELETE /:id/rows/:rowId removes the row on both sides', async () => {
    const res = await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(NC.tables.get(4).rows.has(3), false);
    assert.strictEqual((await realRows('facturen')).length, 2);
    const again = await call('delete', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '3' } }));
    assert.strictEqual(again.statusCode, 404);
});

test('a column renamed in Nextcloud keeps its key and id; a column added arrives; a retype swaps the column under the same key', async () => {
    const t = NC.tables.get(4);
    t.columns.find(c => c.id === 2).title = 'Supplier';
    t.columns.push({ id: 7, title: 'Btw', type: 'number' });
    for (const r of t.rows.values()) r[7] = 21;
    await call('post', '/:id/nextcloud/refresh', as(OWNER, { params: { id: facturenId } }));
    let schema = (await call('get', '/:id/schema', as(OWNER, { params: { id: facturenId } }))).body.fields;
    assert.deepStrictEqual(schema.find(f => f.id === 'fld_nc2txt') && [schema.find(f => f.id === 'fld_nc2txt').key, schema.find(f => f.id === 'fld_nc2txt').name], ['leverancier', 'Supplier']);
    assert.ok(schema.some(f => f.key === 'btw' && f.type === 'number'));
    assert.strictEqual(Number((await realRows('facturen'))[0].btw), 21);

    t.columns.find(c => c.id === 6).type = 'text';
    for (const r of t.rows.values()) r[6] = String(r[6]);
    const res = await call('post', '/:id/nextcloud/refresh', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
    schema = (await call('get', '/:id/schema', as(OWNER, { params: { id: facturenId } }))).body.fields;
    const tot = schema.find(f => f.key === 'totaal');
    assert.strictEqual(tot.id, 'fld_nc6txt');
    assert.strictEqual(tot.type, 'text');
    const col = await rawQuery(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'facturen' AND column_name = 'totaal'`, [schemaOf(ORG)]);
    assert.strictEqual(col.rows[0].data_type, 'text');
    assert.strictEqual((await realRows('facturen'))[0].totaal, '121');
});

test('a second table linked with a declared relation gets a filled _ref column', async () => {
    const res = await call('post', '/nextcloud/link', as(OWNER, {
        body: {
            tables: [{ ncTableId: 6, name: 'Leveranciers', key: 'leveranciers' }],
            relations: [{ from: { ncTableId: 4, ncColumnId: 2 }, to: { ncTableId: 6, ncColumnId: 20 } }],
        },
    }));
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    leveranciersId = res.body.datatables[0].id;
    await settled(leveranciersId);
    // The relation lives on Facturen (the FROM side), which was linked earlier:
    // declare it there now that both exist.
    const lev = await datatableStore.getDatatable(leveranciersId, SC);
    const levMeta = await datatableStore.getTableMeta(SC, leveranciersId);
    const naam = levMeta.fields.find(f => f.key === 'naam');
    const rel = await call('put', '/:id/nextcloud/relations', as(OWNER, {
        params: { id: facturenId },
        body: { relations: [{ targetDatatableId: lev.id, localFieldId: 'fld_nc2txt', targetFieldId: naam.id }] },
    }));
    assert.strictEqual(rel.statusCode, 200, JSON.stringify(rel.body));
    assert.deepStrictEqual(rel.body.datatable.source.relations.map(r => r.kind), ['match']);
    await call('post', '/:id/nextcloud/refresh', as(OWNER, { params: { id: facturenId } }));
    const rows = await realRows('facturen');
    const acme = rows.find(r => r.leverancier === 'Acme');
    const bee = rows.find(r => r.leverancier === 'Bee');
    assert.strictEqual(acme.leveranciers_ref, '1', 'Acme matches supplier row 1');
    assert.strictEqual(bee.leveranciers_ref, null, 'Bee has no supplier');
    const schema = (await call('get', '/:id/schema', as(OWNER, { params: { id: facturenId } }))).body.fields;
    const ref = schema.find(f => f.key === 'leveranciers_ref');
    assert.strictEqual(ref.type, 'relation');
    assert.deepStrictEqual(ref.relation, { table: leveranciersId, fk: false });
    // a derived column cannot be written directly
    const cur = (await call('get', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '2' } }))).body.row;
    const w = await call('put', '/:id/rows/:rowId', as(OWNER, { params: { id: facturenId, rowId: '2' }, body: { expectedUpdatedAt: new Date(cur.updated_at).toISOString(), values: { leveranciers_ref: '1' } } }));
    assert.strictEqual(w.statusCode, 400);
    assert.strictEqual(w.body.code, 'derived_column');
});

test('a push event patches one row without a full pass', async () => {
    const id = ncAddRow(4, { 1: '2026-09-20', 2: 'Dee', 3: 'F-9', 6: '5', 7: 1 });
    NC.calls.length = 0;
    const out = await events.onTablesEvent({ orgId: ORG, event: 'tables.row.added', payload: { tableId: 4, rowId: id, values: { 2: 'partial' } } });
    assert.deepStrictEqual(out, { patched: 1, kicked: 0 });
    assert.strictEqual(NC.calls.some(c => c[0] === 'listRows'), false, 'no full pass');
    const rows = await realRows('facturen');
    assert.ok(rows.some(r => r.id === String(id) && r.leverancier === 'Dee'));
    NC.tables.get(4).rows.delete(id);   // Nextcloud deleted it, and says so
    const del = await events.onTablesEvent({ orgId: ORG, event: 'tables.row.deleted', payload: { tableId: 4, rowId: id } });
    assert.strictEqual(del.patched, 1);
    assert.strictEqual((await realRows('facturen')).some(r => r.id === String(id)), false);
});

test('the sync sweeps rows Nextcloud no longer has', async () => {
    NC.tables.get(4).rows.delete(2);
    await call('post', '/:id/nextcloud/refresh', as(OWNER, { params: { id: facturenId } }));
    const rows = await realRows('facturen');
    assert.deepStrictEqual(rows.map(r => r.id), ['1']);
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).rowCount, 1);
});

test('the ticker sees a mirror that is due, and the claim keeps a second pass out', async () => {
    await datatableStore.finishNcSync(facturenId, { nextRunAt: '2000-01-01T00:00:00.000Z', status: 'ok' });
    const due = await datatableStore.listDueNcSyncs(10);
    assert.ok(due.some(t => t.id === facturenId));
    const claimed = await datatableStore.claimNcSync(facturenId);
    assert.strictEqual(claimed.syncState.status, 'running');
    assert.strictEqual(await datatableStore.claimNcSync(facturenId), null);
    assert.ok((await datatableStore.claimNcSync(facturenId, { staleMs: 0 })), 'a stale claim can be taken over');
    await datatableStore.finishNcSync(facturenId, { status: 'ok' });
    assert.strictEqual((await datatableStore.getDatatable(facturenId, SC)).syncState.startedAt, undefined);
});

test('DELETE /:id unlinks the mirror and leaves Nextcloud untouched', async () => {
    const before = NC.tables.get(4).rows.size;
    const res = await call('delete', '/:id', as(OWNER, { params: { id: facturenId } }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(NC.tables.get(4).rows.size, before);
    assert.strictEqual(await datatableStore.getDatatable(facturenId, SC), null);
});

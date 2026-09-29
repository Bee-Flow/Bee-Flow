/**
 * Write-through: Nextcloud first, the copy from its answer; the caller's own
 * rights probe the copy BEFORE Nextcloud is asked; a refusal changes nothing
 * on either side and carries status/code/errorClass/safe.
 *
 * Nextcloud is a fake `fetch` (the integrations/nextcloudTablesTools.test.js
 * idiom) behind the real ncApi, so the wire shape is asserted for real: an
 * OBJECT keyed by column id, option labels as numeric ids.
 *
 * Run: cd server && node --test core/dataEngine/sources/nextcloudTable/writeThrough.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const SCOPE = { kind: 'org', id: 'org_1' };
const OPTS = [{ id: 0, label: 'open' }, { id: 1, label: 'betaald' }];
const META = {
    id: 'tbl_fac', key: 'facturen',
    access: { default: 'app' },
    fields: [
        { id: 'fld_nc2txt', key: 'leverancier', type: 'text' },
        { id: 'fld_nc6num', key: 'totaal', type: 'number' },
        { id: 'fld_nc7sel', key: 'status', type: 'select', options: ['open', 'betaald'] },
        { id: 'fld_ncrelabc', key: 'leveranciers_ref', type: 'relation', derived: true },
    ],
};
const TABLE = {
    id: 'tbl_fac', key: 'facturen', name: 'Facturen', scope: SCOPE, organizationId: 'org_1', managedKind: 'nextcloud_table',
    rowScope: 'all', scope_kind: 'org', scope_id: 'org_1', organization_id: 'org_1', owner_user_id: 'user_1',
    is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
    source: {
        kind: 'nextcloud_table', ncTableId: 4, ncViewId: null, linkedByUserId: 'user_1',
        columnMap: {
            fld_nc2txt: { ncColumnId: 2, ncType: 'text', ncSubtype: 'line', title: 'Leverancier' },
            fld_nc6num: { ncColumnId: 6, ncType: 'number', title: 'Totaal' },
            fld_nc7sel: { ncColumnId: 7, ncType: 'selection', ncSubtype: '', title: 'Status', options: OPTS },
            fld_ncrelabc: { derived: 'match', localFieldId: 'fld_nc2txt', targetFieldId: 'x' },
        },
        relations: [],
    },
};

// ── the fake Nextcloud ─────────────────────────────────────────────────────
const nc = { calls: [], rows: new Map(), status: 200 };
function ncRowFor(id, data) {
    return { id, tableId: 4, data: Object.entries(data).map(([columnId, value]) => ({ columnId: Number(columnId), value })) };
}
async function fakeFetch(url, init = {}) {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    nc.calls.push({ method, url: url.replace('http://nc/index.php/apps/tables/api/1', ''), body });
    if (nc.status !== 200) return { ok: false, status: nc.status, text: async () => JSON.stringify({ message: 'nope' }) };
    if (method === 'POST') { const id = 100 + nc.rows.size; nc.rows.set(id, body.data); return { ok: true, status: 200, text: async () => JSON.stringify(ncRowFor(id, body.data)) }; }
    const m = /\/rows\/(\d+)$/.exec(url);
    const id = m ? Number(m[1]) : null;
    if (method === 'PUT') {
        if (!nc.rows.has(id)) return { ok: false, status: 404, text: async () => '' };
        nc.rows.set(id, { ...nc.rows.get(id), ...body.data });
        return { ok: true, status: 200, text: async () => JSON.stringify(ncRowFor(id, nc.rows.get(id))) };
    }
    if (method === 'DELETE') { nc.rows.delete(id); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(ncRowFor(id, nc.rows.get(id) || {})) };
}

// ── the fake copy ──────────────────────────────────────────────────────────
const db = { rows: new Map(), execs: [], bumps: [] };
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: async (a, b, sql, params) => {
        if (/^SELECT \* FROM "facturen" WHERE "id" = \?/.test(sql)) {
            const row = db.rows.get(params[0]);
            return { rows: row ? [row] : [] };
        }
        return { rows: [] };
    },
    exec: async (a, b, sql, params) => {
        db.execs.push({ sql, params });
        if (/^INSERT INTO/.test(sql)) { db.rows.set(params[0], { id: params[0], updated_at: params[2] }); return { changes: 1 }; }
        if (/^UPDATE/.test(sql)) { const id = params[params.length - 2]; if (db.rows.has(id)) { db.rows.set(id, { ...db.rows.get(id), updated_at: params[0] }); return { changes: 1 }; } return { changes: 0 }; }
        if (/^DELETE/.test(sql)) { const had = db.rows.delete(params[0]); return { changes: had ? 1 : 0 }; }
        return { changes: 0 };
    },
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': { bumpAfterWrite: async (id, scope, d) => { db.bumps.push(d); } },
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { gradeAtLeast: (g, min) => (g === 'owner' || g === 'editor' || min === 'viewer') },
    './linkerAuth': { resolveLinker: async () => ({ auth: { baseUrl: 'http://nc', fetch: fakeFetch }, userId: 'user_1' }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map([['fld_ncrelabc', new Map([['Acme', '40']])]]), labelIndexes: new Map(), warnings: [] }) },
});
const wt = require('./writeThrough');
test.after(() => restore());
test.beforeEach(() => { nc.calls.length = 0; nc.rows.clear(); nc.status = 200; db.rows.clear(); db.execs.length = 0; db.bumps.length = 0; });

const ctx = () => wt.contextOf({ table: TABLE, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: META, grade: 'editor', viewerId: 'user_9' });

test('insert: the wire body is an object keyed by column id with labels as ids; the copy takes Nextcloud\'s row id', async () => {
    const r = await wt.insertRow(ctx(), { leverancier: 'Acme', totaal: '121', status: 'betaald', id: 'ignored' });
    assert.deepEqual(nc.calls[0], { method: 'POST', url: '/tables/4/rows', body: { data: { 2: 'Acme', 6: 121, 7: 1 } } });
    assert.equal(r.id, '100');
    assert.match(db.execs[0].sql, /^INSERT INTO "facturen"/);
    assert.equal(db.execs[0].params[0], '100');
    assert.equal(db.execs[0].params[3], 'user_9');                  // created_by is the editor
    assert.ok(db.execs[0].params.includes('40'), 'the derived relation was filled from the index');
    assert.deepEqual(db.bumps, [1]);
    assert.ok(r.row && r.row.id === '100');
});

test('insert: a derived column is refused before Nextcloud is asked', async () => {
    await assert.rejects(() => wt.insertRow(ctx(), { leveranciers_ref: '40' }), (e) => e.status === 400 && e.code === 'derived_column' && e.safe);
    await assert.rejects(() => wt.insertRow(ctx(), { nope: 1 }), /unknown field: nope/);
    assert.equal(nc.calls.length, 0);
});

test('insert: a viewer is refused; Nextcloud 403 is a 403 with errorClass and nothing written', async () => {
    await assert.rejects(() => wt.insertRow({ ...ctx(), grade: 'viewer' }, { leverancier: 'x' }), (e) => e.status === 403);
    nc.status = 403;
    await assert.rejects(() => wt.insertRow(ctx(), { leverancier: 'x' }),
        (e) => e.status === 403 && e.code === 'nextcloud_forbidden' && e.errorClass === 'datatable_forbidden' && e.safe === true);
    assert.equal(db.execs.length, 0);
    assert.deepEqual(db.bumps, []);
});

test('update: the copy is probed first — not there → 0/null, stale token → 0/row — without a Nextcloud call', async () => {
    assert.deepEqual(await wt.updateRow(ctx(), '5', { leverancier: 'x' }), { changes: 0, row: null });
    db.rows.set('5', { id: '5', updated_at: '2026-09-12T10:00:00.000Z' });
    const stale = await wt.updateRow(ctx(), '5', { leverancier: 'x' }, { expectedUpdatedAt: '2026-09-12T09:00:00.000Z' });
    assert.equal(stale.changes, 0);
    assert.equal(stale.row.id, '5');
    assert.equal(nc.calls.length, 0);
});

test('update: a matching token goes to Nextcloud by row id, then the copy is rewritten from the answer', async () => {
    db.rows.set('5', { id: '5', updated_at: '2026-09-12T10:00:00.000Z' });
    nc.rows.set(5, { 2: 'Old', 6: 1 });
    const r = await wt.updateRow(ctx(), '5', { totaal: 9 }, { expectedUpdatedAt: '2026-09-12T10:00:00Z' });
    assert.deepEqual(nc.calls[0], { method: 'PUT', url: '/rows/5', body: { data: { 6: 9 } } });
    assert.equal(r.changes, 1);
    assert.match(db.execs[0].sql, /^UPDATE "facturen"/);
    assert.deepEqual(db.bumps, [0]);
});

test('update: a row Nextcloud no longer has leaves the copy too', async () => {
    db.rows.set('5', { id: '5', updated_at: 'x' });
    const r = await wt.updateRow(ctx(), '5', { totaal: 9 });
    assert.deepEqual(r, { changes: 0, row: null });
    assert.equal(db.rows.has('5'), false);
    assert.deepEqual(db.bumps, [-1]);
});

test('delete: probe, then Nextcloud, then the copy; already-gone in Nextcloud still counts', async () => {
    assert.deepEqual(await wt.deleteRow(ctx(), '5'), { changes: 0 });
    db.rows.set('5', { id: '5' });
    const r = await wt.deleteRow(ctx(), '5');     // not in nc.rows → DELETE answers 200 anyway here
    assert.deepEqual(r, { changes: 1 });
    assert.deepEqual(nc.calls.map(c => c.method), ['DELETE']);
    assert.deepEqual(db.bumps, [-1]);
});

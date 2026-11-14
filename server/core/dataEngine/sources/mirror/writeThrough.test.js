/**
 * The shared write-through, driven by a FAKE adapter — the contract every
 * kind gets without knowing Nextcloud:
 *   • the copy is probed with the CALLER's filter first: not there → 0/null,
 *     stale token → 0/row, and the source is never asked;
 *   • a viewer is refused with the kind's own forbidden code;
 *   • a not-found code from the source deletes the local copy;
 *   • the batch forms use the adapter's many-calls when it has them (ONE
 *     source write for the list) and the per-row loop when it has not, and
 *     `collect` reports per-index errors, stopping only when the source is
 *     unreachable.
 * The copy is a real Postgres table (the planner's, on PGlite, behind the
 * datatableDbStore surface of testUtils/pgDatatableEngine.testkit.js).
 *
 * Run: cd server && node --test core/dataEngine/sources/mirror/writeThrough.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const { pgDatatableEngine } = require('../../../../testUtils/pgDatatableEngine.testkit');

const SCOPE = { kind: 'org', id: 'org_1' };
const META = {
    id: 'tbl_s', key: 'sheet', access: { default: 'app' },
    fields: [{ id: 'fld_a', key: 'a', type: 'text' }, { id: 'fld_b', key: 'b', type: 'number' }],
};
const TABLE = {
    id: 'tbl_s', key: 'sheet', name: 'Sheet', scope: SCOPE, organizationId: 'org_1', managedKind: 'fake_kind',
    rowScope: 'all', scope_kind: 'org', scope_id: 'org_1', organization_id: 'org_1', owner_user_id: 'u',
    is_published: false, shared_groups: [], write_mode: 'grants', row_scope: 'all',
    source: { kind: 'fake_kind', linkedByUserId: 'u', columnMap: { fld_a: { col: 0 }, fld_b: { col: 1 } }, relations: [] },
};

// ── the copy: the planner's table on PGlite (testUtils/pgDatatableEngine.testkit.js) ──
const db = { bumps: [] };
/** @type {Awaited<ReturnType<typeof pgDatatableEngine>>} */
let dt;
// Handed out before the engine boots; the methods reach it at call time.
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: (o, a, sql, params) => dt.store.query(o, a, sql, params),
    exec: (o, a, sql, params) => dt.store.exec(o, a, sql, params),
    batch: (o, a, stmts) => dt.store.batch(o, a, stmts),
};
/** Put a row in the copy (or move its token). */
const setCopy = (id, updatedAt = '2026-09-12T10:00:00.000Z') => dt.pg.query(
    `INSERT INTO "sheet" (id, org_id, updated_at) VALUES ($1, 'org_1', $2) ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`, [id, updatedAt]);
const inCopy = async (id) => (await dt.pg.query('SELECT 1 FROM "sheet" WHERE id = $1', [id])).rows.length > 0;
const copyRow = async (id) => (await dt.pg.query('SELECT * FROM "sheet" WHERE id = $1', [id])).rows[0];
const batches = () => dt.calls.filter((c) => c.fn === 'batch').length;
const restore = installResolveStub({
    '../../../../stores/datatableStore': { bumpAfterWrite: async (id, scope, d) => { db.bumps.push(d); } },
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { gradeAtLeast: (g, min) => (g === 'owner' || g === 'editor' || min === 'viewer') },
});
const { makeWriteThrough } = require('./writeThrough');
const { SourceError } = require('./errors');
test.before(async () => { dt = await pgDatatableEngine([META]); });
test.after(async () => { restore(); await dt.close(); });

// ── the fake source ────────────────────────────────────────────────────────
class FakeError extends SourceError { constructor(...a) { super(...a); this.name = 'SourceError'; } }
const src = { calls: [], rows: new Map(), next: 1, fail: null };
function base() {
    return {
        KIND: 'fake_kind',
        isMirror: (t) => !!t && t.managedKind === 'fake_kind',
        Err: FakeError,
        forbiddenCode: 'fake_forbidden',
        notFoundCodes: new Set(['fake_not_found']),
        toWire: (ctx, values) => {
            if (values && values.derived !== undefined) throw new FakeError(400, 'derived_column', 'derived');
            return [values.a ?? null, values.b ?? null];
        },
        apiFor: async () => src,
        sourceInsert: async (api, ctx, wire) => { api.calls.push(['insert', wire]); if (api.fail) throw api.fail; const id = String(api.next++); api.rows.set(id, wire); return { id, wire }; },
        sourceUpdate: async (api, ctx, rowId, wire) => { api.calls.push(['update', rowId, wire]); if (api.fail) throw api.fail; if (!api.rows.has(rowId)) throw new FakeError(404, 'fake_not_found', 'gone'); api.rows.set(rowId, wire); return { id: rowId, wire }; },
        sourceDelete: async (api, ctx, rowId) => { api.calls.push(['delete', rowId]); if (api.fail) throw api.fail; api.rows.delete(rowId); },
        localValuesFor: async (ctx, raw, { rowId = null } = {}) => ({ id: rowId || raw.id, values: { a: raw.wire[0], b: raw.wire[1] } }),
    };
}
const ctx = (wt, grade = 'editor') => wt.contextOf({ table: TABLE, scope: SCOPE, scopeKey: 'org:org_1', tableMeta: META, grade, viewerId: 'user_9' });
test.beforeEach(async () => {
    src.calls.length = 0; src.rows.clear(); src.next = 1; src.fail = null; db.bumps.length = 0;
    await dt.pg.exec('TRUNCATE "sheet"');
    dt.calls.length = 0;
});

test('insert: source first, then the copy under the source\'s id; the editor is created_by', async () => {
    const wt = makeWriteThrough(base());
    const r = await wt.insertRow(ctx(wt), { a: 'x', b: 2 });
    assert.deepEqual(src.calls, [['insert', ['x', 2]]]);
    assert.equal(r.id, '1');
    const row = await copyRow('1');
    assert.equal(row.a, 'x');
    assert.equal(Number(row.b), 2);
    assert.equal(row.created_by, 'user_9', 'the editor is created_by');
    assert.deepEqual(db.bumps, [1]);
    assert.ok(r.row && r.row.id === '1');
});

test('a viewer is refused with the kind\'s forbidden code; a wire refusal never reaches the source', async () => {
    const wt = makeWriteThrough(base());
    await assert.rejects(() => wt.insertRow(ctx(wt, 'viewer'), { a: 'x' }), (e) => e.status === 403 && e.code === 'fake_forbidden' && e.errorClass === 'datatable_forbidden' && e.safe);
    await assert.rejects(() => wt.insertRow(ctx(wt), { derived: 1 }), (e) => e.code === 'derived_column');
    assert.equal(src.calls.length, 0);
    assert.deepEqual(dt.calls.filter((c) => c.fn !== 'query'), [], 'nothing written to the copy');
});

test('update: probe first — not there → 0/null, stale token → 0/row — with no source call; then source, then copy', async () => {
    const wt = makeWriteThrough(base());
    assert.deepEqual(await wt.updateRow(ctx(wt), '5', { a: 'x' }), { changes: 0, row: null });
    await setCopy('5');
    const stale = await wt.updateRow(ctx(wt), '5', { a: 'x' }, { expectedUpdatedAt: '2026-09-12T09:00:00.000Z' });
    assert.equal(stale.changes, 0);
    assert.equal(stale.row.id, '5');
    assert.equal(src.calls.length, 0, 'the source was never asked');
    src.rows.set('5', ['old', 1]);
    const r = await wt.updateRow(ctx(wt), '5', { b: 9 }, { expectedUpdatedAt: '2026-09-12T10:00:00Z' });
    assert.deepEqual(src.calls, [['update', '5', [null, 9]]]);
    assert.equal(r.changes, 1);
    assert.equal(Number((await copyRow('5')).b), 9, 'the copy is rewritten from the source\'s answer');
    assert.deepEqual(db.bumps, [0]);
});

test('update: a not-found code from the source deletes the local copy', async () => {
    const wt = makeWriteThrough(base());
    await setCopy('5');
    const r = await wt.updateRow(ctx(wt), '5', { b: 9 });
    assert.deepEqual(r, { changes: 0, row: null });
    assert.equal(await inCopy('5'), false);
    assert.deepEqual(db.bumps, [-1]);
    // any other refusal propagates, and nothing changed locally
    await setCopy('6');
    src.rows.set('6', []);
    src.fail = new FakeError(503, 'fake_unavailable', 'down', { errorClass: 'datatable_source_unavailable' });
    await assert.rejects(() => wt.updateRow(ctx(wt), '6', { b: 1 }), (e) => e.code === 'fake_unavailable');
    assert.equal(await inCopy('6'), true);
});

test('delete: probe, then source, then copy; already-gone at the source still counts', async () => {
    const wt = makeWriteThrough(base());
    assert.deepEqual(await wt.deleteRow(ctx(wt), '5'), { changes: 0 });
    assert.equal(src.calls.length, 0);
    await setCopy('5');
    src.fail = new FakeError(404, 'fake_not_found', 'gone');
    assert.deepEqual(await wt.deleteRow(ctx(wt), '5'), { changes: 1 });
    assert.equal(await inCopy('5'), false);
    assert.deepEqual(db.bumps, [-1]);
});

test('batch forms without many-calls: the per-row loop; collect reports per index and stops when the source is unreachable', async () => {
    const wt = makeWriteThrough(base());
    // the automation-step contract: the first refusal throws
    await assert.rejects(() => wt.insertRows(ctx(wt), [{ a: 'ok' }, { derived: 1 }, { a: 'never' }]), (e) => e.code === 'derived_column');
    assert.equal(src.calls.length, 1, 'stopped at the refusal');
    src.calls.length = 0;
    // the import contract: errors beside their index, the rest goes on
    const out = await wt.insertRows(ctx(wt), [{ a: 'one' }, { derived: 1 }, { a: 'three' }], { collect: true });
    assert.deepEqual(out.inserted.map(r => [r.index, r.id]), [[0, '2'], [2, '3']]);
    assert.deepEqual(out.errors.map(e => [e.index, e.error.code]), [[1, 'derived_column']]);
    assert.equal(out.stopped, false);
    // …until the source is unreachable: then it stops, and the rest are not attempted
    src.fail = new FakeError(503, 'fake_unavailable', 'down', { errorClass: 'datatable_source_unavailable' });
    src.calls.length = 0;
    const cut = await wt.insertRows(ctx(wt), [{ a: 'x' }, { a: 'y' }], { collect: true });
    assert.deepEqual(cut.inserted, []);
    assert.deepEqual(cut.errors.map(e => e.index), [0]);
    assert.equal(cut.stopped, true);
    assert.equal(src.calls.length, 1);
    src.fail = null;
    await setCopy('2');
    const upd = await wt.updateRows(ctx(wt), [{ id: '2', values: { b: 1 } }, { id: 'nope', values: { b: 1 } }]);
    assert.equal(upd.changed, 1);
    assert.deepEqual(upd.results.map(r => [r.index, r.changes]), [[0, 1], [1, 0]]);
    const del = await wt.deleteRows(ctx(wt), ['2', 'nope']);
    assert.equal(del.changed, 1);
});

test('batch forms with many-calls: ONE source write for the list, the copy in one batch, the counter once', async () => {
    const many = base();
    many.sourceInsertMany = async (api, c, wires) => { api.calls.push(['insertMany', wires]); return wires.map((wire) => { const id = String(api.next++); api.rows.set(id, wire); return { id, wire }; }); };
    many.sourceUpdateMany = async (api, c, items) => { api.calls.push(['updateMany', items.map(i => i.rowId)]); return items.map(i => (api.rows.has(i.rowId) ? { id: i.rowId, wire: i.wire } : null)); };
    many.sourceDeleteMany = async (api, c, ids) => { api.calls.push(['deleteMany', ids]); for (const id of ids) api.rows.delete(id); };
    const wt = makeWriteThrough(many);

    const ins = await wt.insertRows(ctx(wt), [{ a: 'one', b: 1 }, { derived: 1 }, { a: 'three', b: 3 }], { collect: true });
    assert.deepEqual(src.calls, [['insertMany', [['one', 1], ['three', 3]]]], 'one source write, the refused row left out');
    assert.deepEqual(ins.inserted.map(r => [r.index, r.id]), [[0, '1'], [2, '2']]);
    assert.deepEqual(ins.errors.map(e => e.index), [1]);
    assert.equal(batches(), 1, 'the copy in one batch');
    assert.deepEqual(db.bumps, [2], 'the counter moves once, by what landed');
    assert.ok(ins.inserted.every(r => r.row && r.row.id === r.id));

    src.calls.length = 0; db.bumps.length = 0;
    await setCopy('1');
    src.rows.delete('2');   // gone at the source, still in the copy
    const upd = await wt.updateRows(ctx(wt), [
        { id: '1', values: { b: 11 } },
        { id: '2', values: { b: 22 } },
        { id: '1', values: { b: 0 }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
        { id: 'nope', values: { b: 1 } },
    ]);
    assert.deepEqual(src.calls, [['updateMany', ['1', '2']]], 'the stale and the missing never reach the source');
    assert.deepEqual(upd.results.map(r => [r.index, r.changes, r.row ? r.row.id : null]), [[0, 1, '1'], [1, 0, null], [2, 0, '1'], [3, 0, null]]);
    assert.equal(upd.changed, 1);
    assert.equal(await inCopy('2'), false, 'a null from the source deletes the copy');

    src.calls.length = 0; db.bumps.length = 0;
    const del = await wt.deleteRows(ctx(wt), ['1', 'nope']);
    assert.deepEqual(src.calls, [['deleteMany', ['1']]]);
    assert.equal(del.changed, 1);
    assert.equal(await inCopy('1'), false, 'the copy lost the row in the same batch');
    assert.deepEqual(del.results.map(r => [r.index, r.changes]), [[0, 1], [1, 0]]);
    assert.deepEqual(db.bumps, [-1]);
});

test('the context check refuses another kind and a context without access', async () => {
    const wt = makeWriteThrough(base());
    await assert.rejects(() => wt.insertRow({ ...ctx(wt), table: { ...TABLE, managedKind: 'other' } }, {}), /not a fake_kind mirror/);
    await assert.rejects(() => wt.insertRow({ ...ctx(wt), tableMeta: { fields: [] } }, {}), /tableMeta with access/);
    assert.throws(() => makeWriteThrough({}), /toWire\(\) and apiFor\(\)/);
});

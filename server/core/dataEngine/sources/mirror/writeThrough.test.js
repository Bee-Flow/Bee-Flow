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
 *
 * Run: cd server && node --test core/dataEngine/sources/mirror/writeThrough.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

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

// ── the fake copy ──────────────────────────────────────────────────────────
const db = { rows: new Map(), execs: [], batches: [], bumps: [] };
const datatableDbStore = {
    scopeKey: () => 'org:org_1',
    query: async (a, b, sql, params) => {
        if (/^SELECT \* FROM "sheet" WHERE "id" = \?/.test(sql)) {
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
    batch: async (a, b, stmts) => {
        db.batches.push(stmts);
        return Promise.all(stmts.map(s => datatableDbStore.exec(a, b, s.sql, s.params)));
    },
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': { bumpAfterWrite: async (id, scope, d) => { db.bumps.push(d); } },
    '../../../../stores/datatableDbStore': datatableDbStore,
    '../../../../auth/datatableAccess': { gradeAtLeast: (g, min) => (g === 'owner' || g === 'editor' || min === 'viewer') },
});
const { makeWriteThrough } = require('./writeThrough');
const { SourceError } = require('./errors');
test.after(() => restore());

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
test.beforeEach(() => { src.calls.length = 0; src.rows.clear(); src.next = 1; src.fail = null; db.rows.clear(); db.execs.length = 0; db.batches.length = 0; db.bumps.length = 0; });

test('insert: source first, then the copy under the source\'s id; the editor is created_by', async () => {
    const wt = makeWriteThrough(base());
    const r = await wt.insertRow(ctx(wt), { a: 'x', b: 2 });
    assert.deepEqual(src.calls, [['insert', ['x', 2]]]);
    assert.equal(r.id, '1');
    assert.match(db.execs[0].sql, /^INSERT INTO "sheet"/);
    assert.equal(db.execs[0].params[0], '1');
    assert.equal(db.execs[0].params[3], 'user_9');
    assert.deepEqual(db.bumps, [1]);
    assert.ok(r.row && r.row.id === '1');
});

test('a viewer is refused with the kind\'s forbidden code; a wire refusal never reaches the source', async () => {
    const wt = makeWriteThrough(base());
    await assert.rejects(() => wt.insertRow(ctx(wt, 'viewer'), { a: 'x' }), (e) => e.status === 403 && e.code === 'fake_forbidden' && e.errorClass === 'datatable_forbidden' && e.safe);
    await assert.rejects(() => wt.insertRow(ctx(wt), { derived: 1 }), (e) => e.code === 'derived_column');
    assert.equal(src.calls.length, 0);
    assert.equal(db.execs.length, 0);
});

test('update: probe first — not there → 0/null, stale token → 0/row — with no source call; then source, then copy', async () => {
    const wt = makeWriteThrough(base());
    assert.deepEqual(await wt.updateRow(ctx(wt), '5', { a: 'x' }), { changes: 0, row: null });
    db.rows.set('5', { id: '5', updated_at: '2026-09-12T10:00:00.000Z' });
    const stale = await wt.updateRow(ctx(wt), '5', { a: 'x' }, { expectedUpdatedAt: '2026-09-12T09:00:00.000Z' });
    assert.equal(stale.changes, 0);
    assert.equal(stale.row.id, '5');
    assert.equal(src.calls.length, 0, 'the source was never asked');
    src.rows.set('5', ['old', 1]);
    const r = await wt.updateRow(ctx(wt), '5', { b: 9 }, { expectedUpdatedAt: '2026-09-12T10:00:00Z' });
    assert.deepEqual(src.calls, [['update', '5', [null, 9]]]);
    assert.equal(r.changes, 1);
    assert.match(db.execs[0].sql, /^UPDATE "sheet"/);
    assert.deepEqual(db.bumps, [0]);
});

test('update: a not-found code from the source deletes the local copy', async () => {
    const wt = makeWriteThrough(base());
    db.rows.set('5', { id: '5', updated_at: 'x' });
    const r = await wt.updateRow(ctx(wt), '5', { b: 9 });
    assert.deepEqual(r, { changes: 0, row: null });
    assert.equal(db.rows.has('5'), false);
    assert.deepEqual(db.bumps, [-1]);
    // any other refusal propagates, and nothing changed locally
    db.rows.set('6', { id: '6', updated_at: 'x' });
    src.rows.set('6', []);
    src.fail = new FakeError(503, 'fake_unavailable', 'down', { errorClass: 'datatable_source_unavailable' });
    await assert.rejects(() => wt.updateRow(ctx(wt), '6', { b: 1 }), (e) => e.code === 'fake_unavailable');
    assert.equal(db.rows.has('6'), true);
});

test('delete: probe, then source, then copy; already-gone at the source still counts', async () => {
    const wt = makeWriteThrough(base());
    assert.deepEqual(await wt.deleteRow(ctx(wt), '5'), { changes: 0 });
    assert.equal(src.calls.length, 0);
    db.rows.set('5', { id: '5' });
    src.fail = new FakeError(404, 'fake_not_found', 'gone');
    assert.deepEqual(await wt.deleteRow(ctx(wt), '5'), { changes: 1 });
    assert.equal(db.rows.has('5'), false);
    assert.deepEqual(db.bumps, [-1]);
});

test('batch forms without many-calls: the per-row loop; collect reports per index and stops when the source is unreachable', async () => {
    const wt = makeWriteThrough(base());
    // the routine-step contract: the first refusal throws
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
    db.rows.set('2', { id: '2', updated_at: 'x' });
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
    assert.equal(db.batches.length, 1, 'the copy in one batch');
    assert.deepEqual(db.bumps, [2], 'the counter moves once, by what landed');
    assert.ok(ins.inserted.every(r => r.row && r.row.id === r.id));

    src.calls.length = 0; db.bumps.length = 0;
    db.rows.set('1', { id: '1', updated_at: '2026-09-12T10:00:00.000Z' });
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
    assert.equal(db.rows.has('2'), false, 'a null from the source deletes the copy');

    src.calls.length = 0; db.bumps.length = 0;
    const del = await wt.deleteRows(ctx(wt), ['1', 'nope']);
    assert.deepEqual(src.calls, [['deleteMany', ['1']]]);
    assert.equal(del.changed, 1);
    assert.deepEqual(del.results.map(r => [r.index, r.changes]), [[0, 1], [1, 0]]);
    assert.deepEqual(db.bumps, [-1]);
});

test('the context check refuses another kind and a context without access', async () => {
    const wt = makeWriteThrough(base());
    await assert.rejects(() => wt.insertRow({ ...ctx(wt), table: { ...TABLE, managedKind: 'other' } }, {}), /not a fake_kind mirror/);
    await assert.rejects(() => wt.insertRow({ ...ctx(wt), tableMeta: { fields: [] } }, {}), /tableMeta with access/);
    assert.throws(() => makeWriteThrough({}), /toWire\(\) and apiFor\(\)/);
});

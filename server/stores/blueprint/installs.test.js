/**
 * The ref ledger and the install stamps (stores/blueprint/installs.js), against
 * a real Postgres (@electric-sql/pglite, in-process) through makeBlueprintStore.
 * No module is replaced: the schema is the store's own applyBlueprintSchema.
 *
 * Proven:
 *   - a ref is stable across reorderings, is numbered per prefix, and a
 *     retired ref is never handed out again (kind 'connection' is 'cn'); a
 *     parts call and a connections call never retire each other's rows;
 *   - listStamps is still a Map by ref, now with the stage columns.
 *
 * Run: cd server && node --test stores/blueprint/installs.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeBlueprintStore, applyBlueprintSchema } = require('../blueprintStore');

// The manifest's REF_PREFIX, as a caller passes it.
const PREFIX = { automations: 'aut', apps: 'app', webpages: 'web', datatables: 'dt', agents: 'agt', knowledgeBases: 'kb' };
const prefixOf = (kind) => PREFIX[kind];

const { pg, db: q } = pgliteDb();
// db.js's shape over the pglite connection; the ledger and the stamps need no other table.
const store = makeBlueprintStore({
    withTransaction: (fn) => q.tx(fn),
    getAll: async (sql, params) => (await q.query(sql, params)).rows,
    getOne: async (sql, params) => (await q.query(sql, params)).rows[0] || null,
    run: (sql, params) => q.query(sql, params),
});

before(async () => {
    await applyBlueprintSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (_tag, statements) => {
            for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql);
        },
    });
});
after(async () => { await pg.close(); });

// ── The ref ledger ──────────────────────────────────────────────────────────

test('allocateRefs keeps every ref across a reordering, numbered per prefix', async () => {
    const members = [
        { kind: 'automations', entityId: 'a1' },
        { kind: 'automations', entityId: 'a2' },
        { kind: 'apps', entityId: 'p1' },
    ];
    const first = await store.allocateRefs('dev1', members, { prefixOf });
    assert.deepStrictEqual([...first], [['a1', 'aut_1'], ['a2', 'aut_2'], ['p1', 'app_1']]);

    const again = await store.allocateRefs('dev1', [...members].reverse(), { prefixOf });
    assert.deepStrictEqual(Object.fromEntries(again), Object.fromEntries(first), 'the order of the store is not the identity');

    const other = await store.allocateRefs('dev2', [{ kind: 'automations', entityId: 'a2' }], { prefixOf });
    assert.strictEqual(other.get('a2'), 'aut_1', 'the ledger is per Solution');
});

test('a retired ref is never handed out again, and a part that comes back gets its own ref back', async () => {
    // a2 leaves the Solution.
    const gone = await store.allocateRefs('dev1', [
        { kind: 'automations', entityId: 'a1' }, { kind: 'apps', entityId: 'p1' },
    ], { prefixOf });
    assert.strictEqual(gone.has('a2'), false);
    const retired = (await store.refsFor('dev1')).find(r => r.entityId === 'a2');
    assert.strictEqual(retired.ref, 'aut_2');
    assert.ok(retired.retiredAt, 'an absent part is retired, not deleted');

    // A new part is numbered past the retired one.
    const added = await store.allocateRefs('dev1', [
        { kind: 'automations', entityId: 'a1' }, { kind: 'apps', entityId: 'p1' }, { kind: 'automations', entityId: 'a3' },
    ], { prefixOf });
    assert.strictEqual(added.get('a3'), 'aut_3', 'aut_2 belongs to a2 for good');

    // The newest ref retires too; the next new part still does not reuse it.
    const next = await store.allocateRefs('dev1', [
        { kind: 'automations', entityId: 'a1' }, { kind: 'apps', entityId: 'p1' }, { kind: 'automations', entityId: 'a4' },
    ], { prefixOf });
    assert.strictEqual(next.get('a4'), 'aut_4');

    // a2 comes back: same ref, revived.
    const back = await store.allocateRefs('dev1', [
        { kind: 'automations', entityId: 'a1' }, { kind: 'automations', entityId: 'a2' },
    ], { prefixOf });
    assert.strictEqual(back.get('a2'), 'aut_2');
    const rows = await store.refsFor('dev1');
    assert.strictEqual(rows.find(r => r.entityId === 'a2').retiredAt, null);
    assert.ok(rows.find(r => r.entityId === 'p1').retiredAt, 'and what is absent now is retired');
});

test('a connection is a ledger kind with the prefix cn; a kind without a prefix is refused', async () => {
    const refs = await store.allocateRefs('devP', [
        { kind: 'connection', entityId: 'conn_x' }, { kind: 'datatables', entityId: 't1' },
    ], { prefixOf });
    assert.strictEqual(refs.get('conn_x'), 'cn_1');
    assert.strictEqual(refs.get('t1'), 'dt_1');
    await assert.rejects(store.allocateRefs('devP', [{ kind: 'mystery', entityId: 'm1' }], { prefixOf }),
        /no ref prefix for kind 'mystery'/);
    await assert.rejects(store.allocateRefs('devP', [{ kind: 'apps' }], { prefixOf }), /entityId/);
});

test('allocateRefs joins a transaction the caller holds', async () => {
    const refs = await q.tx((client) => store.allocateRefs('devP', [
        { kind: 'connection', entityId: 'conn_x' }, { kind: 'agents', entityId: 'g1' },
    ], { prefixOf, client }));
    assert.strictEqual(refs.get('g1'), 'agt_1');
    assert.strictEqual(refs.get('conn_x'), 'cn_1');
});

test('a parts call never retires connection slots, and a connections call never retires parts', async () => {
    await store.allocateRefs('devL', [
        { kind: 'connection', entityId: 'conn_a' }, { kind: 'connection', entityId: 'conn_b' },
    ], { prefixOf });
    await store.allocateRefs('devL', [
        { kind: 'automations', entityId: 'a1' }, { kind: 'apps', entityId: 'p1' },
    ], { prefixOf });
    let rows = await store.refsFor('devL');
    const retired = (id) => rows.find(r => r.entityId === id).retiredAt;
    assert.strictEqual(retired('conn_a'), null, 'the gallery export (parts only) leaves the slots alone');
    assert.strictEqual(retired('conn_b'), null);

    // Connections only: conn_b left, the parts stay live.
    await store.allocateRefs('devL', [{ kind: 'connection', entityId: 'conn_a' }], { prefixOf });
    rows = await store.refsFor('devL');
    assert.ok(retired('conn_b'), 'a slot absent from a connections call retires');
    assert.strictEqual(retired('a1'), null, 'parts are not retired by a connections call');
    assert.strictEqual(retired('p1'), null);

    // Parts only, without apps: within the parts family every absent kind retires.
    await store.allocateRefs('devL', [{ kind: 'automations', entityId: 'a1' }], { prefixOf });
    rows = await store.refsFor('devL');
    assert.ok(retired('p1'), 'a kind that left entirely still retires');
    assert.strictEqual(retired('conn_a'), null);

    // An explicit scope wins, and an empty call retires nothing by default.
    await store.allocateRefs('devL', [], { prefixOf });
    rows = await store.refsFor('devL');
    assert.strictEqual(retired('a1'), null);
    await store.allocateRefs('devL', [], { prefixOf, kinds: ['connection'] });
    rows = await store.refsFor('devL');
    assert.ok(retired('conn_a'));
    assert.strictEqual(retired('a1'), null);
    await assert.rejects(store.allocateRefs('devL', [], { kinds: 'connection' }), /kinds must be an array/);
});

// ── Stamps ──────────────────────────────────────────────────────────────────

test('listStamps is still a Map by ref, now with the stage columns', async () => {
    await store.stampEntity({
        projectId: 'inst1', ref: 'aut_1', kind: 'automation', entityId: 'a-inst', installHash: 'h0',
        stepIdMap: { s1: 's1x' },
    });
    // A gallery re-stamp without a map keeps the install's map (D3).
    await store.stampEntity({ projectId: 'inst1', ref: 'aut_1', kind: 'automation', entityId: 'a-inst', installHash: 'h1', installedVersion: 2 });
    let stamps = await store.listStamps('inst1');
    assert.ok(stamps instanceof Map);
    const s = stamps.get('aut_1');
    assert.strictEqual(s.installHash, 'h1');
    assert.strictEqual(s.installedVersion, 2);
    assert.deepStrictEqual(s.stepIdMap, { s1: 's1x' });
    assert.strictEqual(s.releaseId, null);
    assert.strictEqual(s.retiredAt, null);

    // upsertStamp on a transaction client: the stage columns, then a retire.
    const written = await q.tx((client) => store.upsertStamp(client, {
        projectId: 'inst1', ref: 'aut_1', kind: 'automation', entityId: 'a-inst', installHash: 'h2',
        installedVersion: 3, releaseId: 'rel_x', sourceHash: 'src1',
    }));
    assert.strictEqual(written.releaseId, 'rel_x');
    assert.deepStrictEqual(written.stepIdMap, { s1: 's1x' }, 'a map left out is kept');
    await store.upsertStamp(null, {
        projectId: 'inst1', ref: 'web_1', kind: 'webpage', entityId: 'w1', installHash: 'hw', retired: true, stepIdMap: null,
    });

    stamps = await store.listStamps('inst1');
    assert.deepStrictEqual([...stamps.keys()].sort(), ['aut_1', 'web_1']);
    assert.strictEqual(stamps.get('aut_1').sourceHash, 'src1');
    assert.strictEqual(stamps.get('aut_1').installedVersion, 3);
    assert.ok(stamps.get('aut_1').updatedAt);
    assert.ok(stamps.get('web_1').retiredAt, 'retired');

    const revived = await store.upsertStamp(null, {
        projectId: 'inst1', ref: 'web_1', kind: 'webpage', entityId: 'w1', installHash: 'hw2', retired: false,
    });
    assert.strictEqual(revived.retiredAt, null);

    // A retire without installedVersion keeps the version the stamp holds.
    const retiredAut = await store.upsertStamp(null, {
        projectId: 'inst1', ref: 'aut_1', kind: 'automation', entityId: 'a-inst', installHash: 'h2', retired: true,
    });
    assert.strictEqual(retiredAut.installedVersion, 3, 'a version left out is kept');
    assert.ok(retiredAut.retiredAt);
    await assert.rejects(store.upsertStamp(null, {
        projectId: 'inst1', ref: 'aut_1', kind: 'automation', entityId: 'a-inst', installHash: 'h2', installedVersion: 0,
    }), /positive integer/);
    await assert.rejects(store.upsertStamp(null, { projectId: 'inst1', ref: 'x' }), /kind is required/);
});

/**
 * Record triggers on the writes of SEVERAL ROWS, through the real write paths on both engines
 * (SQLite in memory and Postgres through PGlite): a batch create, an update and a delete of the
 * rows matching a filter, a transaction step, a replace, and a delete that follows delete rules
 * (cascade and setNull). Only the outbox is a stand-in that keeps what it was handed.
 *
 * What it pins (triggers/recordCapture.mts): each path records one change per row it changed,
 * with the rows as they were and as they are, in the order written; a transaction that rolls
 * back records nothing; a write over the cap records nothing and says so; and a table without an
 * armed trigger for the event runs EXACTLY the statements it runs without an origin.
 *
 * Run: cd server && node --test appStudio/actionExecutor/records.recordTriggerRows.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootLinkedEngines, useEngineAsAppStore } = require('../../testUtils/linkedEngines.testkit');
const { standInOutbox } = require('../../testUtils/recordOutboxStandIn.testkit');
const { validateDataModel } = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { writeRecord, writeRecordBatch, eraseRecord } = require('./records');
const { replaceRecordBatch } = require('./replaceRecords.mts');

const app = { id: 'app-rows', userId: 'owner-1', organizationId: 'org-1' };
const viewer = { id: 'u1', role: 'member' };
const access = { default: 'none', roles: { member: { read: 'all', create: true, update: 'all', delete: 'all' } }, rowFilters: {} };
const table = (id, key, extra = []) => ({
    id: `tbl_${id}001`, key, name: key, access,
    fields: [{ id: `fld_${id}tit1`, key: 'title', type: 'text' }, { id: `fld_${id}sta1`, key: 'status', type: 'text' }, ...extra],
});
const parent = (id, of, onDelete) => ({ id: `fld_${id}par1`, key: 'parent', type: 'relation', relation: { table: of.id, onDelete } });

const ORDERS = table('ord', 'orders');
const LINES = table('lin', 'lines', [parent('lin', ORDERS, 'cascade')]);
const NOTES = table('not', 'notes', [parent('not', ORDERS, 'setNull')]);
// No trigger at all on these two; AUDIT has one for creates only.
const PLAIN = table('pln', 'plain');
const KIDS = table('kid', 'kids', [parent('kid', PLAIN, 'cascade')]);
const AUDIT = table('aud', 'audit');
const MODEL = { modelVersion: 1, roles: [{ key: 'member', label: 'Member' }], tables: [ORDERS, LINES, NOTES, PLAIN, KIDS, AUDIT] };

const ALL_EVENTS = ['create', 'update', 'delete'];
const outbox = standInOutbox(() => [
    ...[ORDERS, LINES, NOTES].map((t) => ({ appId: app.id, triggerId: `on_${t.key}`, config: { tableId: t.id, on: ALL_EVENTS } })),
    { appId: app.id, triggerId: 'on_audit', config: { tableId: AUDIT.id, on: ['create'] } },
]);

const USER = { kind: 'user' };
const ctx = (extra = {}) => ({ viewerId: viewer.id, viewer: { id: viewer.id }, role: viewer.role, vars: {}, ...extra });
const lit = (value) => ({ kind: 'static', value });
const where = (status) => [{ field: 'status', op: 'eq', value: lit(status) }];

const closers = [];
let engines;
/** Every call the write path made on the app's database: ['exec' | 'query', sql] or ['batch', ...sql]. */
let calls;
test.after(async () => { outbox.restore(); for (const close of closers) await close(); });

test('(setup) the model on both engines', async () => {
    assert.deepEqual(validateDataModel(MODEL).errors, []);
    engines = await bootLinkedEngines(MODEL, closers);
});

const logged = (engine) => ({
    ...engine,
    run: (sql, params) => { calls.push(['exec', sql]); return engine.run(sql, params); },
    all: (sql, params) => { calls.push(['query', sql]); return engine.all(sql, params); },
    batch: (statements) => { calls.push(['batch', ...statements.map((s) => s.sql)]); return engine.batch(statements); },
});

/** Run `fn(engine)` on each engine in turn, on empty tables and an empty outbox. */
async function onBoth(fn) {
    for (const engine of Object.values(engines)) {
        for (const t of [KIDS, LINES, NOTES, AUDIT, PLAIN, ORDERS]) await engine.run(`DELETE FROM "${t.key}"`, []);
        calls = [];
        outbox.install();
        const restore = useEngineAsAppStore(logged(engine));
        try { await fn(engine); } finally { restore(); }
    }
}

/** Rows written without an origin (they record nothing); the ids in order. */
async function seed(t, rows) {
    const ids = [];
    for (const row of rows) ids.push((await writeRecord(app, MODEL, t, row, { viewer })).id);
    calls.length = 0;
    return ids;
}
const titles = async (engine, t, status) => (await engine.all(`SELECT title FROM "${t.key}" WHERE status = ? ORDER BY title`, [status])).map((r) => r.title);
const seen = () => outbox.recorded.map((d) => [d.event, d.tableId, d.rowId, d.before ? d.before.status : null, d.after ? d.after.status : null]);
/** Rows laid down in the same millisecond are picked in id order: compare such a set whatever its order. */
const sameSet = (got, want, label) => assert.deepEqual(got.map((x) => JSON.stringify(x)).sort(), want.map((x) => JSON.stringify(x)).sort(), label);
const vias = () => calls.map((c) => (c[0] === 'batch' ? `batch:${c.length - 1}` : c[0]));

test('a batch create records every created row as it is, in one batch with one read', async () => {
    await onBoth(async (engine) => {
        const ids = await writeRecordBatch(app, MODEL, LINES, [{ title: 'a', status: 'new' }, { title: 'b', status: 'new' }, { title: 'c', status: 'new' }], { viewer, source: USER });
        assert.deepEqual(seen(), ids.map((id) => ['create', LINES.id, id, null, 'new']), engine.dialect);
        assert.deepEqual(outbox.recorded.map((d) => d.after.title), ['a', 'b', 'c']);
        assert.deepEqual(outbox.recorded.map((d) => [d.writerKind, d.depth, d.causeTriggerId]), Array(3).fill(['member', 0, null]));
        assert.deepEqual(vias(), ['batch:4'], `${engine.dialect}: three inserts and the read after them`);
    });
});

test('update_record with a filter records each row it changed, before and after, and carries a trigger run\'s chain', async () => {
    await onBoth(async (engine) => {
        const [a, b] = await seed(LINES, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }, { title: 'c', status: 'held' }]);
        const chain = { kind: 'trigger', depth: 2, triggerId: 'on_other' };
        const out = await executeDataStep(app, MODEL, { kind: 'update_record', tableId: LINES.id, filter: where('open'), values: { status: lit('done') } }, ctx({ writeSource: chain }));
        assert.equal(out.result.updated, 2, `${engine.dialect}: ${JSON.stringify(out)}`);
        sameSet(seen(), [['update', LINES.id, a, 'open', 'done'], ['update', LINES.id, b, 'open', 'done']]);
        assert.deepEqual(outbox.recorded.map((d) => [d.writerKind, d.depth, d.causeTriggerId]), Array(2).fill(['trigger', 2, 'on_other']));
        assert.deepEqual(vias(), ['query', 'query', 'batch:3'], 'count, pick, then the rows before, the update, the rows after');
        assert.deepEqual(await titles(engine, LINES, 'done'), ['a', 'b']);
    });
});

test('delete_record with a filter records each row it deleted, as it was', async () => {
    await onBoth(async (engine) => {
        const [a, b] = await seed(LINES, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }, { title: 'c', status: 'held' }]);
        const out = await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: LINES.id, filter: where('open') }, ctx({ writeSource: USER }));
        assert.equal(out.result.deleted, 2, `${engine.dialect}: ${JSON.stringify(out)}`);
        sameSet(seen(), [['delete', LINES.id, a, 'open', null], ['delete', LINES.id, b, 'open', null]]);
        assert.deepEqual(vias(), ['query', 'query', 'batch:2'], 'count, pick, then the rows before and the delete');
        assert.deepEqual(await titles(engine, LINES, 'held'), ['c']);
    });
});

test('a transaction step records its creates, updates and deletes by id in order once it commits; a filter child records nothing', async () => {
    await onBoth(async (engine) => {
        const [a, b] = await seed(LINES, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }, { title: 'c', status: 'wait' }]);
        const out = await executeDataStep(app, MODEL, { kind: 'transaction', steps: [
            { kind: 'create_record', tableId: LINES.id, values: { title: lit('new'), status: lit('new') } },
            { kind: 'update_record', tableId: LINES.id, recordId: lit(a), values: { status: lit('done') } },
            { kind: 'update_record', tableId: LINES.id, filter: where('wait'), values: { status: lit('held') } },
            { kind: 'delete_record', tableId: LINES.id, recordId: lit(b) },
        ] }, ctx({ writeSource: USER }));
        assert.equal(out.ok, true, `${engine.dialect}: ${JSON.stringify(out)}`);
        const made = out.result.results[0].id;
        assert.deepEqual(seen(), [['create', LINES.id, made, null, 'new'], ['update', LINES.id, a, 'open', 'done'], ['delete', LINES.id, b, 'open', null]]);
        assert.deepEqual(await titles(engine, LINES, 'held'), ['c'], 'the filter child ran, unrecorded');
        assert.deepEqual(vias(), ['batch:8'], 'insert + read, read + update + read, the filter update, read + delete');
    });
});

test('a transaction step that rolls back records nothing, and still names its own failing step', async () => {
    await onBoth(async (engine) => {
        const out = await executeDataStep(app, MODEL, { kind: 'transaction', steps: [
            { kind: 'create_record', tableId: LINES.id, values: { title: lit('new') } },
            { kind: 'update_record', tableId: LINES.id, recordId: lit('missing'), values: { status: lit('done') } },
        ] }, ctx({ writeSource: USER }));
        assert.equal(out.ok, false, engine.dialect);
        assert.match(out.error, /^Step 2 of the transaction \(update_record\): Record not found\. Nothing was saved\./);
        assert.deepEqual(outbox.recorded, []);
        assert.equal((await engine.all('SELECT COUNT(*) AS n FROM "lines"', []))[0].n * 1, 0);
    });
});

test('a replace records the rows it deleted and the rows it created', async () => {
    await onBoth(async (engine) => {
        const [a, b] = await seed(LINES, [{ title: 'a', status: 'old' }, { title: 'b', status: 'old' }, { title: 'c', status: 'keep' }]);
        const out = await replaceRecordBatch(app, MODEL, LINES, [{ title: 'n1', status: 'new' }, { title: 'n2', status: 'new' }], {
            viewer, filters: [{ field: 'status', op: 'eq', value: 'old' }], limit: 500, source: USER,
        });
        assert.equal(out.deleted, 2, engine.dialect);
        sameSet(seen().slice(0, 2), [['delete', LINES.id, a, 'old', null], ['delete', LINES.id, b, 'old', null]], 'the deleted rows first');
        assert.deepEqual(seen().slice(2), [['create', LINES.id, out.ids[0], null, 'new'], ['create', LINES.id, out.ids[1], null, 'new']]);
        assert.deepEqual(await titles(engine, LINES, 'keep'), ['c']);
    });
});

test('a delete that follows delete rules records the emptied children as updates, the deleted children and the record itself as deletes', async () => {
    await onBoth(async (engine) => {
        const [order] = await seed(ORDERS, [{ title: 'o', status: 'open' }]);
        const [l1, l2] = await seed(LINES, [{ title: 'l1', status: 'x', parent: order }, { title: 'l2', status: 'x', parent: order }, { title: 'other', status: 'x' }]);
        const [note] = await seed(NOTES, [{ title: 'n', status: 'x', parent: order }]);
        const out = await eraseRecord(app, MODEL, ORDERS, order, { viewer, source: USER });
        assert.equal(out.deleted, true, engine.dialect);
        assert.deepEqual(seen()[0], ['update', NOTES.id, note, 'x', 'x']);
        sameSet(seen().slice(1, 3), [['delete', LINES.id, l1, 'x', null], ['delete', LINES.id, l2, 'x', null]], 'then the deleted children');
        assert.deepEqual(seen()[3], ['delete', ORDERS.id, order, 'open', null], 'the record itself last');
        assert.equal(outbox.recorded.length, 4);
        const emptied = outbox.recorded[0];
        assert.deepEqual([emptied.before.parent, emptied.after.parent], [order, null]);
        assert.deepEqual(outbox.recorded.map((d) => [d.writerKind, d.depth]), Array(4).fill(['member', 0]), 'by the writer of the delete, at its depth');
        assert.deepEqual(await titles(engine, LINES, 'x'), ['other']);
    });
});

test('the cap: a write about to change more rows than a trigger takes from one write records none of them and says so; the write itself is unchanged', async () => {
    await onBoth(async (engine) => {
        await seed(LINES, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }, { title: 'c', status: 'open' }]);
        outbox.limits.maxRowsPerWrite = 2;
        const out = await executeDataStep(app, MODEL, { kind: 'update_record', tableId: LINES.id, filter: where('open'), values: { status: lit('done') } }, ctx({ writeSource: USER }));
        assert.equal(out.result.updated, 3, engine.dialect);
        assert.deepEqual(outbox.recorded, [], 'never a part of the rows');
        assert.equal(outbox.notes.length, 1);
        assert.equal(outbox.notes[0][0], 'on_lines');
        assert.match(outbox.notes[0][1], /^Skipped: too many rows in one write\. It changed 3 rows.*STUDIO_APP_RECORD_TRIGGER_MAX_ROWS_PER_WRITE=2/);
        assert.deepEqual(vias(), ['query', 'query', 'exec'], 'the statement it runs without a trigger');
        // At the cap it records.
        await executeDataStep(app, MODEL, { kind: 'update_record', tableId: LINES.id, filter: where('done'), limit: 2, values: { status: lit('sent') } }, ctx({ writeSource: USER }));
        assert.equal(outbox.recorded.length, 2);
        outbox.limits.maxRowsPerWrite = 0;
        await executeDataStep(app, MODEL, { kind: 'update_record', tableId: LINES.id, filter: where('sent'), values: { status: lit('paid') } }, ctx({ writeSource: USER }));
        assert.equal(outbox.recorded.length, 4, '0 = unlimited');
    });
});

/** The write paths of several rows on tables without a trigger for the event, each with what to lay down first. */
const UNARMED = {
    'a batch create': {
        run: (by) => writeRecordBatch(app, MODEL, PLAIN, [{ title: 'a' }, { title: 'b' }], { viewer, ...by }),
        vias: ['batch:2'],
    },
    'update_record with a filter': {
        seed: () => seed(PLAIN, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }]),
        run: (by) => executeDataStep(app, MODEL, { kind: 'update_record', tableId: PLAIN.id, filter: where('open'), values: { status: lit('done') } }, ctx(by.source ? { writeSource: by.source } : {})),
        vias: ['query', 'query', 'exec'],
    },
    'update_record with a filter on a table whose trigger listens to creates only': {
        seed: () => seed(AUDIT, [{ title: 'a', status: 'open' }]),
        run: (by) => executeDataStep(app, MODEL, { kind: 'update_record', tableId: AUDIT.id, filter: where('open'), values: { status: lit('done') } }, ctx(by.source ? { writeSource: by.source } : {})),
        vias: ['query', 'query', 'exec'],
    },
    'delete_record with a filter': {
        seed: () => seed(KIDS, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }]),
        run: (by) => executeDataStep(app, MODEL, { kind: 'delete_record', tableId: KIDS.id, filter: where('open') }, ctx(by.source ? { writeSource: by.source } : {})),
        vias: ['query', 'query', 'exec'],
    },
    'a transaction step': {
        seed: () => seed(KIDS, [{ title: 'a', status: 'open' }, { title: 'b', status: 'open' }]),
        run: (by, [a, b]) => executeDataStep(app, MODEL, { kind: 'transaction', steps: [
            { kind: 'create_record', tableId: KIDS.id, values: { title: lit('new') } },
            { kind: 'update_record', tableId: KIDS.id, recordId: lit(a), values: { status: lit('done') } },
            { kind: 'delete_record', tableId: KIDS.id, recordId: lit(b) },
        ] }, ctx(by.source ? { writeSource: by.source } : {})),
        vias: ['batch:3'],
    },
    'a replace': {
        seed: () => seed(KIDS, [{ title: 'a', status: 'old' }]),
        run: (by) => replaceRecordBatch(app, MODEL, KIDS, [{ title: 'n' }], { viewer, filters: [{ field: 'status', op: 'eq', value: 'old' }], limit: 500, ...by }),
        vias: ['batch:2'],
    },
    'a delete that follows delete rules': {
        seed: async () => {
            const [p] = await seed(PLAIN, [{ title: 'p' }]);
            await seed(KIDS, [{ title: 'k1', parent: p }, { title: 'k2', parent: p }]);
            return [p];
        },
        run: (by, [p]) => eraseRecord(app, MODEL, PLAIN, p, { viewer, ...by }),
    },
};

test('a table without an armed trigger for the event runs exactly the statements it runs without an origin, on every path', async () => {
    for (const [label, path] of Object.entries(UNARMED)) {
        const runs = {};
        for (const [name, by] of [['without an origin', {}], ['with an origin', { source: USER }]]) {
            await onBoth(async (engine) => {
                const seeded = path.seed ? await path.seed() : [];
                const out = await path.run(by, seeded);
                assert.notEqual(out && out.ok, false, `${label} ${name} (${engine.dialect}): ${out && out.error}`);
                runs[`${engine.dialect} ${name}`] = calls.slice();
                assert.deepEqual(outbox.recorded, [], label);
                assert.deepEqual(outbox.notes, [], label);
                if (path.vias) assert.deepEqual(vias(), path.vias, `${label} ${name} (${engine.dialect})`);
            });
        }
        for (const dialect of ['sqlite', 'pg']) {
            assert.deepEqual(runs[`${dialect} with an origin`], runs[`${dialect} without an origin`], `${label} (${dialect}): the same statements through the same store calls`);
        }
    }
});

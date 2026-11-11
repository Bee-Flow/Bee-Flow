/**
 * Record triggers on the App Studio write paths, against a REAL in-memory SQLite: the real query
 * compiler, RLS gateway and dispatcher. Only the outbox store is a stand-in that keeps what it
 * was handed.
 *
 * What it pins: WHICH write path records a change for a record trigger and which does not
 * (triggers/recordTriggerRule.mts rule 1), that the recorded rows are the real ones, and that a
 * table without an armed trigger runs exactly the statement it ran before.
 *
 * Run: cd server && node --test appStudio/actionExecutor/records.recordTrigger.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useSqliteAppStores } = require('../../testUtils/sqliteAppStores.testkit');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const executed = [];
const db = useSqliteAppStores(test, { onSql: (sql) => executed.push(sql) });

const dataModel = require('../dataModel');
const { executeDataStep } = require('./dispatch');
const { writeRecord, writeRecordBatch, eraseRecord } = require('./records');
const { _setOutboxDeps } = require('../triggers/recordOutbox.mts');
const { recordTriggerLimits } = require('../triggers/recordTriggerLimits.mts');

const tableOf = (name) => ({
    id: `tbl_${name}00`.slice(0, 10), key: name, name,
    fields: [{ id: `fld_${name}_t`, key: 'title', name: 'Title', type: 'text' }, { id: `fld_${name}_q`, key: 'qty', name: 'Quantity', type: 'number' }],
    access: { default: 'app', roles: {}, rowFilters: {} },
});
const ORDERS = tableOf('orders');
const PLAIN = tableOf('plain');
// A table whose `margin` only the manager reads and writes (column rights).
const PRICED = { ...tableOf('priced'), fields: [...tableOf('priced').fields, { id: 'fld_priced_m', key: 'margin', name: 'Margin', type: 'number', access: { read: ['manager'] } }] };
const MODEL = { modelVersion: 1, roles: [], tables: [ORDERS, PLAIN, PRICED] };
for (const t of MODEL.tables) db.exec(dataModel.ddlForTable(t, { tableKeyById: new Map(), dialect: 'sqlite' }));

const USER = { kind: 'user' };
const viewer = { id: OWNER, role: 'owner' };
const stepCtx = (extra = {}) => ({ viewerId: OWNER, viewer: { id: OWNER }, role: 'owner', vars: {}, ...extra });
const lit = (value) => ({ kind: 'static', value });

/** The deliveries the outbox was handed. */
let recorded;
let reads;
test.beforeEach(() => {
    db.exec('DELETE FROM "orders"; DELETE FROM "plain"; DELETE FROM "priced";');
    executed.length = 0;
    recorded = [];
    reads = 0;
    _setOutboxDeps({
        store: () => ({
            armedRecordTriggers: async () => {
                reads += 1;
                return [ORDERS, PRICED].map((armed) => ({ appId: app.id, triggerId: `on_${armed.name}`, config: { tableId: armed.id, on: ['create', 'update', 'delete'] } }));
            },
            add: async (list) => { recorded.push(...list); return { written: list.length, dropped: [] }; },
            noteSkip: async () => {},
        }),
        now: () => 1_000_000,
        limits: () => recordTriggerLimits({}),
        log: { warn() {} },
    });
});
test.after(() => _setOutboxDeps({}));

const seen = () => recorded.map((d) => [d.event, d.tableId, d.before && d.before.title, d.after && d.after.title]);

test('the record API path (writeRecord / eraseRecord with an origin) records create, update and delete with the real rows', async () => {
    const { id } = await writeRecord(app, MODEL, ORDERS, { title: 'A', qty: 1 }, { viewer, source: USER });
    await writeRecord(app, MODEL, ORDERS, { title: 'B' }, { viewer, recordId: id, source: USER });
    await eraseRecord(app, MODEL, ORDERS, id, { viewer, source: USER });
    assert.deepEqual(seen(), [['create', ORDERS.id, null, 'A'], ['update', ORDERS.id, 'A', 'B'], ['delete', ORDERS.id, 'B', null]]);
    assert.equal(recorded[0].after.id, id);
    assert.equal(recorded[0].after.qty, 1);
    assert.deepEqual([recorded[0].writerKind, recorded[0].depth, recorded[0].causeTriggerId], ['owner', 0, null]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "orders"').get().n, 0);
});

test('a table with column rights and an armed trigger: a role that does not read a field still writes its rows, and the change is recorded as the owner reads it', async () => {
    const agent = { id: 'u-agent', role: 'agent' };
    const { id } = await writeRecord(app, MODEL, PRICED, { title: 'A', margin: 12 }, { viewer: { id: 'u-boss', role: 'manager' }, source: USER });
    const out = await writeRecord(app, MODEL, PRICED, { title: 'B' }, { viewer: agent, recordId: id, source: USER });
    assert.equal(out.changes, 1);
    assert.deepEqual(recorded.map((d) => [d.event, d.writerKind, d.before && d.before.margin, d.after && d.after.title, d.after && d.after.margin]),
        [['create', 'member', null, 'A', 12], ['update', 'member', 12, 'B', 12]]);
    await assert.rejects(() => writeRecord(app, MODEL, PRICED, { margin: 99 }, { viewer: agent, recordId: id, source: USER }), { code: 'field_not_writable' });
    assert.equal(recorded.length, 2, 'a refused write records nothing');
});

test('an update that matches no row answers 0 changes and records nothing; a compare-and-set that loses does the same', async () => {
    const { id } = await writeRecord(app, MODEL, ORDERS, { title: 'A' }, { viewer, source: USER });
    recorded.length = 0;
    assert.equal((await writeRecord(app, MODEL, ORDERS, { title: 'B' }, { viewer, recordId: 'missing', source: USER })).changes, 0);
    assert.equal((await writeRecord(app, MODEL, ORDERS, { title: 'B' }, { viewer, recordId: id, expectedUpdatedAt: '2001-01-01T00:00:00.000Z', source: USER })).changes, 0);
    assert.equal((await eraseRecord(app, MODEL, ORDERS, 'missing', { viewer, source: USER })).changes, 0);
    assert.deepEqual(recorded, []);
});

test('the three record steps record when the host says where the write comes from, and carry a trigger run\'s chain', async () => {
    const made = await executeDataStep(app, MODEL, { kind: 'create_record', tableId: ORDERS.id, values: { title: lit('S') } }, stepCtx({ writeSource: USER }));
    const id = made.result.id;
    const chain = { kind: 'trigger', depth: 2, triggerId: 'on_other' };
    await executeDataStep(app, MODEL, { kind: 'update_record', tableId: ORDERS.id, recordId: lit(id), values: { title: lit('T') } }, stepCtx({ writeSource: chain }));
    await executeDataStep(app, MODEL, { kind: 'delete_record', tableId: ORDERS.id, recordId: lit(id) }, stepCtx({ writeSource: chain }));
    assert.deepEqual(seen(), [['create', ORDERS.id, null, 'S'], ['update', ORDERS.id, 'S', 'T'], ['delete', ORDERS.id, 'T', null]]);
    assert.deepEqual(recorded.map((d) => [d.writerKind, d.depth, d.causeTriggerId]), [['owner', 0, null], ['trigger', 2, 'on_other'], ['trigger', 2, 'on_other']]);
});

test('matrix: the write paths that do NOT fire a record trigger, on an armed table', async () => {
    const { id } = await writeRecord(app, MODEL, ORDERS, { title: 'seed' }, { viewer });
    const paths = {
        'writeRecord without an origin (seeding, sync, builder tools, hooks, imports)': () => writeRecord(app, MODEL, ORDERS, { title: 'x' }, { viewer }),
        'writeRecord update without an origin': () => writeRecord(app, MODEL, ORDERS, { title: 'y' }, { viewer, recordId: id }),
        'writeRecordBatch (ai_extract rows, connector sync)': () => writeRecordBatch(app, MODEL, ORDERS, [{ title: 'b1' }, { title: 'b2' }], { viewer }),
        'a record step in a host that names no origin (MCP runs and tests, the mailbox hook)': () => executeDataStep(app, MODEL, { kind: 'create_record', tableId: ORDERS.id, values: { title: lit('m') } }, stepCtx()),
        'update_record with a filter (bulk)': () => executeDataStep(app, MODEL, { kind: 'update_record', tableId: ORDERS.id, filter: [{ field: 'title', op: 'eq', value: lit('seed') }], values: { qty: lit(5) } }, stepCtx({ writeSource: USER })),
        'delete_record with a filter (bulk)': () => executeDataStep(app, MODEL, { kind: 'delete_record', tableId: ORDERS.id, filter: [{ field: 'title', op: 'eq', value: lit('b1') }] }, stepCtx({ writeSource: USER })),
        'a transaction step': () => executeDataStep(app, MODEL, { kind: 'transaction', steps: [{ kind: 'create_record', tableId: ORDERS.id, values: { title: lit('tx') } }] }, stepCtx({ writeSource: USER })),
        'eraseRecord without an origin': () => eraseRecord(app, MODEL, ORDERS, id, { viewer }),
    };
    for (const [label, run] of Object.entries(paths)) {
        const out = await run();
        assert.notEqual(out && out.ok, false, `${label}: the write itself worked (${out && out.error})`);
        assert.deepEqual(recorded, [], label);
    }
    assert.equal(reads, 0, 'none of these paths even asks for the armed list');
});

test('a table without an armed trigger runs the one statement it always ran, with or without an origin', async () => {
    await writeRecord(app, MODEL, PLAIN, { title: 'A' }, { viewer });
    const before = executed.slice();
    executed.length = 0;
    const { id } = await writeRecord(app, MODEL, PLAIN, { title: 'A' }, { viewer, source: USER });
    assert.deepEqual(executed, before, 'the same single INSERT');
    executed.length = 0;
    await writeRecord(app, MODEL, PLAIN, { title: 'B' }, { viewer, recordId: id, source: USER });
    await eraseRecord(app, MODEL, PLAIN, id, { viewer, source: USER });
    assert.equal(executed.length, 2, 'one UPDATE, one DELETE');
    assert.deepEqual(recorded, []);
    assert.equal(reads, 1, 'the armed list is read once and then kept in memory');
});

test('an outbox that cannot be written never fails the write that already happened', async () => {
    _setOutboxDeps({
        store: () => ({
            armedRecordTriggers: async () => [{ appId: app.id, triggerId: 'on_orders', config: { tableId: ORDERS.id, on: ['create'] } }],
            add: async () => { throw new Error('down'); },
            noteSkip: async () => {},
        }),
        now: () => 1, limits: () => recordTriggerLimits({}), log: { warn() {} },
    });
    const { id, created } = await writeRecord(app, MODEL, ORDERS, { title: 'A' }, { viewer, source: USER });
    assert.equal(created, true);
    assert.equal(db.prepare('SELECT title FROM "orders" WHERE id = ?').get(id).title, 'A');
});

test('an armed list that cannot be read records nothing and writes the usual way', async () => {
    _setOutboxDeps({ store: () => ({ armedRecordTriggers: async () => { throw new Error('down'); } }), now: () => 1, limits: () => recordTriggerLimits({}), log: { warn() {} } });
    executed.length = 0;
    await writeRecord(app, MODEL, ORDERS, { title: 'A' }, { viewer, source: USER });
    assert.equal(executed.length, 1);
});

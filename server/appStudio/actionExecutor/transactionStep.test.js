/**
 * The `transaction` step against a REAL SQLite engine (the same blob engine
 * App Studio runs on): all children commit together, or none does.
 *
 * Run: cd server && node --test appStudio/actionExecutor/transactionStep.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRecordingDb } = require('../../testUtils/mockDb');
const { createSqliteBlobEngine } = require('../../stores/lib/sqliteBlobEngine');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { transactionStep } = require('./transactionStep.mts');

const OWNER = 'owner-tx';
const workDir = path.join(os.tmpdir(), `beeflow-tx-step-test-${process.pid}`);
const engine = createSqliteBlobEngine({
    workDir,
    buildKey: (ownerId, id) => `apps/${ownerId}/${id}/data.db`,
    metaTable: 'things',
    logPrefix: 'TxTest',
    entityLabel: 'Tx test DB',
    storage: { isAvailable: () => false, streamFile: async () => { throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); }, uploadFile: async () => ({}), deleteFile: async () => {} },
    runQuery: createRecordingDb({ tables: { things: [] } }).db.run,
    statementTimeoutMs: 0,
});
test.after(() => { engine.closeAll(); fs.rmSync(workDir, { recursive: true, force: true }); });

const OPEN = { default: 'app', roles: {}, rowFilters: {} };
const ORDERS = { id: 'tbl_orders', key: 'orders', name: 'Orders', fields: [{ id: 'fld_n', key: 'name', type: 'text' }], access: OPEN };
const LINES = {
    id: 'tbl_lines', key: 'lines', name: 'Lines', access: OPEN,
    fields: [{ id: 'fld_o', key: 'order_id', type: 'text' }, { id: 'fld_q', key: 'qty', type: 'number', subtype: 'integer' }],
};
const LINKED = { id: 'tbl_linked', key: 'linked', name: 'Linked', fields: [], access: OPEN, source: { kind: 'datatable', datatableId: 'dt_1', mode: 'write' } };
const model = { modelVersion: 1, tables: [ORDERS, LINES, LINKED], roles: [], roleMapping: { default: 'app', byGroup: {} } };

async function freshApp() {
    const app = { id: `app-${crypto.randomBytes(6).toString('hex')}`, userId: OWNER, organizationId: 'org-1' };
    for (const t of [ORDERS, LINES]) await engine.exec(OWNER, app.id, ddlForTable(t, { dialect: 'sqlite', rowScope: 'all' }));
    return app;
}

const bumps = [];
const counts = [];
function deps(extra = {}) {
    return {
        db: { batch: (o, a, s) => engine.batch(o, a, s) },
        quota: { assertRowQuota: async () => {}, assertDbByteQuota: async () => {} },
        records: {
            bumpVersion: async (_app, key) => { bumps.push(key); },
            bumpCount: async (_app, key, n) => { counts.push([key, n]); },
        },
        ...extra,
    };
}
const ctx = { viewerId: OWNER, role: 'owner', viewer: { id: OWNER }, vars: {}, formValues: {} };
const stat = (value) => ({ kind: 'static', value });
const rowsOf = async (app, table) => (await engine.query(OWNER, app.id, `SELECT * FROM "${table}"`)).rows;

test.beforeEach(() => { bumps.length = 0; counts.length = 0; });

test('spec: a transaction with a failing update leaves no earlier create behind', async () => {
    const app = await freshApp();
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('A') } },
        { kind: 'update_record', tableId: 'tbl_orders', recordId: stat('rec_missing'), values: { name: stat('B') } },
    ] }, ctx, deps());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'transaction_rolled_back');
    assert.equal(res.retryable, false);
    assert.match(res.error, /^Step 2 of the transaction \(update_record\): Record not found\. Nothing was saved\.$/);
    assert.deepEqual(await rowsOf(app, 'orders'), [], 'the create of step 1 was rolled back');
    assert.deepEqual(bumps, [], 'no bookkeeping for a rolled-back batch');
});

test('the row quota sees every create of the batch: per table and in total', async () => {
    const app = await freshApp();
    const asked = [];
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('A') } },
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('B') } },
        { kind: 'create_record', tableId: 'tbl_lines', values: { qty: stat(1) } },
    ] }, ctx, deps({ quota: { assertRowQuota: async (_a, name, n, total) => { asked.push([name, n, total]); }, assertDbByteQuota: async () => {} } }));
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(asked.sort(), [['lines', 1, 3], ['orders', 2, 3]]);
});

test('an order and its line commit together; the line reads vars.order.id', async () => {
    const app = await freshApp();
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('Order 1') }, resultVar: 'order' },
        { kind: 'create_record', tableId: 'tbl_lines', values: { order_id: { kind: 'formula', expr: 'vars.order.id' }, qty: stat(3) }, resultVar: 'line' },
    ] }, ctx, deps());
    assert.equal(res.ok, true, res.error);
    const [order] = await rowsOf(app, 'orders');
    const [line] = await rowsOf(app, 'lines');
    assert.equal(line.order_id, order.id);
    assert.equal(res.result.count, 2);
    assert.equal(res.result.vars.order.id, order.id);
    assert.equal(res.result.vars.line.id, line.id);
    assert.deepEqual(res.result.results.map((r) => r.created), [true, true]);
    assert.deepEqual(bumps.sort(), ['lines', 'orders'], 'one version bump per table');
    assert.deepEqual(counts.sort(), [['lines', 1], ['orders', 1]]);
});

test('update and delete inside a transaction; versions bumped once per table', async () => {
    const app = await freshApp();
    const made = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('x') }, resultVar: 'a' },
        { kind: 'update_record', tableId: 'tbl_orders', recordId: { kind: 'formula', expr: 'vars.a.id' }, values: { name: stat('y') } },
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('z') }, resultVar: 'b' },
        { kind: 'delete_record', tableId: 'tbl_orders', recordId: { kind: 'formula', expr: 'vars.b.id' } },
    ] }, ctx, deps());
    assert.equal(made.ok, true, made.error);
    const rows = await rowsOf(app, 'orders');
    assert.deepEqual(rows.map((r) => r.name), ['y']);
    assert.deepEqual(bumps, ['orders']);
    assert.deepEqual(counts, [['orders', 1]], 'two creates and a delete: net +1');
});

test('a linked (datatable-backed) table is refused before anything runs', async () => {
    const app = await freshApp();
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('A') } },
        { kind: 'create_record', tableId: 'tbl_linked', values: {} },
    ] }, ctx, deps());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'transaction_linked_table');
    assert.match(res.error, /Step 2 of the transaction/);
    assert.deepEqual(await rowsOf(app, 'orders'), []);
});

test('a child of another kind is refused', async () => {
    const app = await freshApp();
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [{ kind: 'send_email' }] }, ctx, deps());
    assert.equal(res.ok, false);
    assert.equal(res.code, 'transaction_invalid');
    assert.match(res.error, /holds only create_record, update_record and delete_record/);
});

test('expectedUpdatedAt that no longer matches gives the conflict sentence and rolls back', async () => {
    const app = await freshApp();
    const first = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('A') }, resultVar: 'a' },
    ] }, ctx, deps());
    const id = first.result.vars.a.id;
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('B') } },
        { kind: 'update_record', tableId: 'tbl_orders', recordId: stat(id), values: { name: stat('A2') }, expectedUpdatedAt: stat('2000-01-01T00:00:00.000Z') },
    ] }, ctx, deps());
    assert.equal(res.ok, false);
    assert.match(res.error, /Step 2 of the transaction \(update_record\): This record was changed by someone else/);
    assert.match(res.error, /Nothing was saved\.$/);
    assert.deepEqual((await rowsOf(app, 'orders')).map((r) => r.name), ['A']);
});

test('an empty transaction is a no-op; more than the cap is refused', async () => {
    const app = await freshApp();
    assert.deepEqual(await transactionStep(app, model, { kind: 'transaction', steps: [] }, ctx, deps()), { ok: true, result: { results: [], vars: {}, count: 0 } });
    const many = Array.from({ length: 51 }, () => ({ kind: 'create_record', tableId: 'tbl_orders', values: {} }));
    const res = await transactionStep(app, model, { kind: 'transaction', steps: many }, ctx, deps());
    assert.equal(res.code, 'transaction_too_many');
});

test('another database failure goes through describeStepError and still says nothing was saved', async () => {
    const app = await freshApp();
    const boom = { batch: async () => { throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }); } };
    const res = await transactionStep(app, model, { kind: 'transaction', steps: [
        { kind: 'create_record', tableId: 'tbl_orders', values: { name: stat('A') } },
    ] }, ctx, deps({ db: boom }));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'db_busy');
    assert.equal(res.retryable, true);
    assert.match(res.error, /busy.*Nothing was saved\.$/);
    assert.doesNotMatch(res.error, /SQLITE_BUSY/);
});

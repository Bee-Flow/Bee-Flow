'use strict';

/**
 * Data bindings resolved for a server walk. The read seam (`readData`) here compiles with the
 * REAL query compiler and access filter, exactly as stepDataSource does before it queries, and
 * runs the SELECT on the app's real engine: better-sqlite3 with the table laid down by the real
 * migration planner (testUtils/linkedEngines.testkit.js, which boots PGlite beside it). What the
 * walk asks for is what the rows show, without mocking a store through the module system.
 *
 * Run: cd server && node --test appStudio/runBindings.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { bootLinkedEngines } = require('../testUtils/linkedEngines.testkit');
const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const stepDataSource = require('./stepDataSource');

const queryCalls = [];
/** @type {{ sqlite: any }} */
let engines;
const closers = [];

const tableOf = (model, id) => model.tables.find((t) => t.id === id) || null;

/** stepDataSource.resolveDataBinding's compile half, run on the app engine. */
async function compilingRead(app, model, binding, { viewer, role, resolveValue, maxRows }) {
    const table = tableOf(model, binding.tableId);
    if (!table) return null;
    const { filters, blocked } = stepDataSource._resolveFilters(binding.filter, resolveValue);
    if (blocked) return binding.kind === 'record' ? null : [];
    const accessFilter = rlsGateway.compileAccessFilter(table, role, viewer, 'read', {});
    const limit = Math.min(Number.isFinite(binding.limit) ? binding.limit : maxRows, maxRows);
    const compiled = binding.kind === 'aggregate'
        ? queryCompiler.compileAggregate(table, { filters, groupBy: binding.groupBy, aggregates: binding.aggregates, sort: binding.sort, limit }, accessFilter)
        : queryCompiler.compileRecordList(table, { filters, sort: binding.sort, limit: binding.kind === 'record' ? 1 : limit }, accessFilter);
    queryCalls.push({ ownerId: app.userId, maxRows });
    const rows = await engines.sqlite.all(compiled.sql, compiled.params);
    if (binding.kind === 'record') return rows[0] ?? null;
    return rows;
}

const { resolveRunBinding, applyPick, DEFAULT_LIMIT } = require('./runBindings.mts');
const { buildServerScope } = require('./actionExecutor/shared');

const OWNER = 'owner-1';
const app = { id: 'app-1', userId: OWNER, organizationId: 'org-1' };
const model = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_t', key: 'tickets', name: 'Tickets',
        fields: [
            { id: 'f_s', key: 'status', type: 'text' },
            { id: 'f_c', key: 'customer', type: 'text' },
            { id: 'f_a', key: 'amount', type: 'number' },
        ],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};

function env(vars = {}, over = {}) {
    const ctx = { viewerId: OWNER, role: 'owner', formValues: {}, vars, viewer: { id: OWNER, role: 'owner' } };
    return { app, model, ctx, scope: buildServerScope(ctx), maxRows: 200, readData: compilingRead, ...over };
}

before(async () => { engines = await bootLinkedEngines(model, closers); });
after(() => { for (const close of closers) close(); });
beforeEach(async () => {
    queryCalls.length = 0;
    await engines.sqlite.run('DELETE FROM tickets', []);
});

let seq = 0;
/** Ticket rows of the app. */
async function tickets(rows) {
    for (const r of rows) {
        await engines.sqlite.run('INSERT INTO tickets (id, status, customer, amount) VALUES (?, ?, ?, ?)',
            [r.id || `r${++seq}`, r.status ?? null, r.customer ?? null, r.amount ?? null]);
    }
}
const pickRows = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

test('a records binding without a limit reads what a screen gets: 51 rows (the probe row past 50)', async () => {
    await tickets(Array.from({ length: 60 }, (_, i) => ({ id: `o${String(i).padStart(2, '0')}`, status: 'open' })));
    await tickets([{ id: 'closed-1', status: 'closed' }]);
    const rows = await resolveRunBinding({ kind: 'records', tableId: 'tbl_t', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.status' } }] }, env({ status: 'open' }));
    assert.equal(DEFAULT_LIMIT, 50);
    assert.equal(rows.length, 51);
    assert.ok(rows.every((r) => r.status === 'open'), 'the formula-valued filter reached the query as a literal');
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].ownerId, OWNER);
});

test('a limit above maxRows is capped at maxRows (plus the probe row)', async () => {
    await tickets(Array.from({ length: 250 }, () => ({ status: 'open' })));
    const rows = await resolveRunBinding({ kind: 'records', tableId: 'tbl_t', limit: 5000 }, env({}, { maxRows: 200 }));
    assert.equal(rows.length, 201);
});

test('a required filter without a value reads no rows and sends no query', async () => {
    const notes = [];
    const rows = await resolveRunBinding(
        { kind: 'records', tableId: 'tbl_t', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.missing' }, required: true }] },
        env({}, { onNote: (t) => notes.push(t), where: 'steps[0]' }),
    );
    assert.deepEqual(rows, []);
    assert.equal(queryCalls.length, 0);
    assert.match(notes[0], /^steps\[0\]: a required filter/);
    const one = await resolveRunBinding({ kind: 'record', tableId: 'tbl_t', filter: [{ field: 'status', op: 'eq', value: '', required: true }] }, env());
    assert.equal(one, null);
});

test('an aggregate binding resolves a formula-valued groupBy before it compiles', async () => {
    await tickets([{ status: 'open' }, { status: 'open' }, { status: 'open' }, { status: 'closed' }]);
    const out = await resolveRunBinding({
        kind: 'aggregate', tableId: 'tbl_t',
        groupBy: { kind: 'formula', expr: 'vars.dimension' },
        aggregates: [{ fn: 'count', as: 'n' }],
    }, env({ dimension: [{ field: 'status' }] }));
    assert.deepEqual(pickRows(out, ['status', 'n']).sort((a, b) => a.status.localeCompare(b.status)), [{ status: 'closed', n: 1 }, { status: 'open', n: 3 }]);
    assert.equal(queryCalls.length, 1);
});

test('pick narrows the rows to one value; a record binding applies its path', async () => {
    await tickets([{ id: 'r1', customer: 'Ada', amount: 4 }, { id: 'r2', customer: 'Bo', amount: 9 }]);
    const sort = [{ field: 'amount', dir: 'asc' }];
    assert.equal(await resolveRunBinding({ kind: 'records', tableId: 'tbl_t', sort, pick: { row: 'last', column: 'amount' } }, env()), 9);
    assert.equal(await resolveRunBinding({ kind: 'record', tableId: 'tbl_t', sort, path: 'customer' }, env()), 'Ada');
    assert.equal(applyPick([], { column: 'x' }), undefined);
    assert.deepEqual(applyPick([{ a: 1 }], { row: 'first' }), { a: 1 });
});

test('an unknown table reads as nothing, with a note; static and formula bindings resolve as before', async () => {
    const notes = [];
    assert.equal(await resolveRunBinding({ kind: 'records', tableId: 'tbl_gone' }, env({}, { onNote: (t) => notes.push(t) })), null);
    assert.match(notes[0], /returned nothing .*app_query_data/);
    assert.equal(await resolveRunBinding({ kind: 'static', value: 3 }, env()), 3);
    assert.equal(await resolveRunBinding({ kind: 'formula', expr: 'vars.a + 1' }, env({ a: 1 })), 2);
    assert.equal(await resolveRunBinding({ kind: 'connector', connectorId: 'c1' }, env({}, { onNote: (t) => notes.push(t) })), null);
    assert.match(notes[1], /connector bindings are not read here/);
});

test('onRead is called before each read and may refuse it', async () => {
    let n = 0;
    const e = env({}, { onRead: () => { n += 1; if (n > 1) throw Object.assign(new Error('read cap'), { safe: true }); } });
    await resolveRunBinding({ kind: 'records', tableId: 'tbl_t' }, e);
    await assert.rejects(resolveRunBinding({ kind: 'records', tableId: 'tbl_t' }, e), /read cap/);
    assert.equal(queryCalls.length, 1);
});

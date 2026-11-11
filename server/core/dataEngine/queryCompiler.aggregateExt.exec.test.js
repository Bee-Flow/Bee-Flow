/**
 * countDistinct, numeric bins, groupFilter and groupBy through a relation,
 * EXECUTED on both engines (better-sqlite3 in memory, Postgres through PGlite)
 * against the same rows:
 *   - each result equals a plain evaluation of the same question over the rows
 *     the viewer may read, and both engines agree;
 *   - grouping through a relation applies the RELATED table's row rules: an
 *     order whose customer the viewer may not read still counts, in the empty
 *     group, and no value of such a customer appears in the answer;
 *   - the join never multiplies rows (every visible order is counted once).
 *
 * Run: cd server && node --test core/dataEngine/queryCompiler.aggregateExt.exec.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../../testUtils/routeHarness').recordDb();

const qc = require('./queryCompiler');
const { compileAccessFilter } = require('./accessFilter');
const { CUSTOMER_FIELDS, readableCustomer, seedRelationEngines } = require('../../testUtils/relationEngines.testkit');

const MEMBER_ACCESS = { default: 'none', roles: { member: { read: 'all', create: true, update: 'own', delete: 'none' } } };
const CUSTOMERS = {
    id: 'tbl_cust01',
    key: 'customers',
    fields: [...CUSTOMER_FIELDS],
    // A member reads only the retail customers.
    access: { ...MEMBER_ACCESS, rowFilters: { member: 'record.segment == "retail"' } },
};
const ORDERS = {
    id: 'tbl_ord01',
    key: 'orders',
    fields: [
        { id: 'o1', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'o3', key: 'channel', type: 'text' },
    ],
    access: { default: 'none', roles: { member: { read: 'own', create: true, update: 'own', delete: 'none' } } },
};
const VIEWER = { id: 'u1' };


/** 40 orders of u1 (some without a customer, negative amounts, empty amounts) plus orders of u2. */
function orderRows() {
    const customers = ['cus_a', 'cus_b', 'cus_c', 'cus_d', null];
    const channels = ['web', 'shop', null];
    const rows = [];
    for (let i = 0; i < 40; i += 1) {
        rows.push({ values: { amount: i % 9 === 0 ? null : (i * 37) % 230 - 30, customer: customers[i % 5], channel: channels[i % 3] }, owner: 'u1' });
    }
    for (let i = 0; i < 8; i += 1) rows.push({ values: { amount: 1000 + i, customer: 'cus_c', channel: 'web' }, owner: 'u2' });
    return rows;
}

/** @type {Record<string, (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>>} */
const engines = {};
const closers = [];
const seeded = [];
test.after(async () => { for (const close of closers) await close(); });

test('(setup) the same customers and orders on SQLite and on Postgres', async () => {
    await seedRelationEngines({ customers: CUSTOMERS, orders: ORDERS, orderRows: orderRows(), engines, seeded, closers });
    assert.strictEqual(seeded.length, 48);
});

/** The member's own orders, as the main access predicate admits them. */
const visibleOrders = () => seeded.filter((o) => o.owner === 'u1');

/** Compile for the member and run on one engine; numbers normalised (pg NUMERIC/BIGINT arrive as text). */
async function run(dialect, opts) {
    const access = compileAccessFilter(ORDERS, 'member', VIEWER, 'read', { dialect });
    const related = { customer: { tableMeta: CUSTOMERS, accessFilter: compileAccessFilter(CUSTOMERS, 'member', VIEWER, 'read', { dialect }) } };
    const { sql, params } = qc.compileAggregate(ORDERS, { ...opts, dialect }, access, related);
    const rows = await engines[dialect](sql, params);
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
}

const byKey = (key) => (a, b) => String(a[key]).localeCompare(String(b[key]));

/** Group rows by a key function into { [key]: rows }. */
function groupOf(rows, keyFn) {
    const out = new Map();
    for (const r of rows) {
        const k = keyFn(r);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(r);
    }
    return out;
}

test('countDistinct counts the different non-empty values, the same on both engines', async () => {
    const expected = [...groupOf(visibleOrders(), (o) => o.channel)]
        .map(([channel, rows]) => ({ channel, customers: new Set(rows.map((r) => r.customer).filter(Boolean)).size }))
        .sort(byKey('channel'));
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await run(dialect, { groupBy: [{ field: 'channel' }], aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'customers' }] });
        assert.deepStrictEqual(rows.sort(byKey('channel')), expected, dialect);
    }
});

test('binWidth folds numbers onto the lower bound of their step, negatives included', async () => {
    const expected = [...groupOf(visibleOrders(), (o) => (o.amount === null ? null : Math.floor(o.amount / 50) * 50))]
        .map(([band, rows]) => ({ band, n: rows.length }))
        .sort((a, b) => (a.band ?? -Infinity) - (b.band ?? -Infinity));
    assert.ok(expected.some((e) => e.band !== null && e.band < 0), 'the rows hold a negative step');
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await run(dialect, { groupBy: [{ field: 'amount', binWidth: 50, as: 'band' }], aggregates: [{ fn: 'count', as: 'n' }] });
        rows.sort((a, b) => (a.band ?? -Infinity) - (b.band ?? -Infinity));
        assert.deepStrictEqual(rows, expected, dialect);
    }
});

test('groupFilter keeps only the groups whose aggregate passes', async () => {
    const all = [...groupOf(visibleOrders(), (o) => o.channel)].map(([channel, rows]) => ({ channel, n: rows.length }));
    const threshold = Math.min(...all.map((g) => g.n)) + 1;
    const expected = all.filter((g) => g.n >= threshold).sort(byKey('channel'));
    assert.ok(expected.length > 0 && expected.length < all.length, 'the threshold drops some groups and keeps others');
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await run(dialect, { groupBy: [{ field: 'channel' }], aggregates: [{ fn: 'count', as: 'n' }], groupFilter: [{ field: 'n', op: 'gte', value: threshold }] });
        assert.deepStrictEqual(rows.sort(byKey('channel')), expected, dialect);
    }
});

test('grouping through a relation applies the related table\'s row rules', async () => {
    const expected = [...groupOf(visibleOrders(), (o) => { const c = readableCustomer(o.customer); return c ? c.name : null; })]
        .map(([who, rows]) => ({ who, n: rows.length }))
        .sort(byKey('who'));
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await run(dialect, { groupBy: [{ field: 'customer', relatedField: 'name', as: 'who' }], aggregates: [{ fn: 'count', as: 'n' }] });
        rows.sort(byKey('who'));
        assert.deepStrictEqual(rows, expected, dialect);
        const names = rows.map((r) => r.who);
        assert.ok(!names.includes('Charlie') && !names.includes('Delta'), `${dialect}: no name of a customer the member may not read`);
        assert.strictEqual(rows.reduce((s, r) => s + r.n, 0), visibleOrders().length, `${dialect}: every visible order counted once`);
    }
});

test('a related column takes a bin, a percentile and a groupFilter on both engines', async () => {
    const results = {};
    for (const dialect of ['sqlite', 'pg']) {
        results[dialect] = (await run(dialect, {
            groupBy: [{ field: 'customer', relatedField: 'staff', binWidth: 100, as: 'size' }],
            aggregates: [{ fn: 'p50', field: 'amount', as: 'median' }, { fn: 'count', as: 'n' }],
            groupFilter: [{ field: 'n', op: 'gt', value: 0 }],
        })).sort((a, b) => (a.size ?? -1) - (b.size ?? -1));
    }
    assert.deepStrictEqual(results.sqlite, results.pg);
    // Retail customers have 4 and 120 staff: steps 0 and 100; every other order is in the empty step.
    assert.deepStrictEqual(results.sqlite.map((r) => r.size), [null, 0, 100]);
});

test('without a relation map a relatedField is refused, never read unscoped', () => {
    assert.throws(() => qc.compileAggregate(ORDERS, { groupBy: [{ field: 'customer', relatedField: 'name' }], dialect: 'sqlite' },
        compileAccessFilter(ORDERS, 'member', VIEWER, 'read', { dialect: 'sqlite' })), /not available/);
});

/**
 * Record reads through a relation, EXECUTED on both engines (better-sqlite3 in
 * memory, Postgres through PGlite) against the same rows:
 *   - expand puts the related row on each record under the RELATED table's row
 *     rules: a customer the viewer may not read expands to null, exactly like
 *     an order without a customer, and no value of such a customer leaves;
 *   - a role that may not read the related table at all gets null everywhere
 *     and no lookup runs;
 *   - a `<relation>.<column>` filter matches only through related rows the
 *     viewer may read, and its negation tells such rows apart from nothing;
 *   - `fields` returns `id` and the listed columns only, and paging on a
 *     column outside the list still walks every row once.
 *
 * Run: cd server && node --test core/dataEngine/relationRead.exec.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../../testUtils/routeHarness').recordDb();

const qc = require('./queryCompiler');
const { ddlForTable } = require('./dataModel/ddl');
const { compileAccessFilter } = require('./accessFilter');
const { relationRead, finishRecords } = require('./relationRead.mts');
const { toDollarParams } = require('../../stores/lib/pgAppEngine');

const CUSTOMERS = {
    id: 'tbl_cust01',
    key: 'customers',
    fields: [
        { id: 'c1', key: 'name', type: 'text' },
        { id: 'c2', key: 'segment', type: 'text' },
        { id: 'c3', key: 'staff', type: 'number', subtype: 'integer' },
    ],
    // A member reads only the retail customers; an outsider reads none of the table.
    access: { default: 'none', roles: { member: { read: 'all' } }, rowFilters: { member: 'record.segment == "retail"' } },
};
const ORDERS = {
    id: 'tbl_ord01',
    key: 'orders',
    fields: [
        { id: 'o1', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'o2', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01', displayField: 'name' } },
        { id: 'o3', key: 'channel', type: 'text' },
    ],
    access: { default: 'none', roles: { member: { read: 'own' }, outsider: { read: 'own' } } },
};
const MODEL = { tables: [CUSTOMERS, ORDERS] };
const VIEWER = { id: 'u1' };

const CUSTOMER_ROWS = [
    { id: 'cus_a', name: 'Alpha', segment: 'retail', staff: 4 },
    { id: 'cus_b', name: 'Bravo', segment: 'retail', staff: 120 },
    { id: 'cus_c', name: 'Charlie', segment: 'wholesale', staff: 55 },
    { id: 'cus_d', name: 'Delta', segment: 'public', staff: 7 },
];
const HIDDEN_NAMES = ['Charlie', 'Delta'];

/** 40 orders of u1 (every fifth without a customer, one pointing at a deleted customer) plus orders of u2. */
function orderRows() {
    const customers = ['cus_a', 'cus_b', 'cus_c', 'cus_d', null];
    const rows = [];
    for (let i = 0; i < 40; i += 1) rows.push({ values: { amount: (i * 37) % 230, customer: i === 39 ? 'cus_gone' : customers[i % 5], channel: i % 2 ? 'web' : 'shop' }, owner: 'u1' });
    for (let i = 0; i < 8; i += 1) rows.push({ values: { amount: 1000 + i, customer: 'cus_a', channel: 'web' }, owner: 'u2' });
    return rows;
}

/** @type {Record<string, (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>>} */
const engines = {};
/** @type {Record<string, Array<{ sql: string, params: unknown[] }>>} */
const ran = { sqlite: [], pg: [] };
const closers = [];
const seeded = [];
test.after(async () => { for (const close of closers) await close(); });

test('(setup) the same customers and orders on SQLite and on Postgres', async () => {
    const Database = require('better-sqlite3');
    const lite = new Database(':memory:');
    closers.push(() => lite.close());
    const { newPglite } = require('../../testUtils/pgliteTemplate');
    const pg = newPglite();
    closers.push(() => pg.close());
    engines.sqlite = async (sql, params) => {
        ran.sqlite.push({ sql, params });
        const stmt = lite.prepare(sql);
        return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
    };
    engines.pg = async (sql, params) => {
        ran.pg.push({ sql, params });
        return (await pg.query(toDollarParams(sql, params.length), params)).rows;
    };
    for (const table of [CUSTOMERS, ORDERS]) {
        lite.exec(ddlForTable(table, { dialect: 'sqlite' }));
        await pg.exec(ddlForTable(table, { dialect: 'pg' }));
    }
    const inserts = [
        ...CUSTOMER_ROWS.map(({ id, ...values }) => ({ table: CUSTOMERS, values, id, owner: 'u9' })),
        ...orderRows().map((row, n) => ({ table: ORDERS, values: row.values, id: `ord_${String(n).padStart(3, '0')}`, owner: row.owner })),
    ];
    for (const ins of inserts) {
        for (const dialect of ['sqlite', 'pg']) {
            const c = qc.compileInsert(ins.table, ins.values, { createdBy: ins.owner, orgId: 'o1', id: ins.id, dialect });
            await engines[dialect](c.sql, c.params);
        }
        if (ins.table === ORDERS) seeded.push({ id: ins.id, ...ins.values, owner: ins.owner });
    }
    assert.strictEqual(seeded.length, 48);
});

const visibleOrders = () => seeded.filter((o) => o.owner === 'u1');
const customerOf = (id) => CUSTOMER_ROWS.find((c) => c.id === id) || null;
/** The customer as the member may see it: retail only. */
const readableCustomer = (id) => { const c = customerOf(id); return c && c.segment === 'retail' ? c : null; };
const byId = (a, b) => String(a.id).localeCompare(String(b.id));

/** One page of orders for a role, through the compiler and the expansion step, on one engine. */
async function page(dialect, role, descriptor, own = {}) {
    const who = { role, viewer: VIEWER, dialect };
    const access = compileAccessFilter(ORDERS, role, VIEWER, 'read', { dialect });
    const read = relationRead(MODEL, ORDERS, descriptor, who);
    const compiled = qc.compileRecordList(ORDERS, { filters: descriptor.filters, sort: descriptor.sort, limit: 1000, ...own, dialect }, access, read);
    const rows = await engines[dialect](compiled.sql, compiled.params);
    const last = rows.length > compiled.limit ? rows[compiled.limit - 1] : null;
    const records = await finishRecords(compiled, rows.slice(0, compiled.limit), (sql, params) => engines[dialect](sql, params).then((r) => ({ rows: r })));
    return { records, nextCursor: last ? qc.nextCursor(compiled, last) : null };
}

test('expand puts the readable related row on each record and null for every other', async () => {
    const expected = visibleOrders().map((o) => {
        const c = readableCustomer(o.customer);
        return { id: o.id, customer: o.customer, customer_record: c ? { id: c.id, name: c.name, staff: c.staff, _label: c.name } : null };
    }).sort(byId);
    assert.ok(expected.some((e) => e.customer && !e.customer_record), 'some orders point at a customer the member may not read');
    for (const dialect of ['sqlite', 'pg']) {
        const { records } = await page(dialect, 'member', { expand: [{ field: 'customer', pick: ['name', 'staff'] }] });
        const got = records.map((r) => ({ id: r.id, customer: r.customer, customer_record: r.customer_record })).sort(byId);
        assert.deepStrictEqual(got, expected, dialect);
        const text = JSON.stringify(records);
        for (const name of HIDDEN_NAMES) assert.ok(!text.includes(name), `${dialect}: ${name} never leaves`);
        assert.ok(records.every((r) => Object.hasOwn(r, 'amount') && Object.hasOwn(r, 'channel')), `${dialect}: without fields every column still comes back`);
    }
});

test('without pick an expansion carries the display field', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const { records } = await page(dialect, 'member', { expand: [{ field: 'customer', as: 'who' }], filters: [{ field: 'customer', op: 'eq', value: 'cus_b' }] });
        assert.ok(records.length > 0);
        for (const r of records) assert.deepStrictEqual(r.who, { id: 'cus_b', name: 'Bravo', _label: 'Bravo' }, dialect);
    }
});

test('a role that may not read the related table gets null everywhere, and no lookup runs', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const before = ran[dialect].length;
        const { records } = await page(dialect, 'outsider', { expand: [{ field: 'customer', pick: ['name'] }] });
        assert.strictEqual(records.length, visibleOrders().length, dialect);
        assert.ok(records.every((r) => r.customer_record === null), dialect);
        assert.strictEqual(ran[dialect].length - before, 1, `${dialect}: only the list itself ran`);
    }
});

test('a filter through a relation matches only through related rows the viewer may read', async () => {
    const ids = (rows) => rows.map((r) => r.id).sort();
    const where = (fn) => ids(visibleOrders().filter(fn));
    const cases = [
        ['a readable value', [{ field: 'customer.segment', op: 'eq', value: 'retail' }], where((o) => !!readableCustomer(o.customer))],
        ['a value only hidden rows have', [{ field: 'customer.segment', op: 'eq', value: 'wholesale' }], []],
        ['a hidden name', [{ field: 'customer.name', op: 'contains', value: 'harl' }], []],
        ['neq still needs a readable row', [{ field: 'customer.segment', op: 'neq', value: 'nothing' }], where((o) => !!readableCustomer(o.customer))],
        ['a number of the related row', [{ field: 'customer.staff', op: 'gt', value: 50 }], where((o) => (readableCustomer(o.customer) || {}).staff > 50)],
        ['not: everything the clause did not match', [{ not: { field: 'customer.segment', op: 'eq', value: 'retail' } }], where((o) => !readableCustomer(o.customer))],
        ['or with a plain clause', [{ any: [{ field: 'customer.name', op: 'eq', value: 'Alpha' }, { field: 'amount', op: 'gt', value: 200 }] }],
            where((o) => (readableCustomer(o.customer) || {}).name === 'Alpha' || o.amount > 200)],
    ];
    for (const [name, filters, expected] of cases) {
        for (const dialect of ['sqlite', 'pg']) {
            const { records } = await page(dialect, 'member', { filters });
            assert.deepStrictEqual(ids(records), expected, `${name} (${dialect})`);
        }
    }
    // Negating a clause about a hidden value keeps exactly what negating any other value keeps: nothing is told apart.
    for (const dialect of ['sqlite', 'pg']) {
        const hidden = await page(dialect, 'member', { filters: [{ not: { field: 'customer.segment', op: 'eq', value: 'wholesale' } }] });
        const absent = await page(dialect, 'member', { filters: [{ not: { field: 'customer.segment', op: 'eq', value: 'no-such-segment' } }] });
        assert.deepStrictEqual(ids(hidden.records), ids(absent.records), dialect);
        assert.strictEqual(hidden.records.length, visibleOrders().length, dialect);
    }
});

test('a relation filter for a role without read on the related table matches nothing', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const { records } = await page(dialect, 'outsider', { filters: [{ field: 'customer.segment', op: 'eq', value: 'retail' }] });
        assert.deepStrictEqual(records, [], dialect);
    }
});

test('an aggregate takes the same filter', async () => {
    const expected = visibleOrders().filter((o) => !!readableCustomer(o.customer)).length;
    const { relatedForAggregate } = require('./aggregateRelated.mts');
    for (const dialect of ['sqlite', 'pg']) {
        const filters = [{ field: 'customer.segment', op: 'in', value: ['retail', 'wholesale'] }];
        const who = { role: 'member', viewer: VIEWER, dialect };
        const { sql, params } = qc.compileAggregate(ORDERS, { filters, aggregates: [{ fn: 'count', as: 'n' }], dialect },
            compileAccessFilter(ORDERS, 'member', VIEWER, 'read', { dialect }), relatedForAggregate(MODEL, ORDERS, undefined, who, filters));
        const rows = await engines[dialect](sql, params);
        assert.strictEqual(Number(rows[0].n), expected, dialect);
    }
});

test('fields returns id and the listed columns only; paging on a column outside the list walks every row once', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const seen = [];
        let cursor;
        for (let guard = 0; guard < 20; guard += 1) {
            const out = await page(dialect, 'member', { fields: ['channel'], expand: [{ field: 'customer', pick: ['name'] }], sort: [{ field: 'amount', dir: 'asc' }] }, { limit: 7, cursor });
            for (const r of out.records) {
                assert.deepStrictEqual(Object.keys(r).sort(), ['channel', 'customer_record', 'id'], dialect);
                seen.push(r.id);
            }
            cursor = out.nextCursor;
            if (!cursor) break;
        }
        const expected = visibleOrders().slice().sort((a, b) => a.amount - b.amount || byId(a, b)).map((o) => o.id);
        assert.deepStrictEqual(seen, expected, dialect);
    }
});

test('the lookups are batched, one query per batch of ids, and an empty page runs none', async () => {
    const plan = { field: 'customer', as: 'c', target: { tableMeta: CUSTOMERS, accessFilter: { where: '1=1', params: [] } }, pick: ['name'], label: null, dialect: 'sqlite' };
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `o${i}`, customer: `c${i % 430}` }));
    const calls = [];
    const out = await finishRecords({ expand: [plan] }, rows, async (sql, params) => {
        calls.push(params.length);
        return { rows: params.map((id) => ({ id, name: `n-${id}` })) };
    });
    assert.deepStrictEqual(calls, [qc.EXPAND_LOOKUP_BATCH, qc.EXPAND_LOOKUP_BATCH, 30]);
    assert.deepStrictEqual(out[449], { id: 'o449', customer: 'c19', c: { id: 'c19', name: 'n-c19' } });
    assert.strictEqual(rows[0].c, undefined, 'the rows handed in are not changed');
    const none = [];
    assert.deepStrictEqual(await finishRecords({ expand: [plan] }, [], async () => { none.push(1); return { rows: [] }; }), []);
    assert.strictEqual(none.length, 0);
    const same = [{ id: 'x' }];
    assert.strictEqual(await finishRecords({ sql: '', params: [] }, same, async () => ({ rows: [] })), same, 'a list without expand or fields is handed back as it is');
});

test('relationRead hands over nothing for a read that uses none of it, and never a table outside the app\'s own storage', () => {
    const who = { role: 'member', viewer: VIEWER, dialect: 'sqlite' };
    assert.strictEqual(relationRead(MODEL, ORDERS, { filters: [{ field: 'amount', op: 'gt', value: 1 }] }, who), undefined);
    assert.strictEqual(relationRead(MODEL, ORDERS, {}, who), undefined);
    assert.strictEqual(relationRead(MODEL, ORDERS, null, who), undefined);
    const linked = { tables: [{ ...CUSTOMERS, source: { kind: 'datatable', datatableId: 'dt_1' } }, ORDERS] };
    const read = relationRead(linked, ORDERS, { expand: [{ field: 'customer' }] }, who);
    assert.deepStrictEqual(read.related, {});
    assert.throws(() => qc.compileRecordList(ORDERS, { dialect: 'sqlite' }, compileAccessFilter(ORDERS, 'member', VIEWER, 'read', { dialect: 'sqlite' }), read),
        /linked Studio table cannot be read through a relation/);
    // The expand and fields of the CLIENT descriptor are never read by the compiler itself.
    const plain = qc.compileRecordList(ORDERS, { dialect: 'sqlite', expand: [{ field: 'customer' }], fields: ['amount'] }, compileAccessFilter(ORDERS, 'member', VIEWER, 'read', { dialect: 'sqlite' }));
    assert.ok(plain.sql.startsWith('SELECT * FROM'));
    assert.strictEqual(plain.expand, undefined);
});

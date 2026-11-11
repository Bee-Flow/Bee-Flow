/**
 * Lookup, rollup and many-relation fields (dataModel/linkedFields.js), EXECUTED on both engines
 * (SQLite in memory, Postgres through PGlite) against the same rows, with the tables laid down by
 * the real migration planner:
 *   - a lookup reads the related row's field under the RELATED table's row rules: a customer the
 *     viewer may not read looks up null, and none of its values leaves;
 *   - a rollup counts and sums only the child rows the viewer may read, with its own filter;
 *   - a many relation reads as the list of readable ids, expands to the readable rows, and
 *     `contains` / `notContains` tell an unreadable id apart from nothing;
 *   - filter, sort, group and aggregate on any of them are refused by name;
 *   - the junction drops a link with either of its rows (its foreign keys cascade).
 *
 * Run: cd server && node --test core/dataEngine/linkedRead.exec.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../../testUtils/routeHarness').recordDb();

const qc = require('./queryCompiler');
const { compileAccessFilter } = require('./accessFilter');
const { relationRead, finishRecords, fillLinkedRecords } = require('./relationRead.mts');
const { junctionName } = require('./dataModel/linkedFields');
const { bootLinkedEngines } = require('../../testUtils/linkedEngines.testkit');

const memberRule = (rule) => ({ default: 'none', roles: { member: { read: 'all' }, outsider: { read: 'all' } }, rowFilters: { member: rule } });
const CUSTOMERS = {
    id: 'tbl_cust01', key: 'customers',
    fields: [
        { id: 'fld_name01', key: 'name', type: 'text' },
        { id: 'fld_segm01', key: 'segment', type: 'text' },
        { id: 'fld_cnt001', key: 'order_count', type: 'rollup', rollup: { table: 'tbl_ord001', relation: 'customer', fn: 'count' } },
        { id: 'fld_open01', key: 'open_total', type: 'rollup', rollup: { table: 'orders', relation: 'customer', fn: 'sum', field: 'amount', filter: [{ field: 'status', op: 'eq', value: 'open' }] } },
        { id: 'fld_tags01', key: 'tags', type: 'relation', relation: { table: 'tbl_tag001', many: true, displayField: 'label' } },
    ],
    access: { ...memberRule('record.segment == "retail"'), default: 'none', roles: { member: { read: 'all' } } },
};
const ORDERS = {
    id: 'tbl_ord001', key: 'orders',
    fields: [
        { id: 'fld_amt001', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'fld_stat01', key: 'status', type: 'text' },
        { id: 'fld_cust01', key: 'customer', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'fld_cnam01', key: 'customer_name', type: 'lookup', lookup: { relation: 'customer', field: 'name' } },
    ],
    // A member never reads a secret order: a rollup must not count it.
    access: memberRule('record.status != "secret"'),
};
const TAGS = { id: 'tbl_tag001', key: 'tags', fields: [{ id: 'fld_labl01', key: 'label', type: 'text' }], access: memberRule('record.label != "hidden"') };
const MODEL = { modelVersion: 1, tables: [CUSTOMERS, ORDERS, TAGS] };
const VIEWER = { id: 'u1' };
const JN = junctionName(CUSTOMERS.id, 'fld_tags01');

const CUSTOMER_ROWS = [
    { id: 'cus_a', name: 'Alpha', segment: 'retail' },
    { id: 'cus_b', name: 'Bravo', segment: 'retail' },
    { id: 'cus_c', name: 'Charlie', segment: 'wholesale' },
];
const ORDER_ROWS = [
    { id: 'ord_1', amount: 10, status: 'open', customer: 'cus_a' },
    { id: 'ord_2', amount: 20, status: 'done', customer: 'cus_a' },
    { id: 'ord_3', amount: 400, status: 'secret', customer: 'cus_a' },
    { id: 'ord_4', amount: 7, status: 'open', customer: 'cus_c' },
    { id: 'ord_5', amount: 5, status: 'open', customer: null },
];
const TAG_ROWS = [{ id: 'tag_x', label: 'vip' }, { id: 'tag_y', label: 'late' }, { id: 'tag_h', label: 'hidden' }];
const LINKS = [['cus_a', 'tag_x'], ['cus_a', 'tag_h'], ['cus_b', 'tag_x'], ['cus_b', 'tag_y'], ['cus_c', 'tag_x']];

const closers = [];
let engines;
test.after(async () => { for (const close of closers) await close(); });

test('(setup) the planner lays down the tables, the junction and its index on both engines', async () => {
    engines = await bootLinkedEngines(MODEL, closers);
    for (const engine of Object.values(engines)) {
        const seed = [[TAGS, TAG_ROWS], [CUSTOMERS, CUSTOMER_ROWS], [ORDERS, ORDER_ROWS]];
        for (const [table, rows] of seed) {
            for (const { id, ...values } of rows) {
                const c = qc.compileInsert(table, values, { id, createdBy: 'u9', orgId: 'o1', dialect: engine.dialect });
                await engine.run(c.sql, c.params);
            }
        }
        for (const [s, t] of LINKS) await engine.run(`INSERT INTO "${JN}" (source_id, target_id) VALUES (?, ?)`, [s, t]);
        const cols = Object.keys((await engine.all('SELECT * FROM "customers" LIMIT 1', []))[0]).sort();
        assert.deepStrictEqual(cols, ['created_at', 'created_by', 'id', 'name', 'org_id', 'segment', 'updated_at'], `${engine.dialect}: no column for a rollup or a many relation`);
    }
});

async function read(dialect, table, role, descriptor = {}) {
    const who = { role, viewer: VIEWER, dialect };
    const access = compileAccessFilter(table, role, VIEWER, 'read', { dialect });
    const r = relationRead(MODEL, table, descriptor, who);
    const compiled = qc.compileRecordList(table, { filters: descriptor.filters, limit: 100, dialect }, access, r);
    const rows = await engines[dialect].all(compiled.sql, compiled.params);
    const q = (sql, params) => engines[dialect].all(sql, params).then((x) => ({ rows: x }));
    return (await finishRecords(compiled, rows.slice(0, compiled.limit), q)).sort((a, b) => a.id.localeCompare(b.id));
}

test('a lookup reads the related field under the related table\'s rules', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await read(dialect, ORDERS, 'member');
        assert.deepStrictEqual(rows.map((r) => [r.id, r.customer_name]), [['ord_1', 'Alpha'], ['ord_2', 'Alpha'], ['ord_4', null], ['ord_5', null]], dialect);
        assert.ok(!JSON.stringify(rows).includes('Charlie'), `${dialect}: a hidden customer's name never leaves`);
        const outsider = await read(dialect, ORDERS, 'outsider');
        assert.ok(outsider.length === 5 && outsider.every((r) => r.customer_name === null), `${dialect}: no read on customers, every lookup null`);
        const narrowed = await read(dialect, ORDERS, 'member', { fields: ['customer_name'] });
        assert.deepStrictEqual(narrowed[0], { id: 'ord_1', customer_name: 'Alpha' }, `${dialect}: fields keeps the lookup, not the relation it reads through`);
    }
});

test('a rollup counts and sums only the readable child rows, with its own filter', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await read(dialect, CUSTOMERS, 'member');
        assert.deepStrictEqual(rows.map((r) => [r.id, r.order_count, r.open_total]), [['cus_a', 2, 10], ['cus_b', 0, null]], dialect);
        const [one] = await fillLinkedRecords(MODEL, CUSTOMERS, { role: 'member', viewer: VIEWER, dialect }, [{ id: 'cus_a' }],
            (sql, params) => engines[dialect].all(sql, params).then((x) => ({ rows: x })));
        assert.deepStrictEqual([one.order_count, one.open_total, one.tags], [2, 10, ['tag_x']], `${dialect}: one record reads the same values`);
    }
});

test('a many relation reads as its readable ids, expands to readable rows and filters with contains', async () => {
    const ids = (rows) => rows.map((r) => r.id);
    for (const dialect of ['sqlite', 'pg']) {
        const rows = await read(dialect, CUSTOMERS, 'member', { expand: [{ field: 'tags' }] });
        assert.deepStrictEqual(rows.map((r) => [r.id, r.tags]), [['cus_a', ['tag_x']], ['cus_b', ['tag_x', 'tag_y']]], dialect);
        assert.deepStrictEqual(rows[0].tags_record, [{ id: 'tag_x', label: 'vip', _label: 'vip' }], dialect);
        assert.ok(!JSON.stringify(rows).includes('tag_h'), `${dialect}: a hidden tag is not even an id`);
        assert.deepStrictEqual(ids(await read(dialect, CUSTOMERS, 'member', { filters: [{ field: 'tags', op: 'contains', value: 'tag_y' }] })), ['cus_b'], dialect);
        assert.deepStrictEqual(ids(await read(dialect, CUSTOMERS, 'member', { filters: [{ field: 'tags', op: 'contains', value: 'tag_h' }] })), [], dialect);
        const hidden = ids(await read(dialect, CUSTOMERS, 'member', { filters: [{ field: 'tags', op: 'notContains', value: 'tag_h' }] }));
        const absent = ids(await read(dialect, CUSTOMERS, 'member', { filters: [{ field: 'tags', op: 'notContains', value: 'tag_nope' }] }));
        assert.deepStrictEqual(hidden, absent, `${dialect}: a hidden id is told apart from nothing`);
    }
});

test('filter, sort, group and aggregate on a lookup, a rollup or a many relation are refused', () => {
    for (const dialect of ['sqlite', 'pg']) {
        const access = (t) => compileAccessFilter(t, 'member', VIEWER, 'read', { dialect });
        const list = (t, opts) => qc.compileRecordList(t, { dialect, ...opts }, access(t), relationRead(MODEL, t, opts, { role: 'member', viewer: VIEWER, dialect }));
        assert.throws(() => list(ORDERS, { filters: [{ field: 'customer_name', op: 'eq', value: 'Charlie' }] }), /lookup field: it has no column/);
        assert.throws(() => list(ORDERS, { sort: { field: 'customer_name', dir: 'asc' } }), /lookup field/);
        assert.throws(() => list(CUSTOMERS, { filters: [{ field: 'order_count', op: 'gt', value: 0 }] }), /rollup field/);
        assert.throws(() => list(CUSTOMERS, { orderBy: [{ field: 'open_total', dir: 'desc' }] }), /rollup field/);
        assert.throws(() => list(CUSTOMERS, { filters: [{ field: 'tags', op: 'eq', value: 'tag_x' }] }), /filtered with contains or notContains/);
        assert.throws(() => list(CUSTOMERS, { search: { value: 'x', fields: ['tags'] } }), /many relation field/);
        assert.throws(() => qc.compileAggregate(ORDERS, { dialect, groupBy: [{ field: 'customer_name' }], aggregates: [{ fn: 'count', as: 'n' }] }, access(ORDERS)), /lookup field/);
        assert.throws(() => qc.compileAggregate(CUSTOMERS, { dialect, aggregates: [{ fn: 'sum', field: 'order_count', as: 'n' }] }, access(CUSTOMERS)), /rollup field/);
    }
});

test('a read of a table without such a field compiles and answers exactly as before', () => {
    const who = { role: 'member', viewer: VIEWER, dialect: 'sqlite' };
    assert.strictEqual(relationRead(MODEL, TAGS, {}, who), undefined);
    assert.strictEqual(relationRead(null, ORDERS, {}, who), undefined, 'a linked table gets no model, so nothing is filled');
});

test('the junction loses a link with either of its rows, on both engines', async () => {
    for (const engine of Object.values(engines)) {
        await engine.run('DELETE FROM "tags" WHERE id = ?', ['tag_y']);
        await engine.run('DELETE FROM "customers" WHERE id = ?', ['cus_b']);
        const left = (await engine.all(`SELECT source_id, target_id FROM "${JN}" ORDER BY source_id, target_id`, [])).map((r) => `${r.source_id}>${r.target_id}`);
        assert.deepStrictEqual(left, ['cus_a>tag_h', 'cus_a>tag_x', 'cus_c>tag_x'], engine.dialect);
    }
});

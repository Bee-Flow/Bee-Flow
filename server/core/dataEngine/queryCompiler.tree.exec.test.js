/**
 * Filter trees, column comparisons and `orderBy`, EXECUTED on both engines
 * (better-sqlite3 in memory, Postgres through PGlite) against the same rows:
 *   - a tree returns exactly the rows a plain two-valued evaluation of it
 *     selects, on both engines;
 *   - the access predicate holds whatever the tree says (an OR or a NOT never
 *     returns another owner's row);
 *   - walking an `orderBy` read page by page visits every visible row once, in
 *     the order the one-page read gives, with empty values, ties and mixed
 *     directions, and both engines agree on that order.
 *
 * Run: cd server && node --test core/dataEngine/queryCompiler.tree.exec.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
require('../../testUtils/routeHarness').recordDb();

const qc = require('./queryCompiler');
const { ddlForTable } = require('./dataModel/ddl');
const { toDollarParams } = require('../../stores/lib/pgAppEngine');

const TABLE = {
    id: 'tbl_tree01',
    key: 'jobs',
    fields: [
        { id: 'f1', key: 'region', type: 'text' },
        { id: 'f2', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'f3', key: 'budget', type: 'number', subtype: 'integer' },
        { id: 'f4', key: 'done', type: 'bool' },
        { id: 'f5', key: 'label', type: 'text' },
    ],
};
const MINE = { where: '"created_by" = ?', params: ['u1'] };

/** 36 rows of u1 with empty values and ties in every column, plus rows of another owner. */
function seedRows() {
    const regions = ['eu', 'us', null, 'apac'];
    const rows = [];
    for (let i = 0; i < 36; i += 1) {
        rows.push({
            values: {
                region: regions[i % 4],
                amount: i % 5 === 0 ? null : (i * 7) % 6,
                budget: i % 7 === 0 ? null : (i * 5) % 6,
                done: i % 3 === 0 ? null : i % 2 === 0,
                label: i % 6 === 0 ? null : `l${i % 9}`,
            },
            owner: 'u1',
        });
    }
    for (let i = 0; i < 6; i += 1) {
        rows.push({ values: { region: 'eu', amount: i, budget: 0, done: true, label: 'other' }, owner: 'u2' });
    }
    return rows;
}

/** @type {Record<string, (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>>} */
const engines = {};
/** id → the seeded values, the same ids on both engines. */
const byId = new Map();
/** What to close when the file is done, so the process ends by itself. */
const closers = [];
test.after(async () => { for (const close of closers) await close(); });

test('(setup) the same rows on SQLite and on Postgres', async () => {
    const Database = require('better-sqlite3');
    const lite = new Database(':memory:');
    closers.push(() => lite.close());
    lite.exec(ddlForTable(TABLE, { dialect: 'sqlite' }));
    engines.sqlite = async (sql, params) => {
        const stmt = lite.prepare(sql);
        return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
    };

    const { newPglite } = require('../../testUtils/pgliteTemplate');
    const pg = newPglite();
    closers.push(() => pg.close());
    await pg.exec("SET TIME ZONE 'UTC'");
    await pg.exec(ddlForTable(TABLE, { dialect: 'pg' }));
    engines.pg = async (sql, params) => (await pg.query(toDollarParams(sql, params.length), params)).rows;

    let n = 0;
    for (const row of seedRows()) {
        n += 1;
        const id = `rec_${String(n).padStart(3, '0')}`;
        byId.set(id, { ...row.values, owner: row.owner });
        for (const dialect of ['sqlite', 'pg']) {
            const ins = qc.compileInsert(TABLE, row.values, { createdBy: row.owner, orgId: 'o1', id, dialect });
            await engines[dialect](ins.sql, ins.params);
        }
    }
    assert.strictEqual(byId.size, 42);
});

// ── Filter trees ────────────────────────────────────────────────────

const cmp = { eq: (a, b) => a === b, neq: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };

/** Two-valued evaluation: a comparison with an empty value does not match; `not` is the complement. */
function matches(entry, row) {
    if (entry.any) return entry.any.some((e) => matches(e, row));
    if (entry.all) return entry.all.every((e) => matches(e, row));
    if (entry.not) return !matches(entry.not, row);
    const left = row[entry.field];
    if (entry.op === 'isNull') return left === null;
    const right = entry.otherField !== undefined ? row[entry.otherField] : entry.value;
    if (left === null || right === null) return false;
    return cmp[entry.op](left, right);
}

const EU = { field: 'region', op: 'eq', value: 'eu' };
const US = { field: 'region', op: 'eq', value: 'us' };
const BIG = { field: 'amount', op: 'gte', value: 3 };
const DONE = { field: 'done', op: 'eq', value: true };
const OVER = { field: 'amount', op: 'gt', otherField: 'budget' };

const TREES = {
    'all inside any': [{ any: [{ all: [EU, BIG] }, { all: [US, DONE] }] }],
    'not a clause keeps rows with an empty value': [{ not: EU }],
    'not an any group': [{ not: { any: [EU, US] } }],
    'depth 3': [{ any: [{ all: [{ not: DONE }, BIG] }, { not: { all: [EU, BIG] } }] }],
    'top-level clause and groups': [BIG, { any: [EU, { not: { field: 'label', op: 'isNull' } }] }, { not: DONE }],
    'a column against another column': [OVER],
    'a column comparison inside a tree': [{ any: [{ all: [OVER, EU] }, { not: { field: 'amount', op: 'lte', otherField: 'budget' } }] }],
    'two text columns': [{ field: 'region', op: 'neq', otherField: 'label' }],
};

for (const [name, filters] of Object.entries(TREES)) {
    test(`tree: ${name}`, async () => {
        const expected = [...byId].filter(([, row]) => row.owner === 'u1' && filters.every((f) => matches(f, row))).map(([id]) => id).sort();
        assert.ok(expected.length > 0 && expected.length < 36, `the case selects some rows, not all (${expected.length})`);
        for (const dialect of ['sqlite', 'pg']) {
            const c = qc.compileRecordList(TABLE, { filters, limit: 1000, dialect }, MINE);
            assert.ok(c.sql.includes('WHERE ("created_by" = ?) AND '), 'the access predicate is the first conjunct, outside the tree');
            const rows = await engines[dialect](c.sql, c.params);
            assert.deepStrictEqual(rows.map((r) => r.id).sort(), expected, dialect);
        }
    });
}

test('tree: an OR or a NOT that is true for every row still returns only the viewer\'s rows', async () => {
    const widest = [
        [{ any: [{ field: 'id', op: 'isNotNull' }, { not: EU }] }],
        [{ not: { field: 'id', op: 'isNull' } }],
        [{ not: { all: [{ field: 'created_by', op: 'eq', value: 'u1' }] } }],
    ];
    for (const filters of widest) {
        for (const dialect of ['sqlite', 'pg']) {
            for (const match of ['all', 'any']) {
                const c = qc.compileRecordList(TABLE, { filters, match, limit: 1000, dialect }, MINE);
                const rows = await engines[dialect](c.sql, c.params);
                assert.ok(rows.every((r) => r.created_by === 'u1'), `${dialect} ${match} ${JSON.stringify(filters)}`);
            }
            const agg = qc.compileAggregate(TABLE, { filters, aggregates: [{ fn: 'count', as: 'n' }], dialect }, MINE);
            const [{ n }] = await engines[dialect](agg.sql, agg.params);
            assert.ok(Number(n) <= 36, `${dialect}: the count folds only the viewer's rows`);
        }
    }
});

// ── orderBy ─────────────────────────────────────────────────────────

const ORDERS = {
    'one column asc': [{ field: 'amount', dir: 'asc' }],
    'one column desc': [{ field: 'region', dir: 'desc' }],
    'two columns, mixed': [{ field: 'region', dir: 'asc' }, { field: 'amount', dir: 'desc' }],
    'three columns, mixed': [{ field: 'done', dir: 'desc' }, { field: 'label', dir: 'asc' }, { field: 'amount', dir: 'desc' }],
    'id named by the author': [{ field: 'budget', dir: 'desc' }, { field: 'id', dir: 'asc' }],
};

/** The expected order: per column empty values last, then by direction; `id` in the last column's direction. */
function expectedOrder(orderBy) {
    const cols = orderBy.some((o) => o.field === 'id') ? orderBy : [...orderBy, { field: 'id', dir: orderBy[orderBy.length - 1].dir }];
    const rows = [...byId].filter(([, row]) => row.owner === 'u1').map(([id, row]) => ({ id, ...row }));
    rows.sort((a, b) => {
        for (const col of cols) {
            const x = a[col.field];
            const y = b[col.field];
            if (x === y) continue;
            if (x === null) return 1;
            if (y === null) return -1;
            const less = x < y ? -1 : 1;
            return col.dir === 'asc' ? less : -less;
        }
        return 0;
    });
    return rows.map((r) => r.id);
}

for (const [name, orderBy] of Object.entries(ORDERS)) {
    test(`orderBy: ${name}: every row once, in order, page by page, on both engines`, async () => {
        const expected = expectedOrder(orderBy);
        for (const dialect of ['sqlite', 'pg']) {
            const seen = [];
            let cursor;
            for (let page = 0; page < 40; page += 1) {
                const c = qc.compileRecordList(TABLE, { orderBy, cursor, limit: 5, dialect }, MINE);
                const rows = await engines[dialect](c.sql, c.params);
                const kept = rows.slice(0, c.limit);
                seen.push(...kept.map((r) => r.id));
                if (rows.length <= c.limit) { cursor = null; break; }
                cursor = qc.nextCursor(c, kept[kept.length - 1]);
                assert.ok(cursor, 'a page that ends on an empty value still has a cursor');
            }
            assert.strictEqual(cursor, null, `${dialect}: the walk ends`);
            assert.deepStrictEqual(seen, expected, dialect);
        }
    });
}

test('orderBy: an aggregate sorts on up to three of its output columns', async () => {
    for (const dialect of ['sqlite', 'pg']) {
        const c = qc.compileAggregate(TABLE, {
            groupBy: [{ field: 'region' }, { field: 'label' }], aggregates: [{ fn: 'count', as: 'n' }],
            filters: [{ field: 'region', op: 'isNotNull' }, { field: 'label', op: 'isNotNull' }],
            orderBy: [{ field: 'n', dir: 'desc' }, { field: 'region', dir: 'asc' }, { field: 'label', dir: 'desc' }], dialect,
        }, MINE);
        const rows = await engines[dialect](c.sql, c.params);
        const keys = rows.map((r) => [Number(r.n), r.region, r.label]);
        const text = (/** @type {string} */ x, /** @type {string} */ y) => (x < y ? -1 : x > y ? 1 : 0);
        const sorted = [...keys].sort((a, b) => (b[0] - a[0]) || text(a[1], b[1]) || text(b[2], a[2]));
        assert.deepStrictEqual(keys, sorted, dialect);
        assert.ok(keys.length >= 4);
    }
});

test('a `sort` list still reads its first entry only; nextCursor mints the legacy cursor for it', () => {
    const c = qc.compileRecordList(TABLE, { sort: [{ field: 'region', dir: 'asc' }, { field: 'amount', dir: 'desc' }], dialect: 'sqlite' }, MINE);
    assert.ok(c.sql.endsWith('ORDER BY "region" ASC, "id" ASC LIMIT ?'));
    assert.strictEqual(c.orderFields, undefined);
    assert.strictEqual(qc.nextCursor(c, { id: 'rec_1', region: 'eu' }), qc.encodeCursor('eu', 'rec_1'));
});

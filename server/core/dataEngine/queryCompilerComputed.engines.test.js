/**
 * Read-time computed fields on the real engines (issue 587): the SQL the
 * compiler emits runs on SQLite (better-sqlite3, the per-app engine) and on
 * Postgres (PGlite), gives the same values on both, keeps the row rule, and a
 * failing expression reads NULL with a note instead of failing the read.
 *
 * Also pins the claim the guard rests on: every function and keyword it lets
 * through exists on BOTH engines.
 *
 * Run: cd server && node --test core/dataEngine/queryCompilerComputed.engines.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const { ddlForTable } = require('./dataModel/ddl');
const { readTimeExprSql, READ_TIME_FUNCTIONS } = require('./queryCompilerComputed.mts');
const { queryWithComputed, computedNote } = require('./computedRead.mts');
const { APP_ENGINES, sqliteEngine, pgEngine } = require('../../testUtils/appEngines');

const ITEMS = {
    id: 'tbl_items1',
    key: 'items',
    fields: [
        { id: 'fld_i1', key: 'title', type: 'text' },
        { id: 'fld_i2', key: 'price', type: 'number' },
        { id: 'fld_i3', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_i4', key: 'total', type: 'computed', computed: { expr: 'price * qty' } },
        { id: 'fld_i5', key: 'label', type: 'computed', computed: { expr: "upper(title) || ' x' || CAST(qty AS TEXT)" } },
        { id: 'fld_i6', key: 'band', type: 'computed', computed: { expr: "CASE WHEN price * qty >= 100 THEN 'big' ELSE 'small' END" } },
        { id: 'fld_i7', key: 'shown', type: 'computed', computed: { expr: "rtrim(rtrim(CAST(price AS TEXT),'0'),'.')" } },
        { id: 'fld_i8', key: 'legacy', type: 'computed', computed: { expr: 'iif(qty > 1, 1, 0)' } }, // SQLite only → refused
    ],
};
// Postgres raises on a division by zero; SQLite answers NULL.
const RATIOS = {
    id: 'tbl_ratio1',
    key: 'ratios',
    fields: [
        { id: 'fld_r1', key: 'a', type: 'number' },
        { id: 'fld_r2', key: 'b', type: 'number' },
        { id: 'fld_r3', key: 'ratio', type: 'computed', computed: { expr: 'a / b' } },
        { id: 'fld_r4', key: 'sum', type: 'computed', computed: { expr: 'a + b' } },
    ],
};
const MINE = { where: '"created_by" = ?', params: ['user-1'] };

async function seed(engine, table, rows) {
    await engine.exec(ddlForTable(table, { dialect: engine.dialect }));
    for (const [values, createdBy] of rows) {
        const ins = qc.compileInsert(table, values, { createdBy, orgId: 'org-1', dialect: engine.dialect });
        await engine.query(ins.sql, ins.params);
    }
}

for (const [name, make] of APP_ENGINES) {
    test(`${name}: read-time computed fields read a value, under the row rule`, async () => {
        const engine = make();
        try {
            await seed(engine, ITEMS, [
                [{ title: 'pen', price: 2.5, qty: 4 }, 'user-1'],
                [{ title: 'desk', price: 120, qty: 1 }, 'user-1'],
                [{ title: 'secret', price: 999, qty: 9 }, 'user-2'],
            ]);
            const compiled = qc.compileRecordList(ITEMS, { dialect: engine.dialect, readTimeComputed: true, sort: [{ field: 'title', dir: 'asc' }] }, MINE);
            const { result, notes } = await queryWithComputed(engine.query, compiled);
            const rows = result.rows.map((r) => ({ title: r.title, total: r.total, label: r.label, band: r.band, shown: r.shown, legacy: r.legacy }));
            assert.deepStrictEqual(rows, [
                { title: 'desk', total: 120, label: 'DESK x1', band: 'big', shown: '120', legacy: null },
                { title: 'pen', total: 10, label: 'PEN x4', band: 'small', shown: '2.5', legacy: null },
            ], 'the other owner\'s row stays hidden; the values agree across engines');
            assert.deepStrictEqual(notes, [computedNote('legacy')]);

            const one = qc.compileGetById(ITEMS, 'missing', MINE, { dialect: engine.dialect, readTimeComputed: true });
            assert.deepStrictEqual((await queryWithComputed(engine.query, one)).result.rows, []);
        } finally { await engine.close(); }
    });

    test(`${name}: a get-by-id the row rule hides stays hidden, a visible one is evaluated`, async () => {
        const engine = make();
        try {
            await seed(engine, ITEMS, [[{ title: 'mine', price: 3, qty: 3 }, 'user-1'], [{ title: 'theirs', price: 5, qty: 5 }, 'user-2']]);
            const all = await engine.query('SELECT id, title FROM "items"', []);
            const idOf = (t) => all.rows.find((r) => r.title === t).id;
            const read = async (id) => (await queryWithComputed(engine.query,
                qc.compileGetById(ITEMS, id, MINE, { dialect: engine.dialect, readTimeComputed: true }))).result.rows;
            assert.strictEqual((await read(idOf('mine')))[0].total, 9);
            assert.deepStrictEqual(await read(idOf('theirs')), []);
        } finally { await engine.close(); }
    });
}

test('sqlite: a division by zero reads NULL; pg: the read falls back and names every computed field', async () => {
    const rows = [[{ a: 6, b: 3 }, 'user-1'], [{ a: 1, b: 0 }, 'user-1']];
    const lite = sqliteEngine();
    const pg = pgEngine();
    try {
        await seed(lite, RATIOS, rows);
        await seed(pg, RATIOS, rows);
        const opts = (dialect) => ({ dialect, readTimeComputed: true, sort: [{ field: 'b', dir: 'desc' }] });
        const fromLite = await queryWithComputed(lite.query, qc.compileRecordList(RATIOS, opts('sqlite'), MINE));
        assert.deepStrictEqual(fromLite.result.rows.map((r) => [r.ratio, r.sum]), [[2, 9], [null, 1]]);
        assert.deepStrictEqual(fromLite.notes, []);

        const compiledPg = qc.compileRecordList(RATIOS, opts('pg'), MINE);
        await assert.rejects(pg.query(compiledPg.sql, compiledPg.params), /division by zero/, 'the plain read would fail');
        const fromPg = await queryWithComputed(pg.query, compiledPg);
        assert.deepStrictEqual(fromPg.result.rows.map((r) => [r.a, r.b, r.ratio, r.sum]), [[6, 3, null, null], [1, 0, null, null]]);
        assert.deepStrictEqual(fromPg.notes, [computedNote('ratio'), computedNote('sum')]);
    } finally {
        await lite.close();
        await pg.close();
    }
});

/** One call per function the guard allows; a function without a sample fails the test. */
const FUNCTION_SAMPLES = {
    abs: 'abs(-1)', round: 'round(2.4)', sign: 'sign(-2)', ceil: 'ceil(1.2)', ceiling: 'ceiling(1.2)', floor: 'floor(1.7)',
    trunc: 'trunc(1.7)', sqrt: 'sqrt(4)', power: 'power(2, 3)', mod: 'mod(7, 3)', exp: 'exp(0)', ln: 'ln(1)', log10: 'log10(100)',
    coalesce: 'coalesce(NULL, 1)', nullif: 'nullif(1, 1)',
    upper: "upper('a')", lower: "lower('A')", length: "length('abc')", substr: "substr('abc', 2)", substring: "substring('abc', 2)",
    trim: "trim(' a ')", ltrim: "ltrim(' a')", rtrim: "rtrim('a ')", replace: "replace('abc', 'b', 'x')", concat: "concat('a', 'b')",
};
const KEYWORD_SAMPLES = [
    "CASE WHEN 1 = 1 THEN 'y' ELSE 'n' END", '1 IS NULL OR NOT 2 IN (1, 2)', "'abc' LIKE 'a!%' ESCAPE '!'",
    '2 BETWEEN 1 AND 3', 'TRUE AND FALSE', "CAST('5' AS INTEGER) + CAST('1' AS INT)", "CAST('1.5' AS REAL) + CAST('1.5' AS NUMERIC) + CAST('2' AS DECIMAL)",
    "CAST(1 AS TEXT) || CAST(2 AS VARCHAR)", 'CURRENT_DATE IS NOT NULL', 'CURRENT_TIMESTAMP IS NOT NULL', 'CURRENT_TIME IS NOT NULL',
    "1 <> 2 AND 1 != 2 AND 1 <= 2 AND 2 >= 1 AND 1 < 2 AND 2 > 1 AND 7 % 3 = 1 AND 'a' || 'b' = 'ab' AND (6 / 2) * 1 - 1 + 1 = 3",
];

test('every allowed function and keyword runs on both engines', async () => {
    assert.deepStrictEqual(Object.keys(FUNCTION_SAMPLES).sort(), [...READ_TIME_FUNCTIONS].sort(), 'a sample per allowed function');
    const engines = [sqliteEngine(), pgEngine()];
    const empty = { key: 'none', fields: [] };
    try {
        for (const engine of engines) {
            for (const expr of [...Object.values(FUNCTION_SAMPLES), ...KEYWORD_SAMPLES]) {
                const out = readTimeExprSql(expr, empty, engine.dialect);
                assert.ok(!('error' in out), `${expr}: ${out.error}`);
                await assert.doesNotReject(engine.query(`SELECT (${out.sql}) AS v`, []), `${engine.dialect}: ${expr}`);
            }
        }
    } finally {
        for (const engine of engines) await engine.close();
    }
});

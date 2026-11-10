/**
 * Read-time computed fields in the select list (issue 587): the guard, the
 * SQL it rebuilds, and the opt-in on compileRecordList / compileGetById.
 *
 * Pure, no database; queryCompilerComputed.engines.test.js runs the SQL on
 * SQLite and Postgres. Run: cd server && node --test core/dataEngine/queryCompilerComputed.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const {
    readTimeExprSql, readTimeComputedError, readTimeComputedSelect, lexReadTimeExpr, READ_TIME_FUNCTIONS,
} = require('./queryCompilerComputed.mts');
const { queryWithComputed, computedNote } = require('./computedRead.mts');

const TABLE = {
    id: 'tbl_items1',
    key: 'items',
    fields: [
        { id: 'fld_1', key: 'title', type: 'text' },
        { id: 'fld_2', key: 'price', type: 'number' },
        { id: 'fld_3', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_4', key: 'select', type: 'text' },
        { id: 'fld_5', key: 'net', type: 'computed', computed: { expr: 'price * 0.8', stored: true } },
        { id: 'fld_6', key: 'total', type: 'computed', computed: { expr: 'price * qty' } },
        { id: 'fld_7', key: 'twice', type: 'computed', computed: { expr: 'total * 2' } },
    ],
};
const ALLOW = { where: '1=1', params: [] };
const sql = (expr, dialect = 'sqlite') => readTimeExprSql(expr, TABLE, dialect);

test('an accepted expression is rebuilt from its tokens with every column quoted', () => {
    assert.deepStrictEqual(sql('price * qty'), { sql: '"price" * "qty"', columns: ['price', 'qty'] });
    assert.deepStrictEqual(sql("CASE WHEN Price >= 10 THEN 'big' ELSE 'small' END"),
        { sql: "CASE WHEN \"price\" >= 10 THEN 'big' ELSE 'small' END", columns: ['price'] });
    assert.deepStrictEqual(sql('upper(title) || \' - \' || "title"'),
        { sql: 'upper ( "title" ) || \' - \' || "title"', columns: ['title'] });
    // System columns and a STORED computed field hold a value; both may be named.
    assert.deepStrictEqual(sql('coalesce(net, 0) + length(id)').columns, ['net', 'id']);
    assert.deepStrictEqual(sql("title LIKE 'a%' AND qty IN (1, 2) AND price BETWEEN 1 AND 5 AND qty IS NOT NULL").columns,
        ['title', 'qty', 'price']);
    assert.deepStrictEqual(sql("'it''s' || CAST(qty AS TEXT)").sql, "'it''s' || CAST ( \"qty\" AS TEXT )");
    assert.deepStrictEqual(sql('1.5e3 + .5').sql, '1.5e3 + .5');
});

test('a column named like a keyword is emitted quoted, never as SQL', () => {
    // `select` is a field of this table: it reads that column, it does not start a subquery.
    assert.deepStrictEqual(sql('"select" || title'), { sql: '"select" || "title"', columns: ['select', 'title'] });
});

test('anything outside the expression vocabulary refuses the field', () => {
    const refused = [
        ['(SELECT title FROM other)', /"from" is not a column|is not a column/],
        ['price; DELETE FROM items', /unexpected character ";"/],
        ['price -- note', /comment/],
        ['price /* x */', /comment/],
        ['items.price', /unexpected character "\."/],
        ['price::text', /unexpected character|is not a column/],
        ['price + ?', /unexpected character "\?"/],
        ['price + $1', /unexpected character "\$"/],
        ["'a\\' || title", /backslash/],
        ['iif(qty > 1, 1, 0)', /iif\(\) is not available on both/],
        ['ifnull(qty, 0)', /ifnull\(\) is not available on both/],
        ['instr(title, \'a\')', /instr\(\) is not available on both/],
        ['printf(\'%d\', qty)', /printf\(\) is not available on both/],
        ['greatest(price, qty)', /greatest\(\) is not available on both/],
        ['left(title, 2)', /left\(\) is not available on both/],
        ['max(price)', /max\(\) is not available on both/],
        ['count(id)', /count\(\) is not available on both/],
        ['title GLOB \'a*\'', /"GLOB" is not a column/],
        ['unknown_col + 1', /"unknown_col" is not a column/],
        ['"Title"', /"Title" is not a column/],
        ['total * 2', /"total" is not a column/], // another read-time field has no column
        ['"title"(1)', /cannot be called/],
        ['(price', /unbalanced/],
        ['price)', /unbalanced/],
        ['1abc', /malformed number/],
        ["'open", /unterminated string/],
        ['', /empty/],
        ['   ', /empty/],
        ['x'.repeat(501), /longer than 500/],
    ];
    for (const [expr, why] of refused) {
        const out = sql(expr);
        assert.ok('error' in out, `${expr} must be refused`);
        assert.match(out.error, why, expr);
    }
    assert.ok('error' in sql(42));
    assert.ok('error' in sql('('.repeat(40) + '1' + ')'.repeat(40)), 'nesting is bounded');
});

test('the SQLite number-trimming idiom becomes trim_scale on Postgres, as for stored columns', () => {
    const idiom = "rtrim(rtrim(CAST(price AS TEXT),'0'),'.') || ' EUR'";
    assert.strictEqual(sql(idiom, 'sqlite').sql, "rtrim ( rtrim ( CAST ( \"price\" AS TEXT ) , '0' ) , '.' ) || ' EUR'");
    assert.strictEqual(sql(idiom, 'pg').sql, "trim_scale(\"price\")::text || ' EUR'");
    assert.ok('error' in sql("rtrim(rtrim(CAST(nope AS TEXT),'0'),'.')", 'pg'), 'the idiom still checks its column');
    // Anything else with rtrim is passed on as written.
    assert.strictEqual(sql("rtrim(title, 'x')", 'pg').sql, "rtrim ( \"title\" , 'x' )");
});

test('readTimeComputedError answers for both dialects', () => {
    assert.strictEqual(readTimeComputedError(TABLE.fields[5], TABLE), null);
    assert.match(readTimeComputedError(TABLE.fields[6], TABLE), /"total" is not a column/);
    assert.match(readTimeComputedError({ type: 'computed', computed: null }, TABLE), /empty/);
});

test('the lexer returns tokens, not text', () => {
    const lexed = lexReadTimeExpr("a<=1 OR b<>'x'");
    assert.deepStrictEqual(lexed.tokens.map((t) => `${t.kind}:${t.text}`),
        ['word:a', 'op:<=', 'number:1', 'word:OR', 'word:b', 'op:<>', "string:'x'"]);
});

test('every listed function is a plain lower-case name', () => {
    for (const fn of READ_TIME_FUNCTIONS) assert.ok(/^[a-z][a-z0-9_]*$/.test(fn), fn);
});

test('readTimeComputedSelect: evaluated, refused and absent', () => {
    const sel = readTimeComputedSelect(TABLE, 'sqlite');
    assert.deepStrictEqual(sel, {
        list: '*, ("price" * "qty") AS "total", NULL AS "twice"',
        fallbackList: '*, NULL AS "total", NULL AS "twice"',
        keys: ['total', 'twice'],
        refused: ['twice'],
        columns: { total: ['price', 'qty'] },
    });
    assert.strictEqual(readTimeComputedSelect({ key: 'plain', fields: [{ key: 'a', type: 'text' }] }, 'pg'), null);
    // A stored computed field has a column: it is in `*`, not added.
    assert.strictEqual(readTimeComputedSelect({ key: 'p', fields: TABLE.fields.slice(0, 5) }, 'pg'), null);
});

test('compileRecordList: without the option, or on a table without one, the read is unchanged', () => {
    const plain = qc.compileRecordList(TABLE, { dialect: 'sqlite' }, ALLOW);
    assert.strictEqual(plain.sql, 'SELECT * FROM "items" WHERE (1=1) ORDER BY "created_at" DESC, "id" DESC LIMIT ?');
    assert.deepStrictEqual(Object.keys(plain), ['sql', 'params', 'primaryField', 'limit']);
    for (const readTimeComputed of [false, 'true', 1, undefined]) {
        assert.deepStrictEqual(qc.compileRecordList(TABLE, { dialect: 'sqlite', readTimeComputed }, ALLOW), plain);
    }
    const noComputed = { key: 'items', fields: TABLE.fields.slice(0, 4) };
    assert.deepStrictEqual(qc.compileRecordList(noComputed, { dialect: 'pg', readTimeComputed: true }, ALLOW),
        qc.compileRecordList(noComputed, { dialect: 'pg' }, ALLOW));
    assert.deepStrictEqual(qc.compileGetById(noComputed, 'r1', ALLOW, { dialect: 'pg', readTimeComputed: true }),
        qc.compileGetById(noComputed, 'r1', ALLOW, { dialect: 'pg' }));
});

test('compileRecordList with readTimeComputed: the expressions, the same WHERE and params, a fallback', () => {
    const access = { where: '"created_by" = ?', params: ['u1'] };
    const opts = { dialect: 'pg', filters: [{ field: 'title', op: 'contains', value: 'a' }], sort: [{ field: 'price', dir: 'asc' }], limit: 5 };
    const base = qc.compileRecordList(TABLE, opts, access);
    const withComputed = qc.compileRecordList(TABLE, { ...opts, readTimeComputed: true }, access);
    assert.strictEqual(withComputed.sql, base.sql.replace('SELECT *', 'SELECT *, ("price" * "qty") AS "total", NULL AS "twice"'));
    assert.deepStrictEqual(withComputed.params, base.params);
    assert.strictEqual(withComputed.primaryField, base.primaryField);
    assert.strictEqual(withComputed.limit, base.limit);
    assert.strictEqual(withComputed.readTimeComputed.fallbackSql,
        base.sql.replace('SELECT *', 'SELECT *, NULL AS "total", NULL AS "twice"'));
    assert.ok(withComputed.sql.includes('"created_by" = ?'), 'the row rule stays in the WHERE');
    // Filter and sort on a read-time field stay refused.
    assert.throws(() => qc.compileRecordList(TABLE, { readTimeComputed: true, filters: [{ field: 'total', op: 'gt', value: 1 }] }, ALLOW), /read-time computed/);
    assert.throws(() => qc.compileRecordList(TABLE, { readTimeComputed: true, sort: [{ field: 'total' }] }, ALLOW), /read-time computed/);
});

test('compileGetById with readTimeComputed', () => {
    const out = qc.compileGetById(TABLE, 'rec_1', ALLOW, { dialect: 'sqlite', readTimeComputed: true });
    assert.strictEqual(out.sql, 'SELECT *, ("price" * "qty") AS "total", NULL AS "twice" FROM "items" WHERE "id" = ? AND (1=1) LIMIT 1');
    assert.deepStrictEqual(out.params, ['rec_1']);
    assert.strictEqual(out.readTimeComputed.fallbackSql, 'SELECT *, NULL AS "total", NULL AS "twice" FROM "items" WHERE "id" = ? AND (1=1) LIMIT 1');
});

test('queryWithComputed: passthrough, refused notes, fallback, and a read that fails anyway', async () => {
    const plain = { sql: 'A', params: [1] };
    assert.deepStrictEqual(await queryWithComputed(async (s, p) => ({ rows: [{ s, p }] }), plain),
        { result: { rows: [{ s: 'A', p: [1] }] }, notes: [] });

    const compiled = { sql: 'MAIN', params: [7], readTimeComputed: { keys: ['a', 'b'], refused: ['b'], fallbackSql: 'FALLBACK' } };
    const ok = await queryWithComputed(async () => ({ rows: [{ a: 1, b: null }] }), compiled);
    assert.deepStrictEqual(ok.notes, [computedNote('b')]);

    const seen = [];
    const fell = await queryWithComputed(async (s, p) => {
        seen.push([s, p]);
        if (s === 'MAIN') throw Object.assign(new Error('division by zero: 42'), { code: '22012' });
        return { rows: [{ a: null, b: null }] };
    }, compiled);
    assert.deepStrictEqual(seen, [['MAIN', [7]], ['FALLBACK', [7]]], 'same params on the fallback');
    assert.deepStrictEqual(fell.notes, [computedNote('a'), computedNote('b')]);
    assert.ok(!fell.notes.join(' ').includes('42'), 'the engine message never reaches the note');

    const first = new Error('first');
    await assert.rejects(queryWithComputed(async (s) => { throw s === 'MAIN' ? first : new Error('second'); }, compiled), (e) => e === first);
    await assert.rejects(queryWithComputed(async () => { throw first; }, plain), (e) => e === first);
});

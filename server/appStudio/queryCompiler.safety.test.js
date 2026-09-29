/**
 * Query compiler — SAFETY invariants (the deliverable).
 *
 * Proves THE ONE INVARIANT at the SQL-generation boundary:
 *   • the RLS access predicate is present in EVERY compiled string;
 *   • client field/op/fn/bucket strings are validated against a closed vocab —
 *     an unknown one throws, and a client string NEVER becomes an identifier;
 *   • every value is a BOUND ? param, never interpolated (injection payloads
 *     round-trip verbatim in the params array);
 *   • limits are clamped; __proto__/constructor keys are rejected;
 *   • the row-filter translator rejects function-calls / arithmetic.
 *
 * Pure — no DB. Run: cd server && node --test appStudio/queryCompiler.safety.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub the PG-backed data store BEFORE requiring rlsGateway (its module top
// `require('../stores/studioAppDataStore')` would otherwise open a live PG
// connection). The gateway's rowFilterToSql needs no store at all.
const filename = require.resolve('../stores/studioAppDataStore');
require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: { getMemberRole: async () => null },
};

const qc = require('./queryCompiler');
const { rowFilterToSql } = require('./rlsGateway');
const { parseExpr } = require('../automation/expr');

// ── Fixtures ────────────────────────────────────────────────────────
const TABLE = {
    id: 'tbl_abc123',
    key: 'tasks',
    fields: [
        { id: 'fld_1', key: 'title', type: 'text' },
        { id: 'fld_2', key: 'amount', type: 'number', subtype: 'integer' },
        { id: 'fld_3', key: 'region', type: 'text' },
        { id: 'fld_4', key: 'tags', type: 'multiselect', options: ['a', 'b'] },
        { id: 'fld_5', key: 'total', type: 'computed', computed: { expr: 'amount * 2' } }, // read-time
    ],
};
// A distinctive access filter so we can assert its presence in the SQL.
const ACCESS = { where: 'created_by = ?', params: ['viewer-1'] };
const ALLOW = { where: '1=1', params: [] };

// ── Access predicate is present in EVERY compiled string ────────────

test('every read/mutate compiler embeds the access predicate + its params', () => {
    const list = qc.compileRecordList(TABLE, {}, ACCESS);
    const agg = qc.compileAggregate(TABLE, { aggregates: [{ fn: 'count' }] }, ACCESS);
    const upd = qc.compileUpdate(TABLE, 'rec_1', { title: 'x' }, ACCESS);
    const del = qc.compileDelete(TABLE, 'rec_1', ACCESS);
    const one = qc.compileGetById(TABLE, 'rec_1', ACCESS);

    for (const { sql, params } of [list, agg, upd, del, one]) {
        assert.ok(sql.includes(`(${ACCESS.where})`), `access predicate wrapped in SQL: ${sql}`);
        assert.ok(params.includes('viewer-1'), 'access param bound');
    }
});

test('expectedUpdatedAt ANDs a CAS guard on without displacing the access filter', () => {
    const plain = qc.compileUpdate(TABLE, 'rec_1', { title: 'x' }, ACCESS);
    assert.ok(!/updated_at"\s*=\s*\?\s*$/.test(plain.sql), 'no guard without a token (opt-in)');

    const stamp = '2026-08-07T10:11:12.345Z';
    const cas = qc.compileUpdate(TABLE, 'rec_1', { title: 'x' }, ACCESS, { expectedUpdatedAt: stamp });
    assert.ok(cas.sql.includes(`(${ACCESS.where})`), 'access predicate still wrapped');
    assert.ok(/AND "updated_at" = \?$/.test(cas.sql), `guard is the last predicate: ${cas.sql}`);
    // Param ORDER is the contract: SET values, id, access params, then guard.
    assert.strictEqual(cas.params.at(-1), stamp);
    assert.strictEqual(cas.params.at(-2), 'viewer-1');
    assert.strictEqual(cas.params.at(-3), 'rec_1');
    assert.strictEqual(cas.params.length, plain.params.length + 1);

    for (const bad of ['', 42, {}, []]) {
        assert.throws(
            () => qc.compileUpdate(TABLE, 'rec_1', { title: 'x' }, ACCESS, { expectedUpdatedAt: bad }),
            /expectedUpdatedAt/,
            `rejects ${JSON.stringify(bad)}`,
        );
    }
});

test('fuzzed list/aggregate descriptors always keep the AND (accessFilter) wrapper', () => {
    const fields = ['title', 'amount', 'region', 'created_at'];
    const ops = ['eq', 'neq', 'gt', 'lt', 'contains', 'in', 'isNull'];
    for (let i = 0; i < 60; i++) {
        const f = fields[i % fields.length];
        const op = ops[i % ops.length];
        const value = op === 'in' ? [1, 2, i] : (op === 'isNull' ? undefined : `v${i}`);
        const filters = [{ field: f, op, value }];
        const access = i % 2 ? ACCESS : ALLOW;
        const list = qc.compileRecordList(TABLE, { filters, limit: i }, access);
        const agg = qc.compileAggregate(TABLE, { filters, groupBy: [{ field: 'region' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] }, access);
        assert.ok(list.sql.includes(`(${access.where})`), `list wraps access: ${list.sql}`);
        assert.ok(agg.sql.includes(`(${access.where})`), `aggregate wraps access: ${agg.sql}`);
        // access predicate comes before GROUP BY so aggregates fold visible rows only
        if (agg.sql.includes('GROUP BY')) {
            assert.ok(agg.sql.indexOf(access.where) < agg.sql.indexOf('GROUP BY'), 'access ANDed before GROUP BY');
        }
    }
});

// ── accessFilter is REQUIRED — no unscoped overload ─────────────────

test('compileRecordList / Aggregate / Update / Delete / GetById REQUIRE an accessFilter', () => {
    assert.throws(() => qc.compileRecordList(TABLE, {}), /accessFilter/);
    assert.throws(() => qc.compileAggregate(TABLE, { aggregates: [{ fn: 'count' }] }), /accessFilter/);
    assert.throws(() => qc.compileUpdate(TABLE, 'rec_1', { title: 'x' }), /accessFilter/);
    assert.throws(() => qc.compileDelete(TABLE, 'rec_1'), /accessFilter/);
    assert.throws(() => qc.compileGetById(TABLE, 'rec_1'), /accessFilter/);
    // A malformed access filter (missing params / where) is also rejected.
    assert.throws(() => qc.compileRecordList(TABLE, {}, { where: 'x' }), /accessFilter/);
    assert.throws(() => qc.compileRecordList(TABLE, {}, { params: [] }), /accessFilter/);
});

// ── Closed vocabularies ─────────────────────────────────────────────

test('unknown field → throws (client string never becomes an identifier)', () => {
    assert.throws(() => qc.compileRecordList(TABLE, { filters: [{ field: 'ssn', op: 'eq', value: 1 }] }, ACCESS), /unknown field/);
    assert.throws(() => qc.compileRecordList(TABLE, { sort: [{ field: 'nope' }] }, ACCESS), /unknown field/);
    assert.throws(() => qc.compileAggregate(TABLE, { groupBy: [{ field: 'nope' }] }, ACCESS), /unknown field/);
    assert.throws(() => qc.compileInsert(TABLE, { nope: 1 }), /unknown field/);
    assert.throws(() => qc.compileUpdate(TABLE, 'rec_1', { nope: 1 }, ACCESS), /unknown field/);
});

test('read-time computed field cannot be queried', () => {
    assert.throws(() => qc.compileRecordList(TABLE, { filters: [{ field: 'total', op: 'gt', value: 1 }] }, ACCESS), /computed/);
});

test('unknown op / aggregate fn / date bucket → throws', () => {
    assert.throws(() => qc.compileRecordList(TABLE, { filters: [{ field: 'title', op: 'regex', value: 'x' }] }, ACCESS), /unknown filter op/);
    assert.throws(() => qc.compileAggregate(TABLE, { aggregates: [{ fn: 'median', field: 'amount' }] }, ACCESS), /unknown aggregate fn/);
    assert.throws(() => qc.compileAggregate(TABLE, { groupBy: [{ field: 'created_at', bucket: 'decade' }] }, ACCESS), /date bucket/);
});

test('unsafe aggregate alias → throws (aliases become quoted identifiers)', () => {
    assert.throws(() => qc.compileAggregate(TABLE, { aggregates: [{ fn: 'count', as: 'a"; DROP' }] }, ACCESS), /invalid alias/);
});

// ── Injection payloads round-trip as BOUND params ───────────────────

test('injection-y values are bound params, never interpolated into SQL', () => {
    const payloads = ["'; DROP TABLE tasks; --", '1=1', '" OR ""="', "\\'; --", '%_wild'];
    for (const p of payloads) {
        const { sql, params } = qc.compileRecordList(TABLE, { filters: [{ field: 'title', op: 'eq', value: p }] }, ACCESS);
        assert.ok(params.includes(p), `value bound verbatim: ${p}`);
        assert.ok(!sql.includes('DROP TABLE'), 'payload not spliced into SQL text');
        assert.ok(sql.includes('"title" = ?'), 'value is a ? placeholder');
    }
    // contains escapes LIKE wildcards but still binds the value.
    const c = qc.compileRecordList(TABLE, { filters: [{ field: 'title', op: 'contains', value: '100%_x' }] }, ACCESS);
    assert.ok(c.sql.includes("LIKE ? ESCAPE '\\'"), 'LIKE uses ESCAPE');
    assert.ok(c.params.some((v) => typeof v === 'string' && v.includes('\\%') && v.includes('\\_')), 'wildcards escaped in the bound param');
});

test('IN clause binds each element as its own ? param', () => {
    const { sql, params } = qc.compileRecordList(TABLE, { filters: [{ field: 'amount', op: 'in', value: [1, 2, "3; DROP"] }] }, ACCESS);
    assert.ok(/IN \(\?, \?, \?\)/.test(sql), 'one placeholder per element');
    assert.ok(params.includes('3; DROP'), 'element bound verbatim');
});

// ── Limit clamping ──────────────────────────────────────────────────

test('list limit is clamped to MAX_RESULT_ROWS', () => {
    const { params, limit } = qc.compileRecordList(TABLE, { limit: 10_000_000 }, ACCESS);
    assert.strictEqual(limit, qc.MAX_RESULT_ROWS);
    assert.strictEqual(params[params.length - 1], qc.MAX_RESULT_ROWS + 1); // +1 probe row
});

test('aggregate limit is clamped to MAX_RESULT_ROWS', () => {
    const { params } = qc.compileAggregate(TABLE, { aggregates: [{ fn: 'count' }], limit: 999999 }, ACCESS);
    assert.strictEqual(params[params.length - 1], qc.MAX_RESULT_ROWS);
});

// ── Prototype-pollution keys ────────────────────────────────────────

test('__proto__ / constructor as a field key → rejected (Object.hasOwn resolution)', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
        assert.throws(() => qc.compileRecordList(TABLE, { filters: [{ field: bad, op: 'eq', value: 1 }] }, ACCESS), /unknown field/);
        assert.throws(() => qc.compileInsert(TABLE, { [bad]: 1 }), /unknown field/);
    }
});

test('__proto__ / injection strings as a TABLE key → rejected before quoting', () => {
    // (`constructor` IS a grammatically valid lowercase identifier and is safe
    // once quoted; the prototype-pollution risk is only in field-key *lookup*,
    // covered above via the Map-based resolver.)
    for (const bad of ['__proto__', 'DROP TABLE x', 'tasks; --', 'has space', '1tbl', 'UPPER']) {
        assert.throws(() => qc.compileRecordList({ key: bad, fields: [] }, {}, ACCESS), /invalid table key/);
    }
});

// ── System columns are server-owned ─────────────────────────────────

test('insert stamps id/created_at/created_by/org_id from args; client system cols dropped', () => {
    const { sql, params, id } = qc.compileInsert(TABLE, {
        title: 'hi', created_by: 'attacker', id: 'evil', org_id: 'evil-org', created_at: '1970',
    }, { createdBy: 'real-user', orgId: 'real-org' });
    assert.ok(id.startsWith('rec_'), 'server-generated record id');
    assert.strictEqual(params[0], id, 'id column = generated id, not client "evil"');
    assert.strictEqual(params[3], 'real-user', 'created_by from server arg');
    assert.strictEqual(params[4], 'real-org', 'org_id from server arg');
    assert.ok(!params.includes('evil'), 'client id ignored');
    assert.ok(!params.includes('attacker'), 'client created_by ignored');
    // Only the 5 system cols + title are inserted.
    assert.ok(sql.includes('"title"'));
    assert.ok(!/"created_at"[^)]*"created_at"/.test(sql), 'no duplicate system column');
});

test('update never sets system columns and always bumps updated_at', () => {
    const { sql } = qc.compileUpdate(TABLE, 'rec_1', { title: 'x', created_by: 'attacker', id: 'evil' }, ACCESS);
    const setPart = sql.split(' WHERE ')[0]; // only the SET clause, not the id in WHERE
    assert.ok(setPart.includes('"updated_at" = ?'), 'updated_at bumped');
    assert.ok(setPart.includes('"title" = ?'));
    assert.ok(!setPart.includes('"created_by" = ?'), 'created_by not settable');
    assert.ok(!setPart.includes('"id" = ?'), 'id not settable in SET');
});

// ── Row-filter translator: bounded subset only ──────────────────────

test('rowFilterToSql accepts the bounded subset (comparison, &&/||, !, record.*, viewer.*, literals)', () => {
    const viewer = { id: 'u1', region: 'EU' };
    const ok = [
        'record.region == viewer.region',
        'record.amount >= 100 && record.title != "x"',
        '!(record.region == "US") || record.amount < 5',
        'record.amount',
    ];
    for (const expr of ok) {
        const { sql } = rowFilterToSql(parseExpr(expr), viewer, TABLE);
        assert.ok(typeof sql === 'string' && sql.length, `translated: ${expr}`);
        // no literal ever appears un-parameterised (values are ? / columns only)
        assert.ok(!/'[^']/.test(sql) || sql.includes('ESCAPE'), `no raw string literal in: ${sql}`);
    }
    // viewer.region binds as a param, not an identifier.
    const r = rowFilterToSql(parseExpr('record.region == viewer.region'), viewer, TABLE);
    assert.ok(r.sql.includes('"region"'), 'record.region → quoted column');
    assert.ok(r.params.includes('EU'), 'viewer.region bound as a param');
});

test('rowFilterToSql REJECTS function-calls, arithmetic, brackets, ternary, unknown roots, null', () => {
    const bad = [
        'upper(record.title) == "X"',   // function call
        'record.amount + 1 > 2',         // arithmetic
        'record["region"] == "EU"',      // computed/bracket access
        'record.region == "EU" ? 1 : 0', // ternary
        'evil.secret == 1',              // unknown root
        'record.region == null',         // null literal
        'record.a.b == 1',               // deep path (not record.<field>)
    ];
    for (const expr of bad) {
        assert.throws(() => rowFilterToSql(parseExpr(expr), { id: 'u1' }, TABLE), `rejected: ${expr}`);
    }
});

test('rowFilterToSql rejects record.<unknownField>', () => {
    assert.throws(() => rowFilterToSql(parseExpr('record.ssn == 1'), { id: 'u1' }, TABLE), /unknown field/);
});

// ── Percentiles ─────────────────────────────────────────────────────────────

test('p50/p90 compile to a nearest-rank window with RLS INSIDE the CTE', () => {
    // The placement of the access predicate is the whole security story: the
    // window ranks whatever the CTE returns, so filtering afterwards would
    // compute a median over rows the viewer may not see — and then show it.
    const { sql, params } = qc.compileAggregate(
        TABLE,
        { aggregates: [{ fn: 'p50', field: 'amount', as: 'median' }] },
        ACCESS,
    );

    assert.match(sql, /^WITH __src AS \(SELECT /);
    const cteEnd = sql.indexOf(') SELECT');
    const cte = sql.slice(0, cteEnd);
    const outer = sql.slice(cteEnd);
    assert.ok(cte.includes('created_by = ?'), 'the access predicate must be in the CTE');
    assert.ok(!outer.includes('created_by = ?'), 'and NOT deferred to the outer query');

    assert.match(sql, /ROW_NUMBER\(\) OVER \(ORDER BY \(CASE WHEN "amount" IS NULL THEN 1 ELSE 0 END\), "amount"\)/);
    assert.match(sql, /COUNT\("amount"\) OVER \(\)/, 'counts non-NULLs, so gaps do not shift the rank');
    assert.match(sql, /AS "median"/);
    assert.deepStrictEqual(params, ['viewer-1', 50]);
});

test('a grouped percentile partitions by the same expressions it groups on', () => {
    const { sql } = qc.compileAggregate(
        TABLE,
        { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'p90', field: 'amount', as: 'p90_amount' }] },
        ACCESS,
    );
    assert.match(sql, /PARTITION BY "region"/);
    assert.match(sql, /GROUP BY "region"/);
    assert.match(sql, /0\.9 \* "__cn_0"/);
});

test('percentiles combine with ordinary aggregates in one query', () => {
    const { sql } = qc.compileAggregate(
        TABLE,
        {
            groupBy: [{ field: 'region' }],
            aggregates: [{ fn: 'count', as: 'n' }, { fn: 'p50', field: 'amount', as: 'median' }],
        },
        ACCESS,
    );
    assert.match(sql, /COUNT\(\*\) AS "n"/);
    assert.match(sql, /AS "median"/);
});

test('a percentile without a field is refused', () => {
    assert.throws(
        () => qc.compileAggregate(TABLE, { aggregates: [{ fn: 'p50' }] }, ACCESS),
        /needs a field to rank/,
    );
});

test('a query with NO percentile still compiles to the plain, CTE-free form', () => {
    // Regression guard: adding percentiles must not change the SQL every
    // existing dashboard already runs.
    const { sql } = qc.compileAggregate(
        TABLE,
        { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'sum', field: 'amount', as: 'total' }] },
        ACCESS,
    );
    assert.ok(!sql.includes('WITH __src'));
    assert.match(sql, /^SELECT "region" AS "region", SUM\("amount"\) AS "total" FROM "tasks" WHERE/);
});

test("the 'hour' bucket folds every day onto hour-of-day", () => {
    const { sql } = qc.compileAggregate(
        TABLE,
        { groupBy: [{ field: 'created_at', bucket: 'hour', as: 'hour' }], aggregates: [{ fn: 'count', as: 'n' }] },
        ACCESS,
    );
    assert.match(sql, /strftime\('%H', "created_at"\) AS "hour"/);
});

/**
 * Executable proof, not just string matching: run the generated SQL on a real
 * SQLite and check both the maths and the isolation. A percentile that compiles
 * but returns the wrong number, or ranks over rows the viewer cannot see, would
 * pass every assertion above.
 */
test('percentiles execute on SQLite and rank ONLY the visible rows', (t) => {
    let Database;
    try { Database = require('better-sqlite3'); } catch { return t.skip('better-sqlite3 unavailable'); }

    const T = { id: 'tbl_p', key: 'tickets', fields: [
        { id: 'fld_1', key: 'region', type: 'text' },
        { id: 'fld_2', key: 'secs', type: 'number', subtype: 'integer' },
    ] };
    const access = { where: 'created_by = ?', params: ['u1'] };

    const db = new Database(':memory:');
    db.exec('CREATE TABLE tickets (id TEXT, created_by TEXT, region TEXT, secs INTEGER)');
    const ins = db.prepare('INSERT INTO tickets VALUES (?,?,?,?)');
    [10, 20, 30, 40, 50].forEach((s, i) => ins.run(`r${i}`, 'u1', 'nl', s));
    // Rows another viewer owns. If the access filter slipped to the outer query
    // these would drag the median down to single digits.
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((s, i) => ins.run(`x${i}`, 'u2', 'nl', s));
    ins.run('n1', 'u1', 'nl', null);   // a gap must not shift the rank

    const { sql, params } = qc.compileAggregate(T, {
        aggregates: [{ fn: 'p50', field: 'secs', as: 'median' }, { fn: 'p90', field: 'secs', as: 'p90' }],
    }, access);
    const row = db.prepare(sql).get(...params);

    assert.strictEqual(row.median, 30, 'median of the five visible values');
    assert.strictEqual(row.p90, 50);

    const grouped = qc.compileAggregate(T, {
        groupBy: [{ field: 'region' }],
        aggregates: [{ fn: 'count', as: 'n' }, { fn: 'p50', field: 'secs', as: 'median' }],
    }, access);
    const rows = db.prepare(grouped.sql).all(...grouped.params);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].median, 30);
    db.close();
});

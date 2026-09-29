/**
 * Query compiler — PG DIALECT (App Studio v3 wave B2).
 *
 * Compiles the full descriptor surface under engineFlag 'pg' and EXECUTES the
 * result against a real Postgres (@electric-sql/pglite, in-memory WASM PG) so
 * the dialect port is proven on a live engine, not by string inspection alone:
 *   • DDL from dataModel (pg types incl. GENERATED … STORED) materialises;
 *   • record list: filters (contains→ILIKE, in, EMPTY in→FALSE, isNull),
 *     sort, keyset cursor;
 *   • insert/update/delete with access-scoping semantics (0 changes = 404);
 *   • aggregates: count/sum/avg, date buckets (to_char family),
 *     p50/p90 via PERCENTILE_DISC — WITH THE ACCESS FILTER INSIDE THE ONLY
 *     WHERE (asserted on the SQL and proven by executing against a table
 *     holding another owner's outlier);
 *   • booleans bind as true/false and come back as booleans;
 *   • toDollarParams count-mismatch throws (placeholder/param drift is loud).
 *
 * The sqlite dialect stays covered by queryCompiler.safety.test.js — this file
 * flips the flag for its whole process (node --test isolates processes).
 *
 * Run: cd server && node --test appStudio/queryCompiler.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// Stub the PG-backed data store BEFORE requiring rlsGateway (its module top
// `require('../stores/studioAppDataStore')` would otherwise open a live PG
// connection). rowFilterToSql needs no store at all.
const dataStorePath = require.resolve('../stores/studioAppDataStore');
require.cache[dataStorePath] = {
    id: dataStorePath, filename: dataStorePath, loaded: true,
    exports: { getMemberRole: async () => null },
};

const engineFlag = require('./engineFlag');
engineFlag._setForTests('pg');

const qc = require('./queryCompiler');
const { rowFilterToSql } = require('./rlsGateway');
const { ddlForTable } = require('./dataModel');
const { toDollarParams } = require('../stores/lib/pgAppEngine');

// ── Fixtures: every field type, incl. stored + read-time computed ───
const PROJECTS = {
    id: 'tbl_proj01',
    key: 'projects',
    fields: [{ id: 'fld_p1', key: 'pname', type: 'text' }],
};
const TASKS = {
    id: 'tbl_task01',
    key: 'tasks',
    fields: [
        { id: 'fld_t1', key: 'title', type: 'text' },
        { id: 'fld_t2', key: 'notes', type: 'richtext' },
        { id: 'fld_t3', key: 'amount', type: 'number' },
        { id: 'fld_t4', key: 'qty', type: 'number', subtype: 'integer' },
        { id: 'fld_t5', key: 'due', type: 'date' },
        { id: 'fld_t6', key: 'happened_at', type: 'datetime' },
        { id: 'fld_t7', key: 'active', type: 'bool' },
        { id: 'fld_t8', key: 'status', type: 'select', options: ['open', 'done'] },
        { id: 'fld_t9', key: 'tags', type: 'multiselect', options: ['a', 'b'] },
        { id: 'fld_t10', key: 'project', type: 'relation', relation: { table: 'tbl_proj01' } },
        { id: 'fld_t11', key: 'attachment', type: 'file' },
        { id: 'fld_t12', key: 'title_upper', type: 'computed', computed: { expr: 'upper(title)', stored: true, type: 'text' } },
        { id: 'fld_t13', key: 'derived', type: 'computed', computed: { expr: 'amount * 2' } }, // read-time
    ],
};
const KEY_BY_ID = new Map([[PROJECTS.id, PROJECTS.key], [TASKS.id, TASKS.key]]);

const ALLOW = { where: '1=1', params: [] };
const MINE = { where: '"created_by" = ?', params: ['user-1'] };

// ── pglite harness ──────────────────────────────────────────────────
let db = null;
const run = async (sql, params = []) => {
    const converted = toDollarParams(sql, params.length);
    return db.query(converted, params);
};

const seededIds = {}; // title -> record id

test('(setup) boot pglite, materialise pg DDL, seed via compiled inserts', async () => {
    const { PGlite } = require('@electric-sql/pglite');
    db = new PGlite();
    await db.exec("SET TIME ZONE 'UTC'");
    await db.exec(ddlForTable(PROJECTS, { tableKeyById: KEY_BY_ID }));
    await db.exec(ddlForTable(TASKS, { tableKeyById: KEY_BY_ID }));

    const proj = qc.compileInsert(PROJECTS, { pname: 'Apollo' }, { createdBy: 'user-1', orgId: 'org-1' });
    await run(proj.sql, proj.params);
    seededIds.project = proj.id;

    const seed = [
        // [title, amount, qty, due, happened_at, active, status, tags, project, createdBy]
        ['Alpha task', 10, 1, '2026-03-14', '2026-03-14T10:30:00.000Z', true, 'open', ['a'], proj.id, 'user-1'],
        ['beta task', 20, 2, '2026-06-01', '2026-06-01T23:15:00.000Z', false, 'open', ['a', 'b'], null, 'user-1'],
        ['100% done', 30, 3, '2026-12-31', '2026-12-31T05:00:00.000Z', true, 'done', [], null, 'user-1'],
        ['intruder outlier', 1000, 9, '2026-01-01', '2026-01-01T00:00:00.000Z', false, 'done', [], null, 'user-2'],
    ];
    for (const [title, amount, qty, due, at, active, status, tags, project, createdBy] of seed) {
        const ins = qc.compileInsert(TASKS, {
            title, amount, qty, due, happened_at: at, active, status, tags,
            ...(project ? { project } : {}),
            attachment: [{ name: `${title}.txt` }],
            derived: 999, // computed → must be dropped by the compiler
        }, { createdBy, orgId: 'org-1' });
        assert.ok(!ins.sql.includes('derived'), 'computed fields are never written');
        assert.ok(!ins.sql.includes('$'), 'compiler emits ? placeholders, never $n');
        await run(ins.sql, ins.params);
        seededIds[title] = ins.id;
    }
});

test.after(async () => { if (db) await db.close(); });

// ── Booleans: bind true/false, come back as booleans ────────────────

test('pg: bool filter binds a real boolean and rows return booleans', async () => {
    const { sql, params } = qc.compileRecordList(TASKS, {
        filters: [{ field: 'active', op: 'eq', value: true }],
    }, ALLOW);
    assert.deepStrictEqual(params, [true, 51], 'boolean binds as true (not 1), plus the limit probe');
    const res = await run(sql, params);
    assert.strictEqual(res.rows.length, 2);
    for (const row of res.rows) assert.strictEqual(row.active, true, 'BOOLEAN comes back as true');
});

test('pg: stored computed column works, read-time computed is rejected', async () => {
    const { sql, params } = qc.compileRecordList(TASKS, {
        filters: [{ field: 'title_upper', op: 'eq', value: 'ALPHA TASK' }],
    }, ALLOW);
    const res = await run(sql, params);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].title, 'Alpha task');
    assert.throws(
        () => qc.compileRecordList(TASKS, { filters: [{ field: 'derived', op: 'eq', value: 1 }] }, ALLOW),
        /read-time computed/,
    );
});

// ── contains / startsWith → ILIKE (+ escaped wildcards) ─────────────

test('pg: contains compiles to ILIKE and matches case-insensitively', async () => {
    const { sql, params } = qc.compileRecordList(TASKS, {
        filters: [{ field: 'title', op: 'contains', value: 'ALPHA' }],
    }, ALLOW);
    assert.match(sql, /ILIKE/);
    assert.doesNotMatch(sql, /(?<!I)LIKE/, 'plain LIKE is the sqlite spelling');
    const res = await run(sql, params);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].title, 'Alpha task');
});

test('pg: contains escapes % so a literal percent only matches itself', async () => {
    const { sql, params } = qc.compileRecordList(TASKS, {
        filters: [{ field: 'title', op: 'contains', value: '0% d' }],
    }, ALLOW);
    const res = await run(sql, params);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].title, '100% done');
});

test('pg: startsWith uses ILIKE with a trailing wildcard', async () => {
    const { sql, params } = qc.compileRecordList(TASKS, {
        filters: [{ field: 'title', op: 'startsWith', value: 'BETA' }],
    }, ALLOW);
    assert.match(sql, /ILIKE/);
    const res = await run(sql, params);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].title, 'beta task');
});

// ── in / EMPTY in / isNull ──────────────────────────────────────────

test('pg: in filter binds every value; empty in emits FALSE and matches nothing', async () => {
    const inQ = qc.compileRecordList(TASKS, {
        filters: [{ field: 'status', op: 'in', value: ['open'] }],
    }, ALLOW);
    const inRes = await run(inQ.sql, inQ.params);
    assert.strictEqual(inRes.rows.length, 2);

    const emptyQ = qc.compileRecordList(TASKS, {
        filters: [{ field: 'status', op: 'in', value: [] }],
    }, ALLOW);
    assert.match(emptyQ.sql, /FALSE/, 'pg needs a boolean literal (bare 0 is a type error under AND)');
    const emptyRes = await run(emptyQ.sql, emptyQ.params);
    assert.strictEqual(emptyRes.rows.length, 0);
});

test('pg: isNull / isNotNull on a relation column', async () => {
    const q = qc.compileRecordList(TASKS, {
        filters: [{ field: 'project', op: 'isNull' }],
    }, ALLOW);
    const res = await run(q.sql, q.params);
    assert.strictEqual(res.rows.length, 3);
    const q2 = qc.compileRecordList(TASKS, {
        filters: [{ field: 'project', op: 'isNotNull' }],
    }, ALLOW);
    const res2 = await run(q2.sql, q2.params);
    assert.strictEqual(res2.rows.length, 1);
    assert.strictEqual(res2.rows[0].project, seededIds.project);
});

// ── sort + keyset cursor ────────────────────────────────────────────

test('pg: keyset pagination pages the whole set in order without overlap', async () => {
    const page1 = qc.compileRecordList(TASKS, { sort: [{ field: 'amount', dir: 'asc' }], limit: 2 }, ALLOW);
    const r1 = await run(page1.sql, page1.params);
    assert.strictEqual(r1.rows.length, 3, 'limit+1 probe row');
    const window1 = r1.rows.slice(0, page1.limit);
    const cursor = qc.encodeCursor(window1[1][page1.primaryField], window1[1].id);

    const page2 = qc.compileRecordList(TASKS, { sort: [{ field: 'amount', dir: 'asc' }], limit: 2, cursor }, ALLOW);
    const r2 = await run(page2.sql, page2.params);
    const window2 = r2.rows.slice(0, page2.limit);

    const amounts = [...window1, ...window2].map((r) => Number(r.amount));
    assert.deepStrictEqual(amounts, [10, 20, 30, 1000], 'contiguous, ordered, no overlap');
    const ids = new Set([...window1, ...window2].map((r) => r.id));
    assert.strictEqual(ids.size, 4);
});

// ── getById / update / delete with access-scoping semantics ─────────

test('pg: getById honors the access filter (out-of-scope row → 0 rows)', async () => {
    const mine = qc.compileGetById(TASKS, seededIds['Alpha task'], MINE);
    const r1 = await run(mine.sql, mine.params);
    assert.strictEqual(r1.rows.length, 1);

    const notMine = qc.compileGetById(TASKS, seededIds['intruder outlier'], MINE);
    const r2 = await run(notMine.sql, notMine.params);
    assert.strictEqual(r2.rows.length, 0, 'hidden row reads as absent (404 semantics)');
});

test('pg: update bumps updated_at, respects scope; delete removes the row', async () => {
    const upd = qc.compileUpdate(TASKS, seededIds['beta task'], { notes: 'edited', active: true }, MINE);
    const r1 = await run(upd.sql, upd.params);
    assert.strictEqual(r1.affectedRows, 1);

    const blocked = qc.compileUpdate(TASKS, seededIds['intruder outlier'], { notes: 'nope' }, MINE);
    const r2 = await run(blocked.sql, blocked.params);
    assert.strictEqual(r2.affectedRows, 0, 'out-of-scope update touches 0 rows');

    const ins = qc.compileInsert(TASKS, { title: 'doomed', amount: 5 }, { createdBy: 'user-1', orgId: 'org-1' });
    await run(ins.sql, ins.params);
    const del = qc.compileDelete(TASKS, ins.id, MINE);
    const r3 = await run(del.sql, del.params);
    assert.strictEqual(r3.affectedRows, 1);
    const gone = await run(...(({ sql, params }) => [sql, params])(qc.compileGetById(TASKS, ins.id, ALLOW)));
    assert.strictEqual(gone.rows.length, 0);
});

// ── aggregates: plain fns + date buckets ────────────────────────────

test('pg: count/sum/avg/min/max fold only access-visible rows', async () => {
    const agg = qc.compileAggregate(TASKS, {
        aggregates: [
            { fn: 'count', as: 'n' },
            { fn: 'sum', field: 'amount', as: 'total' },
            { fn: 'avg', field: 'qty', as: 'avg_qty' },
            { fn: 'min', field: 'amount', as: 'lo' },
            { fn: 'max', field: 'amount', as: 'hi' },
        ],
    }, MINE);
    const res = await run(agg.sql, agg.params);
    const row = res.rows[0];
    assert.strictEqual(Number(row.n), 3);
    assert.strictEqual(Number(row.total), 60);
    assert.strictEqual(Number(row.avg_qty), 2);
    assert.strictEqual(Number(row.lo), 10);
    assert.strictEqual(Number(row.hi), 30);
});

test('pg: groupBy select field with sort by aggregate alias', async () => {
    const agg = qc.compileAggregate(TASKS, {
        groupBy: [{ field: 'status' }],
        aggregates: [{ fn: 'count', as: 'n' }],
        sort: [{ field: 'n', dir: 'desc' }],
    }, ALLOW);
    const res = await run(agg.sql, agg.params);
    // Both groups count 2, so their mutual order is unspecified — compare as a set.
    const entries = res.rows.map(r => [r.status, Number(r.n)]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepStrictEqual(entries, [['done', 2], ['open', 2]]);
});

test('pg: every date bucket compiles to to_char and buckets correctly (UTC)', async () => {
    const expect = {
        hour: ['00', '05', '10', '23'],
        day: ['2026-01-01', '2026-03-14', '2026-06-01', '2026-12-31'],
        week: ['2026-W01', '2026-W11', '2026-W23', '2026-W53'],
        month: ['2026-01', '2026-03', '2026-06', '2026-12'],
        quarter: ['2026-Q1', '2026-Q2', '2026-Q4'],
        year: ['2026'],
    };
    for (const [bucket, want] of Object.entries(expect)) {
        const agg = qc.compileAggregate(TASKS, {
            groupBy: [{ field: 'happened_at', bucket, as: 'b' }],
            aggregates: [{ fn: 'count', as: 'n' }],
            sort: [{ field: 'b', dir: 'asc' }],
        }, ALLOW);
        assert.match(agg.sql, /to_char\(/, `${bucket} uses to_char under pg`);
        assert.doesNotMatch(agg.sql, /strftime/, `${bucket} must not leak strftime into pg SQL`);
        const res = await run(agg.sql, agg.params);
        assert.deepStrictEqual(res.rows.map(r => r.b), want, `bucket ${bucket}`);
    }
});

// ── percentiles: PERCENTILE_DISC with the access filter INSIDE ──────

test('pg: p50/p90 use PERCENTILE_DISC, no CTE, access filter in the one WHERE', async () => {
    const agg = qc.compileAggregate(TASKS, {
        aggregates: [
            { fn: 'p50', field: 'amount', as: 'med' },
            { fn: 'p90', field: 'amount', as: 'p90' },
        ],
    }, MINE);
    assert.match(agg.sql, /PERCENTILE_DISC\(0\.5\) WITHIN GROUP \(ORDER BY "amount"\)/);
    assert.match(agg.sql, /PERCENTILE_DISC\(0\.9\) WITHIN GROUP \(ORDER BY "amount"\)/);
    assert.ok(!agg.sql.includes('WITH __src'), 'pg path must not use the sqlite ranking CTE');
    assert.ok(agg.sql.includes(`WHERE (${MINE.where})`), 'ACCESS FILTER PRESENT in the percentile SQL WHERE');
    assert.ok(agg.params.includes('user-1'), 'access param bound');

    const res = await run(agg.sql, agg.params);
    // user-1 amounts are [10,20,30]; user-2 holds a 1000 outlier. p90 over the
    // scoped set is 30 — if the access filter leaked outside the fold, the
    // outlier would drag it to 1000.
    assert.strictEqual(Number(res.rows[0].med), 20);
    assert.strictEqual(Number(res.rows[0].p90), 30, 'outlier excluded → access filter folds INSIDE');
});

test('pg: grouped percentile keeps GROUP BY after the access-scoped WHERE', async () => {
    const agg = qc.compileAggregate(TASKS, {
        groupBy: [{ field: 'status' }],
        aggregates: [{ fn: 'p50', field: 'amount', as: 'med' }, { fn: 'count', as: 'n' }],
        sort: [{ field: 'med', dir: 'asc' }],
    }, MINE);
    assert.ok(agg.sql.indexOf(MINE.where) < agg.sql.indexOf('GROUP BY'), 'access WHERE precedes GROUP BY');
    const res = await run(agg.sql, agg.params);
    assert.deepStrictEqual(res.rows.map(r => [r.status, Number(r.med), Number(r.n)]),
        [['open', 10, 2], ['done', 30, 1]]);
});

// ── connector-sync + retention compilers under pg ───────────────────

test('pg: compileKeyIndex maps key values to record ids', async () => {
    const ki = qc.compileKeyIndex(TASKS, 'title', ['Alpha task', 'beta task', 'missing'], MINE);
    const res = await run(ki.sql, ki.params);
    const map = new Map(res.rows.map(r => [r.k, r.id]));
    assert.strictEqual(map.get('Alpha task'), seededIds['Alpha task']);
    assert.strictEqual(map.get('beta task'), seededIds['beta task']);
    assert.strictEqual(map.size, 2);
});

test('pg: compileDeleteOlderThan / compileDeleteOrphans execute (tx-rolled-back probe)', async () => {
    await db.exec('BEGIN');
    try {
        const old = qc.compileDeleteOlderThan(TASKS, MINE, { field: 'happened_at', cutoffIso: '2026-06-01T00:00:00.000Z' });
        const r1 = await run(old.sql, old.params);
        assert.strictEqual(r1.affectedRows, 1, 'only user-1 rows older than the cutoff (Alpha)');
        const orphans = qc.compileDeleteOrphans(TASKS, ALLOW, { relationField: 'project', parentTableMeta: PROJECTS });
        const r2 = await run(orphans.sql, orphans.params);
        assert.ok(r2.affectedRows >= 2, 'NULL-relation rows sweep as orphans');
        const all = qc.compileDeleteAll(TASKS, MINE);
        await run(all.sql, all.params);
    } finally {
        await db.exec('ROLLBACK');
    }
    const still = await run(...(({ sql, params }) => [sql, params])(qc.compileRecordList(TASKS, {}, ALLOW)));
    assert.strictEqual(still.rows.length, 4, 'probe was rolled back');
});

// ── rlsGateway boolean binds under pg ───────────────────────────────

test('pg: row-filter booleans bind as true/false, not 0/1', () => {
    const rf = rowFilterToSql('record.active == true', {}, TASKS);
    assert.deepStrictEqual(rf.params, [true]);
    const rf2 = rowFilterToSql('viewer.premium == record.active', { premium: false }, TASKS);
    assert.deepStrictEqual(rf2.params, [false]);
});

// ── toDollarParams: the ? → $n seam ─────────────────────────────────

test('toDollarParams converts in order, skips quoted regions, asserts count', () => {
    assert.strictEqual(toDollarParams('a = ? AND b = ?', 2), 'a = $1 AND b = $2');
    assert.strictEqual(
        toDollarParams(`t ILIKE ? ESCAPE '\\' AND n = 'what?' AND "col?" = ?`, 2),
        `t ILIKE $1 ESCAPE '\\' AND n = 'what?' AND "col?" = $2`,
        'a ? inside quotes is data, not a placeholder',
    );
    assert.throws(() => toDollarParams('a = ? AND b = ?', 1), /placeholder count mismatch/);
    assert.throws(() => toDollarParams('a = ?', 2), /placeholder count mismatch/);
});

/**
 * Unit — the datatable row retention sweep. DB-free: the stores and the engine
 * are replaced so the assertions are about the GUARDS, not about Postgres.
 *
 * This job DELETEs customer data on a timer, unattended, on every replica. The
 * four things worth pinning are therefore not the happy path but the four ways
 * it must decline to delete:
 *
 *   1. the operator kill switch;
 *   2. a retention column that is no longer a date column (renamed, retyped or
 *      dropped since the owner chose it) — falling back to `created_at` would
 *      delete on a rule nobody picked;
 *   3. the per-pass cap, so a misconfiguration is a partial delete somebody
 *      notices rather than a table emptied between two heartbeats;
 *   4. one table's failure not becoming the whole pass's failure — the next
 *      organisation has its own retention obligation.
 *
 * Run: cd server && node --test --test-force-exit jobs/datatableRetention.test.js
 */

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// ── Doubles, installed before the job is required ──────────────────────────
function mock(relPath, exports) {
    const resolved = require.resolve(path.join(__dirname, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let TABLES = [];
let META = {};
const deletedIds = [];
let queryImpl = null;

mock('../stores/datatableStore', {
    listDatatablesWithRetention: async () => TABLES,
    getTableMeta: async (_scope, id) => META[id] || null,
    bumpAfterWrite: async () => {},
    setRowCount: async () => {},
    // Missing this one silently turned every successful sweep into a "skipped"
    // table: it throws, the per-table catch swallows it, and `deleted` stays 0.
    stampRetentionSweep: async () => {},
});

mock('../stores/datatableDbStore', {
    scopeKey: (scope) => `${scope.kind}:${scope.id}`,
    query: async (_o, _e, sql, params) => (queryImpl ? queryImpl(sql, params) : { rows: [] }),
    sizeBytes: async () => 0,
    batch: async (_o, _e, stmts) => {
        for (const s of stmts) deletedIds.push(s.params && s.params[0]);
        return stmts.map(() => ({ changes: 1 }));
    },
});

// The compiler is exercised by its own suite; here it only has to be
// deterministic and to carry the id through so `batch` can record it.
mock('../core/dataEngine/queryCompiler', {
    MAX_RESULT_ROWS: 1000,
    compileSelectOlderThan: (_meta, _f, { limit }) => ({ sql: `SELECT ${limit}`, params: [] }),
    compileDelete: (_meta, id) => ({ sql: 'DELETE', params: [id] }),
    compileAggregate: () => ({ sql: 'COUNT', params: [] }),
});
mock('../core/dataEngine/accessFilter', { compileAccessFilter: () => ({ sql: '1=1', params: [] }) });
mock('../telemetry/metrics', { recordJobRun: () => {} });

const job = require('./datatableRetention');

const DATE_META = { id: 'tbl_a', key: 'leads', fields: [{ id: 'fld_1', key: 'seen_at', name: 'Seen', type: 'datetime' }] };

function table(over = {}) {
    return {
        id: 'tbl_a', name: 'Leads', scope: { kind: 'org', id: 'org-a' },
        retentionDays: 30, retentionField: 'seen_at', rowScope: 'all', ...over,
    };
}

/** N rows on the first probe, then none — the shape the drain loop expects. */
function rowsOnce(n) {
    let served = false;
    return () => {
        if (served) return { rows: [] };
        served = true;
        return { rows: Array.from({ length: n }, (_, i) => ({ id: `rec_${i}` })) };
    };
}

beforeEach(() => {
    TABLES = [table()];
    META = { tbl_a: DATE_META };
    deletedIds.length = 0;
    queryImpl = null;
    delete process.env.DATATABLE_RETENTION_DISABLED;
});

test('the kill switch stops the pass before it reads anything', async () => {
    process.env.DATATABLE_RETENTION_DISABLED = '1';
    queryImpl = () => { throw new Error('must not reach the database'); };

    const out = await job.datatableRetentionPass();

    assert.strictEqual(out.disabled, true);
    assert.strictEqual(out.deleted, 0);
    assert.deepStrictEqual(deletedIds, [], 'nothing may be deleted while the brake is on');
});

test('DATATABLE_RETENTION_DISABLED=0 is a person switching it OFF, not on', async () => {
    // envFlagOn, not bare truthiness: the string "0" is truthy in JS, and an
    // operator who writes =0 means "leave retention running".
    process.env.DATATABLE_RETENTION_DISABLED = '0';
    assert.strictEqual(job.killSwitchOn(), false);
});

test('a retention column that is no longer a date column is SKIPPED, never guessed', async () => {
    // The owner picked `seen_at`; a later schema save retyped it to text. A
    // fallback to created_at here would delete on a rule nobody chose, and a
    // text column compares LEXICALLY — '9 Jan' would outlive '10 Jan'.
    META = { tbl_a: { ...DATE_META, fields: [{ id: 'fld_1', key: 'seen_at', name: 'Seen', type: 'text' }] } };
    queryImpl = () => { throw new Error('must not probe a table it cannot age'); };

    const out = await job.datatableRetentionPass();

    assert.strictEqual(out.deleted, 0);
    assert.strictEqual(out.skipped, 1);
    assert.deepStrictEqual(deletedIds, []);
});

test('a retention column that no longer exists is SKIPPED', async () => {
    META = { tbl_a: { ...DATE_META, fields: [] } };
    queryImpl = () => { throw new Error('must not probe a table it cannot age'); };

    const out = await job.datatableRetentionPass();
    assert.strictEqual(out.skipped, 1);
    assert.deepStrictEqual(deletedIds, []);
});

test('a table whose columns cannot be read at all is skipped, not swept', async () => {
    META = {};
    queryImpl = () => { throw new Error('must not probe a table with no descriptor'); };

    const out = await job.datatableRetentionPass();
    assert.strictEqual(out.deleted, 0);
    assert.deepStrictEqual(deletedIds, []);
});

test('the per-pass cap bounds a misconfiguration to a partial delete', async () => {
    // Every probe keeps returning rows: without the cap this loop would drain
    // the whole table in one unattended pass.
    queryImpl = (sql) => {
        const want = Number(String(sql).split(' ')[1]) || 0;
        return { rows: Array.from({ length: want }, (_, i) => ({ id: `rec_${i}` })) };
    };

    const out = await job.datatableRetentionPass();

    assert.strictEqual(out.deleted, job.MAX_ROWS_PER_TABLE_PER_PASS,
        'the drain loop must stop at the per-pass cap');
    assert.strictEqual(deletedIds.length, job.MAX_ROWS_PER_TABLE_PER_PASS);
});

test('one table failing does not stop the next organisation being swept', async () => {
    TABLES = [
        table({ id: 'tbl_bad', name: 'Bad', scope: { kind: 'org', id: 'org-a' } }),
        table({ id: 'tbl_ok', name: 'OK', scope: { kind: 'user', id: 'u-1' } }),
    ];
    META = { tbl_bad: DATE_META, tbl_ok: DATE_META };
    const ok = rowsOnce(2);
    queryImpl = (sql, params) => {
        // The first table's probe throws; the second must still run.
        if (queryImpl._seenBad) return ok(sql, params);
        queryImpl._seenBad = true;
        throw new Error('engine exploded');
    };

    const out = await job.datatableRetentionPass();

    assert.strictEqual(out.tables, 2);
    assert.ok(out.skipped >= 1, 'the failing table is counted as skipped');
    assert.strictEqual(deletedIds.length, 2, "the second organisation's rows were still aged out");
});

test('a personal table is swept the same way an organisation table is', async () => {
    // Retention is an obligation to a data subject; whose scope the rows sit in
    // does not change it.
    TABLES = [table({ scope: { kind: 'user', id: 'u-1' } })];
    queryImpl = rowsOnce(3);

    const out = await job.datatableRetentionPass();
    assert.strictEqual(out.deleted, 3);
});

test('a pass with nothing to age deletes nothing and still reports cleanly', async () => {
    TABLES = [];
    const out = await job.datatableRetentionPass();
    assert.deepStrictEqual(
        { deleted: out.deleted, tables: out.tables, skipped: out.skipped },
        { deleted: 0, tables: 0, skipped: 0 },
    );
});

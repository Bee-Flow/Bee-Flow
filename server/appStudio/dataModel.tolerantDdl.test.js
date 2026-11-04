/**
 * App Studio v2 — tolerant DDL execution (dataModel.applyPlanTolerantly).
 *
 * The reconcile seam for the SQLite-ahead-of-Postgres window: a replayed
 * migration plan must skip the EXACT already-applied signatures (duplicate
 * ADD COLUMN, completed renames; IF NOT EXISTS creates are natively
 * idempotent) and still throw on everything else. Real better-sqlite3 against
 * an in-memory db; tests SKIP — not fail — when the native binding can't load
 * (same convention as studioAppDbStore.test.js).
 *
 * Run: cd server && node --test appStudio/dataModel.tolerantDdl.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { applyPlanTolerantly, migrationPlan } = require('./dataModel');

let Database = null;
let probeError = null;
try {
    Database = require('better-sqlite3');
    new Database(':memory:').close(); // probe the native binding
} catch (err) {
    Database = null;
    probeError = err;
}

const skipIfNoSqlite = (t) =>
    !Database && t.skip(`better-sqlite3 native binding unavailable: ${probeError?.message}`);

const silentLog = { warn: () => {} };

function freshDb() {
    return new Database(':memory:');
}

// A model pair whose plan covers create + add-column + renames.
function tableModel(tables) {
    return { modelVersion: 1, tables, roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

test('a fresh plan applies fully (nothing skipped)', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    const plan = migrationPlan(tableModel([]), tableModel([
        { id: 'tbl_aaa111', key: 'tasks', fields: [{ id: 'fld_a1', key: 'title', type: 'text', unique: true }] },
    ]));
    const res = applyPlanTolerantly(db, plan, { log: silentLog });
    assert.strictEqual(res.applied, plan.length);
    assert.deepStrictEqual(res.skipped, []);
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'`).get());
});

test('replaying the SAME plan skips only the already-applied signatures', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    const oldM = tableModel([
        { id: 'tbl_aaa111', key: 'tasks', fields: [{ id: 'fld_a1', key: 'title', type: 'text' }] },
    ]);
    const newM = tableModel([
        {
            id: 'tbl_aaa111', key: 'tickets', // table rename
            fields: [
                { id: 'fld_a1', key: 'subject', type: 'text' },   // column rename
                { id: 'fld_a2', key: 'done', type: 'bool' },      // add column
            ],
        },
        { id: 'tbl_bbb222', key: 'people', fields: [{ id: 'fld_b1', key: 'name', type: 'text' }] }, // new table
    ]);
    // Materialise the OLD schema, then apply the migration once.
    applyPlanTolerantly(db, migrationPlan(tableModel([]), oldM), { log: silentLog });
    const plan = migrationPlan(oldM, newM);
    const first = applyPlanTolerantly(db, plan, { log: silentLog });
    assert.strictEqual(first.skipped.length, 0, 'first application skips nothing');

    // Replay (the PG-commit-failed retry): renames + add-column are skipped,
    // IF NOT EXISTS creates re-run as native no-ops.
    const logged = [];
    const replay = applyPlanTolerantly(db, plan, { log: { warn: (m) => logged.push(m) } });
    const reasons = replay.skipped.map(s => s.reason).sort();
    assert.deepStrictEqual(reasons, ['column already added', 'column already renamed', 'table already renamed']);
    assert.strictEqual(replay.applied + replay.skipped.length, plan.length);
    assert.strictEqual(logged.length, 3, 'every skip is logged');
    assert.ok(logged.every(m => /tolerant DDL skipped/.test(m)));

    // Schema unchanged by the replay.
    const cols = db.prepare(`PRAGMA table_info("tickets")`).all().map(c => c.name);
    assert.ok(cols.includes('subject') && cols.includes('done'));
    assert.strictEqual(cols.filter(c => c === 'done').length, 1, 'no duplicate column');
});

test('a rename whose source still exists is NOT skipped (executes normally)', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    db.exec('CREATE TABLE "a" (id TEXT)');
    const res = applyPlanTolerantly(db, ['ALTER TABLE "a" RENAME TO "b"'], { log: silentLog });
    assert.strictEqual(res.applied, 1);
    assert.deepStrictEqual(res.skipped, []);
});

test('a rename with BOTH source gone and target missing still throws', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    assert.throws(
        () => applyPlanTolerantly(db, ['ALTER TABLE "ghost" RENAME TO "elsewhere"'], { log: silentLog }),
        /no such table/i,
    );
});

test('a column rename is only no-op\'d when target exists AND source is gone', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    db.exec('CREATE TABLE "t" (id TEXT, "new_name" TEXT)');
    // Already-renamed signature → skipped.
    const ok = applyPlanTolerantly(db, ['ALTER TABLE "t" RENAME COLUMN "old_name" TO "new_name"'], { log: silentLog });
    assert.strictEqual(ok.skipped[0].reason, 'column already renamed');
    // Source AND target both present (a genuine conflict) → throws.
    db.exec('ALTER TABLE "t" ADD COLUMN "old_name" TEXT');
    assert.throws(
        () => applyPlanTolerantly(db, ['ALTER TABLE "t" RENAME COLUMN "old_name" TO "new_name"'], { log: silentLog }),
    );
});

test('non-replay errors still throw (bad SQL, NOT NULL add on populated table)', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    db.exec('CREATE TABLE "t" (id TEXT)');
    db.prepare('INSERT INTO "t" (id) VALUES (?)').run('r1');
    assert.throws(() => applyPlanTolerantly(db, ['THIS IS NOT SQL'], { log: silentLog }), /syntax error/i);
    assert.throws(
        () => applyPlanTolerantly(db, ['ALTER TABLE "t" ADD COLUMN "req" TEXT NOT NULL'], { log: silentLog }),
        /cannot add a not null column/i,
    );
    assert.throws(() => applyPlanTolerantly(db, [''], { log: silentLog }), /non-empty string/);
    assert.throws(() => applyPlanTolerantly(db, [42], { log: silentLog }), /non-empty string/);
});

test('a quoted identifier containing doubled quotes round-trips through the no-op detection', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    // Keys can't contain quotes under KEY_RE, but qi() escaping must still be
    // parsed correctly rather than silently mis-matching.
    db.exec('CREATE TABLE "we""ird" (id TEXT)');
    const res = applyPlanTolerantly(db, ['ALTER TABLE "gone" RENAME TO "we""ird"'], { log: silentLog });
    assert.strictEqual(res.skipped[0].reason, 'table already renamed');
});

// ── Changing the model while the table holds rows (real SQLite) ─────

const { planMigration } = require('./dataModel');

/** Run a planMigration result the way studioAppDbStore.applyMigration does: one transaction. */
function applyPlanned(db, planned) {
    return db.transaction(() => applyPlanTolerantly(db, planned.statements, { log: silentLog, probes: planned.probes }))();
}

const LINES = (fields) => tableModel([{ id: 'tbl_lines1', key: 'lines', fields }]);
const QTY = { id: 'fld_qty', key: 'qty', type: 'number' };
const computedField = (expr, key = 'dbl', id = 'fld_dbl') => ({ id, key, type: 'computed', computed: { expr, type: 'number', stored: true } });

/** A fresh database holding the `lines` table of `model` with `rows`. */
function populated(model, rows) {
    const db = freshDb();
    applyPlanTolerantly(db, migrationPlan(tableModel([]), model), { log: silentLog });
    const cols = Object.keys(rows[0]);
    const ins = db.prepare(`INSERT INTO "lines" (id, ${cols.map((c) => `"${c}"`).join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`);
    rows.forEach((r, i) => ins.run(`rec_${i}`, ...cols.map((c) => r[c])));
    return db;
}

test('spec: a stored computed field with a NEW expression gives the new value for every existing row', (t) => {
    if (skipIfNoSqlite(t)) return;
    const before = LINES([QTY, computedField('qty * 2')]);
    const db = populated(before, [{ qty: 1 }, { qty: 2 }, { qty: 5 }]);
    t.after(() => db.close());
    assert.deepStrictEqual(db.prepare('SELECT dbl FROM lines ORDER BY qty').all().map((r) => r.dbl), [2, 4, 10]);

    const planned = planMigration(before, LINES([QTY, computedField('qty * 3')]), { dialect: 'sqlite' });
    const res = applyPlanned(db, planned);
    assert.deepStrictEqual(db.prepare('SELECT dbl FROM lines ORDER BY qty').all().map((r) => r.dbl), [3, 6, 15]);
    const op = planned.ops.findIndex((o) => o.kind === 'recompute');
    assert.strictEqual(planned.ops[op].reason, 'expression');
    assert.strictEqual(res.probed.find((p) => p.opIndex === op).n, 3, 'the report counts every recomputed row');
});

test('a NEW stored computed field on a populated table is added and filled (VIRTUAL: SQLite cannot ADD STORED)', (t) => {
    if (skipIfNoSqlite(t)) return;
    const before = LINES([QTY]);
    const db = populated(before, [{ qty: 4 }, { qty: 7 }]);
    t.after(() => db.close());
    const planned = planMigration(before, LINES([QTY, computedField('qty + 1')]), { dialect: 'sqlite' });
    assert.match(planned.statements[0], /VIRTUAL$/);
    applyPlanned(db, planned);
    assert.deepStrictEqual(db.prepare('SELECT dbl FROM lines WHERE dbl > 5 ORDER BY dbl DESC').all().map((r) => r.dbl), [8],
        'the added column filters and sorts');
});

test('a renamed stored computed field drops its OLD column (no "no such column")', (t) => {
    if (skipIfNoSqlite(t)) return;
    const before = LINES([QTY, computedField('qty * 2')]);
    const db = populated(before, [{ qty: 3 }]);
    t.after(() => db.close());
    const planned = planMigration(before, LINES([QTY, computedField('qty * 2', 'twice')]), { dialect: 'sqlite' });
    assert.deepStrictEqual(planned.statements[0], 'ALTER TABLE "lines" DROP COLUMN "dbl"');
    applyPlanned(db, planned);
    assert.deepStrictEqual(db.prepare('SELECT twice FROM lines').get(), { twice: 6 });
    assert.ok(!db.prepare('PRAGMA table_info(lines)').all().some((c) => c.name === 'dbl'));
});

test('text → number converts in place (shadow-column swap), sorts numerically, keeps the dependent stored field', (t) => {
    if (skipIfNoSqlite(t)) return;
    const AMOUNT = { id: 'fld_amt', key: 'amount', type: 'text', unique: true };
    const before = LINES([AMOUNT, computedField('amount * 2')]);
    const db = populated(before, [{ amount: '10' }, { amount: ' 9.5 ' }, { amount: '100' }, { amount: '' }]);
    t.after(() => db.close());
    const after = LINES([{ ...AMOUNT, type: 'number' }, computedField('amount * 2')]);
    const planned = planMigration(before, after, { dialect: 'sqlite', convertTypes: true });
    const res = applyPlanned(db, planned);
    assert.deepStrictEqual(db.prepare('SELECT amount, dbl FROM lines WHERE amount IS NOT NULL ORDER BY amount').all(),
        [{ amount: 9.5, dbl: 19 }, { amount: 10, dbl: 20 }, { amount: 100, dbl: 200 }]);
    assert.strictEqual(db.prepare('SELECT amount FROM lines WHERE id = ?').get('rec_3').amount, null, 'an empty text becomes NULL');
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'uq_tbl_lines1_fld_amt'`).get(), 'the unique index is back');
    const conv = planned.ops.findIndex((o) => o.kind === 'convert');
    assert.deepStrictEqual(res.probed.find((p) => p.opIndex === conv), { opIndex: conv, refuse: true, n: 4, bad: 0 });
    assert.ok(planned.ops.some((o) => o.kind === 'recompute' && o.reason === 'dependency'));
    // Replaying the same plan (the SQLite-ahead-of-Postgres window) is harmless.
    applyPlanned(db, planned);
    assert.deepStrictEqual(db.prepare('SELECT amount FROM lines WHERE amount IS NOT NULL ORDER BY amount').all().map((r) => r.amount), [9.5, 10, 100]);
});

test('refuse mode: values that cannot convert fail the plan and roll it back; clear mode empties them', (t) => {
    if (skipIfNoSqlite(t)) return;
    const CODE = { id: 'fld_code', key: 'code', type: 'text' };
    const before = LINES([CODE]);
    const db = populated(before, [{ code: '12' }, { code: '12,50' }, { code: '007' }, { code: null }]);
    t.after(() => db.close());
    const after = LINES([{ ...CODE, type: 'number' }]);
    assert.throws(() => applyPlanned(db, planMigration(before, after, { dialect: 'sqlite', convertTypes: true })), (err) => {
        assert.strictEqual(err.code, 'migration_precondition');
        assert.strictEqual(err.probed[0].bad, 2, "'12,50' and '007' are not numbers");
        return true;
    });
    assert.strictEqual(db.prepare('SELECT typeof(code) AS t FROM lines WHERE id = ?').get('rec_0').t, 'text', 'rolled back');
    applyPlanned(db, planMigration(before, after, { dialect: 'sqlite', convertTypes: true, onUnconvertible: 'clear' }));
    assert.deepStrictEqual(db.prepare('SELECT code FROM lines ORDER BY id').all().map((r) => r.code), [12, null, null, null]);
});

test('text → select counts exactly the values outside the options; no DDL without clear', (t) => {
    if (skipIfNoSqlite(t)) return;
    const ST = { id: 'fld_st', key: 'status', type: 'text' };
    const before = LINES([ST]);
    const db = populated(before, [{ status: 'open' }, { status: 'done' }, { status: 'later' }, { status: '' }, { status: 'weird' }]);
    t.after(() => db.close());
    const after = LINES([{ ...ST, type: 'select', options: ['open', { value: 'done', label: 'Done' }] }]);
    const planned = planMigration(before, after, { dialect: 'sqlite', convertTypes: true });
    assert.deepStrictEqual(planned.statements, []);
    assert.throws(() => applyPlanned(db, planned), (err) => err.probed[0].bad === 2);
    applyPlanned(db, planMigration(before, after, { dialect: 'sqlite', convertTypes: true, onUnconvertible: 'clear' }));
    assert.deepStrictEqual(db.prepare('SELECT status FROM lines ORDER BY id').all().map((r) => r.status), ['open', 'done', null, '', null]);
});

test('number ⇄ integer ⇄ text keeps the values', (t) => {
    if (skipIfNoSqlite(t)) return;
    const N = { id: 'fld_n', key: 'n', type: 'number' };
    const asInt = { ...N, subtype: 'integer' };
    const asText = { ...N, type: 'text' };
    const db = populated(LINES([N]), [{ n: 20 }, { n: 3 }]);
    t.after(() => db.close());
    applyPlanned(db, planMigration(LINES([N]), LINES([asInt]), { dialect: 'sqlite', convertTypes: true }));
    assert.deepStrictEqual(db.prepare('SELECT typeof(n) AS t FROM lines').all().map((r) => r.t), ['integer', 'integer']);
    applyPlanned(db, planMigration(LINES([asInt]), LINES([asText]), { dialect: 'sqlite', convertTypes: true }));
    assert.deepStrictEqual(db.prepare('SELECT n FROM lines ORDER BY id').all().map((r) => r.n), ['20', '3']);

    const db2 = populated(LINES([N]), [{ n: 20 }, { n: 2.5 }]);
    t.after(() => db2.close());
    applyPlanned(db2, planMigration(LINES([N]), LINES([asText]), { dialect: 'sqlite', convertTypes: true }));
    assert.deepStrictEqual(db2.prepare('SELECT n FROM lines ORDER BY id').all().map((r) => r.n), ['20', '2.5'], 'a whole REAL renders without ".0"');
});

test('a failing statement carries its plan index', (t) => {
    if (skipIfNoSqlite(t)) return;
    const db = freshDb();
    t.after(() => db.close());
    assert.throws(() => applyPlanTolerantly(db, ['CREATE TABLE a (x TEXT)', 'ALTER TABLE a DROP COLUMN nope'], { log: silentLog }),
        (err) => err.migrationStatementIndex === 1);
});

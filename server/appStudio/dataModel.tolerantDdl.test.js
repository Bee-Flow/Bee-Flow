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

/**
 * FRM-08's durable column — it must land on the row that LIVES (automation_runs,
 * 90-day retention) and never on the 8-hour poll-pointer table
 * (automation_form_sessions, purged every retention tick). Proven against real
 * Postgres (@electric-sql/pglite behind the db.js facade).
 *
 * Under test:
 *   - the ALTER targets automation_runs; no SQL in this migration touches
 *     automation_form_sessions;
 *   - the column has its OWN name (user_id stays the routine owner) and is
 *     nullable with no default — NULL is "anonymous public link" and every
 *     pre-existing row, so old writers keep working and a rollback is inert;
 *   - two runs add the column exactly once (idempotent);
 *   - --dry-run writes nothing.
 *
 * Run: cd server && node --test --test-force-exit migrations/automation-form-submitter-2026-09.integration.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    return { rows: r.rows || [] };
}
async function rawQuery(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
    return adaptResult(await pg.query(sql));
}
const dbPath = path.join(SERVER, 'db.js');
const m = new Module(dbPath);
m.exports = {
    run: rawQuery,
    getOne: async (sql, params) => (await rawQuery(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rawQuery(sql, params)).rows,
    exec: (sql) => rawQuery(sql),
};
m.loaded = true;
require.cache[dbPath] = m;

const { up } = require('./automation-form-submitter-2026-09');
const SRC = fs.readFileSync(path.join(__dirname, 'automation-form-submitter-2026-09.js'), 'utf8');

async function columns() {
    const r = await rawQuery(`
        SELECT column_name, is_nullable, data_type, column_default
          FROM information_schema.columns
         WHERE table_name = 'automation_runs'
         ORDER BY ordinal_position`);
    return r.rows;
}

before(async () => {
    // The slice of automation_runs this migration touches (the real DDL is
    // owned by migrations/automation-builder-2026-05-init.js via the
    // automationStore ladder, which runs before LOOSE in every real ladder).
    await pg.exec(`CREATE TABLE automation_runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`);
    await pg.query(`INSERT INTO automation_runs (id, user_id) VALUES ('run-old', 'owner-1')`);
});

test('registered in LOOSE_MIGRATIONS; the SQL targets automation_runs, never the TTL table', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.ok(LOOSE_MIGRATIONS.includes('automation-form-submitter-2026-09'),
        'an unregistered migration never runs (U6 duty)');
    assert.match(SRC, /ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS submitted_by_user_id TEXT/);
    assert.doesNotMatch(SRC, /ALTER TABLE automation_form_sessions/,
        'automation_form_sessions is purged after 8h — an identity stored there would be gone for nearly every submission FRM-07 can still list');
    assert.doesNotMatch(SRC, /submitted_by_user_id TEXT NOT NULL|submitted_by_user_id TEXT DEFAULT/,
        'the column must be nullable with no default: NULL = anonymous/pre-existing, and old code must keep inserting');
});

test('--dry-run writes nothing', async () => {
    await up({ dryRun: true });
    assert.ok(!(await columns()).some((c) => c.column_name === 'submitted_by_user_id'));
});

test('the column is added once, nullable, text, no default — and twice is a no-op', async () => {
    await up();
    const afterFirst = await columns();
    const col = afterFirst.find((c) => c.column_name === 'submitted_by_user_id');
    assert.ok(col, 'column missing after up()');
    assert.strictEqual(col.is_nullable, 'YES');
    assert.strictEqual(col.data_type, 'text');
    assert.strictEqual(col.column_default, null);
    assert.notStrictEqual(col.column_name, 'user_id', 'the owner column keeps its meaning');

    await up();
    assert.deepStrictEqual(await columns(), afterFirst, 'second run must not change the schema');
});

test('old writers keep working: a row inserted without the column reads NULL', async () => {
    await pg.query(`INSERT INTO automation_runs (id, user_id) VALUES ('run-new', 'owner-1')`);
    const r = await rawQuery(`SELECT id, submitted_by_user_id FROM automation_runs ORDER BY id`);
    assert.deepStrictEqual(r.rows, [
        { id: 'run-new', submitted_by_user_id: null },
        { id: 'run-old', submitted_by_user_id: null },
    ], 'pre-existing and owner-written rows are the anonymous/unknown state, never invented');
});

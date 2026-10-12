/**
 * automation_run_steps.binding_warnings: the mappings that found nothing while
 * a step ran, per step row (the runner's binding log, automation/bind.js).
 *
 * Runs against a real Postgres (@electric-sql/pglite, in-process), through the
 * migration's injectable `exec`: no module mocking.
 *
 * Proven:
 *   - the column is added as JSONB, nullable, and an existing row reads NULL;
 *   - replayed on every boot, a second run changes nothing;
 *   - it is registered in the automationStore ladder, after the run-step
 *     JSON-order migration, so it actually runs.
 *
 * Run: cd server && node --test migrations/automation-run-step-binding-warnings-2026-10.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../testUtils/pgliteDb');

const { pg } = pgliteDb();
const migration = require('./automation-run-step-binding-warnings-2026-10');
const up = () => migration.up({ exec: (sql) => pg.exec(sql) });

const column = async () => (await pg.query(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'automation_run_steps' AND column_name = 'binding_warnings'`,
)).rows[0] || null;

before(async () => {
    // The shape automation-builder-2026-05-init creates, trimmed to the key.
    await pg.exec(`CREATE TABLE automation_run_steps (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, step_type TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1, status TEXT,
        PRIMARY KEY (run_id, step_id, attempts))`);
    await pg.query(`INSERT INTO automation_run_steps (run_id, step_id, step_type, status) VALUES ('r0', 's1', 'code', 'success')`);
});
after(async () => { await pg.close(); });

test('adds a nullable JSONB column; a row from before reads NULL', async () => {
    assert.equal(await column(), null, 'not there before the migration');
    await up();
    assert.deepEqual(await column(), { data_type: 'jsonb', is_nullable: 'YES' });
    const [row] = (await pg.query(`SELECT binding_warnings FROM automation_run_steps WHERE run_id = 'r0'`)).rows;
    assert.equal(row.binding_warnings, null);
});

test('replayed on every boot: a second run is a no-op and the column holds a list', async () => {
    await up();
    const list = [{ field: 'to', kind: 'ref', path: 'steps.a.output.x', reason: 'missing', count: 1 }];
    await pg.query(
        `INSERT INTO automation_run_steps (run_id, step_id, step_type, binding_warnings) VALUES ('r1', 's1', 'code', $1)`,
        [JSON.stringify(list)],
    );
    const [row] = (await pg.query(`SELECT binding_warnings FROM automation_run_steps WHERE run_id = 'r1'`)).rows;
    assert.deepEqual(row.binding_warnings, list);
});

test('it is registered in the automationStore migration list, after the run-step JSON-order one', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    const name = 'automation-run-step-binding-warnings-2026-10';
    assert.equal(MIGRATIONS.filter((m) => m === name).length, 1);
    assert.ok(MIGRATIONS.indexOf(name) > MIGRATIONS.indexOf('automation-run-step-json-order-2026-10'));
});

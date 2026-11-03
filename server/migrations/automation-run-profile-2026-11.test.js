/**
 * automation-run-profile-2026-11 against a real Postgres (pglite).
 *
 * Proven: every column of the build-and-test round exists with its default,
 * existing rows keep NULL / FALSE (no backfill), the migration is idempotent,
 * and it is registered exactly once.
 *
 * Run: cd server && node --test migrations/automation-run-profile-2026-11.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { newPglite } = require('../testUtils/pgliteTemplate');

const pg = newPglite();
const exec = (sql) => pg.exec(sql);
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const { up } = require('./automation-run-profile-2026-11');

before(async () => {
    await pg.exec(`
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY, mode TEXT);
        CREATE TABLE automation_approvals (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_pages (id TEXT PRIMARY KEY);
        CREATE TABLE automation_form_sessions (id TEXT PRIMARY KEY);
        INSERT INTO automation_runs VALUES ('r1', 'live');
        INSERT INTO automation_approvals VALUES ('a1');
        INSERT INTO automation_form_pages VALUES ('p1');
        INSERT INTO automation_form_sessions VALUES ('s1');
    `);
    await up({ exec });
});
after(async () => { await pg.close(); });

test('existing rows get no profile and are not tests (no backfill)', async () => {
    assert.deepStrictEqual(await q(`SELECT run_profile FROM automation_runs WHERE id = 'r1'`), [{ run_profile: null }]);
    assert.deepStrictEqual(await q(`SELECT is_test, sandbox_user_id, configured_routing FROM automation_approvals WHERE id = 'a1'`),
        [{ is_test: null, sandbox_user_id: null, configured_routing: null }]);
    assert.deepStrictEqual(await q(`SELECT is_test, issued_by_user_id, expires_at FROM automation_form_pages WHERE id = 'p1'`),
        [{ is_test: false, issued_by_user_id: null, expires_at: null }]);
    assert.deepStrictEqual(await q(`SELECT is_test FROM automation_form_sessions WHERE id = 's1'`), [{ is_test: false }]);
});

test('run_profile holds a profile as JSONB', async () => {
    await pg.query(`UPDATE automation_runs SET run_profile = $1 WHERE id = 'r1'`, [JSON.stringify({ v: 1, kind: 'test', stopAfterStepId: 's1' })]);
    const [row] = await q(`SELECT run_profile->>'kind' AS kind, run_profile->>'stopAfterStepId' AS stop FROM automation_runs WHERE id = 'r1'`);
    assert.deepStrictEqual(row, { kind: 'test', stop: 's1' });
});

test('new rows default to not-a-test', async () => {
    await pg.exec(`INSERT INTO automation_form_pages (id) VALUES ('p2'); INSERT INTO automation_form_sessions (id) VALUES ('s2');`);
    assert.deepStrictEqual(await q(`SELECT is_test FROM automation_form_pages WHERE id = 'p2'`), [{ is_test: false }]);
    assert.deepStrictEqual(await q(`SELECT is_test FROM automation_form_sessions WHERE id = 's2'`), [{ is_test: false }]);
});

test('is idempotent', async () => {
    await up({ exec });
    await up({ exec });
});

test('is registered exactly once, in the automationStore ladder after the tables it alters', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    const name = 'automation-run-profile-2026-11';
    assert.strictEqual(MIGRATIONS.filter((m) => m === name).length, 1);
    assert.strictEqual(LOOSE_MIGRATIONS.filter((m) => m === name).length, 0);
    for (const before of ['automation-form-trigger-2026-08', 'automation-form-sessions-2026-08', 'automation-approvals-2026-08']) {
        assert.ok(MIGRATIONS.indexOf(before) < MIGRATIONS.indexOf(name), `${before} runs first`);
    }
});

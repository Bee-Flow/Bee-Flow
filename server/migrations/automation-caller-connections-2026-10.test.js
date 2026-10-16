/**
 * automation-caller-connections-2026-10 against a real Postgres (pglite).
 *
 * Run: cd server && node --test migrations/automation-caller-connections-2026-10.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const pg = new PGlite();
const exec = (sql) => pg.exec(sql);
const { up } = require('./automation-caller-connections-2026-10');

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (id TEXT PRIMARY KEY);
        CREATE TABLE automation_runs (id TEXT PRIMARY KEY);
        CREATE TABLE automation_run_steps (run_id TEXT NOT NULL, step_id TEXT NOT NULL);
        INSERT INTO automations VALUES ('a1');
        INSERT INTO automation_runs VALUES ('r1');
    `);
    await up({ exec });
});
after(async () => { await pg.close(); });

test('adds the run mode and step identity columns, NULL for existing rows', async () => {
    const { rows } = await pg.query(`SELECT connections_mode FROM automation_runs WHERE id = 'r1'`);
    assert.strictEqual(rows[0].connections_mode, null);
    await pg.exec(`INSERT INTO automation_run_steps (run_id, step_id, identity_user_id) VALUES ('r1', 's1', 'u1')`);
});

test('the notice table keeps one row per user and automation and cascades', async () => {
    await pg.exec(`INSERT INTO automation_caller_notices (user_id, automation_id) VALUES ('u1', 'a1')`);
    await assert.rejects(pg.exec(`INSERT INTO automation_caller_notices (user_id, automation_id) VALUES ('u1', 'a1')`));
    await pg.exec(`DELETE FROM automations WHERE id = 'a1'`);
    const { rows } = await pg.query('SELECT 1 FROM automation_caller_notices');
    assert.strictEqual(rows.length, 0);
});

test('is idempotent', async () => {
    await up({ exec });
    await up({ exec });
});

test('is registered in the automationStore migration list', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    assert.strictEqual(MIGRATIONS.filter(m => m === 'automation-caller-connections-2026-10').length, 1);
});

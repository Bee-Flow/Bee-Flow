/**
 * The run warnings migration: one idempotent, nullable ADD COLUMN, registered
 * in the store's list (an unregistered migration never runs, and every run
 * would then fail to finish with "column does not exist").
 *
 * Run: node --test migrations/automation-run-warnings-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('./automation-run-warnings-2026-10');

const ddl = [];
const fakeDb = { async exec(sql) { ddl.push(String(sql).replace(/\s+/g, ' ').trim()); } };

test('adds the nullable jsonb column, idempotently', async () => {
    await migration.up(fakeDb);
    await migration.up(fakeDb);
    assert.strictEqual(ddl.length, 2);
    for (const q of ddl) assert.strictEqual(q, 'ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS warnings_json JSONB');
});

test('is registered in the store migration list, last', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    assert.strictEqual(MIGRATIONS[MIGRATIONS.length - 1], 'automation-run-warnings-2026-10');
});

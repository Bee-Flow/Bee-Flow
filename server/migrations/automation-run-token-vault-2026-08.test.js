/**
 * The run token-vault migration: a single idempotent ADD COLUMN. Pinned here so
 * (a) up() can run twice without error (the automation store replays every
 * migration on boot), and (b) the column stays NULLABLE with no backfill — an
 * older run simply has no map, which the runner treats as "nothing to restore".
 *
 * Also pins the registration: a migration file that exists but is not listed in
 * automationStore/core.js never runs, and the runner would then fail every
 * write-through with "column does not exist".
 *
 * Run: node --test migrations/automation-run-token-vault-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ddl = [];
const fakeDb = { async exec(sql) { ddl.push(String(sql).replace(/\s+/g, ' ').trim()); } };

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./automation-run-token-vault-2026-08');

test('adds the nullable jsonb column, idempotently', async () => {
    await migration.up();
    await migration.up();
    assert.strictEqual(ddl.length, 2);
    for (const q of ddl) {
        assert.match(q, /ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS pii_token_map JSONB/);
    }
});

test('is registered in the store migration list', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.match(core, /'automation-run-token-vault-2026-08'/,
        'an unregistered migration never runs, and every token write-through would then fail');
});

test('the map is never exposed on a run row (it holds real personal data)', () => {
    const mappers = fs.readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'rowMappers.js'), 'utf8');
    assert.ok(!mappers.includes('pii_token_map'),
        'rowToRun output is serialized to the client — the token map must stay server-side');
});

/**
 * The pii_summary migration: a single idempotent ADD COLUMN. Pinned here so
 * (a) up() can run twice without error (IF NOT EXISTS), and (b) nobody
 * "simplifies" it into a non-idempotent ALTER — the automation store replays
 * every migration on boot.
 *
 * The pg layer is mocked via require.cache (mirrors
 * automation-inline-layers-2026-06.test.js).
 *
 * Run: node --test migrations/automation-pii-summary-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ddl = [];
const fakeDb = { async exec(sql) { ddl.push(String(sql).replace(/\s+/g, ' ').trim()); } };

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./automation-pii-summary-2026-08');

test('adds the nullable jsonb column, idempotently', async () => {
    await migration.up();
    await migration.up(); // replayed on every boot — must not throw
    assert.strictEqual(ddl.length, 2);
    for (const q of ddl) {
        assert.match(q, /ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS pii_summary JSONB/);
    }
});

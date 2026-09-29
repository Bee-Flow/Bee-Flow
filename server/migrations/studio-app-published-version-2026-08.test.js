/**
 * The published_version migration: a single idempotent ADD COLUMN. Pinned here
 * so (a) up() can run twice without error (IF NOT EXISTS), (b) nobody
 * "simplifies" it into a non-idempotent ALTER — studioAppStore replays it on
 * every boot — and (c) the column stays NULLable, since "never published" and
 * "published before this column existed" must not read as version 0.
 *
 * The pg layer is mocked via require.cache (mirrors
 * automation-pii-summary-2026-08.test.js).
 *
 * Run: node --test migrations/studio-app-published-version-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ddl = [];
const fakeDb = { async exec(sql) { ddl.push(String(sql).replace(/\s+/g, ' ').trim()); } };

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./studio-app-published-version-2026-08');

test('adds the nullable integer column, idempotently', async () => {
    await migration.up();
    await migration.up(); // replayed on every boot — must not throw
    assert.strictEqual(ddl.length, 2);
    for (const q of ddl) {
        assert.match(q, /ALTER TABLE studio_apps ADD COLUMN IF NOT EXISTS published_version INTEGER/);
        assert.doesNotMatch(q, /NOT NULL|DEFAULT/, 'NULL means "unknown", so no default may be forced');
    }
});

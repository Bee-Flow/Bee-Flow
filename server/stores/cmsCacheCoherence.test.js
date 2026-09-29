/**
 * Unit — config cache coherence for the CMS editor "reverts to previous
 * version" fix (Workstream A1).
 *
 * Proves:
 *   1. getConfig serves the per-replica cache within the TTL, so a value that
 *      changed in the DB (e.g. written by another pod) is NOT seen.
 *   2. getConfigFresh bypasses the cache (reads DB truth) AND refreshes the
 *      local cache so the stale entry self-heals.
 *   3. getAdminPayload — the editor payload — reads fresh, so it returns DB
 *      truth even when a stale value is already cached. This is the read that,
 *      served stale across replicas, made saved edits appear to revert.
 *
 * DB is mocked via require.cache injection (pattern from
 * integrationConnectionStore.test.js) — no Postgres, no sockets.
 * Run: node --test server/stores/cmsCacheCoherence.test.js
 */

const assert = require('assert');
const test = require('node:test');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.CONFIG_INVALIDATION_LISTENER = '0'; // no LISTEN socket in tests

// ── Mock ../db before the stores load ───────────────────────────────
// `rows` is a mutable key→raw-string map simulating the `config` table. Flip a
// value to simulate "another replica wrote a newer value to the DB".
const rows = {};
const mockDb = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getOne: async (sql, params) => {
        const key = params && params[0];
        if (Object.prototype.hasOwnProperty.call(rows, key)) return { value: rows[key] };
        return null;
    },
};
const dbPath = require.resolve('./../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const configStore = require('./configStore');
const cmsStore = require('./cmsStore');

test('getConfig caches; getConfigFresh bypasses and refreshes', async () => {
    const key = 'cms_test_key_1';
    rows[key] = JSON.stringify({ v: 1 });

    // Warm the cache.
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 1 });

    // Another replica updates the DB.
    rows[key] = JSON.stringify({ v: 2 });

    // Cached read is stale (this is the bug when it crosses replicas).
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 1 });

    // Fresh read sees DB truth...
    assert.deepStrictEqual(await configStore.getConfigFresh(key), { v: 2 });

    // ...and self-heals the cache so the next plain read is also correct.
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 2 });
});

test('getConfigFresh returns null for a missing key', async () => {
    assert.strictEqual(await configStore.getConfigFresh('cms_test_absent'), null);
});

test('getAdminPayload reads fresh — returns DB truth over a stale cached site', async () => {
    const siteId = 'pj_abcd';
    const projectKey = `cms_project_${siteId}`;
    // version high enough to skip getProject's lazy migrations; no pages so the
    // payload build touches only the project + locale + snapshot reads.
    const stale = { version: 999, id: siteId, name: 'STALE NAME', pages: [] };
    const fresh = { version: 999, id: siteId, name: 'FRESH NAME', pages: [] };

    rows[projectKey] = JSON.stringify(stale);
    // Pre-warm the per-replica cache with the stale value (as an earlier GET on
    // this pod would).
    await configStore.getConfig(projectKey);

    // Another replica saved the user's edit.
    rows[projectKey] = JSON.stringify(fresh);

    const payload = await cmsStore.getAdminPayload(siteId);
    assert.strictEqual(payload.site.name, 'FRESH NAME',
        'editor payload must reflect the latest DB write, not the stale cache');
});

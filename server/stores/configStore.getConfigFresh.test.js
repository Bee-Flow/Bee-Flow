/**
 * configStore.getConfigFresh hands the caller a private copy, and the cache
 * keeps its OWN copy. It used to cache the very object it returned, so a
 * caller that edited the result in place (getProject's lazy migration, an edit
 * whose save then failed) changed what every later getConfig on this replica
 * served for up to the 60s TTL. No Postgres: the config rows are answered
 * through the database pool seam of testUtils/routeHarness (no module-system
 * mocking).
 *
 * Run: node --test server/stores/configStore.getConfigFresh.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.CONFIG_INVALIDATION_LISTENER = '0'; // no LISTEN socket in tests

const { recordDb } = require('../testUtils/routeHarness');

const rows = {};
const db = recordDb((sql, params = []) => {
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        return { rows: Object.prototype.hasOwnProperty.call(rows, params[0]) ? [{ value: rows[params[0]] }] : [] };
    }
    return undefined;
});

const configStore = require('./configStore');

const configReads = () => db.queries.filter((q) => /SELECT value FROM config WHERE key/i.test(q)).length;

test('editing the getConfigFresh result does not change what getConfig serves from cache', async () => {
    const key = 'cms_project_pj_fresh_clone';
    rows[key] = JSON.stringify({ name: 'Saved', pages: [{ id: 'pg_1' }] });

    const fresh = await configStore.getConfigFresh(key);
    fresh.name = 'unsaved edit';
    fresh.pages.length = 0;

    // The cache hit must be what the DB holds, not the caller's edit.
    const before = configReads();
    assert.deepEqual(await configStore.getConfig(key), { name: 'Saved', pages: [{ id: 'pg_1' }] });
    assert.equal(configReads(), before, 'getConfig answered from the cache getConfigFresh filled');
});

test('getConfigFresh still caches non-object values and null', async () => {
    rows.cfg_plain_string = 'not json';
    assert.equal(await configStore.getConfigFresh('cfg_plain_string'), 'not json');
    assert.equal(await configStore.getConfigFresh('cfg_absent'), null);
    const before = configReads();
    assert.equal(await configStore.getConfig('cfg_plain_string'), 'not json');
    assert.equal(await configStore.getConfig('cfg_absent'), null);
    assert.equal(configReads(), before, 'both came from the cache');
});

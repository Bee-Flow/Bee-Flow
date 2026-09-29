/**
 * Unit — cross-replica config cache invalidation (Workstream A2).
 *
 * Proves the LISTEN/NOTIFY contract without a real socket:
 *   1. setConfig emits a `pg_notify` carrying the KEY (never the value).
 *   2. Applying an invalidation received from another replica drops the local
 *      cache entry (and its `__secret__` twin), so the next read re-hits the DB
 *      — this is what stops a peer's stale cache from "reverting" a saved edit.
 *   3. An empty payload flushes the whole cache (listener (re)connect recovery).
 *
 * DB is mocked; the listener bootstrap is disabled via CONFIG_INVALIDATION_LISTENER=0.
 * Run: node --test server/stores/configInvalidation.test.js
 */

const assert = require('assert');
const test = require('node:test');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.CONFIG_INVALIDATION_LISTENER = '0';

const rows = {};
const runCalls = [];
const mockDb = {
    exec: async () => ({}),
    run: async (sql, params) => {
        runCalls.push({ sql, params });
        if (/INSERT INTO config/.test(sql)) { rows[params[0]] = params[1]; return { rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
    },
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getOne: async (sql, params) => {
        const key = params && params[0];
        return Object.prototype.hasOwnProperty.call(rows, key) ? { value: rows[key] } : null;
    },
    withTransaction: async (fn) => {
        const client = {
            query: async (sql, params) => {
                if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                if (/SELECT value FROM config/.test(sql)) {
                    const key = params[0];
                    return Object.prototype.hasOwnProperty.call(rows, key)
                        ? { rows: [{ value: rows[key] }] } : { rows: [] };
                }
                if (/INSERT INTO config/.test(sql)) { rows[params[0]] = params[1]; return { rows: [], rowCount: 1 }; }
                return { rows: [] };
            },
        };
        return fn(client);
    },
};
const dbPath = require.resolve('./../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const configStore = require('./configStore');

test('setConfig emits a pg_notify carrying the key', async () => {
    runCalls.length = 0;
    await configStore.setConfig('cms_project_pj_x', { v: 1 });
    const notify = runCalls.find(c => /pg_notify/.test(c.sql));
    assert.ok(notify, 'setConfig should emit pg_notify');
    assert.strictEqual(notify.params[0], configStore.CONFIG_INVALIDATE_CHANNEL);
    assert.strictEqual(notify.params[1], 'cms_project_pj_x'); // key, not the value
});

test('a received invalidation drops this replica cache so the next read is fresh', async () => {
    const key = 'cms_project_pj_y';
    rows[key] = JSON.stringify({ v: 1 });
    // Warm the local cache as an earlier GET on this pod would.
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 1 });

    // Another replica wrote a newer value; this pod's cache is still stale.
    rows[key] = JSON.stringify({ v: 2 });
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 1 }, 'still cached (pre-fix behaviour)');

    // ...until the NOTIFY from the writing replica arrives.
    configStore._applyInvalidation(key);
    assert.deepStrictEqual(await configStore.getConfig(key), { v: 2 }, 'cache dropped → re-read DB');
});

test('invalidation also drops the __secret__ twin; empty payload flushes all', async () => {
    // Seed two cached entries via public reads.
    rows['plain_k'] = JSON.stringify('p');
    rows['other_k'] = JSON.stringify('o');
    await configStore.getConfig('plain_k');
    await configStore.getConfig('other_k');

    // Change both in the DB, then broadcast a targeted + a flush-all.
    rows['plain_k'] = JSON.stringify('P');
    rows['other_k'] = JSON.stringify('O');

    configStore._applyInvalidation('plain_k');           // targeted
    assert.strictEqual(await configStore.getConfig('plain_k'), 'P');
    assert.strictEqual(await configStore.getConfig('other_k'), 'o', 'other key untouched by targeted invalidation');

    await configStore.getConfig('other_k'); // re-warm 'o' (still stale 'o')
    configStore._applyInvalidation('');                  // flush-all
    assert.strictEqual(await configStore.getConfig('other_k'), 'O', 'flush-all dropped every entry');
});

test('mutateConfig read-modify-writes atomically and busts the local cache', async () => {
    rows['cms_projects_index'] = JSON.stringify({ version: 1, projects: [{ id: 'a' }] });
    await configStore.getConfig('cms_projects_index'); // warm the cache with the old value

    const result = await configStore.mutateConfig('cms_projects_index', (cur) => {
        cur.projects.push({ id: 'b' });
        return cur;
    });
    assert.deepStrictEqual(result.projects.map(p => p.id), ['a', 'b']);

    // Cache was busted by the write → the next read reflects the mutation.
    const after = await configStore.getConfig('cms_projects_index');
    assert.deepStrictEqual(after.projects.map(p => p.id), ['a', 'b']);
});

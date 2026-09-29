/**
 * Webpage store cross-tenant IDOR regression tests.
 *
 * Locks the webpage_id scoping added to deleteVersion / deleteSource so a
 * foreign version/source id can't be removed (and its RustFS blob purged) via a
 * webpage the caller happens to own. See the DELETE /:id/versions/:vid and
 * DELETE /:id/sources/:sid routes, which pass the URL's webpageId through.
 *
 * We mock ../db so the store is side-effect free and record every SQL + params
 * pair, then assert the scoped queries carry `webpage_id` and only match rows
 * belonging to the given webpage.
 *
 * Run: node --test stores/webpageStore.idor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Recording mock for ../db ──────────────────────────────────────
// Rows are keyed by a synthetic table; getOne resolves the first row that
// satisfies every `col = $n` equality in the WHERE clause, mimicking Postgres.
const versionsRows = [
    { id: 'v-alice', webpage_id: 'wp-alice', user_id: 'alice', summary: 'x', content_length: 1 },
    { id: 'v-bob', webpage_id: 'wp-bob', user_id: 'bob', summary: 'y', content_length: 1 },
];
const sourceRows = [
    { id: 's-alice', webpage_id: 'wp-alice', type: 'url', status: 'ready', storage_key: null },
    { id: 's-bob', webpage_id: 'wp-bob', type: 'url', status: 'ready', storage_key: 'bob/blob' },
];

const calls = { getOne: [], run: [] };

function matchRow(rows, sql, params) {
    // Extract `col = $n` pairs from the WHERE clause and require all to match.
    const conds = [...sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(m => [m[1], params[Number(m[2]) - 1]]);
    return rows.find(r => conds.every(([col, val]) => r[col] === val)) || null;
}

const mockDb = {
    run: async (sql, params = []) => { calls.run.push({ sql, params }); return { rowCount: 1 }; },
    getOne: async (sql, params = []) => {
        calls.getOne.push({ sql, params });
        if (/FROM webpage_versions/i.test(sql)) return matchRow(versionsRows, sql, params);
        if (/FROM webpage_sources/i.test(sql)) return matchRow(sourceRows, sql, params);
        return null;
    },
    getAll: async () => [],
    exec: async () => undefined,
};
const mockStorage = {
    deleteFile: async () => undefined,
    isAvailable: () => false,
    buildWebpageKey: (userId, webpageId, slot, versionId) =>
        `webpages/${userId}/${webpageId}/${versionId || 'current'}/${slot}`,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // The store is a facade over stores/webpage/*, so the same dependency is
    // written at two depths — match both (installResolveStub semantics: the
    // key is the require string exactly as written in the module doing it).
    if (request === '../db' || request === '../../db') return 'mock-db';
    if (request === './storageStore' || request === '../storageStore') return 'mock-storage';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };
require.cache['mock-storage'] = { id: 'mock-storage', exports: mockStorage };

const webpageStore = require('./webpageStore');

function reset() { calls.getOne = []; calls.run = []; }

// ── deleteVersion ─────────────────────────────────────────────────
test('deleteVersion scoped to webpageId refuses a foreign version', async () => {
    reset();
    // Alice owns wp-alice; she passes Bob's version id v-bob under her webpage.
    const ok = await webpageStore.deleteVersion('alice', 'v-bob', 'wp-alice');
    assert.strictEqual(ok, false, 'foreign version must not delete');
    assert.ok(!calls.run.some(c => /DELETE FROM webpage_versions/i.test(c.sql)),
        'no DELETE should be issued for a foreign version');
    // The lookup must be scoped by webpage_id.
    const lookup = calls.getOne.find(c => /FROM webpage_versions/i.test(c.sql));
    assert.match(lookup.sql, /webpage_id\s*=\s*\$2/i, 'lookup must scope by webpage_id');
    assert.deepStrictEqual(lookup.params, ['v-bob', 'wp-alice']);
});

test('deleteVersion scoped to webpageId deletes an owned version', async () => {
    reset();
    const ok = await webpageStore.deleteVersion('alice', 'v-alice', 'wp-alice');
    assert.strictEqual(ok, true);
    assert.ok(calls.run.some(c => /DELETE FROM webpage_versions/i.test(c.sql)),
        'owned version must be deleted');
});

// ── deleteSource ──────────────────────────────────────────────────
test('deleteSource scoped to webpageId refuses a foreign source', async () => {
    reset();
    const src = await webpageStore.deleteSource('s-bob', 'wp-alice');
    assert.strictEqual(src, null, 'foreign source must not delete');
    assert.ok(!calls.run.some(c => /DELETE FROM webpage_sources/i.test(c.sql)),
        'no DELETE should be issued for a foreign source');
    const lookup = calls.getOne.find(c => /FROM webpage_sources/i.test(c.sql));
    assert.match(lookup.sql, /webpage_id\s*=\s*\$2/i, 'lookup must scope by webpage_id');
});

test('deleteSource scoped to webpageId deletes an owned source', async () => {
    reset();
    const src = await webpageStore.deleteSource('s-alice', 'wp-alice');
    assert.ok(src && src.id === 's-alice');
    assert.ok(calls.run.some(c => /DELETE FROM webpage_sources/i.test(c.sql)),
        'owned source must be deleted');
});

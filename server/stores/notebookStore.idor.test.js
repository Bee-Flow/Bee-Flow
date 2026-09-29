/**
 * Notebook store cross-tenant IDOR regression tests.
 *
 * Locks the notebook_id scoping added to deleteSource / deleteVersion so a
 * foreign source/version id can't be removed via a notebook the caller happens
 * to own. `notebook_sources` and `notebook_versions` carry no user_id of their
 * own — the parent notebook is the only ownership anchor — so the routes
 * DELETE /:id/sources/:sid, POST /:id/sources/bulk-delete and
 * DELETE /:id/versions/:vid all pass the URL's notebookId through.
 *
 * Mirrors stores/webpageStore.idor.test.js, which locks the same invariant for
 * webpages (that one was fixed first; notebooks was missed).
 *
 * We mock ../db so the store is side-effect free and record every SQL + params
 * pair, then assert the scoped queries carry `notebook_id` and only match rows
 * belonging to the given notebook.
 *
 * Run: node --test stores/notebookStore.idor.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// ── Recording mock for ../db ──────────────────────────────────────
// Rows are keyed by a synthetic table; getOne/run resolve rows that satisfy
// every `col = $n` equality in the WHERE clause, mimicking Postgres.
const sourceRows = [
    { id: 's-alice', notebook_id: 'nb-alice', type: 'url', status: 'ready', storage_key: null },
    { id: 's-bob', notebook_id: 'nb-bob', type: 'url', status: 'ready', storage_key: 'bob/blob' },
];
const versionRows = [
    { id: 'v-alice', notebook_id: 'nb-alice', content: 'a', summary: 'x', content_length: 1 },
    { id: 'v-bob', notebook_id: 'nb-bob', content: 'b', summary: 'y', content_length: 1 },
];

const calls = { getOne: [], run: [] };

function matchRow(rows, sql, params) {
    // Extract `col = $n` pairs from the WHERE clause and require all to match.
    const conds = [...sql.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/gi)].map(m => [m[1], params[Number(m[2]) - 1]]);
    return rows.find(r => conds.every(([col, val]) => r[col] === val)) || null;
}

const mockDb = {
    run: async (sql, params = []) => {
        calls.run.push({ sql, params });
        // Scoped deletes must report 0 affected rows when the row doesn't belong
        // to the notebook — that is what makes the route return 404.
        if (/DELETE FROM notebook_versions/i.test(sql)) {
            return { rowCount: matchRow(versionRows, sql, params) ? 1 : 0 };
        }
        return { rowCount: 1 };
    },
    getOne: async (sql, params = []) => {
        calls.getOne.push({ sql, params });
        if (/FROM notebook_sources/i.test(sql)) return matchRow(sourceRows, sql, params);
        if (/FROM notebook_versions/i.test(sql)) return matchRow(versionRows, sql, params);
        return null;
    },
    getAll: async () => [],
    exec: async () => undefined,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };

const notebookStore = require('./notebookStore');

function reset() { calls.getOne = []; calls.run = []; }

// ── deleteSource ──────────────────────────────────────────────────
test('deleteSource scoped to notebookId refuses a foreign source', async () => {
    reset();
    // Alice owns nb-alice; she passes Bob's source id s-bob under her notebook.
    const src = await notebookStore.deleteSource('s-bob', 'nb-alice');
    assert.strictEqual(src, null, 'foreign source must not delete');
    assert.ok(!calls.run.some(c => /DELETE FROM notebook_sources/i.test(c.sql)),
        'no DELETE should be issued for a foreign source');
    const lookup = calls.getOne.find(c => /FROM notebook_sources/i.test(c.sql));
    assert.match(lookup.sql, /notebook_id\s*=\s*\$2/i, 'lookup must scope by notebook_id');
    assert.deepStrictEqual(lookup.params, ['s-bob', 'nb-alice']);
});

test('deleteSource scoped to notebookId deletes an owned source', async () => {
    reset();
    const src = await notebookStore.deleteSource('s-alice', 'nb-alice');
    assert.ok(src && src.id === 's-alice');
    assert.ok(calls.run.some(c => /DELETE FROM notebook_sources/i.test(c.sql)),
        'owned source must be deleted');
});

// ── deleteVersion ─────────────────────────────────────────────────
test('deleteVersion scoped to notebookId refuses a foreign version', async () => {
    reset();
    const ok = await notebookStore.deleteVersion('v-bob', 'nb-alice');
    assert.strictEqual(ok, false, 'foreign version must not delete');
    const del = calls.run.find(c => /DELETE FROM notebook_versions/i.test(c.sql));
    assert.ok(del, 'the scoped DELETE is still issued (it simply matches nothing)');
    assert.match(del.sql, /notebook_id\s*=\s*\$2/i, 'delete must scope by notebook_id');
    assert.deepStrictEqual(del.params, ['v-bob', 'nb-alice']);
});

test('deleteVersion scoped to notebookId deletes an owned version', async () => {
    reset();
    const ok = await notebookStore.deleteVersion('v-alice', 'nb-alice');
    assert.strictEqual(ok, true, 'owned version must be deleted');
});

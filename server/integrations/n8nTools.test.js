'use strict';

/**
 * Regression test for triggerWebhookWorkflow (integrations/n8nTools.js).
 *
 * Guards against BFSF "apiBase is not defined": the two fetch() calls in
 * triggerWebhookWorkflow used to pass `getAgent(apiBase)`, but `apiBase` is
 * only declared in the sibling functions (listActiveWebhookWorkflows /
 * fetchWorkflowById). In this function the in-scope var is `url`, so the bare
 * `apiBase` threw `ReferenceError: apiBase is not defined` the moment the
 * webhook was triggered — surfaced to the KB UI as "Error: apiBase is not
 * defined" when a user clicked Execute & Ingest Output Data. Both the JSON and
 * the multipart (file-upload) branch were affected.
 *
 * A real loopback http server exercises node-fetch end-to-end (incl. the
 * `agent` option we're testing), so no fetch mocking is needed. `../db` is
 * stubbed via require.cache so requiring n8nTools -> configStore opens no pool.
 *
 * Run: cd server && node --test integrations/n8nTools.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── Stub ../db so configStore.initDB() is a no-op (no Postgres pool) ─────────
const dbPath = require.resolve('../db');
const noop = async () => {};
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
        run: async () => ({ rows: [], rowCount: 0 }),
        getOne: async () => null,
        getAll: async () => [],
        exec: noop,
        getClient: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
        withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
        makeStoreInit: () => noop,
        getPoolStats: () => ({}),
        getRedis: () => null,
        redisHealthy: () => false,
        disconnectRedis: noop,
    },
};

const { triggerWebhookWorkflow } = require('./n8nTools');

// ── Loopback n8n stand-in — echoes a JSON array back for any /webhook/* hit ──
let server;
let baseUrl;
const received = [];

before(async () => {
    server = http.createServer((req, res) => {
        received.push({ method: req.method, url: req.url });
        req.resume(); // drain the request body so the socket closes cleanly
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([{ text: 'hello from n8n' }]));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

test('triggerWebhookWorkflow: JSON branch resolves without a ReferenceError', async () => {
    // Before the fix this rejected synchronously with
    // "ReferenceError: apiBase is not defined" while building fetchOptions.
    const result = await triggerWebhookWorkflow(baseUrl, 'my-hook', 'POST', { ok: true }, null);
    assert.deepEqual(result, [{ text: 'hello from n8n' }]);
    assert.ok(received.some((r) => r.url === '/webhook/my-hook'), 'server saw the webhook call');
});

test('triggerWebhookWorkflow: multipart (file upload) branch resolves without a ReferenceError', async () => {
    const files = [{ name: 'f.txt', content: Buffer.from('hi'), mimeType: 'text/plain' }];
    const result = await triggerWebhookWorkflow(baseUrl, 'file-hook', 'POST', { field: 'v' }, files);
    assert.deepEqual(result, [{ text: 'hello from n8n' }]);
    assert.ok(received.some((r) => r.url === '/webhook/file-hook'), 'server saw the multipart call');
});

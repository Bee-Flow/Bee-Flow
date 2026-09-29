/**
 * The two KB routes the Node shim was missing (K1).
 *
 * Production points SEARCH_SERVICE_URL at this router, not at the hosted
 * Python search-service, so the shim has to answer the same paths its clients
 * call. Two of them existed on neither side:
 *
 *   GET    /kb/{kb}/documents/{doc}/content — re-index (routes/knowledgeBases/
 *          reindex.js) needs it to recover a document's text; without it every
 *          non-local re-index failed with "Failed to get existing content".
 *   DELETE /kb/documents/{doc}             — the ONLY chunk-removal route the
 *          Python service has. The callers used to invoke
 *          /kb/{kb}/documents/{doc}/chunks and /kb/{kb}/chunks, which exist
 *          nowhere: deleted documents kept answering questions.
 *
 * Both mirror search-service/app/routers/ingest.py exactly, so a customer can
 * still swap SEARCH_SERVICE_URL between the two implementations.
 *
 * Run: cd server && node --test --test-force-exit routes/search.kbShim.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = { chunks: {}, deletes: [] };

const MOCKS = {
    '../core/kb/localKBIngest': {
        ingestLocally: async () => ({ chunks_created: 0 }),
        searchLocally: async () => ({ chunks: [] }),
        getDocumentContent: async (tenantId, kbId, docId) => fx.chunks[`${tenantId}|${kbId}|${docId}`] || '',
        deleteChunksLocally: async (tenantId, kbId, docId) => { fx.deletes.push({ tenantId, kbId, docId }); },
    },
    '../core/embed/cpuEmbed': { cpuEmbed: async () => [], CPU_EMBED_MODEL_ID: 'm', CPU_EMBED_DIM: 3 },
    '../core/rerank/cpuCrossEncoder': { rerankCpu: async () => [], CPU_RERANK_MODEL_ID: 'r' },
    '../stores/configStore': { getConfig: async () => null, getSecret: async () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:search-shim:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
// The caller under test (core/kb/kbIngestionHelpers) needs two seams of its
// own: the provider choice — 'local' skips the remote call entirely — and the
// local chunk table it cleans first.
const HELPER_MOCKS = {
    './resolveProvider': { resolveKbProvider: async () => 'remote' },
    './localKBIngest': { deleteChunksLocally: async () => {} },
};
const HELPER_IDS = {};
for (const [request, exportsObj] of Object.entries(HELPER_MOCKS)) {
    const mockId = `mock:search-shim-helpers:${request}`;
    HELPER_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]search\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    if (parent && /kb[\\/]kbIngestionHelpers\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(HELPER_IDS, request)) {
        return HELPER_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./search');
const { purgeDocumentChunks } = require('../core/kb/kbIngestionHelpers');

test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {} }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

test('GET /kb/:kb/documents/:doc/content returns the reassembled text', async () => {
    fx.chunks['t1|kb1|d1'] = 'chunk one\n\nchunk two';
    const res = await dispatch({ method: 'GET', url: '/kb/kb1/documents/d1/content?tenant_id=t1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.document_id, 'd1');
    assert.strictEqual(res.body.content, 'chunk one\n\nchunk two');
    assert.strictEqual(res.body.chunk_count, 2);
});

test('content without a tenant_id is a 400, and an unknown document a 404 — like the Python service', async () => {
    const noTenant = await dispatch({ method: 'GET', url: '/kb/kb1/documents/d1/content' });
    assert.strictEqual(noTenant.statusCode, 400);

    const missing = await dispatch({ method: 'GET', url: '/kb/kb1/documents/ghost/content?tenant_id=t1' });
    assert.strictEqual(missing.statusCode, 404);
});

test('DELETE /kb/documents/:doc removes that document\'s chunks', async () => {
    fx.deletes.length = 0;
    const res = await dispatch({ method: 'DELETE', url: '/kb/documents/d9?tenant_id=t1&knowledge_base_id=kb1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { status: 'ok', document_id: 'd9' });
    assert.deepStrictEqual(fx.deletes, [{ tenantId: 't1', kbId: 'kb1', docId: 'd9' }]);
});

test('the delete refuses to run without both scopes — never a KB-wide wipe by omission', async () => {
    fx.deletes.length = 0;
    const noKb = await dispatch({ method: 'DELETE', url: '/kb/documents/d9?tenant_id=t1' });
    assert.strictEqual(noKb.statusCode, 400);
    const noTenant = await dispatch({ method: 'DELETE', url: '/kb/documents/d9?knowledge_base_id=kb1' });
    assert.strictEqual(noTenant.statusCode, 400);
    assert.strictEqual(fx.deletes.length, 0,
        'deleteChunksLocally(tenant, kb, undefined) wipes the whole KB — the guard is what stops that');
});

test('the delete also accepts the scopes in the body, for clients that send one', async () => {
    fx.deletes.length = 0;
    const res = await dispatch({ method: 'DELETE', url: '/kb/documents/d9', body: { tenant_id: 't1', knowledge_base_id: 'kb1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.deletes.length, 1);
});

// ── Client and route, against each other ─────────────────────────────
// The bug was never in either half on its own: the caller asked for a path
// that existed on neither implementation, and deleted documents kept
// answering questions. So the caller is RUN, the request it makes is
// captured, and that exact request is then dispatched through this shim.

test('the request purgeDocumentChunks makes is one this shim answers', async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        sent.push({ url: String(url), method: init && init.method });
        return { ok: true, status: 200 };
    };
    try {
        await purgeDocumentChunks('kb1', 'd9', 't1');
    } finally {
        globalThis.fetch = realFetch;
    }

    assert.strictEqual(sent.length, 1, 'the remote purge never went out');
    assert.strictEqual(sent[0].method, 'DELETE');

    // Replay it against the shim. A path this router does not know falls
    // through and `dispatch` rejects — which is exactly the old bug's shape.
    const asked = new URL(sent[0].url);
    fx.deletes.length = 0;
    const res = await dispatch({ method: 'DELETE', url: asked.pathname + asked.search, body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deletes, [{ tenantId: 't1', kbId: 'kb1', docId: 'd9' }],
        'the shim must read the ids the caller put in the request');
});

test('a document id that needs escaping survives the round trip', async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { sent.push({ url: String(url), method: init && init.method }); return { ok: true, status: 200 }; };
    try {
        await purgeDocumentChunks('kb/1', 'doc 9#a', 't 1');
    } finally {
        globalThis.fetch = realFetch;
    }

    const asked = new URL(sent[0].url);
    fx.deletes.length = 0;
    const res = await dispatch({ method: 'DELETE', url: asked.pathname + asked.search, body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deletes, [{ tenantId: 't 1', kbId: 'kb/1', docId: 'doc 9#a' }]);
});

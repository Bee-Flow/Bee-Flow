/**
 * What the Node search-service twin accepts, and what it says when it refuses
 * (routes/search.js).
 *
 * The Python service it mirrors has always refused unknown fields and values
 * (`extra="forbid"`, search-service/app/models.py). This twin let everything
 * through, and on a search router the fallbacks pointed OUTWARD: a mode it did
 * not know became a web search, so `{"mode": "kb_only"}` sent a question meant
 * for the internal knowledge base to Serper.dev with a 200; and a KB scope in
 * Python's own shape (`kb_scope`) was never read, so 'auto' searched the web
 * instead. What this file pins:
 *
 *   - the 400 NAMES the field (`body.mode`), not just "invalid request";
 *   - a refused search never leaves the building (no Serper call);
 *   - the bodies the real callers send — web-search tool, KB search, ingest —
 *     still pass, including the Python-only keys this twin ignores;
 *   - what the router requires before it answers at all (apiKeyAuth): every
 *     route acts on the tenant and knowledge-base ids the body names, so the
 *     services key is what ties a caller to this instance. Without one it is
 *     503 "not configured" in production (never a search) and open only
 *     outside it; with one, the comparison is constant-time and a wrong key
 *     of any length is 401. The mode is read when the module loads, so those
 *     cases load the router fresh with their own environment.
 *
 * Run: cd server && node --test routes/search.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
delete process.env.SERVICES_API_KEY; // apiKeyAuth is open when unset

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every local search/ingest/embed lands in `touched`; every outbound fetch in
// `outbound`. A refused request must leave both empty.
const touched = [];
const outbound = [];
const logged = [];

const MOCKS = {
    '../core/embed/cpuEmbed': {
        cpuEmbed: async (texts, opts) => { touched.push({ what: 'cpuEmbed', args: [texts, opts] }); return texts.map(() => [0.1, 0.2]); },
        CPU_EMBED_MODEL_ID: 'embed-m', CPU_EMBED_DIM: 2,
    },
    '../core/rerank/cpuCrossEncoder': {
        rerankCpu: async (q, docs, n) => { touched.push({ what: 'rerankCpu', args: [q, docs, n] }); return [{ index: 0, relevance_score: 1 }]; },
        CPU_RERANK_MODEL_ID: 'rerank-m',
    },
    '../core/kb/localKBIngest': {
        searchLocally: async (tenantId, kbIds, query, opts) => {
            touched.push({ what: 'searchLocally', args: [tenantId, kbIds, query, opts] });
            return { chunks: [{ content: 'chunk', title: 'Doc', score: 0.9 }] };
        },
        ingestLocally: async (...args) => { touched.push({ what: 'ingestLocally', args }); return { chunks_created: 3 }; },
        getDocumentContent: async () => 'a\n\nb',
        deleteChunksLocally: async (...args) => { touched.push({ what: 'deleteChunksLocally', args }); },
    },
    '../stores/configStore': { getSecret: async () => 'serper-key', getConfig: async () => null },
    '../telemetry/log': {
        info() {}, debug() {},
        warn: (...a) => logged.push({ level: 'warn', text: a.join(' ') }),
        error: (...a) => logged.push({ level: 'error', text: a.join(' ') }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:search-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]search\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./search');
const realFetch = globalThis.fetch;
const ROUTER_PATH = require.resolve('./search');
test.after(() => { Module._resolveFilename = originalResolve; globalThis.fetch = realFetch; delete require.cache[ROUTER_PATH]; });

/** The router loaded under one environment (the key mode is decided at load). */
function routerWith({ nodeEnv, key }) {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    if (key === undefined) delete process.env.SERVICES_API_KEY; else process.env.SERVICES_API_KEY = key;
    delete require.cache[ROUTER_PATH];
    logged.length = 0;
    return require('./search');
}

// Serper is the one outbound call this router makes; record it instead.
globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return {
        ok: true, status: 200,
        json: async () => ({ organic: [{ title: 'Web hit', link: 'https://example.com', snippet: 's' }] }),
        text: async () => '',
    };
};

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, headers = {} }, use = router) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query,
            // No content-length: express.json() leaves the pre-set body alone.
            headers, get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        use(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; outbound.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not search, embed or ingest');
    assert.deepStrictEqual(outbound, [], 'a refused request must never reach Serper');
    return res;
}

// ═══ /tools/search — nothing leaves by accident ═════════════════════

test('a mode this service does not know is refused, not sent to the web', async () => {
    const res = await refuses({ method: 'POST', url: '/tools/search', body: { query: 'salary Jan de Vries', mode: 'kb_only' } }, 'body.mode');
    assert.strictEqual(res.body.error, 'mode is one of: web, web_fast, kb, auto.');
});

test('a KB scope in the Python shape is searched locally, not replaced by a web search', async () => {
    const res = await dispatch({
        method: 'POST', url: '/tools/search',
        body: { query: 'holiday policy', mode: 'auto', kb_scope: { tenant_id: 't1', knowledge_base_ids: ['kb1'] } },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode_used, 'kb');
    assert.deepStrictEqual(touched[0].args.slice(0, 3), ['t1', ['kb1'], 'holiday policy']);
    assert.deepStrictEqual(outbound, [], 'the question stayed inside');
});

test('with the mode left out, a KB scope is searched first — Python\'s default is auto', async () => {
    const res = await dispatch({
        method: 'POST', url: '/tools/search',
        body: { query: 'holiday policy', kb_scope: { tenant_id: 't1', knowledge_base_ids: ['kb1'] } },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode_used, 'kb');
    assert.deepStrictEqual(outbound, []);
});

test('the web-search tool\'s exact payload still searches the web, extra Python keys and all', async () => {
    const res = await dispatch({
        method: 'POST', url: '/tools/search',
        body: {
            query: 'eu ai act news', mode: 'web',
            web: { max_results: 5, fetch_top_n: 3 },
            // An admin-configured detail level this twin never reads: ignored, not policed.
            response: { include_citations: true, max_tokens_markdown: 2000, detail_level: 'high' },
        },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.mode_used, 'web');
    assert.strictEqual(outbound.length, 1);
    assert.strictEqual(outbound[0].body.num, 5);
});

test('no scope and no mode is still a web search, answered as one', async () => {
    const res = await dispatch({ method: 'POST', url: '/tools/search', body: { query: 'weather' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.mode_used, 'web');
});

test('a misspelled option block is refused, not ignored', async () => {
    await refuses({ method: 'POST', url: '/tools/search', body: { query: 'q', mode: 'web', wbe: { max_results: 5 } } }, 'body');
});

// ═══ /embed and /rerank ══════════════════════════════════════════════

test('a query embedding asked for with a capital is refused, not embedded as a passage', async () => {
    const res = await refuses({ method: 'POST', url: '/embed', body: { texts: ['hello'], kind: 'Query' } }, 'body.kind');
    assert.strictEqual(res.body.error, 'kind is "query" or "passage".');
});

test('a query embedding is still a query embedding', async () => {
    const res = await dispatch({ method: 'POST', url: '/embed', body: { texts: ['hello'], kind: 'query' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[1], { kind: 'query' });
});

test('documents that are not text are refused before the reranker sees them', async () => {
    await refuses({ method: 'POST', url: '/rerank', body: { query: 'q', documents: [1, 2] } }, 'body.documents.0');
});

// ═══ /tools/kb-search and /kb/ingest/json — the callers' own bodies ═

test('the agent KB search body passes whole — inference_routing, rerank and all', async () => {
    const res = await dispatch({
        method: 'POST', url: '/tools/kb-search',
        body: { tenant_id: 'u1', kb_ids: ['kb1'], query: 'q', top_k: 8, rerank: true, inference_routing: { embed: 'x' }, use_azure: false },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched[0].args[3], { topK: 8 });
});

test('a misspelled KB list is refused by name, not answered "kb_ids required"', async () => {
    await refuses({ method: 'POST', url: '/tools/kb-search', body: { tenant_id: 'u1', kb_id: ['kb1'], query: 'q' } }, 'body.kb_ids');
});

test('the ingestion helper\'s body still ingests', async () => {
    const res = await dispatch({
        method: 'POST', url: '/kb/ingest/json',
        body: { tenant_id: 'u1', knowledge_base_id: 'kb1', document_id: 'd1', content: 'text', title: null, source_uri: 'a.pdf', lang: 'auto', use_azure: false },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { document_id: 'd1', chunks_created: 3, status: 'ok' });
});

test('a misspelled document id on ingest is refused by name', async () => {
    await refuses({
        method: 'POST', url: '/kb/ingest/json',
        body: { tenant_id: 'u1', knowledge_base_id: 'kb1', docment_id: 'd1', content: 'text' },
    }, 'body.document_id');
});

// ═══ The two KB routes keep their own "is required" answers ═════════

test('an unknown parameter on the delete is refused — it names what to delete', async () => {
    await refuses({ method: 'DELETE', url: '/kb/documents/d9?tenant_id=t1&kb_id=kb1' }, 'query');
});

// ═══ The services key — what the router requires before it answers ═══

const KB_SEARCH = { method: 'POST', url: '/tools/kb-search', body: { tenant_id: 't1', kb_ids: ['kb1'], query: 'q' } };
const KEY = 'k-right-0123456789';

// The cases above hold NODE_ENV=test and no key; put that back after each.
test.afterEach(() => { process.env.NODE_ENV = 'test'; delete process.env.SERVICES_API_KEY; });

test('production without a key: 503 "not configured", nothing is searched or embedded', async () => {
    const r = routerWith({ nodeEnv: 'production', key: undefined });
    const res = await dispatch(KB_SEARCH, r);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'search_service_not_configured');
    const embed = await dispatch({ method: 'POST', url: '/embed', body: { texts: ['a'] } }, r);
    assert.strictEqual(embed.statusCode, 503);
    assert.deepStrictEqual(touched, []);
});

test('production without a key: /health still answers, and the log says so once', async () => {
    const r = routerWith({ nodeEnv: 'production', key: undefined });
    const health = await dispatch({ method: 'GET', url: '/health' }, r);
    assert.strictEqual(health.statusCode, 200);
    await dispatch(KB_SEARCH, r);
    await dispatch(KB_SEARCH, r);
    assert.strictEqual(logged.filter((l) => l.level === 'error' && /SERVICES_API_KEY/.test(l.text)).length, 1, JSON.stringify(logged));
});

test('outside production without a key: open, with one warning', async () => {
    const r = routerWith({ nodeEnv: 'test', key: undefined });
    const res = await dispatch(KB_SEARCH, r);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.what), ['searchLocally']);
    assert.ok(logged.some((l) => l.level === 'warn' && /SERVICES_API_KEY/.test(l.text)));
});

test('with a key: the right X-API-Key reaches the handler', async () => {
    const r = routerWith({ nodeEnv: 'production', key: KEY });
    const res = await dispatch({ ...KB_SEARCH, headers: { 'x-api-key': KEY } }, r);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.what), ['searchLocally']);
});

test('with a key: a wrong X-API-Key is 401 whatever its length, and nothing is searched', async () => {
    const r = routerWith({ nodeEnv: 'production', key: KEY });
    for (const wrong of ['k-wrong-0123456789', 'short', '']) {
        const res = await dispatch({ ...KB_SEARCH, headers: { 'x-api-key': wrong } }, r);
        assert.strictEqual(res.statusCode, 401, `key ${JSON.stringify(wrong)}`);
    }
    assert.deepStrictEqual(touched, []);
    const health = await dispatch({ method: 'GET', url: '/health' }, r);
    assert.strictEqual(health.statusCode, 200);
});

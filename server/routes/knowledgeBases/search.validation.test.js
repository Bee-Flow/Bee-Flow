/**
 * What the knowledge-base search accepts, and what it says when it refuses
 * (routes/knowledgeBases/search.js).
 *
 * "No kb_ids" means "every knowledge base I can reach" — the mobile app's
 * global search sends `kb_ids: []` for exactly that. The route used to reach
 * the same answer for every OTHER shape too: one id sent as a string, the
 * camelCase `kbIds`, a list holding only ''. Each searched everything under a
 * 200 that looked like the narrow answer. What this file pins:
 *
 *   - only absent, null and [] mean "search everything";
 *   - the 400 NAMES the field (`body.kb_ids.0`), in a sentence;
 *   - a refused search reaches neither the store nor the search engine;
 *   - the search service's own error text is not handed to the caller.
 *
 * Run: cd server && node --test routes/knowledgeBases/search.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const KB1 = '0b6f7a52-3c1e-4d7a-9a51-2f7c1d9e8a01';
const KB2 = '5d2e9b10-7f4a-4c3b-8e21-9a0d6c4b7f02';

// Every store and engine call lands in `touched`. A refused request must leave
// it empty — in particular, it must never become a search of everything.
const touched = [];
const fx = { provider: 'local', upstream: null };
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        listKBs: async (...a) => { touched.push({ what: 'listKBs', args: a }); return [{ id: KB1 }, { id: KB2 }]; },
        canUserAccessKB: () => true,
    },
    '../../stores/configStore': { getConfig: async () => null },
    '../../auth': {
        requireAuth: pass,
        resolveUserOrgIds: async () => new Set(['org1']),
    },
    '../../core/serviceAuth': { getServiceHeaders: () => ({}) },
    './shared': {
        SEARCH_SERVICE_URL: 'http://search.internal',
        getUserId: (req) => req.session?.user?.id || null,
        resolveUserGroups: async () => [],
        resolveIsOrgAdmin: async () => false,
    },
    '../../db': {
        getAll: async (sql, params) => {
            touched.push({ what: 'getAll', args: [sql, params] });
            if (/FROM knowledge_bases/.test(sql)) return params[0].map((id) => ({ id }));
            return [];
        },
    },
    '../../core/kb/resolveProvider': { resolveKbProvider: async () => fx.provider },
    '../../core/kb/localKBIngest': {
        searchLocally: async (...a) => { touched.push({ what: 'searchLocally', args: a }); return []; },
    },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-search-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]search\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./search');

// The remote path calls the search service with the global fetch.
const originalFetch = global.fetch;
global.fetch = async (url, init) => {
    touched.push({ what: 'fetch', args: [url, JSON.parse(init.body)] });
    return fx.upstream || { ok: true, json: async () => ({ results: [] }) };
};
test.after(() => {
    Module._resolveFilename = originalResolve;
    global.fetch = originalFetch;
});

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method = 'POST', url = '/search', body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    touched.length = 0;
    fx.provider = 'local';
    fx.upstream = null;
});

/** Assert: refused with 400, the named field is in `details`, nothing searched. */
async function refuses(body, field) {
    const res = await dispatch({ body });
    const what = JSON.stringify(body);
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused search must reach neither the store nor the engine');
    return res;
}

const searched = () => touched.find((t) => t.what === 'searchLocally');

// ── Only "nothing" means "everything" ───────────────────────────────

test('one id sent as a string is refused, not widened into a search of everything', async () => {
    const res = await refuses({ query: 'verlof', kb_ids: KB1 }, 'body.kb_ids');
    assert.match(res.body.error, /list of knowledge base ids/);
});

test('the camelCase kbIds is refused rather than read as "no list given"', async () => {
    await refuses({ query: 'verlof', kbIds: [KB1] }, 'body');
});

test('a list holding only a blank entry is refused, not emptied into "all"', async () => {
    await refuses({ query: 'verlof', kb_ids: [''] }, 'body.kb_ids.0');
});

test('an id that is not a knowledge base id is a 400, not a Postgres cast error', async () => {
    const res = await refuses({ query: 'verlof', kb_ids: [KB1, 'handboek'] }, 'body.kb_ids.1');
    assert.strictEqual(res.body.error, 'Each entry in kb_ids is a knowledge base id.');
});

test('an empty list is still the global search the mobile app asks for', async () => {
    const res = await dispatch({ body: { query: 'verlof', kb_ids: [] } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'listKBs'), 'every reachable base was listed');
    assert.deepStrictEqual(searched().args[1], [KB1, KB2]);
});

test('leaving kb_ids out, or sending null, is the same global search', async () => {
    for (const body of [{ query: 'verlof' }, { query: 'verlof', kb_ids: null }]) {
        touched.length = 0;
        const res = await dispatch({ body });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(body));
        assert.deepStrictEqual(searched().args[1], [KB1, KB2], JSON.stringify(body));
    }
});

test('named ids search exactly those bases', async () => {
    const res = await dispatch({ body: { query: 'verlof', kb_ids: [KB2] } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!touched.some((t) => t.what === 'listKBs'), 'no global listing for a named search');
    assert.deepStrictEqual(searched().args[1], [KB2]);
});

// ── The query ───────────────────────────────────────────────────────

test('no body at all is answered in words, not with "Required"', async () => {
    const res = await refuses(undefined, 'body.query');
    assert.strictEqual(res.body.error, 'Say what to search for.');
});

test('a query that is not text is refused by name instead of crashing the local search', async () => {
    // searchLocally logs `query.slice(0, 60)`: a number used to be a TypeError
    // and a 500 after the access checks had already run.
    await refuses({ query: 42 }, 'body.query');
});

test('a blank query is refused, and a padded one is trimmed on its way to the engine', async () => {
    await refuses({ query: '   ' }, 'body.query');
    const res = await dispatch({ body: { query: '  verlof  ', kb_ids: [KB1] } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(searched().args[2], 'verlof');
});

test('an over-long query is refused rather than embedded whole', async () => {
    await refuses({ query: 'a'.repeat(2001) }, 'body.query');
});

// ── top_k ───────────────────────────────────────────────────────────

test('a top_k that is not a number is refused, not turned into an empty answer', async () => {
    // On the local path `topK * 2` became NaN: the vector query's LIMIT NaN
    // failed inside a catch and `slice(0, NaN)` emptied the candidates, so the
    // caller was told nothing matched, under a 200.
    await refuses({ query: 'verlof', top_k: 'ten' }, 'body.top_k');
});

test('a top_k outside the search service\'s own 1–50 is refused here, not as a 502', async () => {
    await refuses({ query: 'verlof', top_k: 500 }, 'body.top_k');
    await refuses({ query: 'verlof', top_k: 0 }, 'body.top_k');
    await refuses({ query: 'verlof', top_k: -3 }, 'body.top_k');
    await refuses({ query: 'verlof', top_k: 7.5 }, 'body.top_k');
    await refuses({ query: 'verlof', top_k: true }, 'body.top_k');
});

test('top_k defaults to 8 and is passed through when given', async () => {
    await dispatch({ body: { query: 'verlof', kb_ids: [KB1] } });
    assert.deepStrictEqual(searched().args[3], { topK: 8 });
    touched.length = 0;
    await dispatch({ body: { query: 'verlof', kb_ids: [KB1], top_k: 20 } });
    assert.deepStrictEqual(searched().args[3], { topK: 20 });
});

test('what always worked still does: digits in a string, and null for the default', async () => {
    // "5" was multiplied by JavaScript on the local path and coerced by
    // pydantic on the remote one, so a client sending it was never wrong.
    await dispatch({ body: { query: 'verlof', kb_ids: [KB1], top_k: '5' } });
    assert.deepStrictEqual(searched().args[3], { topK: 5 });
    touched.length = 0;
    await dispatch({ body: { query: 'verlof', kb_ids: [KB1], top_k: null } });
    assert.deepStrictEqual(searched().args[3], { topK: 8 });
});

// ── The search service ──────────────────────────────────────────────

test('the search service gets the validated values on the remote path', async () => {
    fx.provider = 'remote';
    const res = await dispatch({ body: { query: ' verlof ', kb_ids: [KB1], top_k: 5 } });
    assert.strictEqual(res.statusCode, 200);
    const [, sent] = touched.find((t) => t.what === 'fetch').args;
    assert.deepStrictEqual(sent, { tenant_id: 'u1', kb_ids: [KB1], query: 'verlof', top_k: 5, rerank: true });
});

test('a failing search service is a 502 in words, without its own error text', async () => {
    fx.provider = 'remote';
    fx.upstream = {
        ok: false, status: 500,
        text: async () => 'Traceback (most recent call last): qdrant.internal:6333 refused',
    };
    const res = await dispatch({ body: { query: 'verlof', kb_ids: [KB1] } });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'search_failed');
    assert.doesNotMatch(JSON.stringify(res.body), /Traceback|qdrant/);
});

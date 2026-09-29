/**
 * What the local-runtime routes accept (routes/ai/localRuntimes.js).
 *
 * `POST /ai/local-runtimes/test` takes an address and makes an outbound
 * request to it, so the shape of that field IS the SSRF guard: a `file:` or
 * `gopher:` url must never reach the adapter, and neither must a bare host
 * with no scheme. That check used to be a hand-rolled helper beside the
 * handler; it is the schema now, and this pins what a caller sees:
 *
 *   - the 400 names the field and keeps the sentence the admin reads;
 *   - nothing is probed when the body is refused.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/localRuntimes.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
const probed = [];   // every adapter.probe(apiKey, url) the routes reached
const pulled = [];   // every adapter.pullModel(...) the routes reached

const adapter = {
    probe: async (apiKey, url) => {
        probed.push({ apiKey, url });
        return { ok: true, version: '1', modelCount: 1, models: [{ id: 'm1', name: 'M1', cat: 'chat' }] };
    },
    pullModel: async (_key, _url, model) => { pulled.push(model); },
};

const MOCKS = {
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
        hasPermission: async () => true,
    },
    '../../core/aiAgent': {
        getProviders: async () => ({ providers: [{ id: 'p1', type: 'ollama', url: 'http://localhost:11434', apiKey: '' }] }),
        invalidateModelCache: () => {},
    },
    '../../core/providers': { getAdapter: () => adapter },
    '../../core/providers/localModels': {
        LOCAL_RUNTIMES: { ollama: { label: 'Ollama', canPull: true } },
        isLocalProviderType: (t) => t === 'ollama',
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:local-runtimes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /ai[\\/]localRuntimes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./localRuntimes');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the harness
// has to be an app with one.
function dispatch({ method, url, body = {}, session = { user: { id: 'alice' }, isAdmin: true } }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session, query: {}, params: {}, get() { return undefined; } };
        const res = {
            statusCode: 200, headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            flushHeaders() {},
            write() { return true; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            const status = Number(err.status || err.statusCode) || 500;
            if (status >= 500) return reject(err);
            return res.status(status).json({ error: err.message, code: err.code, details: err.details });
        });
    });
}

test.beforeEach(() => { probed.length = 0; pulled.length = 0; });

const TEST_URL = '/local-runtimes/test';

// ═══ The endpoint field is the SSRF guard ═══════════════════════════

test('a non-http scheme is refused by name, and never probed', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://localhost:70', 'ftp://example.test/x']) {
        const res = await dispatch({ method: 'POST', url: TEST_URL, body: { type: 'ollama', url } });
        assert.strictEqual(res.statusCode, 400, url);
        assert.strictEqual(res.body.error, 'Only http:// and https:// endpoints are supported');
        assert.ok(res.body.details.some((d) => d.path === 'body.url'));
    }
    assert.deepStrictEqual(probed, [], 'a refused address must never reach the adapter');
});

test('something that is not a url at all gets the sentence that tells you what to type', async () => {
    const res = await dispatch({ method: 'POST', url: TEST_URL, body: { type: 'ollama', url: 'my ollama box' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Enter a full URL, for example http://localhost:11434');
    assert.deepStrictEqual(probed, []);
});

test('a bare host:port is a SCHEME to the url parser, so it trips the scheme rule', async () => {
    // `new URL('localhost:11434')` parses, with protocol 'localhost:'. Worth
    // pinning: the reason it is refused is not the one an admin would guess,
    // and a future rewrite that "fixes" the message must keep the refusal.
    const res = await dispatch({ method: 'POST', url: TEST_URL, body: { type: 'ollama', url: 'localhost:11434' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Only http:// and https:// endpoints are supported');
    assert.deepStrictEqual(probed, []);
});

test('a missing url is refused by name rather than probed as an empty address', async () => {
    const res = await dispatch({ method: 'POST', url: TEST_URL, body: { type: 'ollama' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.url'));
    assert.deepStrictEqual(probed, []);
});

test('an unknown runtime type is named in the refusal', async () => {
    const res = await dispatch({ method: 'POST', url: TEST_URL, body: { type: 'made-up', url: 'http://localhost:1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "Unknown runtime type 'made-up'");
    assert.deepStrictEqual(probed, []);
});

test('a key the route does not read is refused, not silently dropped', async () => {
    const res = await dispatch({
        method: 'POST', url: TEST_URL,
        body: { type: 'ollama', url: 'http://localhost:11434', headers: { 'X-Smuggled': '1' } },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(probed, []);
});

test('a good address is probed in one canonical spelling', async () => {
    const res = await dispatch({
        method: 'POST', url: TEST_URL,
        body: { type: 'ollama', url: '  http://localhost:11434///  ' },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(probed, [{ apiKey: '', url: 'http://localhost:11434' }],
        'trailing slashes and padding must not make two spellings of one endpoint');
});

// ═══ Pulling a model ════════════════════════════════════════════════

test('a pull with no model name is refused in words, and downloads nothing', async () => {
    for (const body of [{}, { model: '' }, { model: '   ' }, { model: 42 }]) {
        const res = await dispatch({ method: 'POST', url: '/local-runtimes/p1/pull', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.body.error, 'A model name is required');
        assert.ok(res.body.details.some((d) => d.path === 'body.model'));
    }
    assert.deepStrictEqual(pulled, [], 'a refused request must not start a multi-gigabyte download');
});

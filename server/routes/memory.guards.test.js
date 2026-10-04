/**
 * The memory router's own guards: authentication, and validation of what a
 * caller may put into a memory.
 *
 * Both were missing entirely.
 *
 *   • No auth middleware. The mount in index.js carries none, and every handler
 *     used `getEffectiveUserId`, which mints a `guest_<random>` id rather than
 *     returning 401. `POST /import` was therefore an unauthenticated,
 *     unrate-limited LLM call taking 50 KB of caller text.
 *
 *   • `POST /` never validated `type`, never capped `content`, and read
 *     `importance || 0.5` so any number passed through. Anything stored as
 *     `type: 'instruction'` is rendered into the system prompt of every later
 *     turn, so that combination was a persistent prompt-injection channel
 *     rather than merely lax input handling.
 *
 * Sibling file `memory.authz.test.js` covers project-role authorization.
 *
 * Run: cd server && node --test routes/memory.guards.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    created: [],
    updated: [],
    memories: {},
    similar: null,       // what findSimilarMemory returns
    confirmed: [],
    importItems: [],     // what the stubbed LLM "extracts"
};

const MOCKS = {
    '../stores/memoryStore': {
        getMemoryById: async (id) => fx.memories[id] || null,
        createMemory: async (...args) => { fx.created.push(args); return 'new-id'; },
        updateMemory: async (id, content, summary, importance) => {
            fx.updated.push({ id, content, summary, importance });
        },
        findSimilarMemory: async () => fx.similar,
        confirmMemory: async (id) => { fx.confirmed.push(id); },
        deleteMemory: async () => {},
        getMemories: async () => [],
        getMemoriesForAgent: async () => [],
        getMemoriesForProject: async () => [],
        searchUserMemories: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        getMemoryStats: async () => ({ total: 0 }),
        clearAllMemories: async () => {},
    },
    '../auth/projectAccess': { hasProjectRole: async () => true },
    '../auth': {
        requireAuth: (req, res, next) => {
            if (req.session?.user?.id) return next();
            return res.status(401).json({ error: 'Authentication required' });
        },
    },
    '../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../pipeline/llmHelpers': { extractJSON: () => ({ memories: fx.importItems }) },
    '../core/llm/llmClient': { chat: async () => ({ content: '{}' }) },
    '../core/llm/modelResolver': { resolveModelForTier: async () => 'm', getTierConfig: async () => ({}) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:memory-guards:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]memory\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./memory');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.created.length = 0;
    fx.updated.length = 0;
    fx.memories = {};
    fx.similar = null;
    fx.confirmed.length = 0;
    fx.importItems = [];
}

// A schema refusal travels as an error to the terminal handler, so the
// harness answers one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const query = Object.fromEntries(new URLSearchParams(qs));
        const req = { method, url, originalUrl: url, path: url, body, headers: {}, session, query, get() { return undefined; } };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            setHeader() { return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const BOB = { user: { id: 'bob' } };
const ANON = {};                       // a session with no user — what a visitor has

// ═══ Authentication ══════════════════════════════════════════════════

test('every memory route rejects an unauthenticated caller', async () => {
    const routes = [
        { method: 'GET', url: '/' },
        { method: 'GET', url: '/types' },
        { method: 'GET', url: '/stats' },
        { method: 'GET', url: '/m1' },
        { method: 'POST', url: '/', body: { content: 'x' } },
        { method: 'PUT', url: '/m1', body: { content: 'x' } },
        { method: 'POST', url: '/bulk-delete', body: { ids: ['m1'] } },
        { method: 'DELETE', url: '/m1' },
        { method: 'POST', url: '/clear' },
        { method: 'GET', url: '/export/all' },
        { method: 'POST', url: '/import', body: { text: 'hello' } },
    ];

    resetFx();
    for (const r of routes) {
        const res = await dispatch({ ...r, session: ANON });
        assert.strictEqual(res.statusCode, 401, `${r.method} ${r.url} must be 401`);
    }
    assert.deepStrictEqual(fx.created, [], 'nothing was written for an anonymous caller');
});

// ═══ Input validation ════════════════════════════════════════════════

test('POST / rejects a type outside the vocabulary', async () => {
    resetFx();
    for (const type of ['system', 'schedule_coverage', 'admin', '']) {
        const res = await dispatch({ method: 'POST', url: '/', body: { content: 'x', type }, session: BOB });
        assert.strictEqual(res.statusCode, 400, `type ${JSON.stringify(type)} must be rejected`);
    }
    assert.deepStrictEqual(fx.created, [], 'nothing created');
});

test('POST / still accepts every real type', async () => {
    resetFx();
    for (const type of ['instruction', 'person', 'project', 'preference', 'workflow', 'fact', 'context']) {
        const res = await dispatch({ method: 'POST', url: '/', body: { content: 'x', type }, session: BOB });
        assert.strictEqual(res.statusCode, 200, `type ${type} must be accepted`);
    }
    assert.strictEqual(fx.created.length, 7);
});

test('POST / caps content length', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/', body: { content: 'x'.repeat(2001) }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.created, []);
});

test('POST / clamps importance instead of trusting it', async () => {
    resetFx();
    // createMemory's 6th positional argument is `importance`.
    await dispatch({ method: 'POST', url: '/', body: { content: 'a', importance: 99 }, session: BOB });
    await dispatch({ method: 'POST', url: '/', body: { content: 'b', importance: -5 }, session: BOB });
    await dispatch({ method: 'POST', url: '/', body: { content: 'c' }, session: BOB });

    assert.strictEqual(fx.created[0][5], 1, '99 clamps to 1');
    assert.strictEqual(fx.created[1][5], 0, '-5 clamps to 0');
    assert.strictEqual(fx.created[2][5], 0.5, 'no importance is the default');
});

test('POST / refuses an importance that is not a number, instead of storing the default', async () => {
    // It used to fall back to 0.5 under a 200, so the caller never learned
    // that the value they sent had been thrown away.
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/', body: { content: 'c', importance: 'abc' }, session: BOB });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(fx.created, []);
});

test('PUT /:id applies the same validation as POST', async () => {
    // Fixing only the create path would leave the identical hole one verb away.
    resetFx();
    fx.memories.m1 = { id: 'm1', user_id: 'bob', project_id: null, content: 'old', type: 'fact', importance: 0.5 };

    const tooLong = await dispatch({
        method: 'PUT', url: '/m1', body: { content: 'x'.repeat(2001) }, session: BOB,
    });
    assert.strictEqual(tooLong.statusCode, 400);
    assert.deepStrictEqual(fx.updated, []);

    await dispatch({ method: 'PUT', url: '/m1', body: { content: 'new', importance: 42 }, session: BOB });
    assert.strictEqual(fx.updated[0].importance, 1, 'importance is clamped on update too');
});

// ═══ Import ══════════════════════════════════════════════════════════

test('import caps how many memories one paste can create', async () => {
    resetFx();
    fx.importItems = Array.from({ length: 250 }, (_, i) => ({ type: 'fact', content: `fact number ${i}` }));

    const res = await dispatch({ method: 'POST', url: '/import', body: { text: 'blob' }, session: BOB });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.created.length, 100, 'at most 100 inserts');
    assert.strictEqual(res.body.imported, 100);
    assert.strictEqual(res.body.skipped, 150, 'the remainder is reported, not silently dropped');
});

test('import de-dupes against memories that already exist', async () => {
    // Re-pasting the same export used to double the memory count: createMemory
    // was called without subject/attribute, so canonical dedupe never fired and
    // findSimilarMemory was never consulted on this path at all.
    resetFx();
    fx.importItems = [{ type: 'fact', content: 'I live in Utrecht' }];
    fx.similar = { id: 'existing-1' };

    const res = await dispatch({ method: 'POST', url: '/import', body: { text: 'blob' }, session: BOB });
    assert.deepStrictEqual(fx.created, [], 'no duplicate row');
    assert.deepStrictEqual(fx.confirmed, ['existing-1'], 'the existing memory is confirmed instead');
    assert.strictEqual(res.body.imported, 0);
    assert.strictEqual(res.body.skipped, 1);
});

test('import de-dupes within a single paste', async () => {
    resetFx();
    fx.importItems = [
        { type: 'fact', content: 'I live in Utrecht' },
        { type: 'fact', content: '  i live in   UTRECHT ' },
    ];

    await dispatch({ method: 'POST', url: '/import', body: { text: 'blob' }, session: BOB });
    assert.strictEqual(fx.created.length, 1, 'case and whitespace do not make it a new memory');
});

test('import coerces an unknown type rather than rejecting the whole paste', async () => {
    resetFx();
    fx.importItems = [{ type: 'nonsense', content: 'something true' }];

    await dispatch({ method: 'POST', url: '/import', body: { text: 'blob' }, session: BOB });
    assert.strictEqual(fx.created.length, 1);
    assert.strictEqual(fx.created[0][2], 'fact', 'unknown types land in fact');
});

test('import still enforces the byte limit, not a character limit', async () => {
    resetFx();
    // 25 001 two-byte characters is under any character limit and over the byte one.
    const text = 'é'.repeat(25_001);
    const res = await dispatch({ method: 'POST', url: '/import', body: { text }, session: BOB });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /byte limit/);
});

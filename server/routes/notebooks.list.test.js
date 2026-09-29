/**
 * Route tests for /api/notebooks (routes/notebooks.js) — Phase 2 surface:
 * the card-list projection (GET /), CAS updates (PUT /:id), the conversation
 * `locked` flag and the doc-only generate gate.
 *
 * Stores, auth and the AI/provider layer are mocked via the
 * Module._resolveFilename harness (same pattern as routes/studioApps.test.js)
 * so no DB/pool/LLM is touched. Requests go over real HTTP.
 *
 * Run: node --test routes/notebooks.list.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

const state = {
    notebooks: new Map(),   // id → notebook row (owner-scoped via userId)
    sources: new Map(),     // notebookId → [source]
    listCalls: [],          // captured listNotebookCards(userId, opts) args
    listResult: [],         // what listNotebookCards returns
    conversationMeta: { messages: [], locked: false },
};

function reset() {
    state.notebooks.clear();
    state.sources.clear();
    state.listCalls = [];
    state.listResult = [];
    state.conversationMeta = { messages: [], locked: false };
}

function seedNotebook(nb) {
    const full = {
        userId: 'u1', name: 'NB', description: '', instructions: '',
        knowledgeBaseIds: [], settings: {}, documentContent: '', documentMd: null,
        type: 'notebook', version: 1, sourceCount: 0,
        ...nb,
    };
    state.notebooks.set(full.id, full);
    return full;
}

// ── Mock notebookStore (mirrors the Phase-1 contract) ───────────────

const UPDATABLE = ['name', 'description', 'instructions', 'settings', 'knowledgeBaseIds', 'documentContent', 'pinned'];

const mockNotebookStore = {
    MAX_CARD_LIMIT: 200,
    async listNotebookCards(userId, opts = {}) {
        state.listCalls.push({ userId, opts: clone(opts) });
        return clone(state.listResult);
    },
    async getNotebook(id, userId) {
        const nb = state.notebooks.get(id);
        return nb && nb.userId === userId ? clone(nb) : null;
    },
    async updateNotebookCas(id, userId, updates = {}) {
        if (!UPDATABLE.some(k => updates[k] !== undefined)) return { ok: false, conflict: false, noop: true };
        const nb = state.notebooks.get(id);
        if (!nb || nb.userId !== userId) return { ok: false, conflict: false };
        if (typeof updates.expectedVersion === 'number' && updates.expectedVersion !== nb.version) {
            return { ok: false, conflict: true };
        }
        for (const k of UPDATABLE) if (updates[k] !== undefined && k !== 'pinned') nb[k] = updates[k];
        if (updates.documentContent !== undefined) nb.version += 1;
        return { ok: true, conflict: false, version: nb.version };
    },
    async getSources(notebookId) { return clone(state.sources.get(notebookId) || []); },
    async timeoutStuckSources() {},
    async shouldAutoVersion() { return false; },
    async createVersion() {},
    async touchActivity() {},
};

const mockConversationStore = {
    async getMessagesWithMeta() { return clone(state.conversationMeta); },
    async deleteForNotebook() {},
};

// ── Peripheral mocks (module-level requires of routes/notebooks.js) ─

const MOCKS = {
    '../stores/notebookStore': mockNotebookStore,
    '../stores/notebookConversationStore': mockConversationStore,
    '../stores/storageStore': { isAvailable: () => false },
    '../stores/transcriptionStore': { getTranscription: async () => null },
    '../stores/knowledgeBases': {},
    '../agents/notebooks/sourceIngestion': {
        ingestFileSource: async () => {}, ingestUrlSource: async () => {},
        ingestTextSource: async () => {}, ingestDriveSource: async () => {},
        MAX_STORED_TEXT: 1_000_000,
    },
    '../core/documents/documentParser': { parseDocument: async () => ({ text: '' }), isSupportedDocument: () => true },
    '../core/kb/kbIngestionHelpers': { deleteDocumentChunks: async () => {}, findDocumentBySourceUri: async () => null },
    '../auth': { requirePermission: () => (req, res, next) => next() },
    '../support/kbAccess': { partitionAccessibleKBIds: async (req, ids) => ({ allowed: ids || [], denied: [] }) },
    '../auth/permissions': {
        requireAuth: (req, res, next) => {
            if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
            next();
        },
    },
    '../core/kb/notebookCascade': { cleanupSourceArtifacts: async () => {}, deleteNotebookCascade: async () => ({ deleted: true, sources: 0, kbs: 0 }) },
    '../core/dlp/dlpRunner': { getConversationTokenMapAsync: async () => null, clearConversationState: () => {} },
    // Lazily required inside /generate — mocked so the doc-only test streams
    // to completion without a KB, model tiers or a provider.
    '../core/kb/notebookKnowledgeSearch': { gatherNotebookContent: async () => ({ content: 'Document body content' }) },
    '../core/llm/modelResolver': {
        TIER_DEFAULTS: { fast: { maxTokens: 512 }, balanced: { maxTokens: 512 } },
        resolveModelForTier: async () => 'test-model',
        getEUAwareTiers: async () => ({}),
        resolveEffectiveOrgId: async () => null,
    },
    '../core/aiAgent': {
        getAIConfig: async () => ({ model: 'test-model' }),
        getProviderForModel: async () => ({ apiKey: 'k', url: 'http://test.local', providerType: 'mock' }),
    },
    '../core/providers': {
        getAdapter: () => ({
            stream: async (_key, _url, _model, _messages, _opts, cb) => { cb('text', { text: 'GENERATED-OK' }); },
        }),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./notebooks');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/api/notebooks', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/notebooks`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, { user = 'u1', body } = {}) {
    const headers = { 'x-test-user': user };
    let payload;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* SSE / non-JSON body */ }
    return { status: res.status, json, text };
}

// ── GET / — card listing ────────────────────────────────────────────

test('GET / always passes type "notebook" to the store — and a query asking otherwise is refused', async () => {
    reset();
    // The list query is closed (validate()): `type` is not something it takes.
    const refused = await api('GET', '/?type=archive');
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(state.listCalls.length, 0);

    const r = await api('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(state.listCalls.length, 1);
    assert.strictEqual(state.listCalls[0].userId, 'u1');
    assert.strictEqual(state.listCalls[0].opts.type, 'notebook');
    // Envelope shape unchanged.
    assert.deepStrictEqual(r.json, { notebooks: [], limit: 200, offset: 0, hasMore: false });
});

test('GET / forwards trimmed search + whitelisted sort/filter', async () => {
    reset();
    await api('GET', `/?search=${encodeURIComponent('  foo  ')}&sort=name&filter=pinned&limit=60&offset=60`);
    const { opts } = state.listCalls[0];
    assert.strictEqual(opts.search, 'foo');
    assert.strictEqual(opts.sort, 'name');
    assert.strictEqual(opts.filter, 'pinned');
    assert.strictEqual(opts.limit, 60);
    assert.strictEqual(opts.offset, 60);
});

test('GET /?limit=500 clamps to the store cap (200) so hasMore stays honest', async () => {
    reset();
    // A full page at the clamped limit: before the shared clamp, the route
    // passed 500 while the store silently returned 200 → hasMore:false lie.
    state.listResult = Array.from({ length: 200 }, (_, i) => ({ id: `nb${i}` }));
    const r = await api('GET', '/?limit=500');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(state.listCalls[0].opts.limit, 200, 'store must receive the clamped limit');
    assert.strictEqual(r.json.limit, 200);
    assert.strictEqual(r.json.notebooks.length, 200);
    assert.strictEqual(r.json.hasMore, true, 'a full 200-row page signals more');
});

test('GET / caps search at 200 chars, defaults sort/filter, and refuses unknown ones', async () => {
    reset();
    // An unknown filter used to fall back to 'all' — every notebook, under a 200.
    const refused = await api('GET', `/?sort=;DROP TABLE&filter=evil`);
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(state.listCalls.length, 0);

    await api('GET', `/?search=${'x'.repeat(300)}`);
    const { opts } = state.listCalls[0];
    assert.strictEqual(opts.search.length, 200);
    assert.strictEqual(opts.sort, 'activity');
    assert.strictEqual(opts.filter, 'all');
    assert.strictEqual(opts.type, 'notebook');
});

// ── PUT /:id — CAS semantics ────────────────────────────────────────

test('PUT with stale expectedVersion → 409 version_conflict', async () => {
    reset();
    seedNotebook({ id: 'nb1', version: 5, documentContent: '<p>old</p>' });
    const r = await api('PUT', '/nb1', { body: { documentContent: '<p>new</p>', expectedVersion: 4 } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'version_conflict');
    assert.strictEqual(r.json.error, 'Document was updated elsewhere');
    // The stale write must not have landed.
    assert.strictEqual(state.notebooks.get('nb1').documentContent, '<p>old</p>');
});

test('PUT with matching expectedVersion → 200 with the bumped version', async () => {
    reset();
    seedNotebook({ id: 'nb1', version: 5, documentContent: '<p>old</p>' });
    const r = await api('PUT', '/nb1', { body: { documentContent: '<p>new</p>', expectedVersion: 5 } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { success: true, version: 6 });
});

test('PUT {} → 400 No fields to update', async () => {
    reset();
    seedNotebook({ id: 'nb1' });
    const r = await api('PUT', '/nb1', { body: {} });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'No fields to update');
});

test('PUT pinned-only is a valid update; missing notebook still 404s', async () => {
    reset();
    seedNotebook({ id: 'nb1', version: 3 });
    const pin = await api('PUT', '/nb1', { body: { pinned: true } });
    assert.strictEqual(pin.status, 200);
    assert.strictEqual(pin.json.success, true);
    const gone = await api('PUT', '/nope', { body: { name: 'x' } });
    assert.strictEqual(gone.status, 404);
});

// ── GET /:id/conversation — locked flag ─────────────────────────────

test('GET /:id/conversation surfaces locked alongside messages', async () => {
    reset();
    seedNotebook({ id: 'nb1' });
    state.conversationMeta = { messages: [], locked: true };
    const r = await api('GET', '/nb1/conversation');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { messages: [], locked: true });
});

// ── POST /:id/generate/:type — doc-only gate ────────────────────────

test('generate with 0 sources and an empty doc → 400', async () => {
    reset();
    seedNotebook({ id: 'nb1', documentContent: '   ', documentMd: null });
    const r = await api('POST', '/nb1/generate/summary', { body: {} });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'Add a source or write something in the document first');
});

test('generate with 0 sources but a non-empty doc does NOT 400 — it streams', async () => {
    reset();
    seedNotebook({ id: 'nb1', documentContent: '<p>A real document body</p>' });
    const r = await api('POST', '/nb1/generate/summary', { body: {} });
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('GENERATED-OK'), `expected streamed content, got: ${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes('event: done'));
});

/**
 * The projection invariant (K1): no LIST read of a knowledge base carries a
 * document body, and the counters that used to be derived from the returned
 * page are counted in SQL instead.
 *
 * Before this, `GET /api/kb/:id` answered with `SELECT *` rows — every
 * document's `original_content` inline — and derived "38 documents · 120
 * chunks" by summing that page, which was capped at 200 rows and counted
 * failed and duplicate rows as content. The body now has exactly one way out:
 * `GET /:id/documents/:docId/content`, asked for by id.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases.projection.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    documents: [],
    countCalls: 0,
    originalContent: 'the full body of the document',
    localChunks: '',
};

const mw = (req, res, next) => next();
const multerMock = () => ({ single: () => mw, any: () => mw, array: () => mw });
multerMock.memoryStorage = () => ({});

// A projected row: DOCUMENT_COLUMNS, which is every column EXCEPT original_content.
function doc(over = {}) {
    return {
        id: 'd1', knowledge_base_id: 'kb1', title: 'Handbook.pdf', source_type: 'upload',
        source_uri: 'Handbook.pdf', chunk_count: 4, status: 'processed', page_count: 2,
        ...over,
    };
}

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => (id === 'kb1'
            ? { id: 'kb1', tenant_id: 't1', name: 'kb', last_content_at: '2026-09-01T10:00:00.000Z' }
            : null),
        isSystemKB: () => false,
        canUserManageKB: () => true,
        listDocuments: async () => fx.documents,
        countDocuments: async () => fx.documents.length,
        getDocument: async (id) => fx.documents.find(d => d.id === id) || null,
        getDocumentOriginalContent: async () => fx.originalContent,
        countDocumentsByStatus: async () => {
            fx.countCalls++;
            // Deliberately different from the returned page: 500 rows exist,
            // 480 are active, and the page only ever shows 200 of them.
            return { documentCount: 480, documentCountAll: 500, totalChunks: 9100 };
        },
        bumpKBVersion: async () => ({}),
    },
    '../stores/kbSources': { countsByKb: async () => ({ kb1: { sourceCount: 3, autoRefreshCount: 1, lastRefreshAt: null } }) },
    '../stores/configStore': { getConfig: async () => null, getSecret: async () => null },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', name: 'Tom' }) },
    '../auth': {
        requireAuth: mw, requirePermission: () => mw, requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => new Set(['org1']), hasPermission: async () => true,
        validateSharedGroupsForOrg: async () => {}, resolveUserGroups: async () => [],
    },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../core/serviceAuth': { getServiceHeaders: () => ({}) },
    '../support/kbAccess': { canAccessKB: async () => true, resolveIsOrgAdmin: async () => true },
    '../license': { resolveTier: async () => 'community', tiers: { getLimitsForTier: () => ({ max_kb_sources: -1 }) } },
    '../core/kb/localKBIngest': { getDocumentContent: async () => fx.localChunks },
    '../core/kb/kbIngestionHelpers': {
        getAzureIngestParams: async () => ({}),
        assertUrlIsPublic: async (u) => new URL(u),
        deleteDocumentChunks: async () => {},
        purgeDocumentChunks: async () => {},
        ingestDocument: async () => ({ document: {}, chunks: 0, status: 'processed' }),
        reingestDocument: async () => ({ document: {}, chunks: 0, status: 'processed' }),
        extractFileContent: async () => '',
        extractFileContentWithMeta: async () => ({ text: '', meta: {} }),
        fetchUrlContent: async () => ({ content: '', title: '', resolvedUrl: '' }),
        friendlyError: (e) => String(e && e.message),
    },
    '../utils/ssrfGuard': { safeFetch: async () => ({ ok: false, status: 404, headers: { get: () => '' }, text: async () => '' }) },
    'multer': multerMock,
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-projection:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)$/.test(parent.filename)
        && !/\.test\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./knowledgeBases');

test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method, url, body = {} }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1' } },
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

test('GET /:id keeps documents + the legacy counter names, and counts them in SQL', async () => {
    fx.documents = [doc({ id: 'd1' }), doc({ id: 'd2', chunk_count: 6 })];
    fx.countCalls = 0;

    const res = await dispatch({ method: 'GET', url: '/kb1' });
    assert.strictEqual(res.statusCode, 200);

    // Mobile and the pickers read these three; they must not be renamed.
    assert.ok(Array.isArray(res.body.documents));
    assert.strictEqual(res.body.document_count, 480);
    assert.strictEqual(res.body.total_chunks, 9100);
    assert.strictEqual(fx.countCalls, 1, 'the counters come from the store, not from summing the page');
    // Not 2 and not 10 — i.e. NOT derived from the returned page.
    assert.notStrictEqual(res.body.document_count, res.body.documents.length);

    // The K1 additions are camelCase and additive.
    assert.strictEqual(res.body.documentCountAll, 500);
    assert.strictEqual(res.body.sourceCount, 3);
    assert.strictEqual(res.body.lastContentAt, '2026-09-01T10:00:00.000Z');
});

test('no list read carries a document body', async () => {
    fx.documents = [doc({ id: 'd1' })];
    for (const url of ['/kb1', '/kb1/documents']) {
        const res = await dispatch({ method: 'GET', url });
        assert.ok(!JSON.stringify(res.body).includes('original_content'), `${url} must not leak the body`);
    }
});

test('GET /:id/documents/:docId/content is the one way to the body', async () => {
    fx.documents = [doc({ id: 'd1' })];
    fx.originalContent = 'the full body of the document';

    const res = await dispatch({ method: 'GET', url: '/kb1/documents/d1/content' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.content, 'the full body of the document');
    assert.strictEqual(res.body.remote_only, false);
    assert.strictEqual(res.body.document.id, 'd1');
});

test('a document whose chunks live in the search-service says so instead of looking empty', async () => {
    fx.documents = [doc({ id: 'd1', chunk_count: 9 })];
    fx.originalContent = null;
    fx.localChunks = '';

    const res = await dispatch({ method: 'GET', url: '/kb1/documents/d1/content' });
    assert.strictEqual(res.body.content, '');
    assert.strictEqual(res.body.remote_only, true);
});

test('content of a document in another KB is a 404', async () => {
    fx.documents = [doc({ id: 'd1', knowledge_base_id: 'other' })];
    const res = await dispatch({ method: 'GET', url: '/kb1/documents/d1/content' });
    assert.strictEqual(res.statusCode, 404);
});

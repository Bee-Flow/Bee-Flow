/**
 * The wrapper layer: every legacy ingest route now creates or finds a
 * kb_sources row and hangs its document off it.
 *
 * This is the piece of K1 that can silently drift — mobile, the upload wizard
 * and the n8n import all still call these routes, so two things are pinned
 * here at once:
 *
 *   1. the RESPONSE SHAPES are byte-for-byte what they were (a renamed field
 *      breaks a client that ships on its own schedule), and
 *   2. every ingested document carries the sourceId of the right kind of
 *      source, keyed the same way migrations/kb-sources-backfill.js keys it.
 *
 * Plus the property that keeps this safe: the source is BOOKKEEPING. When the
 * source store is unavailable the ingest still happens, with sourceId null.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases.wrappers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    sources: [],
    ingested: [],
    sourceStoreFails: false,
    pages: {},
};

function resetFx() {
    fx.sources = [];
    fx.ingested.length = 0;
    fx.sourceStoreFails = false;
    fx.pages = {};
}

const mw = (req, res, next) => next();

const multerMock = () => ({ single: () => mw, any: () => mw, array: () => mw });
multerMock.memoryStorage = () => ({});

let nextSourceId = 1;

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => ({ id, tenant_id: 't1', name: 'kb', organization_id: 'org1' }),
        isSystemKB: () => false,
        canUserManageKB: () => true,
        hashContent: (c) => `h${String(c).length}`,
        hasContentHash: async () => null,
        bumpKBVersion: async () => ({}),
        listDocuments: async () => [],
        countDocuments: async () => 0,
    },
    '../stores/kbSources': {
        SOURCE_KINDS: ['upload', 'text', 'webpage', 'nextcloud_folder', 'datatable', 'meeting_tag', 'automation', 'legacy'],
        findOne: async (kbId, kind, { configMatch = null } = {}) => {
            if (fx.sourceStoreFails) throw new Error('relation "kb_sources" does not exist');
            return fx.sources.find(s => s.knowledgeBaseId === kbId && s.kind === kind
                && (!configMatch || Object.entries(configMatch).every(([k, v]) => JSON.stringify(s.config[k]) === JSON.stringify(v)))) || null;
        },
        create: async ({ knowledgeBaseId, kind, name, config, createdBy }) => {
            if (fx.sourceStoreFails) throw new Error('relation "kb_sources" does not exist');
            const row = { id: `s${nextSourceId++}`, knowledgeBaseId, kind, name, config: config || {}, createdBy: createdBy || null };
            fx.sources.push(row);
            return row;
        },
        countsByKb: async () => ({}),
    },
    '../stores/configStore': {
        getConfig: async (key) => {
            if (key.startsWith('n8n_url_org_')) return 'https://n8n.example';
            if (key.startsWith('n8n_workflows_org_')) return [{ id: 'wf7', allowKbIngestion: true, name: 'Tickets' }];
            return null;
        },
        getSecret: async () => 'n8n-key',
    },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', organizationId: 'org1', name: 'Tom' }) },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => new Set(['org1']),
        hasPermission: async () => true,
        validateSharedGroupsForOrg: async () => {},
        resolveUserGroups: async () => [],
    },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../core/serviceAuth': { getServiceHeaders: () => ({}) },
    '../support/kbAccess': { canAccessKB: async () => true, resolveIsOrgAdmin: async () => true },
    '../license': { resolveTier: async () => 'community', tiers: { getLimitsForTier: () => ({ max_kb_sources: -1 }) } },
    '../core/kb/kbIngestionHelpers': {
        getAzureIngestParams: async () => ({}),
        assertUrlIsPublic: async (u) => new URL(u),
        extractFileContent: async () => 'extracted text',
        extractFileContentWithMeta: async () => ({ text: 'extracted text long enough', meta: { pageCount: 7, sheetNames: ['Sheet1', 'Sheet2'] } }),
        fetchUrlContent: async (u) => ({ content: `# Page\n\nbody of ${u}`, title: 'Page title', resolvedUrl: `${u}?utm=1` }),
        ingestDocument: async (tenantId, kbId, content, title, sourceType, sourceUri, opts = {}) => {
            fx.ingested.push({ title, sourceType, sourceUri, opts });
            return { document: { id: `d${fx.ingested.length}`, title }, chunks: 3, status: 'processed' };
        },
        deleteDocumentChunks: async () => {},
        purgeDocumentChunks: async () => {},
        reingestDocument: async () => ({ document: {}, chunks: 0, status: 'processed' }),
        friendlyError: (e) => (e && e.message) || String(e),
    },
    '../utils/ssrfGuard': {
        safeFetch: async (u) => respondFor(u),
    },
    '../integrations/n8nTools': {
        fetchWorkflowById: async () => ({ name: 'Tickets', nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path: 'hook', httpMethod: 'GET' } }] }),
        triggerWebhookWorkflow: async () => JSON.stringify([{ title: 'Article one', markdown: '# One\n\nbody' }]),
    },
    '../core/n8nWorkflowConverter': { convertN8nWorkflowToMarkdown: () => '# Workflow\n\nnodes and things' },
    'multer': multerMock,
};

function respondFor(u) {
    const page = fx.pages[u];
    if (!page) return { ok: false, status: 404, url: u, headers: { get: () => '' }, text: async () => '' };
    return {
        ok: true, status: 200, url: u,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? page.contentType : '') },
        text: async () => page.body,
    };
}

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-wrappers:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
// guardedFetch lives in core/kb/fetchGuard.js, where these same two
// dependencies are written './kbIngestionHelpers' and '../../utils/ssrfGuard'.
// The stubs follow it there, or the wrappers reach the real network.
MOCK_IDS['./kbIngestionHelpers'] = MOCK_IDS['../core/kb/kbIngestionHelpers'];
// core/kb/sources/ensureSource.js writes the store path one level deeper than
// the routes do; same double.
MOCK_IDS['../../../stores/kbSources'] = MOCK_IDS['../stores/kbSources'];

// The modules whose requires get the doubles. `core/kb/` entries are pieces
// that USED to live under routes/knowledgeBases and were moved out — the
// routes still call them, so the stubs still have to reach them.
const STUBBED_PARENT = /(routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)|core[\\/]kb[\\/](fetchGuard|sources[\\/]ensureSource)\.js)$/;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && STUBBED_PARENT.test(parent.filename)
        && !/\.test\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./knowledgeBases');

const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('global fetch called — SSRF guard bypassed'); };

test.after(() => {
    Module._resolveFilename = originalResolve;
    globalThis.fetch = realFetch;
});

function dispatch({ method, url, body = {}, file = null, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {}, session,
            ...(file ? { file } : {}),
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

// ═══ ingest/text ════════════════════════════════════════════════════

test('POST /:id/ingest/text keeps its 201 { success, document, chunks } and attaches a text source', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: 'We open at nine.', title: 'Opening hours' } });

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['chunks', 'document', 'success']);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.chunks, 3);

    assert.strictEqual(fx.sources.length, 1);
    assert.strictEqual(fx.sources[0].kind, 'text');
    assert.strictEqual(fx.sources[0].name, 'Opening hours');
    assert.strictEqual(fx.ingested[0].opts.sourceId, fx.sources[0].id);
});

test('re-posting the same snippet title reuses its source instead of stacking a new one', async () => {
    resetFx();
    await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: 'version one', title: 'Opening hours' } });
    await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: 'version two', title: 'Opening hours' } });
    assert.strictEqual(fx.sources.length, 1);
    assert.strictEqual(fx.ingested[0].opts.sourceId, fx.ingested[1].opts.sourceId);
});

// ═══ ingest/file ════════════════════════════════════════════════════

test('POST /:id/ingest/file keeps its shape and puts every upload on ONE upload source', async () => {
    resetFx();
    const file = { originalname: 'Handbook.pdf', mimetype: 'application/pdf', size: 4096, buffer: Buffer.from('pdf') };
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/file', file });

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['chunks', 'document', 'success']);

    assert.strictEqual(fx.sources.length, 1);
    assert.strictEqual(fx.sources[0].kind, 'upload');
    assert.strictEqual(fx.sources[0].name, 'Uploaded files');

    const opts = fx.ingested[0].opts;
    assert.strictEqual(opts.sourceId, fx.sources[0].id);
    assert.strictEqual(opts.externalId, 'Handbook.pdf');
    assert.strictEqual(opts.sizeBytes, 4096);
    assert.strictEqual(opts.mime, 'application/pdf');
    // …WithMeta, so what the extractor learned is stored instead of thrown away.
    assert.strictEqual(opts.pageCount, 7);
    assert.strictEqual(opts.sheetCount, 2);

    await dispatch({ method: 'POST', url: '/kb1/ingest/file', file: { ...file, originalname: 'Prices.xlsx' } });
    assert.strictEqual(fx.sources.length, 1, 'the second file joins the same bucket');
});

// ═══ ingest/url ═════════════════════════════════════════════════════

test('POST /:id/ingest/url keeps { success, document, chunks, source } and keys the source on the resolved URL', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/url', body: { url: 'https://example.com/docs' } });

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['chunks', 'document', 'source', 'success']);
    assert.strictEqual(res.body.source, 'https://example.com/docs?utm=1');

    assert.strictEqual(fx.sources[0].kind, 'webpage');
    assert.deepStrictEqual(fx.sources[0].config, { url: 'https://example.com/docs?utm=1' });
    assert.strictEqual(fx.ingested[0].opts.externalId, 'https://example.com/docs?utm=1');
});

// ═══ sitemap ════════════════════════════════════════════════════════

test('the sitemap walk keeps its response shape and bundles every page on ONE origin source', async () => {
    resetFx();
    fx.pages['https://example.com/sitemap.xml'] = {
        contentType: 'application/xml',
        body: `<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`,
    };
    const html = (t) => ({ contentType: 'text/html; charset=utf-8', body: `<html><head><title>${t}</title></head><body><p>a body long enough to be ingested by the walker</p></body></html>` });
    fx.pages['https://example.com/a'] = html('A');
    fx.pages['https://example.com/b'] = html('B');

    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/sitemap', body: { url: 'https://example.com/', maxPages: 10 } });

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(
        Object.keys(res.body).sort(),
        ['details', 'errors', 'ingested', 'maxPages', 'maxPagesCapped', 'skipped', 'success', 'totalPages'],
    );
    assert.strictEqual(res.body.ingested, 2);

    assert.strictEqual(fx.sources.length, 1);
    assert.strictEqual(fx.sources[0].kind, 'webpage');
    assert.deepStrictEqual(fx.sources[0].config, { url: 'https://example.com', crawl: { maxPages: 10 } });
    assert.ok(fx.ingested.every(i => i.opts.sourceId === fx.sources[0].id), 'both pages share the walk source');
    assert.deepStrictEqual(fx.ingested.map(i => i.opts.externalId), ['https://example.com/a', 'https://example.com/b']);
});

// ═══ n8n ════════════════════════════════════════════════════════════

test('the n8n import keeps its shape and lands on a legacy source, the same one the backfill makes', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/ingest/n8n', body: { workflowId: 'wf7', mode: 'definition' } });

    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['chunks', 'document', 'success', 'workflowName']);
    assert.strictEqual(res.body.workflowName, 'Tickets');

    assert.strictEqual(fx.sources.length, 1);
    assert.strictEqual(fx.sources[0].kind, 'legacy');
    assert.deepStrictEqual(fx.sources[0].config, { sourceType: 'n8n' });
    assert.strictEqual(fx.ingested[0].opts.sourceId, fx.sources[0].id);
});

// ═══ the safety property ════════════════════════════════════════════

test('when the source store is unavailable the ingest still succeeds, with sourceId null', async () => {
    resetFx();
    fx.sourceStoreFails = true;

    const text = await dispatch({ method: 'POST', url: '/kb1/ingest/text', body: { content: 'still fine', title: 'T' } });
    assert.strictEqual(text.statusCode, 201, 'bookkeeping must never fail the ingest');
    assert.strictEqual(fx.ingested[0].opts.sourceId, null);

    const file = await dispatch({ method: 'POST', url: '/kb1/ingest/file', file: { originalname: 'x.pdf', mimetype: 'application/pdf', size: 1, buffer: Buffer.from('x') } });
    assert.strictEqual(file.statusCode, 201);
    assert.strictEqual(fx.ingested[1].opts.sourceId, null);
});

/**
 * The KB source API (K1): who may touch it, what it hands back, and the two
 * things it must never do — leak a document body into a list, or let a client
 * create a kind the product cannot yet refresh.
 *
 * Same harness as routes/knowledgeBases.ssrf.test.js: the sub-routers' own
 * dependencies are replaced with recording doubles through
 * Module._resolveFilename, and the request goes through the REAL facade
 * (routes/knowledgeBases.js), so the mount order is under test too.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/sources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('node:path');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    kb: null,
    sources: [],
    documents: [],
    counts: {},
    canAccess: true,
    canManage: true,
    isSystem: false,
    maxSources: -1,
    // recordings
    ingested: [],
    reingested: [],
    created: [],
    updated: [],
    removed: [],
    refreshed: [],
    statusUpdates: [],
    chunkDeletes: [],
    // Document-ids waarvoor de chunk-opruiming gooit — het pad dat de route
    // moet laten kiezen tussen "bron weghalen" en "bron laten staan".
    chunkDeleteFails: new Set(),
    listCalls: [],
    extracted: [],
    // Hostnames the stubbed SSRF guard refuses. shared.js destructures
    // assertUrlIsPublic at require time, so the switch has to live in the stub
    // itself — swapping the export later would change nothing.
    blockedHosts: new Set(),
    // meeting_tag (K7)
    taggedMeetings: [],
    tagProbes: [],
    tagProbeFails: false,
    // filed transcript lines (M4) — which meetings THIS caller may open
    visibleTranscriptions: [],
    transcriptProbes: [],
    transcriptProbeFails: false,
    // De gebruikers waarmee askerContext de SCOPE van de schrijver opbouwt.
    // `u1` is de aanroeper van vrijwel elke test hier.
    users: {},
    allGroups: [],
    // Capabilities the caller's plan lacks. Empty: everything is licensed.
    locked: new Set(),
    // datatable (K8): the tables the stubbed resolver will hand back.
    datatables: {},
};

const KB = { id: 'kb1', tenant_id: 'owner1', name: 'Handbook', organization_id: 'org1', last_content_at: '2026-09-01T10:00:00.000Z' };

function resetFx() {
    fx.kb = { ...KB };
    fx.sources = [];
    fx.documents = [];
    fx.counts = {};
    fx.canAccess = true;
    fx.canManage = true;
    fx.isSystem = false;
    fx.maxSources = -1;
    fx.blockedHosts = new Set();
    fx.taggedMeetings = [];
    fx.tagProbeFails = false;
    fx.visibleTranscriptions = [];
    fx.transcriptProbeFails = false;
    fx.users = {
        u1: { id: 'u1', name: 'Tom', email: 'x@y.z', organizationId: 'org1', groups: ['g-sales'] },
        u2: { id: 'u2', name: null, email: 'x@y.z', organizationId: 'org2', groups: [] },
    };
    fx.allGroups = [{ id: 'g-sales', organizationId: 'org-via-groep' }];
    fx.locked = new Set();
    fx.datatables = {};
    for (const k of ['ingested', 'reingested', 'created', 'updated', 'removed', 'refreshed', 'statusUpdates', 'chunkDeletes', 'listCalls', 'extracted', 'tagProbes', 'transcriptProbes']) fx[k].length = 0;
    fx.chunkDeleteFails.clear();
}

const mw = (req, res, next) => next();

// A projected documents row — DOCUMENT_COLUMNS, so never original_content.
function doc(over = {}) {
    return {
        id: 'd1', tenant_id: 'owner1', knowledge_base_id: 'kb1', title: 'Handbook.pdf',
        source_type: 'upload', source_uri: 'Handbook.pdf', lang: 'auto', content_hash: 'h1',
        chunk_count: 4, created_at: '2026-09-01T09:00:00.000Z', metadata: {}, duplicate_of: null,
        simhash: null, source_id: 's1', status: 'processed', status_reason: null,
        updated_at: null, source_modified_at: null, external_id: 'Handbook.pdf', size_bytes: 10,
        page_count: 2, sheet_count: null, mime: 'application/pdf', extract_summary: null,
        pii_status: 'unscanned', pii_categories: null, overlaps_document_id: null, created_by: 'u1',
        ...over,
    };
}

function source(over = {}) {
    return {
        id: 's1', knowledgeBaseId: 'kb1', kind: 'upload', name: 'Uploaded files', config: {},
        refreshMode: 'manual', refreshCron: null, refreshTz: null, nextRefreshAt: null,
        lastRefreshStartedAt: null, lastRefreshAt: null, lastRefreshError: null,
        consecutiveErrors: 0, status: 'idle', createdBy: 'u1',
        createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z',
        ...over,
    };
}

let nextId = 100;

const multerMock = () => ({
    any: () => mw,
    single: () => mw,
    array: () => mw,
});
multerMock.memoryStorage = () => ({});

const MOCKS = {
    '../stores/knowledgeBases': {
        DOCUMENT_COLUMNS: ['id', 'title', 'status'],
        DOC_STATUSES: ['processed', 'redacted', 'skipped', 'error', 'duplicate'],
        PII_STATUSES: ['none', 'found', 'redacted', 'unscanned'],
        getKB: async (id) => (fx.kb && fx.kb.id === id ? fx.kb : null),
        isSystemKB: () => fx.isSystem,
        canUserManageKB: () => fx.canManage,
        hashContent: (c) => `hash:${String(c).length}`,
        hasContentHash: async () => null,
        findDocumentByContentHash: async (_kb, hash) => fx.documents.find(d => d.content_hash === hash) || null,
        bumpKBVersion: async () => ({}),
        countsBySource: async (ids) => {
            const out = {};
            for (const id of ids) if (fx.counts[id]) out[id] = fx.counts[id];
            return out;
        },
        countDocumentsByStatus: async () => ({ documentCount: 1, documentCountAll: 2, totalChunks: 4 }),
        listDocuments: async (kbId, opts = {}) => {
            fx.listCalls.push({ kbId, ...opts });
            const f = opts.filters || {};
            const hit = fx.documents.filter(d => (!f.sourceId || d.source_id === f.sourceId));
            // `limit` WORDT gehonoreerd. Deed hij dat niet, dan zag een route
            // zonder rondenlus er in dit harnas net zo goed uit als een route
            // mét — en juist het 201e document is waar dit pad over gaat.
            return Number(opts.limit) > 0 ? hit.slice(0, Number(opts.limit)) : hit;
        },
        countDocuments: async (kbId, filters = {}) => fx.documents.filter(d => (!filters.sourceId || d.source_id === filters.sourceId)).length,
        getDocument: async (id) => fx.documents.find(d => d.id === id) || null,
        getDocumentOriginalContent: async () => 'the full body',
        createDocument: async (tenantId, kbId, title, sourceType, sourceUri, hash, chunks, metadata, simhash, extra = {}) => {
            const row = doc({ id: `d${nextId++}`, title, source_type: sourceType, source_uri: sourceUri, ...extra, source_id: extra.sourceId, status: extra.status || 'processed', status_reason: extra.statusReason || null });
            fx.documents.push(row);
            fx.created.push({ title, sourceType, extra });
            return row;
        },
        updateDocumentStatus: async (docId, patch) => {
            fx.statusUpdates.push({ docId, ...patch });
            const row = fx.documents.find(d => d.id === docId);
            if (row) Object.assign(row, { status: patch.status, status_reason: patch.statusReason || null });
            return row;
        },
        snapshotDocumentVersion: async () => {},
    },
    '../stores/kbSources': {
        SOURCE_KINDS: ['upload', 'text', 'webpage', 'nextcloud_folder', 'datatable', 'meeting_tag', 'automation', 'legacy'],
        REFRESH_MODES: ['manual', 'schedule', 'on_change', 'after_meeting', 'live'],
        get: async (id) => fx.sources.find(s => s.id === id) || null,
        listByKb: async (kbId) => fx.sources.filter(s => s.knowledgeBaseId === kbId),
        findOne: async (kbId, kind) => fx.sources.find(s => s.knowledgeBaseId === kbId && s.kind === kind) || null,
        create: async (p) => {
            const row = source({ id: `s${nextId++}`, knowledgeBaseId: p.knowledgeBaseId, kind: p.kind, name: p.name, config: p.config || {}, refreshMode: p.refreshMode || 'manual', createdBy: p.createdBy || null });
            fx.sources.push(row);
            fx.created.push({ source: row });
            return row;
        },
        update: async (id, patch) => {
            fx.updated.push({ id, patch });
            const row = fx.sources.find(s => s.id === id);
            if (row) Object.assign(row, patch);
            return row;
        },
        remove: async (id) => { fx.removed.push(id); fx.sources = fx.sources.filter(s => s.id !== id); return true; },
        requestRefresh: async (id) => {
            fx.refreshed.push(id);
            const row = fx.sources.find(s => s.id === id);
            if (row) row.nextRefreshAt = '2026-09-04T12:00:00.000Z';
            return row;
        },
        countsByKb: async () => ({}),
    },
    '../stores/configStore': { getConfig: async () => null, getSecret: async () => null },
    '../stores/transcriptionStore': {
        listByTag: async (tag, reader, opts) => {
            fx.tagProbes.push({ tag, reader, opts });
            if (fx.tagProbeFails) throw new Error('transcriptions is down');
            return (fx.taggedMeetings || []).filter(m => (m.tags || []).includes(tag));
        },
        canReadTranscription: async (id, reader, ctx) => {
            fx.transcriptProbes.push({ id, reader, ctx });
            if (fx.transcriptProbeFails) throw new Error('transcriptions is down');
            return (fx.visibleTranscriptions || []).includes(id);
        },
    },
    '../stores/userStore': {
        // Met de velden waar askerContext echt op leunt: de directe org én de
        // groepen waaruit nog meer orgs volgen. Een mock zonder die velden
        // laat de poort met een LEGE org-set probben, en dan bewijst geen
        // enkele assertie op `reader`/`id` nog iets over de scope.
        getUser: async (id) => (fx.users[id] ? { ...fx.users[id] } : null),
        getAllGroups: async () => fx.allGroups,
    },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => new Set(['org1']),
        hasPermission: async () => true,
        validateSharedGroupsForOrg: async () => {},
        resolveUserGroups: async (id) => (fx.users[id]?.groups || []),
    },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    // The licence gate answers the way the real one does when the plan lacks
    // the capability: 403 `feature_locked`, naming it.
    '../core/entitlements/entitlements': {
        requireCapability: (id) => (req, res, next) => (fx.locked.has(id)
            ? res.status(403).json({ error: 'feature_locked', feature: id, required: 'enterprise' })
            : next()),
    },
    '../core/automationRunner/datatableResolve': {
        resolveDatatableForStep: async (id) => {
            const table = fx.datatables[id];
            if (!table) throw new Error('not available');
            return { table, tableMeta: { fields: table.fields }, scope: { kind: 'org', id: 'org1' } };
        },
    },
    '../core/kb/sources/datatable': {
        pickColumns: (cfg, meta) => (cfg.columns && cfg.columns.length ? cfg.columns : meta.fields.map(f => f.key)),
        reconcileUsage: async () => {},
    },
    '../core/serviceAuth': { getServiceHeaders: () => ({}) },
    '../support/kbAccess': {
        canAccessKB: async () => fx.canAccess,
        resolveIsOrgAdmin: async () => true,
    },
    '../license': {
        resolveTier: async () => 'community',
        tiers: { getLimitsForTier: () => ({ max_kb_sources: fx.maxSources }) },
    },
    '../core/kb/kbIngestionHelpers': {
        getAzureIngestParams: async () => ({}),
        assertUrlIsPublic: async (u) => {
            const parsed = new URL(u);
            if (fx.blockedHosts.has(parsed.hostname)) {
                throw new Error(`URL ${parsed.hostname} resolves to a private/loopback address (${parsed.hostname})`);
            }
            return parsed;
        },
        extractFileContent: async () => 'text',
        extractFileContentWithMeta: async (buf, mime, name) => {
            fx.extracted.push(name);
            if (name === 'broken.pdf') throw new Error('Could not extract text from PDF');
            return { text: `content of ${name}`, meta: { pageCount: 3, sheetNames: null } };
        },
        fetchUrlContent: async (u) => ({ content: `# Page\n\nplaywright fallback body for ${u}`, title: 'Page', resolvedUrl: u }),
        ingestDocument: async (tenantId, kbId, content, title, sourceType, sourceUri, opts = {}) => {
            fx.ingested.push({ title, sourceType, sourceUri, opts, content });
            const row = doc({ id: `d${nextId++}`, title, source_type: sourceType, source_id: opts.sourceId || null });
            fx.documents.push(row);
            return { document: row, chunks: 2, status: 'processed' };
        },
        reingestDocument: async (tenantId, kbId, docId, content, opts = {}) => {
            fx.reingested.push({ docId, content, opts });
            const row = fx.documents.find(d => d.id === docId);
            if (row) Object.assign(row, { status: 'processed', chunk_count: 2, status_reason: null });
            return { document: row, chunks: 2, status: 'processed' };
        },
        deleteDocumentChunks: async (kbId, docId, tenantId, opts = {}) => {
            fx.chunkDeletes.push({ kbId, docId, tenantId, opts });
            if (fx.chunkDeleteFails.has(docId)) throw new Error(`chunk cleanup failed for document ${docId}`);
            fx.documents = fx.documents.filter(d => d.id !== docId);
        },
        purgeDocumentChunks: async () => {},
        friendlyError: (e) => (e && e.message ? e.message : String(e)),
    },
    '../utils/ssrfGuard': {
        safeFetch: async (u) => ({
            ok: true, status: 200, url: u,
            headers: { get: () => 'text/html; charset=utf-8' },
            text: async () => '<html><head><title>Docs</title></head><body><p>a long enough public body to ingest</p></body></html>',
        }),
    },
    'multer': multerMock,
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-sources:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // De poort die `metadata.transcriptionId` controleert is een GEDEELDE
    // module geworden (core/kb/transcriptOrigin.js), zodat het duplicaat-pad
    // hem ook passeert. Hij en de org-resolutie waar hij op leunt draaien dus
    // buiten routes/knowledgeBases, maar horen wél in dit harnas: anders praat
    // de poort in deze suite met de ECHTE database en bewijst de test niets
    // over de context waarmee hij probeert.
    if (parent && (/routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)$/.test(parent.filename)
                   || /core[\\/]kb[\\/](transcriptOrigin|askerContext)\.js$/.test(parent.filename))
        && !/\.test\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require(path.join(__dirname, '..', 'knowledgeBases.js'));
const sourcesRouter = require('./sources');

// Nothing here may reach the network.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('global fetch called'); };

test.after(() => {
    Module._resolveFilename = originalResolve;
    globalThis.fetch = realFetch;
});

function dispatch({ method, url, body = {}, files = null, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {}, session,
            ...(files ? { files } : {}),
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(request, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            // A schema refusal reaches the client as an error, so the harness
            // answers it the way index.js does.
            require('../../core/http/terminalErrorHandler').terminalErrorHandler(err, request, res, (e) => reject(e));
        });
    });
}

// ═══ Reads ══════════════════════════════════════════════════════════

test('GET /:id/sources returns camelCase sources with per-source counters and totals', async () => {
    resetFx();
    fx.sources = [
        source({ id: 's1', kind: 'upload', name: 'Uploaded files' }),
        source({ id: 's2', kind: 'webpage', name: 'example.com', config: { url: 'https://example.com', crawl: { maxPages: 3 } }, refreshMode: 'schedule', refreshCron: '0 7 * * *', status: 'error', lastRefreshError: 'HTTP 500' }),
    ];
    fx.counts = {
        s1: { documentCount: 38, processedCount: 36, redactedCount: 0, skippedCount: 1, errorCount: 1, duplicateCount: 0, piiFoundCount: 2, totalChunks: 120 },
    };

    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.sources.length, 2);

    const upload = res.body.sources[0];
    assert.strictEqual(upload.documentCount, 38);
    assert.strictEqual(upload.processedCount, 36);
    assert.strictEqual(upload.totalChunks, 120);
    assert.deepStrictEqual(upload.createdBy, { id: 'u1', name: 'Tom' });
    assert.strictEqual(upload.refreshLabelKey, 'knowledge.sources.refresh.manual');

    const web = res.body.sources[1];
    assert.strictEqual(web.status, 'error');
    assert.strictEqual(web.error, 'HTTP 500');
    assert.strictEqual(web.refreshLabelKey, 'knowledge.sources.refresh.schedule');
    // A source with no documents yet reads as zeroes, never undefined.
    assert.strictEqual(web.documentCount, 0);

    assert.strictEqual(res.body.totals.sourceCount, 2);
    assert.strictEqual(res.body.totals.autoRefreshCount, 1);
    assert.strictEqual(res.body.totals.errorSourceCount, 1);
    assert.strictEqual(res.body.totals.documentCount, 38);
});

test('the public config is an allow-list: a text source never ships its text', async () => {
    resetFx();
    fx.sources = [source({ id: 's9', kind: 'text', name: 'Opening hours', config: { title: 'Opening hours', charCount: 42, text: 'SECRET BODY', internalNote: 'nope' } })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    const cfg = res.body.sources[0].config;
    assert.deepStrictEqual(cfg, { title: 'Opening hours', charCount: 42 });
    assert.ok(!JSON.stringify(res.body).includes('SECRET BODY'));
    assert.ok(!JSON.stringify(res.body).includes('internalNote'));
});

test('reading needs canAccessKB; an unknown KB is a 404 and not a 403', async () => {
    resetFx();
    fx.canAccess = false;
    const denied = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(denied.statusCode, 403);

    resetFx();
    const missing = await dispatch({ method: 'GET', url: '/nope/sources' });
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.body.code, 'kb_not_found');
});

test('GET /:id/sources/:sid/documents is projected and passes the filters through', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 'other' })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?status=error&pii=found&q=hand&limit=5&offset=10' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.documents.length, 1);
    assert.strictEqual(res.body.limit, 5);
    assert.strictEqual(res.body.offset, 10);

    const call = fx.listCalls.at(-1);
    assert.strictEqual(call.limit, 5);
    assert.strictEqual(call.offset, 10);
    assert.deepStrictEqual(call.filters, { sourceId: 's1', status: 'error', pii: 'found', q: 'hand' });
    // The projection is the store's; what matters here is that nothing in the
    // response carries a body.
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.documents[0], 'original_content'));
});

test('a document of another source is a 404 on this source', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' }), source({ id: 's2' })];
    fx.documents = [doc({ id: 'd1', source_id: 's2' })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents/d1' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'document_not_found');

    const ok = await dispatch({ method: 'GET', url: '/kb1/sources/s2/documents/d1' });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.document.id, 'd1');
});

test('a source id from another KB is never resolved', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', knowledgeBaseId: 'other-kb' })];
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'source_not_found');
});

// ═══ Writes: the authz matrix ═══════════════════════════════════════

test('writing needs canManageKB', async () => {
    resetFx();
    fx.canManage = false;
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.sources.length, 0);
});

test('a system-managed KB is read-only even for someone who may manage it', async () => {
    resetFx();
    fx.isSystem = true;
    fx.canManage = true;

    const create = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(create.statusCode, 403);
    assert.match(create.body.error, /read-only/i);

    fx.sources = [source({ id: 's1' })];
    const del = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(del.statusCode, 403);
    assert.strictEqual(fx.removed.length, 0);

    const patch = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 'x' } });
    assert.strictEqual(patch.statusCode, 403);

    const refresh = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
    assert.strictEqual(refresh.statusCode, 403);
    assert.strictEqual(fx.refreshed.length, 0);

    // Reading a system KB stays allowed.
    const read = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(read.statusCode, 200);
});

// ═══ Writes: creating ═══════════════════════════════════════════════

test('a kind whose engine has not landed yet is refused with kind_not_available', async () => {
    // `meeting_tag` left this list in K7 and `datatable` in K8, when their
    // adapters landed. Still ahead: K9 (nextcloud_folder), K10 (automation).
    resetFx();
    for (const kind of ['nextcloud_folder', 'automation', 'legacy']) {
        const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind } });
        assert.strictEqual(res.statusCode, 400, kind);
        assert.strictEqual(res.body.code, 'kind_not_available', kind);
        assert.deepStrictEqual(res.body.availableKinds, ['text', 'upload', 'webpage', 'meeting_tag', 'datatable']);
    }
    const unknown = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'telepathy' } });
    assert.strictEqual(unknown.statusCode, 400);
    assert.strictEqual(unknown.body.code, 'kind_not_available');
    assert.strictEqual(fx.sources.length, 0);
});

test('POST kind=text creates the source and ingests the snippet onto it', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', name: 'Opening hours', config: { text: 'We open at nine.' } },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'text');
    assert.strictEqual(res.body.source.name, 'Opening hours');
    assert.strictEqual(res.body.source.config.charCount, 'We open at nine.'.length);

    const ingest = fx.ingested.at(-1);
    assert.strictEqual(ingest.opts.sourceId, res.body.source.id, 'the document hangs off the new source');
    assert.strictEqual(ingest.opts.createdBy, 'u1');
    assert.strictEqual(ingest.opts.onFailure, 'record', 'a failed snippet leaves a row, not nothing');
});

/**
 * ── WHERE A TEXT SNIPPET CAME FROM (M4) ─────────────────────────────
 * The transcript tab files one line of a meeting as a text source, and the
 * meeting has to find those again afterwards. Two facts make that possible,
 * and they are ALLOW-LISTED rather than copied through: this object is written
 * by a client and read back on another screen, so a spread would carry
 * whatever a caller invents into a knowledge base a whole organisation can
 * query.
 */
test('POST kind=text records which transcript line it came from', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];   // een vergadering die deze schrijver mag openen
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'We gaan met leverancier B verder.',
                metadata: { transcriptionId: 't-1', segmentIndex: 12 },
            },
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body.source.config.metadata, { transcriptionId: 't-1', segmentIndex: 12 });
});

test('POST kind=text keeps ONLY the two allow-listed origin fields', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'We gaan met leverancier B verder.',
                metadata: {
                    transcriptionId: 't-1', segmentIndex: 12,
                    // What a spread would have carried into the base with it.
                    speakerName: 'Sandra de Vries', email: 'sandra@example.com', ownerId: 'u-other',
                },
            },
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body.source.config.metadata).sort(), ['segmentIndex', 'transcriptionId']);
});

test('POST kind=text stores NO origin at all when it is not a usable pair', async () => {
    // Unknown narrows: a half-filled origin (a transcription with no line, a
    // line index that is not a line) would make "this line is already filed"
    // true for every line of that meeting.
    for (const metadata of [undefined, null, 't-1', ['t-1'], {}, { segmentIndex: 3 }, { transcriptionId: '  ' }]) {
        resetFx();
        fx.visibleTranscriptions = ['t-1'];
        const res = await dispatch({
            method: 'POST', url: '/kb1/sources',
            body: { kind: 'text', config: { text: 'Een regel uit de meeting.', metadata } },
        });
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.source.config.metadata, undefined, `metadata ${JSON.stringify(metadata)} must not be stored`);
    }
    // A transcription id with an unusable line number keeps the id and drops
    // the line — the meeting is still findable, no line is falsely claimed.
    for (const bad of [null, true, -1, 1.5, 'twaalf', {}]) {
        resetFx();
        fx.visibleTranscriptions = ['t-1'];
        const res = await dispatch({
            method: 'POST', url: '/kb1/sources',
            body: { kind: 'text', config: { text: 'Een regel uit de meeting.', metadata: { transcriptionId: 't-1', segmentIndex: bad } } },
        });
        assert.deepStrictEqual(res.body.source.config.metadata, { transcriptionId: 't-1' });
    }
});

/**
 * ── HET ID IS EEN BEWERING OVER IEMAND ANDERS ZIJN VERGADERING (M4) ─
 * `metadata.transcriptionId` laat een regel op de tijdlijn van een vergadering
 * landen: de balk onder de tagrij, het Gebruikt-door-tabblad en "Uit dit
 * transcript gehaald" lezen hem allemaal terug, en de verwijderpoort van die
 * vergadering telt hem mee. Op je EIGEN kennisbank ben je altijd beheerder, dus
 * zonder deze controle kon iedereen een id VERZINNEN en een onware, niet te
 * weerleggen regel op de vergadering van een ander plakken — die daarna zijn
 * eigen notitie alleen nog langs de bevestigde ontsnappingsklep kwijt kon.
 *
 * Dezelfde bewaking als de meeting_tag-tak hierboven, en om dezelfde reden:
 * hij draait als de MAKER, en onbekend versmalt.
 */
test('POST kind=text refuses a transcript id the creator cannot see', async () => {
    resetFx();
    fx.visibleTranscriptions = [];        // niet van deze schrijver
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'Een regel uit de vergadering van iemand anders.',
                metadata: { transcriptionId: 't-van-iemand-anders', segmentIndex: 3 },
            },
        },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'transcription_not_visible');
    // En er landt NIETS: geen bron, geen document, geen ingest.
    assert.strictEqual(fx.sources.length, 0, 'no source may be created');
    assert.deepStrictEqual(fx.ingested, [], 'and nothing may be ingested');
});

test('"no such meeting" and "not yours to see" answer the same', async () => {
    // Anders is de route een bestaans-orakel: het verschil tussen de twee
    // antwoorden zou verklappen welke vergadering-ids bestaan.
    resetFx();
    fx.visibleTranscriptions = ['t-mine'];
    const missing = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 'bestaat-niet', segmentIndex: 1 } } },
    });
    const hidden = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-van-een-ander', segmentIndex: 1 } } },
    });
    assert.strictEqual(missing.statusCode, hidden.statusCode);
    assert.deepStrictEqual(missing.body, hidden.body);
});

test('the transcript probe runs as the CREATOR, not as the knowledge base owner', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    assert.strictEqual(fx.transcriptProbes.length, 1);
    assert.strictEqual(fx.transcriptProbes[0].reader, 'u1', 'the person pressing the button, not kb.tenant_id');
    assert.strictEqual(fx.transcriptProbes[0].id, 't-1');
});

/**
 * ── WIE ER PROBET IS DE HELFT; WAARMEE IS DE ANDERE HELFT ───────────
 * De testen hierboven pinnen `reader` en `id` en zwijgen over de DERDE
 * parameter — en juist die bepaalt of de controle iets betekent. De echte
 * store doet `if (ctx.isSuperAdmin) return true;`, dus één vlag erbij en de
 * poort staat wagenwijd open zonder dat één assertie verandert. En te weinig
 * scope (een verkeerd gespelde veldnaam) maakt elke org-gepubliceerde
 * vergadering onfileerbaar. Beide mutaties bleven groen; daarom deze twee.
 */
test('de probe draagt de SCOPE van de schrijver — en nooit isSuperAdmin', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    const { ctx } = fx.transcriptProbes[0];
    assert.ok(ctx && typeof ctx === 'object', 'er gaat een context mee');
    // De vlag die van deze controle een doorgeefluik maakt, mag er niet in
    // zitten — ook niet als `false`, want dan is de vraag hier beantwoord in
    // plaats van door de leesregels van de vergadering.
    assert.strictEqual('isSuperAdmin' in ctx, false, 'de poort geeft zichzelf geen super-admin-doorgang');
    // En de scope die er WEL in zit is die van de schrijver: zijn directe org
    // én de orgs die uit zijn groepen volgen — dezelfde resolutie als het
    // leespad waarmee hij die vergadering überhaupt opende.
    assert.deepStrictEqual([...ctx.orgIds].sort(), ['org-via-groep', 'org1']);
    assert.deepStrictEqual(ctx.userGroupIds, ['g-sales']);
});

test('een schrijver zonder org krijgt ook geen org-scope mee', async () => {
    resetFx();
    fx.users.u3 = { id: 'u3', organizationId: '', groups: [] };
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources', session: { user: { id: 'u3' } },
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    const { ctx, reader } = fx.transcriptProbes[0];
    assert.strictEqual(reader, 'u3');
    assert.deepStrictEqual([...ctx.orgIds], [], 'geen org betekent geen org-clausule, niet "alle orgs"');
});

test('a probe that fails refuses, rather than filing a line it could not check', async () => {
    resetFx();
    fx.transcriptProbeFails = true;
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(fx.sources.length, 0);
    assert.deepStrictEqual(fx.ingested, []);
});

test('a snippet with no origin is not probed for at all', async () => {
    // Een gewone geplakte tekst beweert niets over een vergadering, dus er valt
    // niets te controleren — en een controle die er toch was, zou van elke
    // tekstbron een vergaderingslookup maken.
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: 'Openingstijden: 9-17.' } } });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(fx.transcriptProbes, []);
});

test('POST kind=text refuses an empty snippet', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: ' ' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.config.text'), 'the 400 names the field');
    assert.strictEqual(fx.sources.length, 0);
});

test('POST kind=webpage fetches through the guard and stores the crawl for K3', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'webpage', config: { url: 'https://example.com/docs', crawl: { maxPages: 9999 } } },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'webpage');
    assert.strictEqual(res.body.source.config.url, 'https://example.com/docs');
    assert.deepStrictEqual(res.body.source.config.crawl, { maxPages: 500 }, 'maxPages is clamped');
    assert.strictEqual(res.body.crawlPending, true);

    const ingest = fx.ingested.at(-1);
    assert.strictEqual(ingest.sourceType, 'web');
    assert.strictEqual(ingest.opts.externalId, 'https://example.com/docs');
});

test('POST kind=webpage refuses a URL the guard rejects, and creates nothing', async () => {
    resetFx();
    fx.blockedHosts.add('127.0.0.1');
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'http://127.0.0.1:3101/admin' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'url_rejected');
    assert.strictEqual(fx.sources.length, 0, 'no half-created source is left behind');
    assert.strictEqual(fx.ingested.length, 0, 'and nothing internal was ingested');
});

test('max_kb_sources is enforced against the live count, and -1 is uncapped', async () => {
    resetFx();
    fx.maxSources = 2;
    fx.sources = [source({ id: 's1' }), source({ id: 's2', kind: 'text' })];

    const blocked = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(blocked.statusCode, 403);
    assert.strictEqual(blocked.body.code, 'source_limit_reached');
    assert.strictEqual(blocked.body.limit, 2);
    assert.strictEqual(fx.sources.length, 2, 'nothing was created');

    fx.maxSources = -1;
    const allowed = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(allowed.statusCode, 201);
    assert.strictEqual(fx.sources.length, 3);
});

// ═══ Uploads ════════════════════════════════════════════════════════

function file(name, mimetype = 'application/pdf', size = 1024) {
    return { originalname: name, mimetype, size, buffer: Buffer.from(`bytes of ${name}`) };
}

test('POST /files answers 202 with real document ids, then processes detached', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const res = await dispatch({
        method: 'POST', url: '/kb1/sources/s1/files',
        files: [file('Handbook.pdf'), file('Prices.xlsx', 'application/vnd.ms-excel')],
    });

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.accepted, 2);
    assert.deepStrictEqual(res.body.documents.map(d => d.name), ['Handbook.pdf', 'Prices.xlsx']);
    assert.ok(res.body.documents.every(d => d.status === 'processing'));
    assert.ok(res.body.documents.every(d => typeof d.id === 'string' && d.id.length > 0));
    // The ids are real rows, which is what lets the UI follow them.
    for (const d of res.body.documents) {
        assert.ok(fx.documents.some(row => row.id === d.id), `${d.name} exists as a row before processing`);
    }

    await sourcesRouter.settleUploads();
    assert.strictEqual(fx.reingested.length, 2, 'both files were processed after the response');
    assert.strictEqual(fx.reingested[0].opts.pageCount, 3);
    assert.strictEqual(fx.reingested[0].opts.onFailure, 'record');
    assert.ok(fx.documents.every(d => d.status === 'processed'));
});

test('a file that cannot be extracted leaves an error ROW, never a silent gap', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('broken.pdf')] });
    assert.strictEqual(res.statusCode, 202);
    await sourcesRouter.settleUploads();

    const update = fx.statusUpdates.at(-1);
    assert.strictEqual(update.status, 'error');
    assert.match(update.statusReason, /extract/i);
    assert.strictEqual(fx.reingested.length, 0);
    assert.strictEqual(fx.documents.length, 1, 'the row survives so the file is visible with a reason');
});

test('the same file twice becomes a duplicate row, not a second embedding', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];
    // An existing processed row with the hash the extractor will produce.
    fx.documents = [doc({ id: 'canonical', source_id: 's1', content_hash: `hash:${'content of Handbook.pdf'.length}` })];

    await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('Handbook.pdf')] });
    await sourcesRouter.settleUploads();

    const update = fx.statusUpdates.at(-1);
    assert.strictEqual(update.status, 'duplicate');
    assert.strictEqual(fx.reingested.length, 0, 'a duplicate is never embedded again');
});

test('files may only be added to an upload source', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', config: { url: 'https://example.com' } })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('x.pdf')] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'not_an_upload_source');
});

test('a POST with no files is a 400, not an empty 202', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_files');
});

// ═══ Patch / delete / refresh ═══════════════════════════════════════

test('PATCH renames and refuses a refresh mode the kind cannot do', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const renamed = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '  Contracts  ' } });
    assert.strictEqual(renamed.statusCode, 200);
    assert.strictEqual(fx.updated.at(-1).patch.name, 'Contracts');

    const refused = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'live' } } });
    assert.strictEqual(refused.statusCode, 400);
    assert.strictEqual(refused.body.code, 'refresh_mode_not_available');
});

test('PATCH accepts a schedule on a webpage source and validates cron and tz', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', config: { url: 'https://example.com' } })];

    const ok = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule', cron: '0 7 * * *', tz: 'Europe/Amsterdam' } } });
    assert.strictEqual(ok.statusCode, 200);
    const patched = fx.updated.at(-1).patch;
    assert.strictEqual(patched.refreshMode, 'schedule');
    assert.strictEqual(patched.refreshCron, '0 7 * * *');
    assert.strictEqual(patched.refreshTz, 'Europe/Amsterdam');
    // Saving a schedule must ARM it. `next_refresh_at` is the only thing the
    // refresh tick looks at, so a good cron with a null next-run is a source
    // that silently never refreshes while its schedule is on screen.
    assert.ok(patched.nextRefreshAt, 'a saved schedule must be armed');
    assert.ok(Date.parse(patched.nextRefreshAt) > Date.now(), 'and armed in the future');

    const badCron = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule', cron: 'daily' } } });
    assert.strictEqual(badCron.statusCode, 400);
    assert.ok(badCron.body.details.some(d => d.path === 'body.refresh.cron'));

    const badTz = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { tz: 'Mars/Olympus' } } });
    assert.strictEqual(badTz.statusCode, 400);
    assert.strictEqual(badTz.body.error, 'Unknown time zone: Mars/Olympus');
});

test('editing the cron of an already-scheduled source re-arms it from the NEW cron', async () => {
    // Computed from the row as it will be AFTER the patch. Arming the old
    // cron would leave the source firing on a schedule nobody can see.
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *', refreshTz: 'UTC' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { cron: '30 23 * * *' } } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.refreshCron, '30 23 * * *');
    assert.strictEqual(new Date(patch.nextRefreshAt).getUTCHours(), 23);
    assert.strictEqual(new Date(patch.nextRefreshAt).getUTCMinutes(), 30);
});

test('renaming a scheduled source does not touch its schedule', async () => {
    // Re-arming on every unrelated save would walk the next run forward each
    // time somebody edited the name.
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 'Terms page' } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.name, 'Terms page');
    assert.strictEqual(patch.nextRefreshAt, undefined, 'the schedule was not touched');
});

test('switching back to manual clears the schedule so no stale cron survives', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'manual' } } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.refreshMode, 'manual');
    assert.strictEqual(patch.refreshCron, null);
    assert.strictEqual(patch.nextRefreshAt, null);
});

test('DELETE removes every document\'s chunks before the source row, without snapshotting', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 's1' }), doc({ id: 'd3', source_id: 'other' })];

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deletedDocuments, 2);
    assert.deepStrictEqual(fx.chunkDeletes.map(c => c.docId), ['d1', 'd2']);
    assert.ok(fx.chunkDeletes.every(c => c.opts.skipSnapshot === true),
        'a source-driven removal must not copy the row into kb_document_versions');
    assert.deepStrictEqual(fx.removed, ['s1']);
    assert.deepStrictEqual(fx.documents.map(d => d.id), ['d3'], "another source's documents are untouched");
});

test('DELETE keeps the source row when a document refuses to be purged', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 's1' })];
    fx.chunkDeleteFails.add('d2');

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    // De FK op documents.source_id cascadeert; viel de bronrij tóch, dan
    // verdween d2's rij en bleven zijn embeddings voorgoed doorzoekbaar.
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'purge_incomplete');
    assert.strictEqual(res.body.deletedDocuments, 1);
    assert.deepStrictEqual(fx.removed, [], 'de bron blijft staan');
    assert.ok(fx.documents.some(d => d.id === 'd2'), 'het document dat niet weg wilde staat er nog');
    // Eén rij per document, ook al is het over meerdere ronden geprobeerd.
    assert.deepStrictEqual(res.body.errors.map(e => e.documentId), ['d2']);
});

test('DELETE pages past the first page of documents', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    // Eén meer dan een pagina (PAGE = 200): zonder rondenlus blijft er precies
    // één document achter, zonder dat er iets misgaat om te melden.
    fx.documents = Array.from({ length: 201 }, (_, i) => doc({ id: `p${i}`, source_id: 's1' }));

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deletedDocuments, 201);
    assert.deepStrictEqual(fx.documents, []);
    assert.deepStrictEqual(fx.removed, ['s1']);
});

test('POST /refresh only queues — K3 does the work', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.queued, true);
    assert.deepStrictEqual(fx.refreshed, ['s1']);
    assert.strictEqual(res.body.source.nextRefreshAt, '2026-09-04T12:00:00.000Z');
});

// ═══ Mount order ════════════════════════════════════════════════════

test('the sources router is mounted before detail, so /:id never swallows /:id/sources', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.ok(Array.isArray(res.body.sources), 'the sources handler answered, not GET /:id');
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'documents'));
});

// ── meeting_tag (K7) ────────────────────────────────────────────────

/**
 * A meeting-tag source WIDENS who can read a meeting summary: the note's own
 * audience is replaced by the knowledge base's, which may be larger. The
 * adapter holds one half of that line (it enumerates as the KB's owner,
 * through the store's read ACL); this route holds the other.
 */
test('creating a meeting source requires the creator to see the tag themselves', async () => {
    // Without this, somebody with manage_knowledge could point a knowledge
    // base at a tag they have never been able to read and have the OWNER's
    // reach fill it in for them. The tag would still be filtered by the
    // owner's ACL — but the choice of which meetings to expose would have been
    // made by somebody who cannot see them.
    resetFx();
    fx.taggedMeetings = [];   // nothing this person can open carries it
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'directie' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'tag_not_visible');
    assert.strictEqual(fx.sources.length, 0);
});

test('the probe runs as the CREATOR, not as the knowledge base owner', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(fx.tagProbes[0].reader, 'u1', 'the person pressing the button');
    assert.strictEqual(fx.tagProbes[0].tag, 'sales');
});

test('"no such tag" and "not yours to see" answer the same', async () => {
    // Telling them apart would let somebody probe for which tags exist in the
    // organisation.
    resetFx();
    fx.taggedMeetings = [];
    const missing = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'does-not-exist' } } });
    const hidden = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'directie' } } });
    assert.deepStrictEqual(missing.body, hidden.body);
});

test('a visible tag creates the source, defaulting to summary and decisions', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'meeting_tag');
    assert.match(res.body.source.name, /sales/);
    // The STORED config, not the API projection: `mapSourceForApi` reshapes a
    // source for the row UI, and what the adapter reads later is this.
    const stored = fx.created.at(-1).source;
    assert.deepStrictEqual(stored.config, { tag: 'sales', fields: ['summary', 'decisions'] });
});

test('the fields asked for are kept, and a field this source has no answer for is refused', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const kept = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'questions'] } },
    });
    assert.strictEqual(kept.statusCode, 201);
    assert.deepStrictEqual(fx.created.at(-1).source.config.fields, ['summary', 'questions']);

    // Dropping it silently was how somebody asked for the transcript, was
    // answered 201, and then found a source that does not carry one.
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const refused = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'transcript'] } },
    });
    assert.strictEqual(refused.statusCode, 400);
    assert.ok(refused.body.details.some(d => d.path === 'body.config.fields.1'), 'the 400 names which entry');
    assert.strictEqual(fx.sources.length, 0);
});

test('a tag is required', async () => {
    resetFx();
    for (const config of [{}, { tag: '   ' }, { tag: 5 }]) {
        const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(config));
        assert.strictEqual(res.body.error, 'A meeting source needs a tag.', JSON.stringify(config));
        assert.ok(res.body.details.some(d => d.path === 'body.config.tag'), JSON.stringify(config));
    }
    assert.deepStrictEqual(fx.tagProbes, [], 'and nothing is probed for');
});

test('a probe that fails refuses, rather than creating a source it could not check', async () => {
    resetFx();
    fx.tagProbeFails = true;
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(fx.sources.length, 0);
});

test('someone who may only READ the knowledge base cannot point it at meetings', async () => {
    resetFx();
    fx.canManage = false;
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.sources.length, 0);
});

// ═══ The licence line ═══════════════════════════════════════════════
//
// `kb_datatable_sources` and `kb_scheduled_refresh` refuse NEW use only: a
// datatable source that exists keeps working, renaming is always free, and so
// is switching a schedule off. A mode the kind does not have is a 400 about
// the request on every plan, never hidden behind "not on your plan".

const PRICES = { id: 'dt-prices', name: 'Prices', fields: [{ key: 'name' }, { key: 'price' }] };

test('without kb_datatable_sources, a datatable source is refused and nothing is made', async () => {
    resetFx();
    fx.locked.add('kb_datatable_sources');
    fx.datatables = { [PRICES.id]: PRICES };

    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'datatable', config: { datatableId: PRICES.id } } });
    assert.strictEqual(res.statusCode, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.error, 'feature_locked');
    assert.strictEqual(res.body.feature, 'kb_datatable_sources');
    assert.deepStrictEqual(fx.sources, []);
});

test('with kb_datatable_sources, the same request makes the source', async () => {
    resetFx();
    fx.datatables = { [PRICES.id]: PRICES };

    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'datatable', config: { datatableId: PRICES.id } } });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.source.kind, 'datatable');
    assert.strictEqual(fx.sources.length, 1);
});

test('an existing datatable source keeps working without the licence', async () => {
    // Its sync is also how a row erased upstream leaves the base, so nothing
    // about a source that exists may stop on a lapse.
    resetFx();
    fx.locked = new Set(['kb_datatable_sources', 'kb_scheduled_refresh']);
    fx.sources = [source({ id: 's1', kind: 'datatable', name: 'Prices', config: { datatableId: PRICES.id }, refreshMode: 'live' })];

    const renamed = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 'Price list' } });
    assert.strictEqual(renamed.statusCode, 200, JSON.stringify(renamed.body));
    const refresh = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
    assert.strictEqual(refresh.statusCode, 202, JSON.stringify(refresh.body));
    assert.deepStrictEqual(fx.refreshed, ['s1']);
    const manual = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'manual' } } });
    assert.strictEqual(manual.statusCode, 200, JSON.stringify(manual.body));
});

test('without kb_scheduled_refresh, a source cannot be created on a schedule, but can be made manual', async () => {
    resetFx();
    fx.locked.add('kb_scheduled_refresh');

    const scheduled = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'webpage', config: { url: 'https://example.com/terms' }, refresh: { mode: 'schedule', cron: '0 7 * * *' } },
    });
    assert.strictEqual(scheduled.statusCode, 403, JSON.stringify(scheduled.body));
    assert.strictEqual(scheduled.body.feature, 'kb_scheduled_refresh');
    assert.deepStrictEqual(fx.sources, []);
    assert.deepStrictEqual(fx.ingested, [], 'nothing was fetched or stored for a refused source');

    const manual = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'webpage', config: { url: 'https://example.com/terms' }, refresh: { mode: 'manual' } },
    });
    assert.strictEqual(manual.statusCode, 201, JSON.stringify(manual.body));
    assert.strictEqual(manual.body.source.refreshMode, 'manual');
});

test('without kb_scheduled_refresh, PATCH cannot start or change a schedule', async () => {
    resetFx();
    fx.locked.add('kb_scheduled_refresh');
    fx.sources = [
        source({ id: 's1', kind: 'webpage', config: { url: 'https://example.com' } }),
        source({ id: 's2', kind: 'webpage', config: { url: 'https://example.com/b' }, refreshMode: 'schedule', refreshCron: '0 7 * * *' }),
    ];

    const start = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule', cron: '0 7 * * *' } } });
    assert.strictEqual(start.statusCode, 403, JSON.stringify(start.body));
    assert.strictEqual(start.body.feature, 'kb_scheduled_refresh');
    const change = await dispatch({ method: 'PATCH', url: '/kb1/sources/s2', body: { refresh: { cron: '30 23 * * *' } } });
    assert.strictEqual(change.statusCode, 403, JSON.stringify(change.body));
    assert.deepStrictEqual(fx.updated, [], 'a refused PATCH writes nothing');
});

test('without kb_scheduled_refresh, renaming a scheduled source and switching it off still work', async () => {
    resetFx();
    fx.locked.add('kb_scheduled_refresh');
    fx.sources = [source({ id: 's2', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *' })];

    const renamed = await dispatch({ method: 'PATCH', url: '/kb1/sources/s2', body: { name: 'Terms page' } });
    assert.strictEqual(renamed.statusCode, 200, JSON.stringify(renamed.body));
    const off = await dispatch({ method: 'PATCH', url: '/kb1/sources/s2', body: { refresh: { mode: 'manual' } } });
    assert.strictEqual(off.statusCode, 200, JSON.stringify(off.body));
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.refreshMode, 'manual');
    assert.strictEqual(patch.nextRefreshAt, null, 'switched off means nothing stays armed');
});

test('a refresh mode the kind does not have is a 400 before the licence line', async () => {
    resetFx();
    fx.locked.add('kb_scheduled_refresh');
    fx.sources = [source({ id: 's1', kind: 'text' })];

    const res = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule' } } });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'refresh_mode_not_available');
});

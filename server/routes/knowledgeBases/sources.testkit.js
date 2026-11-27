/**
 * The harness of the KB source API tests (sources*.test.js): the sub-routers' own dependencies
 * replaced with recording doubles through Module._resolveFilename (and, for the files the core
 * asks for by name, in core/featureModules.js), the request through the REAL facade
 * (routes/knowledgeBases.js). `fx` is the mutable world; `resetFx()` starts a test afresh.
 */

const test = require('node:test');
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
    // Document ids for which the chunk clean-up throws — the path that must let the route choose between "remove the source" and "leave the source".
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

const { fakeKbGates } = require('./kbGate.testkit');
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
            // `limit` IS honoured. If it were not, a route without a round loop would look in this harness just as good as a route WITH one — and it is precisely the 201st document that this path is about.
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
        // With the fields that askerContext really leans on: the direct org and the
        // groups from which further orgs follow. A mock without those fields lets the gate probe with an EMPTY org set, and then no
        // assertion on `reader`/`id` proves anything about the scope.
        getUser: async (id) => (fx.users[id] ? { ...fx.users[id] } : null),
        getAllGroups: async () => fx.allGroups,
    },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => new Set(['org1']),
        hasPermission: async () => true, resolvePermissionsByOrg: async () => ({ holds: () => true }),
        validateSharedGroupsForOrg: async () => {},
        resolveUserGroups: async (id) => (fx.users[id]?.groups || []),
    },
    // core/kb/askerContext reads group membership from auth/audience directly.
    '../auth/audience': {
        resolveUserGroups: async (id) => (fx.users[id]?.groups || []),
    },
    '../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../core/serviceAuth': { getServiceHeaders: () => ({}) },
    '../core/kb/kbAccess': { ...fakeKbGates({ kbStore: { getKB: (id) => MOCKS['../stores/knowledgeBases'].getKB(id) }, canRead: () => fx.canAccess, canManage: () => fx.canAccess && fx.canManage }),
        resolveAdminOrgIds: async () => new Set(['org1']),
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
// The core asks for the meetings store by name (core/featureModules.js): the same double answers there.
require('../../core/featureModules').registerFeatureModules({
    'stores/transcriptionStore': () => MOCKS['../stores/transcriptionStore'],
});
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // The gate that checks `metadata.transcriptionId` has become a SHARED
    // module (core/kb/transcriptOrigin.js), so that the duplicate path
    // also passes through it. He and the org resolution he leans on therefore run
    // outside routes/knowledgeBases, but belong in THIS harness: otherwise the gate probes in this suite with the REAL database and the test proves
    // nothing about the context with which it is trying.
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

module.exports = { fx, KB, resetFx, doc, source, MOCKS, router, sourcesRouter, dispatch };

/**
 * App Studio dataset router — the multipart upload state machine over HTTP.
 *
 * Real Express router + real datasetUploadGuard (raw body parser + head sniff);
 * stores / rls / audience / licence stubbed via the require cache before the
 * router loads (the studioAppFiles.test.js harness). The manifest store stub
 * reimplements the SEQUENTIAL-parts rule in memory — the SQL original is
 * covered by stores/datasetFileStore.test.js and the psql smoke.
 *
 * Run: cd server && node --test routes/studioAppDatasets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Readable, Writable } = require('stream');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Tiny parts so a 3-part upload fits in a test. Read by the router AT LOAD.
process.env.DATASET_PART_BYTES = '64';
process.env.STUDIO_APP_DATASET_MAX_FILE_BYTES = '500';
process.env.STUDIO_APP_DATASET_TOTAL_BYTES = '1000';
process.env.STUDIO_APP_DATASET_MAX_FILES = '2';

// ── Mutable stubbed state ───────────────────────────────────────────
const apps = new Map();
const rows = new Map();                       // datasetId → manifest row
const storage = { begins: [], parts: [], completes: [], aborts: [], deletes: [], available: true };
const state = { canWrite: true };

function canReadStudioApp(app, userId, _groups = [], orgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished || !app.organizationId) return false;
    return (Array.isArray(orgIds) ? orgIds : []).includes(app.organizationId);
}

// requireAuth confirms the session's user still exists; the suite only passed
// before because that check used to fail open on an error.
stub('../stores/userStore', { getUser: async (id) => ({ id }), touchLastSeen: async () => {} });

stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    // Project widening (canReadStudioAppAsync): no fixture here is filed into
    // a Studio Project, so the async predicate is the sync one — which is
    // exactly what the real store answers for project_id NULL.
    canReadStudioAppAsync: async (...a) => canReadStudioApp(...a),
});
stub('../stores/studioAppDataStore', {
    getDataModel: async () => ({ model: { tables: [{ id: 't1', key: 'rows', fields: [], access: { default: 'app' } }] }, modelVersion: 1 }),
});
stub('../stores/studioAppDbStore', { query: async () => ({ rows: [] }) });
stub('../appStudio/queryCompiler', { compileGetById: () => ({ sql: '', params: [] }), compileRecordList: () => ({ sql: '', params: [] }) });
stub('../appStudio/rlsGateway', {
    resolveViewerRole: async () => 'member',
    canRead: () => true,
    resolveScope: (_t, _role, action) => (state.canWrite
        ? (action === 'create' ? true : 'all')
        : (action === 'create' ? false : 'none')),
    compileAccessFilter: () => ({ where: '', params: [] }),
});
stub('../stores/storageStore', {
    isAvailable: () => storage.available,
    buildStudioAppDatasetKey: (ownerId, appId, dsId, artifact) => `studio-apps/${ownerId}/${appId}/datasets/${dsId}/${artifact}`,
    beginMultipartUpload: async (key) => { const uploadId = `mpu-${storage.begins.length + 1}`; storage.begins.push({ key, uploadId }); return { uploadId }; },
    uploadPartBuffer: async (key, uploadId, partNumber, buffer) => { storage.parts.push({ key, uploadId, partNumber, size: buffer.length }); return { etag: `etag-${partNumber}` }; },
    completeMultipartUpload: async (key, uploadId, parts) => { storage.completes.push({ key, uploadId, parts }); },
    abortMultipartUpload: async (key, uploadId) => { storage.aborts.push({ key, uploadId }); },
    deleteFile: async (key) => { storage.deletes.push(key); },
});
// In-memory manifest with the same sequential-parts contract as the SQL store.
stub('../stores/datasetFileStore', {
    createDataset: async (fields) => {
        const row = { ...fields, id: fields.id || crypto.randomUUID(), status: 'uploading', partsDone: 0, receivedBytes: 0, dataBytes: null, metadata: null, variantCount: null, progressPct: null, progressNote: null, error: null, createdAt: new Date(), readyAt: null };
        rows.set(row.id, row);
        return row;
    },
    getDataset: async (id, appId, ownerId) => {
        const r = rows.get(id);
        return r && r.appId === appId && r.ownerId === ownerId ? r : null;
    },
    listDatasets: async (appId, ownerId) => [...rows.values()].filter((r) => r.appId === appId && r.ownerId === ownerId),
    recordPart: async (id, appId, ownerId, n, etag, bytes) => {
        const r = rows.get(id);
        if (!r || r.appId !== appId || r.ownerId !== ownerId || r.status !== 'uploading' || r.partsDone !== n) {
            return { ok: false, expected: r && r.status === 'uploading' ? r.partsDone : null };
        }
        r.partsDone++; r.receivedBytes += bytes;
        r.uploadState.etags[String(n)] = etag;
        return { ok: true, partsDone: r.partsDone };
    },
    markUploaded: async (id) => { const r = rows.get(id); if (r && r.partsDone === r.partsTotal) { r.status = 'uploaded'; return true; } return false; },
    sumBytesForOwner: async (ownerId) => [...rows.values()].filter((r) => r.ownerId === ownerId && r.status !== 'failed')
        .reduce((n, r) => n + (r.dataBytes ?? r.declaredBytes), 0),
    countForUploader: async (appId, uploaderId) => [...rows.values()]
        .filter((r) => r.appId === appId && r.uploaderId === uploaderId && r.status !== 'failed').length,
    deleteDataset: async (id, appId, ownerId) => {
        const r = rows.get(id);
        if (!r || r.appId !== appId || r.ownerId !== ownerId) return null;
        rows.delete(id);
        return r;
    },
});
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({ userId: req.session?.user?.id || null, orgIds: new Set(req._testOrgIds || []), userGroups: req._testGroups || [] }),
});
stub('../license/middleware', {
    requireFeature: () => (req, res, next) => next(),
});

const router = require('./studioAppDatasets');

// ── Harness (the studioAppFiles.test.js shapes) ─────────────────────
const OWNER = 'owner-1';
const ORG = 'org-1';
let seq = 0;
function makeApp({ owner = OWNER, org = ORG, published = true } = {}) {
    const id = `app-${++seq}`;
    const app = { id, userId: owner, organizationId: org, isPublished: published, name: 'App' };
    apps.set(id, app);
    return app;
}

class FakeRes extends Writable {
    constructor(resolve) {
        super();
        this.statusCode = 200; this.headers = {}; this.body = undefined;
        this._resolve = resolve; this._settled = false;
        this.on('finish', () => this._done());
    }
    status(c) { this.statusCode = c; return this; }
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
    getHeader(k) { return this.headers[String(k).toLowerCase()]; }
    json(b) { this.body = b; this._done(); return this; }
    _write(chunk, _enc, cb) { cb(); }
    _done() { if (this._settled) return; this._settled = true; this._resolve(this); }
}

function dispatch(req) {
    return new Promise((resolve, reject) => {
        const res = new FakeRes(resolve);
        router(req, res, (err) => reject(err || new Error(`fell through: ${req.method} ${req.url}`)));
    });
}

function bodyReq(url, { method = 'POST', body = null, contentType = 'application/json', user = OWNER, orgIds = [], groups = [] } = {}) {
    const buf = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = new Readable({ read() { this.push(buf); this.push(null); } });
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': contentType, 'content-length': String(buf.length) };
    req.session = user ? { isAuthenticated: true, user: { id: user } } : null;
    req._testOrgIds = orgIds;
    req._testGroups = groups;
    return req;
}
const jsonReq = (url, body, opts = {}) => bodyReq(url, { body, ...opts });
const partReq = (url, buffer, opts = {}) => bodyReq(url, { method: 'PUT', body: buffer, contentType: 'application/octet-stream', ...opts });
const getReq = (url, opts = {}) => bodyReq(url, { method: 'GET', body: null, ...opts });

// A valid-looking VCF head for part 0 (padded to the exact part size).
function vcfPart0(size = 64) {
    const head = Buffer.from('##fileformat=VCFv4.2\n##x=');
    return Buffer.concat([head, Buffer.alloc(size - head.length, 0x61)]);
}

test.beforeEach(() => {
    rows.clear();
    storage.begins.length = 0; storage.parts.length = 0; storage.completes.length = 0;
    storage.aborts.length = 0; storage.deletes.length = 0; storage.available = true;
    state.canWrite = true;
});

async function initUpload(app, bytes = 160, opts = {}) {
    const r = await dispatch(jsonReq(`/${app.id}/large-datasets`, { name: 'me.vcf', bytes }, opts));
    return r;
}

test('init: quotas answered BEFORE bytes; happy path mints the multipart upload', async () => {
    const app = makeApp();
    const r = await initUpload(app, 160);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.partSize, 64);
    assert.strictEqual(r.body.partsTotal, 3);
    assert.strictEqual(storage.begins.length, 1);
    assert.match(storage.begins[0].key, new RegExp(`^studio-apps/${OWNER}/${app.id}/datasets/${r.body.datasetId}/raw$`));

    // Per-file ceiling.
    const big = await initUpload(app, 501);
    assert.strictEqual(big.statusCode, 413);

    // Per-app count ceiling (max 2).
    await initUpload(app, 96);
    const third = await initUpload(app, 96);
    assert.strictEqual(third.statusCode, 409);
    assert.match(third.body.error, /max 2/);
});

test('init: the file ceiling counts each person\'s own uploads, so one member cannot fill the app for the rest', async () => {
    // A member may delete only her own datasets. Counted per app, two of hers
    // would tell every other member "delete one first" about files they can
    // neither see nor delete.
    const app = makeApp();
    const member = (user) => ({ user, orgIds: [ORG] });
    assert.strictEqual((await initUpload(app, 96, member('viewer-1'))).statusCode, 200);
    assert.strictEqual((await initUpload(app, 96, member('viewer-1'))).statusCode, 200);
    const third = await initUpload(app, 96, member('viewer-1'));
    assert.strictEqual(third.statusCode, 409);
    assert.match(third.body.error, /max 2/);

    const others = {
        'viewer-2': (await initUpload(app, 96, member('viewer-2'))).statusCode,
        [OWNER]: (await initUpload(app, 96)).statusCode,
    };
    assert.deepStrictEqual(others, { 'viewer-2': 200, [OWNER]: 200 });
});

test('init: the owner byte quota trips across apps', async () => {
    const a = makeApp();
    const b = makeApp();
    assert.strictEqual((await initUpload(a, 480)).statusCode, 200);
    assert.strictEqual((await initUpload(b, 480)).statusCode, 200);
    const r = await initUpload(b, 480); // 1440 > 1000
    assert.strictEqual(r.statusCode, 409);
    assert.match(r.body.error, /quota/);
});

test('parts: sequential in, 409 + expectation on gaps and duplicates, exact sizes only', async () => {
    const app = makeApp();
    const { body: { datasetId } } = await initUpload(app, 160);
    const base = `/${app.id}/large-datasets/${datasetId}/parts`;

    // Gap: part 1 before part 0.
    const gap = await dispatch(partReq(`${base}/1`, Buffer.alloc(64, 0x61)));
    assert.strictEqual(gap.statusCode, 409);
    assert.strictEqual(gap.body.expected, 0);

    // Part 0 must sniff as VCF; then sequential parts land.
    assert.strictEqual((await dispatch(partReq(`${base}/0`, vcfPart0()))).statusCode, 200);
    const dup = await dispatch(partReq(`${base}/0`, vcfPart0()));
    assert.strictEqual(dup.statusCode, 409);
    assert.strictEqual(dup.body.expected, 1);

    // Wrong size (mid part must be exactly 64).
    const wrong = await dispatch(partReq(`${base}/1`, Buffer.alloc(63, 0x61)));
    assert.strictEqual(wrong.statusCode, 400);
    assert.match(wrong.body.error, /exactly 64 bytes/);

    assert.strictEqual((await dispatch(partReq(`${base}/1`, Buffer.alloc(64, 0x61)))).statusCode, 200);
    // Last part: 160 - 2×64 = 32.
    const last = await dispatch(partReq(`${base}/2`, Buffer.alloc(32, 0x61)));
    assert.strictEqual(last.statusCode, 200);
    assert.strictEqual(last.body.partsDone, 3);
    // Storage got 1-based part numbers.
    assert.deepStrictEqual(storage.parts.map((p) => p.partNumber), [1, 2, 3]);
});

test('part 0 that is not a VCF: 415, multipart aborted, manifest deleted', async () => {
    const app = makeApp();
    const { body: { datasetId } } = await initUpload(app, 160);
    const r = await dispatch(partReq(`/${app.id}/large-datasets/${datasetId}/parts/0`, Buffer.alloc(64, 0x00)));
    assert.strictEqual(r.statusCode, 415);
    assert.strictEqual(storage.aborts.length, 1);
    assert.strictEqual(rows.has(datasetId), false, 'the refused upload leaves no manifest row');
});

test('complete: refused while parts are missing; assembles ordered parts when done', async () => {
    const app = makeApp();
    const { body: { datasetId } } = await initUpload(app, 128);
    const base = `/${app.id}/large-datasets/${datasetId}`;

    const early = await dispatch(jsonReq(`${base}/complete`, {}));
    assert.strictEqual(early.statusCode, 409);
    assert.strictEqual(early.body.partsDone, 0);

    await dispatch(partReq(`${base}/parts/0`, vcfPart0()));
    await dispatch(partReq(`${base}/parts/1`, Buffer.alloc(64, 0x62)));
    const done = await dispatch(jsonReq(`${base}/complete`, {}));
    assert.strictEqual(done.statusCode, 200);
    assert.strictEqual(done.body.status, 'uploaded');
    assert.strictEqual(storage.completes.length, 1);
    assert.deepStrictEqual(storage.completes[0].parts.map((p) => p.partNumber), [1, 2]);
    assert.deepStrictEqual(storage.completes[0].parts.map((p) => p.etag), ['etag-1', 'etag-2']);
});

test('access: read-only viewers cannot init; strangers see uniform 404s; foreign ids never resolve', async () => {
    const app = makeApp();
    // Read-only org viewer: visible app, but no write scope anywhere.
    state.canWrite = false;
    const ro = await initUpload(app, 96, { user: 'viewer-1', orgIds: [ORG] });
    assert.strictEqual(ro.statusCode, 404, 'uniform 404 — upload permission never leaks');
    state.canWrite = true;

    // A stranger outside the audience cannot even list.
    const stranger = await dispatch(getReq(`/${app.id}/large-datasets`, { user: 'stranger', orgIds: [] }));
    assert.strictEqual(stranger.statusCode, 404);

    // A dataset id from ANOTHER app never resolves.
    const { body: { datasetId } } = await initUpload(app, 96);
    const otherApp = makeApp();
    const cross = await dispatch(getReq(`/${otherApp.id}/large-datasets/${datasetId}`));
    assert.strictEqual(cross.statusCode, 404);
});

test('status endpoints expose the public projection, not manifest internals', async () => {
    const app = makeApp();
    const { body: { datasetId } } = await initUpload(app, 96);
    const row = rows.get(datasetId);
    row.status = 'ready';
    row.dataBytes = 40; row.variantCount = 12;
    row.metadata = { build: 'GRCh38', samples: ['ME'], contigs: [{ name: 'chr1' }] };

    const single = await dispatch(getReq(`/${app.id}/large-datasets/${datasetId}`));
    assert.strictEqual(single.statusCode, 200);
    assert.deepStrictEqual(Object.keys(single.body).sort(), [
        'build', 'bytes', 'contigCount', 'createdAt', 'error', 'id', 'kind', 'name',
        'progressNote', 'progressPct', 'readyAt', 'sampleCount', 'status', 'variantCount',
    ]);
    assert.strictEqual(single.body.bytes, 40, 'ready rows report their real post-ingest size');
    assert.strictEqual(single.body.sampleCount, 1);
    assert.strictEqual(single.body.build, 'GRCh38');
    assert.strictEqual(single.body.uploadState, undefined, 'multipart internals never leave the server');

    const list = await dispatch(getReq(`/${app.id}/large-datasets`));
    assert.strictEqual(list.body.datasets.length, 1);
});

test('delete: aborts a live multipart upload and clears every artifact key', async () => {
    const app = makeApp();
    const { body: { datasetId } } = await initUpload(app, 96);
    const row = rows.get(datasetId);
    row.dataKey = `studio-apps/${OWNER}/${app.id}/datasets/${datasetId}/data.bgz`;
    row.indexKey = `studio-apps/${OWNER}/${app.id}/datasets/${datasetId}/index.bin`;
    row.rsidPrefix = `studio-apps/${OWNER}/${app.id}/datasets/${datasetId}/rsid`;

    const r = await dispatch(bodyReq(`/${app.id}/large-datasets/${datasetId}`, { method: 'DELETE' }));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(storage.aborts.length, 1, 'uploading state aborts the multipart upload');
    assert.ok(storage.deletes.includes(row.dataKey));
    assert.ok(storage.deletes.includes(row.indexKey));
    assert.strictEqual(storage.deletes.filter((k) => k.includes('/rsid/')).length, 64, 'all 64 shards swept');
    assert.strictEqual(rows.size, 0);
});

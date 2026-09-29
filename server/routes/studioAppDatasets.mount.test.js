/**
 * The BI-dataset router and the large-dataset router, mounted TOGETHER.
 *
 * Each router has its own test file, and each is green on its own. What those
 * files cannot see is the mount: server/index.js puts routes/studioAppData.js
 * (saved BI aggregates) and routes/studioAppDatasets.js (multi-GB genome
 * uploads) on the same /api/studio-apps prefix, and Express answers a request
 * with the FIRST route that matches it. When both claimed /:id/datasets, the BI
 * router, mounted first, answered the genome upload's init with an empty BI
 * dataset and no `datasetId`; the client then sent its parts and its complete
 * to …/datasets/undefined/…, and the list and the delete of a large dataset
 * reached the BI store too. No large dataset could ever be uploaded.
 *
 * So here both REAL routers sit behind one real Express app, on a real socket,
 * with only the stores stubbed. Each mount is tagged, so every response says
 * which router produced it (`x-answered-by`). Every route is tried in the
 * index.js order AND reversed: a fix that only held for one mount order would
 * be a fix that the next reshuffle of index.js undoes.
 *
 * The large-dataset URLs in the per-order tests are read off the router's own
 * route table, so they test the reachability of whatever path it declares;
 * those went red on the shared path and green on /large-datasets unchanged.
 * The tests after those use the URLs exactly as the client builds them
 * (agent-hub …/runtime/useDatasetUpload.js and components/AppDatasetUpload.jsx)
 * and walk the whole upload: init → parts → complete → list → delete. The
 * last two ask whose the file is once a member can upload one: hers, and
 * nobody else's, not even the app owner's (appStudio/datasetAccess.js).
 *
 * Run: cd server && node --test routes/studioAppDatasets.mount.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// Tiny parts so a three-part upload fits in a test. Read by the router AT LOAD.
process.env.DATASET_PART_BYTES = '64';
process.env.STUDIO_APP_DATASET_MAX_FILE_BYTES = '500';
process.env.STUDIO_APP_DATASET_TOTAL_BYTES = '100000';
process.env.STUDIO_APP_DATASET_MAX_FILES = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

function stub(request, exports) {
    const filename = require.resolve(request);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Stubbed state ───────────────────────────────────────────────────
const OWNER = 'owner-1';
const VIEWER = 'viewer-1';
const ORG = 'org-1';

const apps = new Map();
/** BI saved datasets (studioAppDataStore), and every call that reached them. */
const bi = { rows: new Map(), calls: [] };
/** Large-dataset manifests (datasetFileStore), and every call that reached them. */
const large = { rows: new Map(), calls: [] };
const storage = { begins: [], parts: [], completes: [], aborts: [], deletes: [] };

function canReadStudioApp(app, userId, _groups = [], orgIds = []) {
    if (!app) return false;
    if (app.userId === userId) return true;
    if (!app.isPublished || !app.organizationId) return false;
    return [...(orgIds || [])].includes(app.organizationId);
}

stub('../stores/userStore', { getUser: async (id) => ({ id }), touchLastSeen: async () => {} });
stub('../stores/studioAppStore', {
    getStudioApp: async (id) => apps.get(id) || null,
    canReadStudioApp,
    canReadStudioAppAsync: async (...a) => canReadStudioApp(...a),
    canWriteStudioApp: (app, userId) => !!app && app.userId === userId,
});

// One table every org member may add rows to: that is what lets a viewer
// upload (attachmentAccess.roleMayWriteSomewhere).
const MODEL = {
    roles: [{ key: 'member' }],
    roleMapping: { default: 'member', byGroup: {} },
    tables: [{
        id: 'tbl_rows', key: 'rows', name: 'Rows', fields: [],
        access: { default: 'none', roles: { member: { read: 'own', create: true, update: 'own', delete: 'none' } }, rowFilters: {} },
    }],
};
let biSeq = 0;
stub('../stores/studioAppDataStore', {
    getDataModel: async (appId, ownerId) => ({ appId, ownerUserId: ownerId, model: MODEL, modelVersion: 1 }),
    getMemberRole: async () => null,
    listDatasets: async (appId) => {
        bi.calls.push(['list', appId]);
        return [...bi.rows.values()].filter((d) => d.appId === appId);
    },
    createDataset: async (appId, _ownerId, fields) => {
        bi.calls.push(['create', appId]);
        const row = { id: `bi_${++biSeq}`, appId, ...fields };
        bi.rows.set(row.id, row);
        return row;
    },
    updateDataset: async (id, appId, _ownerId, updates) => {
        bi.calls.push(['update', id]);
        const row = bi.rows.get(id);
        if (!row || row.appId !== appId) return null;
        return Object.assign(row, updates);
    },
    deleteDataset: async (id, appId) => {
        bi.calls.push(['delete', id]);
        const row = bi.rows.get(id);
        if (!row || row.appId !== appId) return false;
        bi.rows.delete(id);
        return true;
    },
    invalidateCache: async () => {},
});
stub('../stores/studioAppDbStore', { query: async () => ({ rows: [] }), exec: async () => ({ changes: 0 }), sizeBytes: async () => 0 });
stub('../stores/storageStore', {
    isAvailable: () => true,
    buildStudioAppDatasetKey: (ownerId, appId, dsId, artifact) => `studio-apps/${ownerId}/${appId}/datasets/${dsId}/${artifact}`,
    beginMultipartUpload: async (key) => { const uploadId = `mpu-${storage.begins.length + 1}`; storage.begins.push({ key, uploadId }); return { uploadId }; },
    uploadPartBuffer: async (key, uploadId, partNumber, buffer) => { storage.parts.push({ key, partNumber, size: buffer.length }); return { etag: `etag-${partNumber}` }; },
    completeMultipartUpload: async (key, uploadId, parts) => { storage.completes.push({ key, uploadId, parts }); },
    abortMultipartUpload: async (key, uploadId) => { storage.aborts.push({ key, uploadId }); },
    deleteFile: async (key) => { storage.deletes.push(key); },
});
// In memory, with the SQL store's sequential-parts contract.
stub('../stores/datasetFileStore', {
    createDataset: async (fields) => {
        large.calls.push(['create', fields.appId]);
        const row = { ...fields, status: 'uploading', partsDone: 0, dataBytes: null, metadata: null, variantCount: null, progressPct: null, progressNote: null, error: null, createdAt: new Date(), readyAt: null };
        large.rows.set(row.id, row);
        return row;
    },
    getDataset: async (id, appId, ownerId) => {
        const r = large.rows.get(id);
        return r && r.appId === appId && r.ownerId === ownerId ? r : null;
    },
    listDatasets: async (appId, ownerId) => {
        large.calls.push(['list', appId]);
        return [...large.rows.values()].filter((r) => r.appId === appId && r.ownerId === ownerId);
    },
    recordPart: async (id, appId, ownerId, n, etag) => {
        const r = large.rows.get(id);
        if (!r || r.status !== 'uploading' || r.partsDone !== n) return { ok: false, expected: r ? r.partsDone : null };
        r.partsDone += 1;
        r.uploadState.etags[String(n)] = etag;
        return { ok: true, partsDone: r.partsDone };
    },
    markUploaded: async (id) => { const r = large.rows.get(id); r.status = 'uploaded'; return true; },
    sumBytesForOwner: async () => 0,
    countForUploader: async () => 0,
    deleteDataset: async (id, appId, ownerId) => {
        large.calls.push(['delete', id]);
        const r = large.rows.get(id);
        if (!r || r.appId !== appId || r.ownerId !== ownerId) return null;
        large.rows.delete(id);
        return r;
    },
});
stub('../auth/audience', {
    resolveAudienceContext: async (req) => ({ userId: req.session?.user?.id || null, orgIds: new Set(req._testOrgIds), userGroups: [] }),
});

// The licence is granted — but only for the router that asks for it, so no
// other module in the tree gets a stubbed licence layer.
const LICENCE_ID = 'mock:studio-app-datasets-mount:license-middleware';
require.cache[LICENCE_ID] = {
    id: LICENCE_ID, filename: LICENCE_ID, loaded: true,
    exports: { requireFeature: () => (req, res, next) => next() },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithLicence(request, parent, ...rest) {
    if (request === '../license/middleware' && parent && /routes[\\/]studioAppDatasets\.js$/.test(parent.filename)) {
        return LICENCE_ID;
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const biRouter = require('./studioAppData');
const largeRouter = require('./studioAppDatasets');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

// ── The app: index.js's shape, reduced to what these routes touch ───
// The two mounts in the order server/index.js has them, and that order reversed.
const INDEX_ORDER = [['studioAppData', biRouter], ['studioAppDatasets', largeRouter]];
const ORDERS = {
    'index.js order': INDEX_ORDER,
    reversed: [...INDEX_ORDER].reverse(),
};

function buildApp(mounts) {
    const app = express();
    app.use(express.json({ limit: '20mb' })); // index.js's global JSON parser
    app.use((req, res, next) => {
        req.session = { isAuthenticated: true, user: { id: req.get('x-test-user') || OWNER } };
        req._testOrgIds = (req.get('x-test-orgs') || '').split(',').filter(Boolean);
        next();
    });
    for (const [name, router] of mounts) {
        // The mount gates (requireModule, requireCapability) are the same for
        // both routers; what matters here is which one answers.
        app.use('/api/studio-apps', (req, res, next) => { res.setHeader('x-answered-by', name); next(); }, router);
    }
    app.use((req, res) => { res.setHeader('x-answered-by', 'nobody'); res.status(404).json({ error: 'no route' }); });
    app.use(terminalErrorHandler);
    return app;
}

const servers = {};
before(async () => {
    for (const [label, mounts] of Object.entries(ORDERS)) {
        const server = buildApp(mounts).listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        servers[label] = { server, base: `http://127.0.0.1:${server.address().port}` };
    }
});
after(async () => {
    Module._resolveFilename = originalResolve;
    await Promise.all(Object.values(servers).map(({ server }) => new Promise((resolve) => server.close(resolve))));
});

async function call(order, method, url, { json, raw, user = OWNER, orgs = [] } = {}) {
    const headers = { 'x-test-user': user, 'x-test-orgs': orgs.join(',') };
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (raw !== undefined) { headers['content-type'] = 'application/octet-stream'; body = raw; }
    const res = await fetch(`${servers[order].base}${url}`, { method, headers, body });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON: keep the text */ }
    return { status: res.status, by: res.headers.get('x-answered-by'), body: parsed };
}

// ── Fixtures ────────────────────────────────────────────────────────
let appSeq = 0;
/** A fresh app per test: the dataset rate limits are keyed per (user, app). */
function makeApp() {
    const app = { id: `app-${++appSeq}`, userId: OWNER, organizationId: ORG, isPublished: true, name: 'Genome app' };
    apps.set(app.id, app);
    return app;
}

/** A manifest row as init leaves it: uploading, nothing received yet. */
function seedManifest(app, { bytes = 96 } = {}) {
    const id = crypto.randomUUID();
    large.rows.set(id, {
        id, appId: app.id, ownerId: app.userId, orgId: ORG, uploaderId: app.userId, name: 'me.vcf', kind: 'vcf',
        declaredBytes: bytes, partSize: 64, partsTotal: Math.ceil(bytes / 64), partsDone: 0,
        uploadState: { s3UploadId: 'mpu-seeded', etags: {} }, rawKey: `studio-apps/${app.userId}/${app.id}/datasets/${id}/raw`,
        status: 'uploading', dataBytes: null, metadata: null, variantCount: null, progressPct: null,
        progressNote: null, error: null, createdAt: new Date(), readyAt: null,
    });
    return id;
}

/** Part 0 must open like a VCF (the head sniff); padded to the exact part size. */
function vcfPart0(size = 64) {
    const head = Buffer.from('##fileformat=VCFv4.2\n##x=');
    return Buffer.concat([head, Buffer.alloc(size - head.length, 0x61)]);
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── The large-dataset router's own route table ──────────────────────
// Its six routes, by what each one is for. Anything else it declares is named
// by method and path, so a seventh route makes the table test below fail
// instead of going untested.
function declaredRoutes(router) {
    return router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => ({ method: m.toUpperCase(), path: layer.route.path })));
}
function purposeOf({ method, path }) {
    if (method === 'PUT' && path.endsWith('/parts/:n')) return 'part';
    if (method === 'POST' && path.endsWith('/complete')) return 'complete';
    const item = path.includes(':datasetId');
    if (method === 'POST' && !item) return 'init';
    if (method === 'GET') return item ? 'single' : 'list';
    if (method === 'DELETE' && item) return 'delete';
    return `${method} ${path}`;
}
const LARGE_ROUTES = Object.fromEntries(declaredRoutes(largeRouter).map((r) => [purposeOf(r), r]));

function fill(path, { appId, datasetId = crypto.randomUUID(), n = 0 }) {
    return `/api/studio-apps${path.replace(':id', appId).replace(':datasetId', datasetId).replace(':n', String(n))}`;
}

/** The request each large route is for, well-formed, against a seeded manifest. */
function largeRequest(purpose, app) {
    const datasetId = seedManifest(app);
    const url = fill(LARGE_ROUTES[purpose].path, { appId: app.id, datasetId });
    const bodies = {
        init: { json: { name: 'me.vcf', bytes: 96, kind: 'vcf' } },
        part: { raw: vcfPart0() },
        complete: { json: {} },
    };
    return [LARGE_ROUTES[purpose].method, url, bodies[purpose] || {}];
}

// ═══ The tests ══════════════════════════════════════════════════════

test('the large-dataset router declares the six routes the client protocol needs', () => {
    assert.deepEqual(Object.keys(LARGE_ROUTES).sort(), ['complete', 'delete', 'init', 'list', 'part', 'single']);
});

for (const order of Object.keys(ORDERS)) {
    test(`${order}: every large-dataset route is answered by studioAppDatasets`, async () => {
        const answered = {};
        for (const purpose of Object.keys(LARGE_ROUTES).sort()) {
            const [method, url, opts] = largeRequest(purpose, makeApp());
            answered[purpose] = (await call(order, method, url, opts)).by;
        }
        assert.deepEqual(answered, {
            complete: 'studioAppDatasets', delete: 'studioAppDatasets', init: 'studioAppDatasets',
            list: 'studioAppDatasets', part: 'studioAppDatasets', single: 'studioAppDatasets',
        });
    });

    test(`${order}: every BI dataset route is still answered by studioAppData, on its own path`, async () => {
        const app = makeApp();
        const base = `/api/studio-apps/${app.id}/datasets`;
        const largeCallsBefore = large.calls.length;
        const created = await call(order, 'POST', base, { json: { name: 'Overdue invoices', tableId: 'tbl_rows', descriptor: { groupBy: [] } } });
        const id = created.body?.dataset?.id;
        const answered = {
            create: `${created.by} ${created.status}`,
            list: await call(order, 'GET', base).then((r) => `${r.by} ${r.status} ${JSON.stringify(r.body?.datasets?.map((d) => d.id))}`),
            update: await call(order, 'PUT', `${base}/${id}`, { json: { name: 'Overdue' } }).then((r) => `${r.by} ${r.status}`),
            delete: await call(order, 'DELETE', `${base}/${id}`).then((r) => `${r.by} ${r.status}`),
        };
        assert.deepEqual(answered, {
            create: 'studioAppData 200',
            list: `studioAppData 200 ${JSON.stringify([id])}`,
            update: 'studioAppData 200',
            delete: 'studioAppData 200',
        });
        assert.equal(bi.rows.has(id), false, 'the BI dataset the test made is gone again');
        assert.deepEqual(large.calls.slice(largeCallsBefore), [], 'no BI request reached the manifest store');
    });

    test(`${order}: the upload the client drives reaches the large-dataset router at every step`, async () => {
        const app = makeApp();
        // The client continues from init's answer: base + /<datasetId>/parts/<n>.
        const base = fill(LARGE_ROUTES.init.path, { appId: app.id });
        const steps = {};

        const init = await call(order, 'POST', base, { json: { name: 'me.vcf', bytes: 96, kind: 'vcf' } });
        const { datasetId } = init.body || {};
        steps.init = `${init.by} ${init.status} ${UUID_RX.test(String(datasetId)) ? 'datasetId' : 'no datasetId'}`;
        const part0 = await call(order, 'PUT', `${base}/${datasetId}/parts/0`, { raw: vcfPart0() });
        steps.part0 = `${part0.by} ${part0.status}`;
        const part1 = await call(order, 'PUT', `${base}/${datasetId}/parts/1`, { raw: Buffer.alloc(32, 0x61) });
        steps.part1 = `${part1.by} ${part1.status}`;
        const complete = await call(order, 'POST', `${base}/${datasetId}/complete`, { json: {} });
        steps.complete = `${complete.by} ${complete.status}`;
        const list = await call(order, 'GET', base);
        steps.list = `${list.by} ${list.status} ${JSON.stringify((list.body?.datasets || []).map((d) => d.status))}`;
        const del = await call(order, 'DELETE', `${base}/${datasetId}`);
        steps.delete = `${del.by} ${del.status}`;

        assert.deepEqual(steps, {
            init: 'studioAppDatasets 200 datasetId',
            part0: 'studioAppDatasets 200',
            part1: 'studioAppDatasets 200',
            complete: 'studioAppDatasets 200',
            list: 'studioAppDatasets 200 ["uploaded"]',
            delete: 'studioAppDatasets 200',
        });
        assert.equal(large.rows.has(datasetId), false, 'the manifest is deleted');
    });
}

// ── The whole upload, at the URLs the client builds ─────────────────
// useDatasetUpload.js: `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/large-datasets`,
// then `${base}/${datasetId}/parts/${n}` and `${base}/${datasetId}/complete`;
// AppDatasetUpload.jsx polls the same base and `${base}/${datasetId}`.
const clientBase = (appId) => `/api/studio-apps/${encodeURIComponent(appId)}/large-datasets`;

test('index.js order: a three-part genome upload, start to finish, never touches a BI dataset', async () => {
    const app = makeApp();
    const base = clientBase(app.id);
    const biCallsBefore = bi.calls.length;
    const partsBefore = storage.parts.length;

    const init = await call('index.js order', 'POST', base, { json: { name: 'me.vcf', bytes: 160, kind: 'vcf' } });
    assert.equal(init.status, 200, JSON.stringify(init.body));
    assert.equal(init.by, 'studioAppDatasets');
    const { datasetId, partSize, partsTotal } = init.body;
    assert.match(datasetId, UUID_RX);
    assert.deepEqual({ partSize, partsTotal }, { partSize: 64, partsTotal: 3 });

    // The parts, as the client slices them: 64 + 64 + 32 bytes.
    const slices = [vcfPart0(), Buffer.alloc(64, 0x62), Buffer.alloc(32, 0x63)];
    for (const [n, slice] of slices.entries()) {
        const part = await call('index.js order', 'PUT', `${base}/${datasetId}/parts/${n}`, { raw: slice });
        assert.equal(part.status, 200, `part ${n}: ${JSON.stringify(part.body)}`);
        assert.equal(part.body.partsDone, n + 1);
    }
    assert.deepEqual(storage.parts.slice(partsBefore).map((p) => [p.partNumber, p.size]), [[1, 64], [2, 64], [3, 32]]);

    const done = await call('index.js order', 'POST', `${base}/${datasetId}/complete`, { json: {} });
    assert.deepEqual([done.status, done.body], [200, { ok: true, status: 'uploaded' }]);
    assert.deepEqual(storage.completes.at(-1).parts.map((p) => p.etag), ['etag-1', 'etag-2', 'etag-3']);

    // The picker's list and the status poll see it, in the public projection.
    const list = await call('index.js order', 'GET', base);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.datasets.map((d) => [d.id, d.name, d.status]), [[datasetId, 'me.vcf', 'uploaded']]);
    assert.equal(list.body.datasets[0].uploadState, undefined, 'multipart internals never leave the server');
    const single = await call('index.js order', 'GET', `${base}/${datasetId}`);
    assert.deepEqual([single.status, single.body.id, single.body.status], [200, datasetId, 'uploaded']);

    const del = await call('index.js order', 'DELETE', `${base}/${datasetId}`);
    assert.deepEqual([del.status, del.body], [200, { ok: true }]);
    assert.equal(large.rows.has(datasetId), false, 'the manifest is gone');
    assert.ok(storage.deletes.includes(`studio-apps/${OWNER}/${app.id}/datasets/${datasetId}/raw`), 'and so is the raw upload');
    const afterDelete = await call('index.js order', 'GET', base);
    assert.deepEqual(afterDelete.body.datasets, []);

    assert.deepEqual(bi.calls.slice(biCallsBefore), [], 'not one request reached the BI dataset store');
});

test('index.js order: an org member who may add rows can start an upload (the BI route gave 403)', async () => {
    const app = makeApp();
    const init = await call('index.js order', 'POST', clientBase(app.id), {
        json: { name: 'mine.vcf', bytes: 64, kind: 'vcf' }, user: VIEWER, orgs: [ORG],
    });
    assert.equal(init.status, 200, JSON.stringify(init.body));
    assert.match(init.body.datasetId, UUID_RX);
    const row = large.rows.get(init.body.datasetId);
    assert.deepEqual([row.uploaderId, row.ownerId], [VIEWER, OWNER], 'the viewer uploads into the owner\'s envelope');

    const list = await call('index.js order', 'GET', clientBase(app.id), { user: VIEWER, orgs: [ORG] });
    assert.deepEqual(list.body.datasets.map((d) => d.id), [init.body.datasetId]);
});

// ── Whose a genome file is ──────────────────────────────────────────
// The test above is why this one exists. Once a member's upload works, a
// second member of the same app, or the app's owner, must not be able to find
// it, poll it, or write into it. The owner lends the storage; the genome stays
// the member's. The owner may still delete it: removing is not reading.
const ALICE = 'member-alice';
const BOB = 'member-bob';

/** One person's call on the index.js-ordered app. Members reach the app through the org. */
function as(user, method, url, opts = {}) {
    return call('index.js order', method, url, { user, orgs: user === OWNER ? [] : [ORG], ...opts });
}

test('index.js order: nobody else writes into a member\'s upload while it is under way', async () => {
    const app = makeApp();
    const base = clientBase(app.id);
    const init = await as(ALICE, 'POST', base, { json: { name: 'alice.vcf', bytes: 96, kind: 'vcf' } });
    assert.equal(init.status, 200, JSON.stringify(init.body));
    const id = init.body.datasetId;

    const tried = {};
    for (const user of [BOB, OWNER]) {
        tried[user] = {
            part: (await as(user, 'PUT', `${base}/${id}/parts/0`, { raw: vcfPart0() })).status,
            complete: (await as(user, 'POST', `${base}/${id}/complete`, { json: {} })).status,
        };
    }
    assert.deepEqual(tried, {
        [BOB]: { part: 404, complete: 404 },
        [OWNER]: { part: 404, complete: 404 },
    });
    assert.equal(large.rows.get(id).partsDone, 0, 'not one foreign byte landed in her file');

    // Alice carries on where she was.
    assert.equal((await as(ALICE, 'PUT', `${base}/${id}/parts/0`, { raw: vcfPart0() })).status, 200);
});

test('index.js order: a member\'s ready genome file is listed and polled by her alone', async () => {
    const app = makeApp();
    const base = clientBase(app.id);
    const init = await as(ALICE, 'POST', base, { json: { name: 'alice.vcf', bytes: 64, kind: 'vcf' } });
    const id = init.body.datasetId;
    assert.equal((await as(ALICE, 'PUT', `${base}/${id}/parts/0`, { raw: vcfPart0() })).status, 200);
    assert.equal((await as(ALICE, 'POST', `${base}/${id}/complete`, { json: {} })).status, 200);
    large.rows.get(id).status = 'ready'; // what the ingest job does next

    const listed = async (user) => {
        const r = await as(user, 'GET', base);
        return `${r.status} ${JSON.stringify((r.body?.datasets || []).map((d) => d.name))}`;
    };
    const seen = {
        aliceList: await listed(ALICE),
        aliceSingle: (await as(ALICE, 'GET', `${base}/${id}`)).status,
        bobList: await listed(BOB),
        bobSingle: (await as(BOB, 'GET', `${base}/${id}`)).status,
        bobDelete: (await as(BOB, 'DELETE', `${base}/${id}`)).status,
        ownerList: await listed(OWNER),
        ownerSingle: (await as(OWNER, 'GET', `${base}/${id}`)).status,
    };
    assert.deepEqual(seen, {
        aliceList: '200 ["alice.vcf"]',
        aliceSingle: 200,
        bobList: '200 []',
        bobSingle: 404,
        bobDelete: 404,
        ownerList: '200 []',
        ownerSingle: 404,
    });
    assert.ok(large.rows.has(id), 'Bob\'s delete removed nothing');

    // The owner frees the storage it occupies without ever having read it.
    assert.equal((await as(OWNER, 'DELETE', `${base}/${id}`)).status, 200);
    assert.equal(large.rows.has(id), false);
});

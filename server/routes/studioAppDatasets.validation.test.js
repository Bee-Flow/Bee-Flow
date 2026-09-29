/**
 * What the large-dataset routes accept, what they say when they refuse, and
 * which requests their licence gate may touch (routes/studioAppDatasets.js).
 *
 * The gate was a path-less `router.use`, so it answered 403 `large_datasets`
 * to requests meant for the routers mounted after this one on /api/studio-apps
 * — the AI-browse step stream among them. And the handlers repaired what they
 * were sent: `bytes: true` became a one-byte dataset, part `1abc` was stored
 * as part 1, and a malformed dataset id reached Postgres and came back a 500.
 * What this file pins:
 *
 *   - a request for another router passes through, licence or not;
 *   - the 400 NAMES the field (`params.n`, `body.bytes`, …), in a sentence;
 *   - the stores are never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/studioAppDatasets.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const licence = { allowed: true };
const touch = (what, value) => async (...args) => { touched.push({ what, args }); return value; };

const APP = { id: 'app1', userId: 'owner', organizationId: 'org1', isPublished: true };
const DS_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const MOCKS = {
    '../stores/studioAppStore': {
        getStudioApp: touch('getStudioApp', APP),
        canReadStudioAppAsync: async () => true,
    },
    '../stores/studioAppDataStore': { getDataModel: async () => null },
    '../stores/storageStore': {
        isAvailable: () => true,
        buildStudioAppDatasetKey: (o, a, d, k) => `${o}/${a}/${d}/${k}`,
        beginMultipartUpload: touch('beginMultipartUpload', { uploadId: 'mpu-1' }),
        deleteFile: touch('deleteFile'),
        abortMultipartUpload: touch('abortMultipartUpload'),
    },
    '../stores/datasetFileStore': {
        countForUploader: async () => 0,
        sumBytesForOwner: async () => 0,
        createDataset: touch('createDataset', { id: DS_ID }),
        getDataset: touch('getDataset', null),
        listDatasets: touch('listDatasets', []),
        deleteDataset: touch('deleteDataset'),
    },
    '../appStudio/rlsGateway': { resolveViewerRole: async () => null },
    '../appStudio/attachmentAccess': { roleMayWriteSomewhere: () => false },
    '../auth/permissions': { requireAuth: pass },
    '../auth/audience': { resolveAudienceContext: async () => ({ orgIds: new Set(['org1']), userGroups: [] }) },
    '../license/middleware': {
        requireFeature: (feature) => (req, res, next) => (licence.allowed
            ? next()
            : res.status(403).json({ error: 'feature_locked', feature })),
    },
    './studioAppRateLimits': {
        datasetInitLimiter: pass, datasetPartLimiter: pass, datasetCompleteLimiter: pass, datasetStatusLimiter: pass,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:studio-app-datasets-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]studioAppDatasets\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./studioAppDatasets');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

/** → the response, or `'passed'` when the router let the request through untouched. */
function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query,
            // No content-length: express.json() leaves the pre-set body alone.
            headers: { 'content-type': 'application/json' },
            session: { isAuthenticated: true, user: { id: 'owner' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            setHeader() {},
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return resolve('passed');
            return terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; licence.allowed = true; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.notStrictEqual(res, 'passed', `${request.method} ${request.url} fell through`);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach a store');
    return res;
}

// ── The licence gate ────────────────────────────────────────────────

test('without the licence, a request for a router mounted after this one passes through untouched', async () => {
    licence.allowed = false;
    for (const url of ['/app1/actions/act1/step/stream', '/app1/data/attachments', '/nope']) {
        assert.strictEqual(await dispatch({ method: 'POST', url, body: {} }), 'passed', url);
    }
});

test('without the licence, every dataset route is still refused', async () => {
    licence.allowed = false;
    for (const [method, url] of [
        ['POST', '/app1/large-datasets'], ['GET', '/app1/large-datasets'], ['GET', `/app1/large-datasets/${DS_ID}`],
        ['PUT', `/app1/large-datasets/${DS_ID}/parts/0`], ['POST', `/app1/large-datasets/${DS_ID}/complete`],
        ['DELETE', `/app1/large-datasets/${DS_ID}`],
    ]) {
        const res = await dispatch({ method, url, body: {} });
        assert.strictEqual(res.statusCode, 403, `${method} ${url}`);
        assert.strictEqual(res.body.feature, 'large_datasets');
    }
    assert.deepStrictEqual(touched, []);
});

// ── Path params ─────────────────────────────────────────────────────

test('a part number parseInt would have "repaired" is refused, in the same sentence every time', async () => {
    for (const n of ['1abc', '1.5', '-1', '0x1']) {
        const res = await refuses({ method: 'PUT', url: `/app1/large-datasets/${DS_ID}/parts/${n}` }, 'params.n');
        assert.strictEqual(res.body.error, 'The part number is a whole number: 0, 1, 2, …', n);
    }
});

test('a dataset id that is not a UUID is a 400 by name, not a Postgres error', async () => {
    for (const [method, url] of [
        ['GET', '/app1/large-datasets/not-a-uuid'], ['DELETE', '/app1/large-datasets/42'],
        ['POST', '/app1/large-datasets/x/complete'], ['PUT', '/app1/large-datasets/x/parts/0'],
    ]) {
        const res = await refuses({ method, url, body: {} }, 'params.datasetId');
        assert.strictEqual(res.body.error, 'That is not a dataset id: a dataset id is a UUID.');
    }
});

// ── Query ───────────────────────────────────────────────────────────

test('a filter the list does not have is refused, not ignored', async () => {
    await refuses({ method: 'GET', url: '/app1/large-datasets?status=ready' }, 'query');
});

// ── Bodies ──────────────────────────────────────────────────────────

test('a size that is not a number is refused, instead of Number() making one of it', async () => {
    for (const bytes of [true, '12', [12], 1.5, 0, -3]) {
        const res = await refuses({ method: 'POST', url: '/app1/large-datasets', body: { name: 'me.vcf', bytes } }, 'body.bytes');
        assert.strictEqual(res.body.error, 'bytes is the size of the file in bytes: a whole number above 0.', JSON.stringify(bytes));
    }
});

test('a missing, non-text or oversized name is refused in words', async () => {
    const missing = await refuses({ method: 'POST', url: '/app1/large-datasets', body: { bytes: 10 } }, 'body.name');
    assert.strictEqual(missing.body.error, 'A dataset needs a name; the file name will do.');
    await refuses({ method: 'POST', url: '/app1/large-datasets', body: { name: { a: 1 }, bytes: 10 } }, 'body.name');
    const long = await refuses({ method: 'POST', url: '/app1/large-datasets', body: { name: 'x'.repeat(256), bytes: 10 } }, 'body.name');
    assert.strictEqual(long.body.error, 'A dataset name is at most 255 characters.');
});

test('an unknown kind is refused in a sentence, not in enum internals', async () => {
    const res = await refuses({ method: 'POST', url: '/app1/large-datasets', body: { name: 'me.bam', bytes: 10, kind: 'bam' } }, 'body.kind');
    assert.strictEqual(res.body.error, 'kind is "vcf": that is the only kind of dataset so far.');
});

test('/complete takes an empty body: a checksum it never verifies is refused, not ignored', async () => {
    await refuses({ method: 'POST', url: `/app1/large-datasets/${DS_ID}/complete`, body: { sha256: 'ab'.repeat(32) } }, 'body');
});

test('a well-formed init still starts the upload, with the name trimmed once', async () => {
    const res = await dispatch({ method: 'POST', url: '/app1/large-datasets', body: { name: '  me.vcf ', bytes: 100, kind: 'vcf' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const created = touched.find((t) => t.what === 'createDataset');
    assert.strictEqual(created.args[0].name, 'me.vcf');
    assert.strictEqual(created.args[0].kind, 'vcf');
    assert.strictEqual(created.args[0].declaredBytes, 100);
});

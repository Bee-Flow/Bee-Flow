/**
 * What the App Studio attachment routes accept, and what they say when they
 * refuse (routes/studioAppFiles.js).
 *
 * The upload cut a long `recordId` to 200 characters and linked the file to a
 * record that does not exist; materialize dropped a misspelled or non-text
 * `tableId` and searched every table; a query parameter was ignored
 * everywhere. What this file pins:
 *
 *   - the 400 NAMES the field (`body.recordId`, `query`, …), in a sentence;
 *   - params and query are checked before the upload guard reads a file;
 *   - the stores are never reached, so a refused request changes nothing;
 *   - the upload's file stays the guard's: only its text fields are schema'd.
 *
 * Run: cd server && node --test routes/studioAppFiles.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const touch = (what, value) => async (...args) => { touched.push({ what, args }); return value; };

const APP = { id: 'app1', userId: 'owner', organizationId: 'org1', isPublished: true };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const MOCKS = {
    '../stores/studioAppStore': {
        getStudioApp: touch('getStudioApp', APP),
        canReadStudioAppAsync: async () => true,
    },
    '../stores/studioAppDataStore': {
        getDataModel: async () => ({ model: { tables: [] } }),
        addAttachment: async (appId, ownerId, rec) => {
            touched.push({ what: 'addAttachment', args: [appId, ownerId, rec] });
            return { id: 'att-1', recordId: rec.recordId, fieldKey: rec.fieldKey, mimeType: rec.mimeType, size: rec.size, sha256: rec.sha256 };
        },
        setAttachmentScan: async () => ({}),
        getAttachment: touch('getAttachment', null),
        deleteAttachment: touch('deleteAttachment', true),
        countAttachmentsBySha: async () => 0,
    },
    '../stores/storageStore': {
        isAvailable: () => true,
        buildStudioAppAttachmentKey: (o, a, sha) => `${o}/${a}/${sha}`,
        uploadFile: touch('uploadFile'),
        deleteFile: touch('deleteFile'),
        streamFile: touch('streamFile'),
    },
    '../core/cad/cadRender': { renderCadSheet: touch('renderCadSheet') },
    '../core/cad/dxfRender': { renderDxfSheet: touch('renderDxfSheet') },
    '../appStudio/rlsGateway': { resolveViewerRole: async () => 'member' },
    '../appStudio/attachmentAccess': { roleMayWriteSomewhere: () => true, viewerMayReadAttachment: async () => true },
    '../appStudio/studioAppQuota': { assertAttachmentQuota: async () => {} },
    '../appStudio/mailboxAttachments': {
        assertAttachmentTotalBytes: async () => {},
        materializeAttachment: touch('materializeAttachment', { kind: 'studio_attachment', fileId: 'att-9' }),
    },
    // Stands in for multer: the file arrives, and the text fields are the
    // ones the test pre-set on req.body — exactly what multer leaves there.
    '../middleware/uploadGuard': {
        uploadGuard: () => (req, res, next) => {
            touched.push({ what: 'guard' });
            req.file = { buffer: PNG, size: PNG.length, mimetype: 'image/png' };
            next();
        },
        scanBuffer: async () => ({ clean: true }),
    },
    '../appStudio/dataModel': { DATA_LIMITS: { MAX_ATTACHMENT_BYTES: 1024 } },
    '../auth/audience': { resolveAudienceContext: async () => ({ orgIds: new Set(['org1']), userGroups: [] }) },
    '../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../auth/permissions': { requireAuth: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:studio-app-files-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]studioAppFiles\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./studioAppFiles');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            return terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    return res;
}
const nothingStored = () => assert.deepStrictEqual(
    touched.filter((t) => t.what !== 'guard' && t.what !== 'getStudioApp'), [],
    'a refused request must not reach a store',
);

// ── Upload ──────────────────────────────────────────────────────────

test('a record id longer than the ledger keeps is refused, not cut into a record that does not exist', async () => {
    const res = await refuses({ method: 'POST', url: '/app1/data/attachments', body: { recordId: 'r'.repeat(250) } }, 'body.recordId');
    assert.match(res.body.error, /^recordId is the id of the record/);
    nothingStored();
});

test('a text field sent twice is refused, instead of landing the file unlinked', async () => {
    await refuses({ method: 'POST', url: '/app1/data/attachments', body: { fieldKey: ['photo', 'photo'] } }, 'body.fieldKey');
    nothingStored();
});

test('a field the upload does not take is refused', async () => {
    await refuses({ method: 'POST', url: '/app1/data/attachments', body: { tableId: 't1' } }, 'body');
    nothingStored();
});

test('a query parameter is refused before the guard reads a file', async () => {
    await refuses({ method: 'POST', url: '/app1/data/attachments?overwrite=1', body: {} }, 'query');
    assert.deepStrictEqual(touched, [], 'not even the guard ran');
});

test('an upload with its record link still lands, linked', async () => {
    const res = await dispatch({ method: 'POST', url: '/app1/data/attachments', body: { recordId: 'rec_1', fieldKey: 'photo' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const added = touched.find((t) => t.what === 'addAttachment').args[2];
    assert.strictEqual(added.recordId, 'rec_1');
    assert.strictEqual(added.fieldKey, 'photo');
});

// ── Stream, preview, delete ─────────────────────────────────────────

test('a query parameter on the stream, the preview or the delete is refused, not ignored', async () => {
    for (const [method, url] of [
        ['GET', '/app1/data/attachments/att-1?download=1'],
        ['GET', '/app1/data/attachments/att-1/preview?size=large'],
        ['DELETE', '/app1/data/attachments/att-1?force=1'],
    ]) {
        await refuses({ method, url }, 'query');
    }
    nothingStored();
});

test('a file id no ledger row could have is refused by name', async () => {
    const res = await refuses({ method: 'GET', url: `/app1/data/attachments/${'f'.repeat(201)}` }, 'params.fileId');
    assert.strictEqual(res.body.error, 'The file id is the id in the file\'s address.');
});

// ── Materialize ─────────────────────────────────────────────────────

test('a misspelled narrowing is refused, not dropped into a search of every table', async () => {
    await refuses({ method: 'POST', url: '/app1/data/attachments/materialize', body: { attachmentId: 'a1', tableID: 't1' } }, 'body');
    nothingStored();
});

test('a narrowing that is not text is refused by name', async () => {
    const res = await refuses({ method: 'POST', url: '/app1/data/attachments/materialize', body: { attachmentId: 'a1', tableId: 42 } }, 'body.tableId');
    assert.strictEqual(res.body.error, 'tableId narrows the search to one table: its id, as text.');
    nothingStored();
});

test('an attachment id that is there but not text is not called missing', async () => {
    const res = await refuses({ method: 'POST', url: '/app1/data/attachments/materialize', body: { attachmentId: 123 } }, 'body.attachmentId');
    assert.strictEqual(res.body.error, 'attachmentId is the id of the mail attachment to open.');
    const none = await refuses({ method: 'POST', url: '/app1/data/attachments/materialize', body: {} }, 'body.attachmentId');
    assert.strictEqual(none.body.error, 'attachmentId is the id of the mail attachment to open.');
    nothingStored();
});

test('the body the client sends still redeems the attachment', async () => {
    const res = await dispatch({ method: 'POST', url: '/app1/data/attachments/materialize', body: { attachmentId: 'a1', tableId: null } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const opts = touched.find((t) => t.what === 'materializeAttachment').args[2];
    assert.strictEqual(opts.attachmentId, 'a1');
    assert.strictEqual(opts.tableId, undefined);
    assert.strictEqual(opts.recordId, undefined);
});

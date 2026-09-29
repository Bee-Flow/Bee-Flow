/**
 * What the KB document routes accept, and what they say when they refuse
 * (routes/knowledgeBases/documents.js).
 *
 * The store drops a filter it does not recognise, so a list narrowed to the
 * failures answered with every document in the base: `?status=eror` (every
 * status filtered out, hence no status clause at all) and `?staus=error` (an
 * unknown key). A date that was not one reached Postgres as a timestamp cast
 * and came back as a 500, and so did a negative thread limit. Bulk delete
 * took the first 200 ids of a longer list, deleted those, and answered 200
 * for the lot. What this file pins:
 *
 *   - the 400 NAMES the field (`query.status`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/knowledgeBases/documents.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();
const KB = { id: 'kb1', tenant_id: 'u1', organization_id: 'orgA' };
const DOC_ID = '0b7e6a52-9d1c-4a6f-8f3e-2c1d5e7a9b10';

const MOCKS = {
    '../../stores/knowledgeBases': {
        DOC_STATUSES: ['processed', 'redacted', 'skipped', 'error', 'duplicate'],
        PII_STATUSES: ['none', 'found', 'redacted', 'unscanned'],
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return id === KB.id ? { ...KB } : null; },
        listDocuments: async (id, opts) => { touched.push({ what: 'listDocuments', args: [id, opts] }); return []; },
        countDocuments: async () => 0,
        listThreads: async (id, opts) => { touched.push({ what: 'listThreads', args: [id, opts] }); return []; },
        getDocument: async (id) => { touched.push({ what: 'getDocument', args: [id] }); return { id, knowledge_base_id: KB.id }; },
        snapshotDocumentVersion: async () => {},
    },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    '../../core/kb/kbIngestionHelpers': {
        deleteDocumentChunks: async (kbId, docId) => { touched.push({ what: 'deleteDocumentChunks', args: [kbId, docId] }); },
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        blockIfSystemKB: () => false,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-documents-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]documents\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./documents');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    const [pathname, search = ''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const refusedAt = (res, path) => {
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.ok(res.body.details.some((d) => d.path === path), `the refusal names ${path}: ${JSON.stringify(res.body.details)}`);
    assert.notStrictEqual(res.body.error, 'Required');
    assert.deepStrictEqual(touched, [], 'a refused request reaches no store');
};

test.beforeEach(() => { touched.length = 0; });

// ── GET /:id/documents ──────────────────────────────────────────────

test('a misspelled status is refused instead of answering with every document', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/documents?status=eror' });
    refusedAt(res, 'query.status');
    assert.match(res.body.error, /status is one or more of/);
});

test('a misspelled filter KEY is refused instead of being ignored', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/documents?staus=error' });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('an unknown pii filter is refused instead of answering unfiltered', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/kb1/documents?pii=fond' }), 'query.pii');
});

test('a date that is not one is a 400, not a Postgres cast error', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/kb1/documents?dateFrom=yesterday' }), 'query.dateFrom');
});

test('hasAttachment is true or false, not "anything but true"', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/kb1/documents?hasAttachment=1' }), 'query.hasAttachment');
});

test('a page size that is not a number is refused; one out of range is clamped', async () => {
    refusedAt(await dispatch({ method: 'GET', url: '/kb1/documents?limit=all' }), 'query.limit');
    const res = await dispatch({ method: 'GET', url: '/kb1/documents?limit=1000&offset=-3' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.limit, 200);
    assert.strictEqual(res.body.offset, 0);
});

test('the filters the Agent Hub and mobile send still pass, and reach the store as filters', async () => {
    const url = '/kb1/documents?limit=50&offset=0&sender=anna&threadId=t1&hasAttachment=true'
        + '&dateFrom=2026-01-01&dateTo=2026-02-01&status=error,skipped&pii=found&q=invoice';
    const res = await dispatch({ method: 'GET', url });
    assert.strictEqual(res.statusCode, 200);
    const { filters, limit, offset } = touched.find((t) => t.what === 'listDocuments').args[1];
    assert.strictEqual(limit, 50);
    assert.strictEqual(offset, 0);
    assert.strictEqual(filters.status, 'error,skipped');
    assert.strictEqual(filters.pii, 'found');
    assert.strictEqual(filters.hasAttachment, true);
    assert.strictEqual(filters.dateFrom, '2026-01-01');
});

test('no query at all is the first page of 50', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/documents' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual([res.body.limit, res.body.offset], [50, 0]);
});

// ── POST /:id/documents/bulk-delete ─────────────────────────────────

test('bulk delete refuses 201 ids instead of deleting the first 200 under a 200', async () => {
    const ids = Array.from({ length: 201 }, () => DOC_ID);
    const res = await dispatch({ method: 'POST', url: '/kb1/documents/bulk-delete', body: { documentIds: ids } });
    refusedAt(res, 'body.documentIds');
    assert.match(res.body.error, /At most 200/);
});

test('bulk delete refuses an id that is not a document id instead of reporting a database error', async () => {
    refusedAt(await dispatch({
        method: 'POST', url: '/kb1/documents/bulk-delete', body: { documentIds: ['not-a-uuid'] },
    }), 'body.documentIds.0');
});

test('bulk delete with nothing to delete says so in words', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/kb1/documents/bulk-delete', body: {} }), 'body.documentIds');
    refusedAt(await dispatch({ method: 'POST', url: '/kb1/documents/bulk-delete', body: { documentIds: [] } }), 'body.documentIds');
});

test('bulk delete of real ids goes through', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/documents/bulk-delete', body: { documentIds: [DOC_ID] } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { deleted: 1, errors: [] });
});

// ── threads and chunks ──────────────────────────────────────────────

test('a negative thread limit is clamped instead of reaching Postgres as LIMIT -5', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/threads?limit=-5' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listThreads').args[1].limit, 1);
});

test('the chunk inspector and the content read refuse options they do not have', async () => {
    const chunks = await dispatch({ method: 'GET', url: `/kb1/documents/${DOC_ID}/chunks?limit=many` });
    refusedAt(chunks, 'query.limit');
    const content = await dispatch({ method: 'GET', url: `/kb1/documents/${DOC_ID}/content?full=1` });
    assert.strictEqual(content.statusCode, 400);
});

test('deleting one document takes no options', async () => {
    const res = await dispatch({ method: 'DELETE', url: `/kb1/documents/${DOC_ID}`, body: { keepChunks: true } });
    refusedAt(res, 'body');
});

/**
 * What the Studio Documents routes accept (routes/studioDocuments.js).
 *
 *   - `?docType=invoce` listed every type: an unknown type was dropped, not
 *     refused.
 *   - `?limit=abc` became 100 without a word.
 *   - a misspelled `expectedVersionId` answered 428 as if the revision had
 *     never been read; `mode: "desing"` on the assistant ran as design.
 *   - the deck-template route echoed an internal error's text on a 500.
 *
 * No refused request reaches the database; the session is checked first.
 * POST /, PATCH /:id and the house-style bodies stay open (see the file).
 *
 * Run: cd server && node --test routes/studioDocuments.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/studio-documents', () => require('./studioDocuments'));

test('a list filter the library does not have is refused, not dropped', async () => {
    h.assertRefused(assert, await api.call('GET', '/api/studio-documents?docType=invoce'), 'query.docType', /document type/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-documents?limit=abc'), 'query.limit', /whole number/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-documents?sort=newest'), 'query.sort', /updated or name/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-documents?knd=section'), 'query', /"knd"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the per-document bodies take only their own keys', async () => {
    const post = (path, body) => api.call('POST', `/api/studio-documents/d1${path}`, { body });
    h.assertRefused(assert, await post('/insert-section', { sourceId: 's1', expectedVersion: 'v1' }), 'body', /"expectedVersion"/);
    h.assertRefused(assert, await post('/ai-proposal', { message: 'Make it blue', mode: 'desing' }), 'body.mode', /design, content or applicability/);
    h.assertRefused(assert, await post('/duplicate', { kind: 'copy' }), 'body.kind');
    h.assertRefused(assert, await post('/versions/v1/restore', { versionId: 'v2' }), 'body', /"versionId"/);
    h.assertRefused(assert, await api.call('GET', '/api/studio-documents/d1/pdf?version=v1'), 'query', /"version"/);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the query', async () => {
    const res = await api.call('GET', '/api/studio-documents?docType=invoce', { user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a valid list reaches the store and answers as before', async () => {
    const res = await api.call('GET', '/api/studio-documents?kind=template&folderId=&sort=name&limit=30&offset=0');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { documents: [] });
    assert.ok(db.queries.some((q) => /FROM studio_documents/.test(q)));
});

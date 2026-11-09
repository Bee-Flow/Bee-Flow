'use strict';
/**
 * GET /:id/documents/:docId/original: the kept original file of a document
 * (routes/knowledgeBases/documents.js, core/kb/originals.mts).
 *
 * The real router behind the real gates' session check; the database answers from a small table of
 * rows and object storage is a double on the shared store object. Run:
 *   node --test routes/knowledgeBases/documents.original.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const h = require('../../testUtils/routeHarness');

const KB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_KB_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DOC_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_DOC_ID = '55555555-5555-4555-8555-555555555555';
const NO_ORIGINAL_DOC_ID = '66666666-6666-4666-8666-666666666666';
const BYTES = Buffer.from('%PDF-1.7 the original bytes');

const KB = { id: KB_ID, tenant_id: 'u1', organization_id: 'org1', is_published: false, shared_groups: '[]' };
const DOCS = {
    [DOC_ID]: { id: DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'u1', title: 'Contract', original_storage_key: `orgs/u1/kb/${KB_ID}/${DOC_ID}/abc`, original_mime: 'application/pdf', original_filename: 'Contract.pdf' },
    [NO_ORIGINAL_DOC_ID]: { id: NO_ORIGINAL_DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'u1', title: 'Notes', original_storage_key: null },
    [OTHER_DOC_ID]: { id: OTHER_DOC_ID, knowledge_base_id: OTHER_KB_ID, tenant_id: 'u1', title: 'Elsewhere', original_storage_key: 'orgs/u1/kb/x/y/z', original_mime: 'application/pdf' },
    [FOREIGN_DOC_ID]: { id: FOREIGN_DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'intruder', title: 'Other tenant', original_storage_key: 'orgs/intruder/kb/x/y/z', original_mime: 'application/pdf' },
};

const db = h.recordDb((sql, params) => {
    if (/FROM knowledge_bases WHERE id = \$1/.test(sql)) return params[0] === KB_ID ? { rows: [KB] } : { rows: [] };
    if (/FROM documents WHERE id = \$1/.test(sql)) {
        const row = DOCS[params[0]];
        return { rows: row ? [row] : [] };
    }
    return undefined;
});
h.openGates();
const documentCrypto = require('../../stores/lib/documentCrypto');
const storageStore = require('../../stores/storageStore');
const streamed = [];
storageStore.streamFile = async (key) => { streamed.push(key); return { stream: Readable.from([BYTES]) }; };
const api = h.serve('/api/kb', require('./documents'));

test.before(async () => {
    documentCrypto.keySources.policy = async () => ({ enabled: false, tier: 'none' });
    await db.settle();
});
test.beforeEach(() => { db.reset(); streamed.length = 0; });
test.after(api.close);

const get = (kb, doc, user) => api.call('GET', `/api/kb/${kb}/documents/${doc}/original`, user === undefined ? {} : { user });

test('the owner gets the file: bytes, type, nosniff, and a PDF may open in the browser', async () => {
    const res = await get(KB_ID, DOC_ID);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, BYTES.toString());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="Contract\.pdf"; filename\*=UTF-8''Contract\.pdf$/);
    assert.deepEqual(streamed, [DOCS[DOC_ID].original_storage_key]);
});

test('anything that is not a PDF or a safe image is an attachment, with an RFC 5987 name', async () => {
    DOCS[DOC_ID].original_mime = 'text/html';
    DOCS[DOC_ID].original_filename = 'Jaarverslag één.html';
    try {
        const res = await get(KB_ID, DOC_ID);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-disposition'), /^attachment; filename="Jaarverslag n\.html"; filename\*=UTF-8''Jaarverslag%20%C3%A9%C3%A9n\.html$/);
    } finally {
        DOCS[DOC_ID].original_mime = 'application/pdf';
        DOCS[DOC_ID].original_filename = 'Contract.pdf';
    }
});

test('a document of another base answers 404, whatever its own base says', async () => {
    const res = await get(KB_ID, OTHER_DOC_ID);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'document_not_found');
    assert.deepEqual(streamed, []);
});

test('a document of another tenant answers 404', async () => {
    const res = await get(KB_ID, FOREIGN_DOC_ID);
    assert.equal(res.status, 404);
    assert.deepEqual(streamed, []);
});

test('no stored original: 404 no_original', async () => {
    const res = await get(KB_ID, NO_ORIGINAL_DOC_ID);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'no_original');
});

test('an unknown document or base is a 404', async () => {
    assert.equal((await get(KB_ID, '77777777-7777-4777-8777-777777777777')).status, 404);
    assert.equal((await get(OTHER_KB_ID, DOC_ID)).status, 404);
});

test('somebody who may not read the base is refused before any document is looked up', async () => {
    const res = await get(KB_ID, DOC_ID, { id: 'stranger', organizationId: 'org2', role: 'user' });
    assert.equal(res.status, 403);
    assert.deepEqual(streamed, []);
    assert.ok(!db.queries.some((q) => /FROM documents/.test(q)), 'the document was never read');
});

test('no session: 401', async () => {
    assert.equal((await get(KB_ID, DOC_ID, null)).status, 401);
});

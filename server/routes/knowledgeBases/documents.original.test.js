'use strict';
/**
 * GET /:id/documents/:docId/original: the kept original file of a document
 * (routes/knowledgeBases/documents.js, core/kb/originals.mts).
 *
 * The real router behind the real gates' session check, on a real Postgres (the boot ladder's
 * schema on PGlite, testUtils/routeHarness.js `pg`, every statement recorded); object storage is a
 * double on the shared store object. Run:
 *   node --test routes/knowledgeBases/documents.original.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const h = require('../../testUtils/routeHarness');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');

const KB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_KB_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DOC_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_DOC_ID = '55555555-5555-4555-8555-555555555555';
const NO_ORIGINAL_DOC_ID = '66666666-6666-4666-8666-666666666666';
const BYTES = Buffer.from('%PDF-1.7 the original bytes');

const KB = { id: KB_ID, tenant_id: 'u1', name: 'KB', organization_id: 'org1', is_published: false, shared_groups: '[]', keep_originals: true };
const DOCS = [
    { id: DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'u1', title: 'Contract', original_storage_key: `orgs/u1/kb/${KB_ID}/${DOC_ID}/abc`, original_mime: 'application/pdf', metadata: { originalFilename: 'Contract.pdf' } },
    { id: NO_ORIGINAL_DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'u1', title: 'Notes', original_storage_key: null },
    { id: OTHER_DOC_ID, knowledge_base_id: OTHER_KB_ID, tenant_id: 'u1', title: 'Elsewhere', original_storage_key: 'orgs/u1/kb/x/y/z', original_mime: 'application/pdf' },
    { id: FOREIGN_DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'intruder', title: 'Other tenant', original_storage_key: 'orgs/intruder/kb/x/y/z', original_mime: 'application/pdf' },
];
const pg = ladderPglite();
const db = h.recordDb(undefined, { pg });
/** @param {string} sql @param {unknown[]} [params] */
const sqlRun = (sql, params) => pg.query(sql, params);
h.openGates();
const documentCrypto = require('../../stores/lib/documentCrypto');
const storageStore = require('../../stores/storageStore');
const streamed = [];
storageStore.streamFile = async (key) => { streamed.push(key); return { stream: Readable.from([BYTES]) }; };
const api = h.serve('/api/kb', require('./documents'));

test.before(async () => {
    documentCrypto.keySources.policy = async () => ({ enabled: false, tier: 'none' });
    await insertRow(pg, 'knowledge_bases', KB);
    await insertRow(pg, 'knowledge_bases', { ...KB, id: OTHER_KB_ID, name: 'Other' });
    for (const d of DOCS) await insertRow(pg, 'documents', d);
    await db.settle(600);
});
test.beforeEach(() => { db.reset(); streamed.length = 0; });
test.after(async () => { await api.close(); await pg.close(); });

const get = (kb, doc, user) => api.call('GET', `/api/kb/${kb}/documents/${doc}/original`, user === undefined ? {} : { user });

test('the owner gets the file: bytes, type, nosniff, and a PDF may open in the browser', async () => {
    const res = await get(KB_ID, DOC_ID);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, BYTES.toString());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="Contract\.pdf"; filename\*=UTF-8''Contract\.pdf$/);
    assert.deepEqual(streamed, [DOCS[0].original_storage_key]);
});

test('anything that is not a PDF or a safe image is an attachment, with an RFC 5987 name', async () => {
    await sqlRun(`UPDATE documents SET original_mime = 'text/html', metadata = '{"originalFilename":"Jaarverslag één.html"}' WHERE id = $1`, [DOC_ID]);
    try {
        const res = await get(KB_ID, DOC_ID);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-disposition'), /^attachment; filename="Jaarverslag n\.html"; filename\*=UTF-8''Jaarverslag%20%C3%A9%C3%A9n\.html$/);
    } finally {
        await sqlRun(`UPDATE documents SET original_mime = 'application/pdf', metadata = '{"originalFilename":"Contract.pdf"}' WHERE id = $1`, [DOC_ID]);
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
    assert.equal(res.status, 404, 'the same answer as for a base that does not exist');
    assert.deepEqual(streamed, []);
    assert.ok(!db.queries.some((q) => q.includes('FROM documents')), 'the document was never read');
});

test('no session: 401', async () => {
    assert.equal((await get(KB_ID, DOC_ID, null)).status, 401);
});

test('a base that no longer keeps originals serves none: 404 no_original', async () => {
    await sqlRun('UPDATE knowledge_bases SET keep_originals = false WHERE id = $1', [KB_ID]);
    try {
        const res = await get(KB_ID, DOC_ID);
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'no_original');
        assert.deepEqual(streamed, []);
    } finally { await sqlRun('UPDATE knowledge_bases SET keep_originals = true WHERE id = $1', [KB_ID]); }
});

test('a document whose text came out redacted serves no original: 404 no_original', async () => {
    await sqlRun("UPDATE documents SET pii_status = 'redacted' WHERE id = $1", [DOC_ID]);
    try {
        const res = await get(KB_ID, DOC_ID);
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'no_original');
        assert.deepEqual(streamed, []);
    } finally { await sqlRun('UPDATE documents SET pii_status = NULL WHERE id = $1', [DOC_ID]); }
});

/**
 * The builders' document catalogue and the Studio Documents licence.
 *
 * Without `studio_documents` the catalogue is empty, which both builders read
 * as "a fill_document step cannot be built", so the step is not offered to
 * someone whose runs would refuse it. With it, the owner's templates come
 * back in the shape the builders read.
 *
 * Run: cd server && node --test automation/builderDocumentCatalog.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildDocumentCatalogForUser, CATALOG_LIMIT } = require('./builderDocumentCatalog');

function fakeStore(rows) {
    const calls = [];
    return {
        calls,
        async listTemplates(userId, opts) {
            calls.push({ userId, opts });
            return rows;
        },
    };
}

const TEMPLATE = { id: 'doc_1', name: 'Factuur', docType: 'invoice', description: 'Our invoice', placeholders: [{ key: 'customer.name', kind: 'value' }], versionId: 'v1' };

test('without Studio Documents the catalogue is empty and the library is not read', async () => {
    const store = fakeStore([TEMPLATE]);
    const asked = [];
    const out = await buildDocumentCatalogForUser('u1', {
        orgId: 'org1',
        session: { user: { id: 'u1' } },
        documentStore: store,
        hasCapability: async (capId, who) => { asked.push({ capId, ...who }); return false; },
    });
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(store.calls, [], 'the documents are not even listed');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].capId, 'studio_documents');
    assert.strictEqual(asked[0].userId, 'u1');
    assert.strictEqual(asked[0].orgId, 'org1');
});

test('with Studio Documents the owner\'s templates come back in the builder shape', async () => {
    const store = fakeStore([{ ...TEMPLATE, placeholders: undefined }]);
    const out = await buildDocumentCatalogForUser('u1', {
        documentStore: store,
        hasCapability: async () => true,
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'doc_1');
    assert.strictEqual(out[0].versionId, 'v1', 'the rest of the row rides along');
    assert.deepStrictEqual(out[0].placeholders, [], 'a missing placeholder list is an empty one');
    assert.deepStrictEqual(store.calls, [{ userId: 'u1', opts: { limit: CATALOG_LIMIT } }]);
});

test('no user, no catalogue, and nobody is asked', async () => {
    let asked = false;
    const out = await buildDocumentCatalogForUser(null, { hasCapability: async () => { asked = true; return true; } });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(asked, false);
});

test('a store failure still throws, so the caller keeps its permissive "could not tell"', async () => {
    const store = { async listTemplates() { throw new Error('db down'); } };
    await assert.rejects(
        () => buildDocumentCatalogForUser('u1', { documentStore: store, hasCapability: async () => true }),
        /db down/,
    );
});

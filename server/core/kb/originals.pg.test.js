'use strict';
/**
 * The kept original against a real Postgres (PGlite behind db.js): the columns, the queries of
 * core/kb/originals.mts, the list projection (`has_original`, `web_url`, never the storage key) and the
 * `keep_originals` setting. Storage and crypto are doubles.
 *
 * Run: cd server && node --test core/kb/originals.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const projectStore = require('../../stores/projectStore');
const solutionStageStore = require('../../stores/solutionStageStore');
const store = require('../../stores/knowledgeBases');
const originals = require('./originals.mts');

const BYTES = Buffer.from('%PDF-1.7 pg bytes');
const blobs = new Map();
const deps = {
    redactionInForce: async () => false,
    storageAvailable: () => true,
    seal: async (_kb, _key, bytes) => bytes,
    upload: async (key, bytes) => { blobs.set(key, bytes); },
    read: async (key) => blobs.get(key),
    remove: async (key) => { blobs.delete(key); },
    removePrefix: async (prefix) => { for (const k of [...blobs.keys()]) if (k.startsWith(prefix)) blobs.delete(k); },
};

let kb;
let doc;

// Writes into a base ask whether a Solution stage manages it, which reads the project tables.
const BLUEPRINT_TABLES = `
    CREATE TABLE IF NOT EXISTS project_solution_entities (
        project_id TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        install_hash TEXT NOT NULL DEFAULT 'h', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, ref));
    CREATE TABLE IF NOT EXISTS solution_part_refs (
        solution_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY (solution_id, kind, entity_id));
`;

before(async () => {
    await projectStore.initDB();
    await solutionStageStore.initDB();
    await store.initDB();
    await pg.exec(BLUEPRINT_TABLES);
    kb = await store.createKB('owner1', 'Contracts', '', null, {});
    doc = await store.createDocument('owner1', kb.id, 'Contract', 'cloud_file', 'https://cloud.example/c', 'hash1', 1,
        { webUrl: 'https://cloud.example/f/42' }, null, { status: 'processed' });
});
after(close);

test('keep_originals defaults to false and is settable through updateKB', async () => {
    assert.equal((await store.getKB(kb.id)).keep_originals, false);
    const updated = await store.updateKB(kb.id, { keepOriginals: true });
    assert.equal(updated.keep_originals, true);
    const untouched = await store.updateKB(kb.id, { name: 'Contracts 2' });
    assert.equal(untouched.keep_originals, true, 'a patch without the flag leaves it as it was');
    assert.equal((await store.updateKB(kb.id, { keepOriginals: false })).keep_originals, false);
});

test('a document starts without an original and the list says so', async () => {
    const [row] = await store.listDocuments(kb.id);
    assert.equal(row.has_original, false);
    assert.equal(row.web_url, 'https://cloud.example/f/42');
});

test('keep: the list says has_original, never the key; open returns the bytes; delete clears it', async () => {
    await store.updateKB(kb.id, { keepOriginals: true });
    const ref = { tenantId: 'owner1', kbId: kb.id, documentId: doc.id };
    const res = await originals.keepOriginal({ ...ref, buffer: BYTES, mime: 'application/pdf', filename: 'Contract.pdf' }, deps);
    assert.equal(res.kept, true);

    const [row] = await store.listDocuments(kb.id);
    assert.equal(row.has_original, true);
    assert.equal(row.original_mime, 'application/pdf');
    assert.equal(row.original_size, BYTES.length);
    assert.equal(row.original_storage_key, undefined, 'the storage key never leaves the server');
    assert.equal(row.original_sha256, undefined);
    assert.equal((await store.getDocument(doc.id)).has_original, true);

    const opened = await originals.openOriginal(ref, deps);
    assert.deepEqual(opened.buffer, BYTES);
    assert.equal(opened.filename, 'Contract.pdf');

    // Another tenant's id for the same document finds nothing.
    assert.equal(await originals.openOriginal({ ...ref, tenantId: 'intruder' }, deps), null);

    await originals.deleteOriginal(ref, { deps });
    assert.equal(blobs.size, 0);
    assert.equal((await store.listDocuments(kb.id))[0].has_original, false);
    assert.equal(await originals.openOriginal(ref, deps), null);
});

test('the whole base is swept by prefix, and only when it kept something', async () => {
    const ref = { tenantId: 'owner1', kbId: kb.id, documentId: doc.id };
    await originals.deleteOriginalsForKb({ id: kb.id, tenant_id: 'owner1' }, { deps });
    await originals.keepOriginal({ ...ref, buffer: BYTES, mime: 'application/pdf' }, deps);
    assert.equal(blobs.size, 1);
    await originals.deleteOriginalsForKb({ id: kb.id, tenant_id: 'owner1' }, { deps });
    assert.equal(blobs.size, 0);
});

test('switching keep-originals off: the files go, then the pointers, and the base serves none', async () => {
    const ref = { tenantId: 'owner1', kbId: kb.id, documentId: doc.id };
    await store.updateKB(kb.id, { keepOriginals: true });
    await originals.keepOriginal({ ...ref, buffer: BYTES, mime: 'application/pdf' }, deps);
    assert.equal((await store.getDocument(doc.id)).has_original, true);
    const off = await store.updateKB(kb.id, { keepOriginals: false });
    assert.equal(await originals.openOriginal(ref, deps), null, 'withheld as soon as the flag is off');
    assert.equal(await originals.dropOriginalsForKb(off, { deps }), true);
    assert.equal(blobs.size, 0);
    assert.equal((await store.getDocument(doc.id)).has_original, false);
    await store.updateKB(kb.id, { keepOriginals: true });
    assert.equal(await originals.openOriginal(ref, deps), null, 'switching it on again brings nothing back');
});

test('withOriginalFlags reads the base and the flag of a document from the database', async () => {
    await originals.keepOriginal({ tenantId: 'owner1', kbId: kb.id, documentId: doc.id, buffer: BYTES, mime: 'application/pdf' }, deps);
    const [out] = await originals.withOriginalFlags([{ document_id: doc.id, content: 'x' }]);
    assert.equal(out.knowledge_base_id, kb.id);
    assert.equal(out.has_original, true);
});

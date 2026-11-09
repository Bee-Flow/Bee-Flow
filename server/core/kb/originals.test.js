'use strict';
/**
 * originals: the kept original file of a knowledge-base document. Run: node --test core/kb/originals.test.js
 *
 * The crypto is the real one (stores/lib/notebookFileCrypto over documentCrypto) with the org key stubbed;
 * storage and the documents row are in-memory doubles.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const documentCrypto = require('../../stores/lib/documentCrypto');
const { openBuffer } = require('../../stores/lib/notebookFileCrypto');
const originals = require('./originals.mts');

const REF = { tenantId: 'u1', kbId: 'kb1', documentId: 'doc1' };
const PDF = Buffer.from('%PDF-1.7 the secret contents of a contract');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** An in-memory world: blobs, one documents row, one base. */
function world({ kb = {}, doc = {}, redaction = false } = {}) {
    const blobs = new Map();
    const row = { id: 'doc1', status: 'processed', pii_status: 'none', title: 'Contract', original_storage_key: null, original_mime: null, original_size: null, original_sha256: null, original_filename: null, ...doc };
    const calls = { uploads: 0, removed: [], prefixes: [], infos: [] };
    const deps = {
        getKb: async () => ({ id: 'kb1', tenant_id: 'u1', organization_id: 'org1', keep_originals: true, ...kb }),
        getDoc: async () => (row ? { ...row } : null),
        saveDoc: async (_ref, fields) => {
            Object.assign(row, {
                original_storage_key: fields.key, original_mime: fields.mime, original_size: fields.size,
                original_sha256: fields.sha256, original_filename: fields.filename,
            });
            return true;
        },
        clearDoc: async () => { Object.assign(row, { original_storage_key: null, original_mime: null, original_size: null, original_sha256: null }); },
        anyOriginals: async () => !!row.original_storage_key,
        redactionInForce: async () => redaction,
        storageAvailable: () => true,
        upload: async (key, bytes) => { calls.uploads++; blobs.set(key, bytes); },
        read: async (key) => openBuffer(key, blobs.get(key)),
        remove: async (key) => { calls.removed.push(key); blobs.delete(key); },
        removePrefix: async (prefix) => { calls.prefixes.push(prefix); },
        info: (m) => calls.infos.push(m),
        warn: () => {},
    };
    return { blobs, row, calls, deps };
}

test.beforeEach(() => {
    delete process.env.KB_ORIGINAL_MAX_MB;
    documentCrypto.keySources.policy = async () => ({ enabled: true, tier: 'managed' });
    documentCrypto.keySources.orgKey = async () => Buffer.alloc(32, 7);
});

test('keep then open: the bytes round-trip, and what sits in storage is sealed', async () => {
    const w = world();
    const kept = await originals.keepOriginal({ ...REF, buffer: PDF, mime: 'application/pdf', filename: 'Contract.pdf' }, w.deps);
    assert.equal(kept.kept, true);
    assert.equal(kept.key, `orgs/u1/kb/kb1/doc1/${sha(PDF)}`);
    const stored = w.blobs.get(kept.key);
    assert.ok(!stored.includes('secret contents'), 'the plain text is not in the stored bytes');
    assert.ok(documentCrypto.envelopeOf(stored.toString('utf8')), 'the stored bytes are an envelope');
    assert.equal(w.row.original_sha256, sha(PDF));

    const opened = await originals.openOriginal(REF, w.deps);
    assert.deepEqual(opened.buffer, PDF);
    assert.equal(opened.mime, 'application/pdf');
    assert.equal(opened.filename, 'Contract.pdf');
    assert.equal(opened.size, PDF.length);
});

test('a base whose privacy screening redacts keeps no copy', async () => {
    const w = world({ redaction: true });
    const res = await originals.keepOriginal({ ...REF, buffer: PDF, mime: 'application/pdf' }, w.deps);
    assert.deepEqual(res, { kept: false, reason: 'privacy_redaction' });
    assert.equal(w.calls.uploads, 0);
    assert.equal(w.row.original_storage_key, null);
});

test('a document that came out redacted keeps no copy, and drops an earlier one', async () => {
    const w = world({ doc: { status: 'redacted', pii_status: 'redacted', original_storage_key: 'orgs/u1/kb/kb1/doc1/old' } });
    w.blobs.set('orgs/u1/kb/kb1/doc1/old', Buffer.from('old'));
    const res = await originals.keepOriginal({ ...REF, buffer: PDF }, w.deps);
    assert.deepEqual(res, { kept: false, reason: 'privacy_redaction' });
    assert.equal(w.calls.uploads, 0);
    assert.deepEqual(w.calls.removed, ['orgs/u1/kb/kb1/doc1/old']);
    assert.equal(w.row.original_storage_key, null);
});

test('over the size cap: skipped with a log line, no error', async () => {
    process.env.KB_ORIGINAL_MAX_MB = '0.00001'; // about 10 bytes
    const w = world();
    const res = await originals.keepOriginal({ ...REF, buffer: PDF }, w.deps);
    assert.deepEqual(res, { kept: false, reason: 'too_large' });
    assert.equal(w.calls.uploads, 0);
    assert.match(w.calls.infos[0], /KB_ORIGINAL_MAX_MB/);
});

test('the cap: default 50 MB, 0 means unlimited, junk falls back to the default', () => {
    const mb = 1024 * 1024;
    assert.equal(originals.maxOriginalBytes({}), 50 * mb);
    assert.equal(originals.maxOriginalBytes({ KB_ORIGINAL_MAX_MB: '0' }), 0);
    assert.equal(originals.maxOriginalBytes({ KB_ORIGINAL_MAX_MB: '5' }), 5 * mb);
    assert.equal(originals.maxOriginalBytes({ KB_ORIGINAL_MAX_MB: 'lots' }), 50 * mb);
    assert.equal(originals.maxOriginalBytes({ KB_ORIGINAL_MAX_MB: '-1' }), 50 * mb);
});

test('unlimited (0) keeps a file over the default cap', async () => {
    process.env.KB_ORIGINAL_MAX_MB = '0';
    const w = world();
    const res = await originals.keepOriginal({ ...REF, buffer: Buffer.alloc(60 * 1024 * 1024, 1) }, w.deps);
    assert.equal(res.kept, true);
});

test('a re-ingest with new bytes replaces the old blob; the same bytes are a no-op', async () => {
    const w = world();
    const first = await originals.keepOriginal({ ...REF, buffer: PDF, mime: 'application/pdf' }, w.deps);
    const again = await originals.keepOriginal({ ...REF, buffer: PDF, mime: 'application/pdf' }, w.deps);
    assert.equal(again.kept, true);
    assert.equal(w.calls.uploads, 1, 'same sha: nothing uploaded twice');

    const v2 = Buffer.from('%PDF-1.7 version two');
    const second = await originals.keepOriginal({ ...REF, buffer: v2, mime: 'application/pdf' }, w.deps);
    assert.notEqual(second.key, first.key);
    assert.deepEqual(w.calls.removed, [first.key], 'the previous blob is deleted');
    assert.equal(w.blobs.has(first.key), false);
    assert.deepEqual((await originals.openOriginal(REF, w.deps)).buffer, v2);
});

test('storage down, a missing document or a failing upload never throw', async () => {
    const down = await originals.keepOriginal({ ...REF, buffer: PDF }, { ...world().deps, storageAvailable: () => false });
    assert.equal(down.reason, 'storage_unavailable');
    const w = world();
    assert.equal((await originals.keepOriginal({ ...REF, buffer: PDF }, { ...w.deps, getDoc: async () => null })).reason, 'document_missing');
    const failing = await originals.keepOriginal({ ...REF, buffer: PDF }, { ...w.deps, upload: async () => { throw new Error('s3 down'); } });
    assert.deepEqual(failing, { kept: false, reason: 'failed' });
});

test('another tenant is not the base: nothing kept', async () => {
    const w = world({ kb: { tenant_id: 'someone-else' } });
    assert.equal((await originals.keepOriginal({ ...REF, buffer: PDF }, w.deps)).reason, 'kb_missing');
});

test('deleteOriginal removes the blob and the pointer; a document without one is a no-op', async () => {
    const w = world();
    const kept = await originals.keepOriginal({ ...REF, buffer: PDF }, w.deps);
    await originals.deleteOriginal(REF, { deps: w.deps });
    assert.deepEqual(w.calls.removed, [kept.key]);
    assert.equal(w.row.original_storage_key, null);
    assert.equal(await originals.openOriginal(REF, w.deps), null);
    await originals.deleteOriginal(REF, { deps: w.deps });
    assert.equal(w.calls.removed.length, 1);
});

test('deleteOriginal: a storage failure is logged, and thrown only when strict', async () => {
    const w = world();
    await originals.keepOriginal({ ...REF, buffer: PDF }, w.deps);
    const broken = { ...w.deps, remove: async () => { throw new Error('s3 down'); } };
    await originals.deleteOriginal(REF, { deps: broken });
    await assert.rejects(originals.deleteOriginal(REF, { strict: true, deps: broken }), /s3 down/);
});

test('deleteOriginalsForKb sweeps the base prefix, and only when the base kept any', async () => {
    const empty = world();
    await originals.deleteOriginalsForKb({ id: 'kb1', tenant_id: 'u1' }, { deps: empty.deps });
    assert.deepEqual(empty.calls.prefixes, []);
    const w = world({ doc: { original_storage_key: 'orgs/u1/kb/kb1/doc1/x' } });
    await originals.deleteOriginalsForKb({ id: 'kb1', tenant_id: 'u1' }, { deps: w.deps });
    assert.deepEqual(w.calls.prefixes, ['orgs/u1/kb/kb1/']);
});

test('originalsBlockedReason reports the privacy rule', async () => {
    const kb = { id: 'kb1', tenant_id: 'u1' };
    assert.equal(await originals.originalsBlockedReason(kb, { redactionInForce: async () => true }), 'privacy_redaction');
    assert.equal(await originals.originalsBlockedReason(kb, { redactionInForce: async () => false }), null);
});

test('download name: the filename that came in, else the title with an extension from the type', () => {
    assert.equal(originals.downloadName({ original_filename: 'a/b.pdf', title: 'x', original_mime: 'application/pdf' }), 'a_b.pdf');
    assert.equal(originals.downloadName({ original_filename: null, title: 'Handbook', original_mime: 'application/pdf' }), 'Handbook.pdf');
    assert.equal(originals.downloadName({ original_filename: null, title: null, original_mime: null }), 'document');
});

test('withOriginalFlags adds the base and the flag, and survives a failing query', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const rows = [{ document_id: id, content: 'a' }, { document_id: null, content: 'b' }];
    const out = await originals.withOriginalFlags(rows, async (ids) => { assert.deepEqual(ids, [id]); return [{ id, kb_id: 'kb9', has_original: true }]; });
    assert.equal(out[0].knowledge_base_id, 'kb9');
    assert.equal(out[0].has_original, true);
    assert.equal(out[1].has_original, undefined);
    const same = await originals.withOriginalFlags(rows, async () => { throw new Error('db'); });
    assert.deepEqual(same, rows);
});

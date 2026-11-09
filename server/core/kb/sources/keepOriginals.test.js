'use strict';
/**
 * The refresh engine keeps the original file of a fetched document when the base opted in.
 * Run: node --test core/kb/sources/keepOriginals.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncSource } = require('./index');
const { keepUploadedOriginal } = require('./keepOriginals');

const SOURCE = { id: 'src1', knowledgeBaseId: 'kb1', kind: 'webpage', refreshMode: 'manual', config: {}, createdBy: 'u1' };
const FILE = { buffer: Buffer.from('%PDF-1.7 bytes'), mime: 'application/pdf', filename: 'Contract.pdf' };

function harness({ keep = true, stored = [], status = 'processed', fetched = { content: 'text', title: 'Contract', original: FILE }, keepImpl } = {}) {
    const kept = [];
    const logs = [];
    const deps = {
        kbStore: {
            getKB: async () => ({ id: 'kb1', tenant_id: 'tenant1', keep_originals: keep }),
            listDocuments: async (_kb, { offset = 0 } = {}) => (offset > 0 ? [] : stored),
            getDocument: async (id) => stored.find((d) => d.id === id) || null,
            bumpKBVersion: async () => {},
        },
        kbSourcesStore: { isCancelRequested: async () => false },
        helpers: {
            ingestDocument: async (_t, _k, _c, _title, _st, _su, opts) => ({ document: { id: `new_${opts.externalId}` }, chunks: 1, status }),
            reingestDocument: async (_t, _k, docId) => ({ document: { id: docId }, chunks: 1, status }),
            deleteDocumentChunks: async () => {},
        },
        keepOriginal: keepImpl || (async (args) => { kept.push(args); return { kept: true, key: 'k', size: 1 }; }),
    };
    const adapter = { enumerate: async () => [{ externalId: 'a' }], isUnchanged: () => false, fetch: async () => fetched };
    return { deps, adapter, kept, logs };
}

const run = (h) => syncSource(SOURCE, { deps: h.deps, adapter: h.adapter, log: (m) => h.logs.push(m) });

test('a new document with an original is kept when the base opted in', async () => {
    const h = harness();
    await run(h);
    assert.equal(h.kept.length, 1);
    assert.deepEqual(h.kept[0], {
        tenantId: 'tenant1', kbId: 'kb1', documentId: 'new_a', buffer: FILE.buffer, mime: 'application/pdf', filename: 'Contract.pdf',
    });
});

test('a changed document keeps its new original under the same id', async () => {
    const h = harness({ stored: [{ id: 'd1', external_id: 'a', title: 'a', status: 'processed' }] });
    await run(h);
    assert.equal(h.kept.length, 1);
    assert.equal(h.kept[0].documentId, 'd1');
});

test('the flag off: nothing is kept', async () => {
    const h = harness({ keep: false });
    await run(h);
    assert.equal(h.kept.length, 0);
});

test('an adapter without bytes keeps nothing', async () => {
    const h = harness({ fetched: { content: 'text', title: 'Contract' } });
    await run(h);
    assert.equal(h.kept.length, 0);
});

test('a document that was not indexed (skipped, error, duplicate) keeps nothing', async () => {
    for (const status of ['skipped', 'error', 'duplicate']) {
        const h = harness({ status });
        await run(h);
        assert.equal(h.kept.length, 0, status);
    }
});

test('a failing keep never fails the document', async () => {
    const h = harness({ keepImpl: async () => { throw new Error('storage exploded'); } });
    const r = await run(h);
    assert.equal(r.added, 1);
    assert.equal(r.failed, 0);
    assert.ok(h.logs.some((m) => /not kept: storage exploded/.test(m)));
});

test('a refusal is a log line, not a failure', async () => {
    const h = harness({ keepImpl: async () => ({ kept: false, reason: 'privacy_redaction' }) });
    const r = await run(h);
    assert.equal(r.added, 1);
    assert.ok(h.logs.some((m) => /privacy_redaction/.test(m)));
});

test('keepUploadedOriginal: only for an opted-in base, an indexed document and a real buffer', async () => {
    const logs = [];
    const file = { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'a.pdf' };
    const log = (m) => logs.push(m);
    // The real keepOriginal would need a database; none of these three must reach it.
    await keepUploadedOriginal({ kb: { id: 'kb1', keep_originals: false }, docId: 'd1', status: 'processed', file, log });
    await keepUploadedOriginal({ kb: { id: 'kb1', keep_originals: true }, docId: 'd1', status: 'skipped', file, log });
    await keepUploadedOriginal({ kb: { id: 'kb1', keep_originals: true }, docId: 'd1', status: 'processed', file: {}, log });
    assert.deepEqual(logs, []);
});

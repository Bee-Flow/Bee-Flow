/**
 * Ingest-funnel status semantics (K1) — DB-free.
 *
 * The store, config and local embedder are stubbed so the test pins the
 * FUNNEL's decisions, not SQL:
 *   - onFailure:'record' keeps a row (skipped / error / duplicate) and resolves
 *   - the legacy 'throw' contract still deletes the row (no snapshot) and throws
 *   - a hash/simhash hit in ANOTHER source is annotated (overlaps_document_id),
 *     a hit in the SAME source (or with no source on either side) is refused
 *   - reingestDocument keeps the row id: replaceDocumentContent, never
 *     createDocument/deleteDocument
 *   - extractFileContentWithMeta keeps extractFileContent's text contract
 *
 * Run: node --test --test-force-exit core/kb/kbIngestionHelpers.status.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

// ── In-memory store double ──────────────────────────────────────────
const state = {
    docs: new Map(),
    calls: [],
    byHash: null,        // row returned by findDocumentByContentHash
    near: null,          // row returned by findNearDuplicateBySimhash
    embedFails: false,   // ingestLocally throws when true
    embedChunks: 4,
};
let seq = 0;

const kbStoreStub = {
    DOCUMENT_COLUMNS: ['id', 'knowledge_base_id', 'title', 'source_id', 'status'],
    hashContent: (c) => `hash:${c.length}`,
    async findDocumentByContentHash(kbId, hash) { state.calls.push(['findDocumentByContentHash', kbId, hash]); return state.byHash; },
    async hasContentHash() { throw new Error('funnel should prefer findDocumentByContentHash'); },
    async findNearDuplicateBySimhash(kbId, simhash, distance) { state.calls.push(['findNearDuplicateBySimhash', kbId, distance]); return state.near; },
    async createDocument(tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount, metadata, simhash, extra = {}) {
        const id = `doc-${++seq}`;
        const row = { id, tenant_id: tenantId, knowledge_base_id: kbId, title, source_type: sourceType, source_uri: sourceUri,
            content_hash: contentHash, chunk_count: chunkCount, simhash, ...snake(extra) };
        state.docs.set(id, row);
        state.calls.push(['createDocument', row]);
        return { ...row };
    },
    async recordDuplicate(tenantId, kbId, title, sourceType, sourceUri, contentHash, canonicalId, metadata, extra = {}) {
        const id = `dup-${++seq}`;
        const row = { id, knowledge_base_id: kbId, title, status: 'duplicate', duplicate_of: canonicalId, ...snake(extra) };
        state.docs.set(id, row);
        state.calls.push(['recordDuplicate', row]);
        return { ...row };
    },
    async updateDocumentStatus(docId, patch) {
        const row = state.docs.get(docId);
        Object.assign(row, { status: patch.status, status_reason: patch.statusReason ?? null, chunk_count: patch.chunkCount ?? row.chunk_count });
        state.calls.push(['updateDocumentStatus', docId, patch]);
        return { ...row };
    },
    async replaceDocumentContent(docId, patch) {
        const row = state.docs.get(docId);
        for (const [k, v] of Object.entries(snake(patch))) if (v !== undefined) row[k] = v;
        state.calls.push(['replaceDocumentContent', docId, patch]);
        return { ...row };
    },
    async getDocument(id) { const r = state.docs.get(id); return r ? { ...r } : null; },
    async deleteDocument(id, opts) { state.calls.push(['deleteDocument', id, opts]); state.docs.delete(id); return true; },
    async updateChunkCount(id, n) { state.calls.push(['updateChunkCount', id, n]); const r = state.docs.get(id); if (r) r.chunk_count = n; },
    async bumpKBVersion(kbId) { state.calls.push(['bumpKBVersion', kbId]); return { kb_version: 2 }; },
};

function snake(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        out[k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = v;
    }
    return out;
}

const localIngestStub = {
    async ingestLocally(tenantId, kbId, docId, content) {
        state.calls.push(['ingestLocally', docId, content.length]);
        if (state.embedFails) throw new Error('embedding provider timeout');
        return { chunks_created: state.embedChunks };
    },
    async deleteChunksLocally(tenantId, kbId, docId) { state.calls.push(['deleteChunksLocally', docId]); },
};

let restore;
let helpers;

before(() => {
    restore = installResolveStub({
        '../../stores/knowledgeBases': kbStoreStub,
        '../../stores/configStore': { getConfig: async () => null, getSecret: async () => null },
        './resolveProvider': { resolveKbProvider: async () => 'local' },
        './localKBIngest': localIngestStub,
        '../serviceAuth': { getServiceHeaders: () => ({}) },
    });
    helpers = require('./kbIngestionHelpers');
});
after(() => restore && restore());
beforeEach(() => {
    state.docs.clear(); state.calls.length = 0;
    state.byHash = null; state.near = null; state.embedFails = false; state.embedChunks = 4;
});

const calls = (name) => state.calls.filter(c => c[0] === name);
const CONTENT = 'A perfectly ordinary paragraph of knowledge base content about pricing and delivery terms.';

// ── onFailure:'record' ──────────────────────────────────────────────

test('record mode: too-short content leaves a skipped row with a friendly reason and resolves', async () => {
    const r = await helpers.ingestDocument('u1', 'kb1', '  ', 'empty.txt', 'upload', 'empty.txt', {
        onFailure: 'record', sourceId: 'src-A', externalId: 'f-1', createdBy: 'u1', mime: 'text/plain',
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.chunks, 0);
    const created = calls('createDocument')[0][1];
    assert.strictEqual(created.status, 'skipped');
    assert.strictEqual(created.status_reason, 'Content is too short (min 3 chars)');
    assert.strictEqual(created.source_id, 'src-A');
    assert.strictEqual(created.external_id, 'f-1');
    assert.strictEqual(created.created_by, 'u1');
    assert.strictEqual(state.docs.size, 1, 'the row stays');
    assert.strictEqual(calls('ingestLocally').length, 0);
    assert.strictEqual(calls('deleteDocument').length, 0);
});

test('record mode: embedding failure keeps the row as status error (friendlyError), no delete, no throw', async () => {
    state.embedFails = true;
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf', {
        onFailure: 'record', sourceId: 'src-A', pageCount: 3, sizeBytes: 999,
    });
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.chunks, 0);
    assert.match(r.error, /embedding provider timeout/);
    assert.strictEqual(r.document.status, 'error');
    assert.strictEqual(r.document.status_reason, 'Timed out while processing — try again.');
    assert.strictEqual(r.document.page_count, 3);
    assert.strictEqual(r.document.size_bytes, 999);
    assert.strictEqual(calls('deleteDocument').length, 0, 'row is not deleted');
    assert.strictEqual(calls('bumpKBVersion').length, 0, 'nothing indexed → no version bump');
    assert.strictEqual(state.docs.size, 1);
});

test('legacy throw mode: embedding failure deletes the row WITHOUT a snapshot and rethrows', async () => {
    state.embedFails = true;
    await assert.rejects(
        () => helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf'),
        /Local ingestion failed: embedding provider timeout/,
    );
    const del = calls('deleteDocument');
    assert.strictEqual(del.length, 1);
    assert.deepStrictEqual(del[0][2], { skipSnapshot: true });
    assert.strictEqual(state.docs.size, 0);
});

test('happy path: processed row with provenance, chunk count, version bump and byte size default', async () => {
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf', {
        sourceId: 'src-A', externalId: 'f-9', mime: 'application/pdf', pageCount: 2, createdBy: 'u1',
        sourceModifiedAt: '2026-01-01T00:00:00Z',
    });
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(r.chunks, 4);
    assert.strictEqual(r.document.chunk_count, 4);
    assert.strictEqual(r.overlapsDocumentId, null);
    const created = calls('createDocument')[0][1];
    assert.strictEqual(created.status, 'processed');
    assert.strictEqual(created.source_id, 'src-A');
    assert.strictEqual(created.external_id, 'f-9');
    assert.strictEqual(created.mime, 'application/pdf');
    assert.strictEqual(created.page_count, 2);
    assert.strictEqual(created.size_bytes, Buffer.byteLength(CONTENT, 'utf8'));
    assert.strictEqual(created.source_modified_at, '2026-01-01T00:00:00Z');
    assert.strictEqual(calls('bumpKBVersion').length, 1);
    assert.deepStrictEqual(calls('updateChunkCount')[0].slice(1), [r.document.id, 4]);
});

test('status redacted is honoured (K4 passes it) and pii fields are carried', async () => {
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf', {
        status: 'redacted', piiStatus: 'redacted', piiCategories: { person: 2 },
    });
    assert.strictEqual(r.status, 'redacted');
    const created = calls('createDocument')[0][1];
    assert.strictEqual(created.status, 'redacted');
    assert.strictEqual(created.pii_status, 'redacted');
    assert.deepStrictEqual(created.pii_categories, { person: 2 });
});

// ── duplicates across / within sources ──────────────────────────────

test('exact hash hit in ANOTHER source is annotated (overlaps_document_id) and still ingested', async () => {
    state.byHash = { id: 'doc-canon', source_id: 'src-B', status: 'processed' };
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'copy.pdf', 'upload', 'copy.pdf', { sourceId: 'src-A' });
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(r.overlapsDocumentId, 'doc-canon');
    assert.strictEqual(r.chunks, 4);
    const created = calls('createDocument')[0][1];
    assert.strictEqual(created.overlaps_document_id, 'doc-canon');
    assert.strictEqual(calls('recordDuplicate').length, 0);
    assert.strictEqual(calls('findNearDuplicateBySimhash').length, 0, 'exact match short-circuits the simhash probe');
});

test('exact hash hit in the SAME source is refused as before (DUPLICATE + alias row status duplicate)', async () => {
    state.byHash = { id: 'doc-canon', source_id: 'src-A', status: 'processed' };
    await assert.rejects(
        () => helpers.ingestDocument('u1', 'kb1', CONTENT, 'copy.pdf', 'upload', 'copy.pdf', { sourceId: 'src-A' }),
        (e) => e.code === 'DUPLICATE' && e.documentId === 'doc-canon',
    );
    const dup = calls('recordDuplicate')[0][1];
    assert.strictEqual(dup.status, 'duplicate');
    assert.strictEqual(dup.duplicate_of, 'doc-canon');
    assert.strictEqual(dup.source_id, 'src-A');
    assert.strictEqual(calls('createDocument').length, 0);
});

test('legacy caller without sourceId keeps KB-wide dedup (a hit anywhere refuses)', async () => {
    state.byHash = { id: 'doc-canon', source_id: 'src-B', status: 'processed' };
    await assert.rejects(
        () => helpers.ingestDocument('u1', 'kb1', CONTENT, 'copy.pdf', 'text', null),
        (e) => e.code === 'DUPLICATE',
    );
});

test('record mode + same-source duplicate resolves with status duplicate instead of throwing', async () => {
    state.byHash = { id: 'doc-canon', source_id: 'src-A', status: 'processed' };
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'copy.pdf', 'upload', 'copy.pdf', { sourceId: 'src-A', onFailure: 'record' });
    assert.strictEqual(r.status, 'duplicate');
    assert.strictEqual(r.duplicateOf, 'doc-canon');
    assert.strictEqual(r.document.status, 'duplicate');
});

test('simhash near-duplicate: other source → annotate; same source → NEAR_DUPLICATE', async () => {
    state.near = { id: 'doc-near', source_id: 'src-B' };
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'n.pdf', 'upload', 'n.pdf', { sourceId: 'src-A' });
    assert.strictEqual(r.overlapsDocumentId, 'doc-near');
    assert.strictEqual(calls('createDocument')[0][1].overlaps_document_id, 'doc-near');

    state.calls.length = 0;
    state.near = { id: 'doc-near', source_id: 'src-A' };
    await assert.rejects(
        () => helpers.ingestDocument('u1', 'kb1', CONTENT, 'n.pdf', 'upload', 'n.pdf', { sourceId: 'src-A' }),
        (e) => e.code === 'NEAR_DUPLICATE' && e.documentId === 'doc-near',
    );
    assert.strictEqual(calls('recordDuplicate')[0][1].status, 'duplicate');
});

test('skipDedup bypasses both probes', async () => {
    state.byHash = { id: 'doc-canon', source_id: 'src-A' };
    state.near = { id: 'doc-near', source_id: 'src-A' };
    const r = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'n.pdf', 'upload', 'n.pdf', { sourceId: 'src-A', skipDedup: true });
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(calls('findDocumentByContentHash').length, 0);
    assert.strictEqual(calls('findNearDuplicateBySimhash').length, 0);
});

// ── refresh-in-place ────────────────────────────────────────────────

test('reingestDocument keeps the row id: purges chunks, re-embeds, replaceDocumentContent — never create/delete', async () => {
    const first = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'row-7', 'datatable_row', 'row:7', { sourceId: 'src-T', externalId: '7' });
    state.calls.length = 0;
    state.embedChunks = 6;
    const r = await helpers.reingestDocument('u1', 'kb1', first.document.id, CONTENT + ' Updated on Tuesday.', {
        externalId: '7', sourceModifiedAt: '2026-05-05T00:00:00Z', sizeBytes: 500,
    });
    assert.strictEqual(r.document.id, first.document.id);
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(r.chunks, 6);
    assert.strictEqual(calls('createDocument').length, 0);
    assert.strictEqual(calls('deleteDocument').length, 0);
    assert.strictEqual(calls('deleteChunksLocally').length, 1, 'old chunks purged first');
    const patch = calls('replaceDocumentContent')[0][2];
    assert.strictEqual(patch.contentHash, `hash:${(CONTENT + ' Updated on Tuesday.').length}`);
    assert.strictEqual(patch.chunkCount, 6);
    assert.strictEqual(patch.status, 'processed');
    assert.strictEqual(patch.statusReason, null);
    assert.strictEqual(patch.sourceModifiedAt, '2026-05-05T00:00:00Z');
    assert.strictEqual(calls('bumpKBVersion').length, 1);
    assert.strictEqual(state.docs.get(first.document.id).content_hash, patch.contentHash);
});

test('reingestDocument on a failed row is "process again": same id, status error → processed', async () => {
    state.embedFails = true;
    const failed = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf', { onFailure: 'record', sourceId: 'src-A' });
    assert.strictEqual(failed.status, 'error');
    state.embedFails = false;
    const r = await helpers.reingestDocument('u1', 'kb1', failed.document.id, CONTENT, { onFailure: 'record' });
    assert.strictEqual(r.document.id, failed.document.id);
    assert.strictEqual(r.status, 'processed');
    assert.strictEqual(state.docs.get(failed.document.id).status, 'processed');
    assert.strictEqual(state.docs.get(failed.document.id).status_reason, null);
});

test('reingestDocument record mode: embedding failure marks the SAME row error and resolves', async () => {
    const first = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf');
    state.embedFails = true;
    const r = await helpers.reingestDocument('u1', 'kb1', first.document.id, CONTENT + ' v2', { onFailure: 'record' });
    assert.strictEqual(r.status, 'error');
    assert.strictEqual(r.document.id, first.document.id);
    assert.strictEqual(r.document.status_reason, 'Timed out while processing — try again.');
    assert.strictEqual(calls('deleteDocument').length, 0);
});

test('reingestDocument refuses a document of another KB', async () => {
    const first = await helpers.ingestDocument('u1', 'kb1', CONTENT, 'a.pdf', 'upload', 'a.pdf');
    await assert.rejects(
        () => helpers.reingestDocument('u1', 'kb-other', first.document.id, CONTENT),
        (e) => e.code === 'KB_MISMATCH',
    );
    await assert.rejects(() => helpers.reingestDocument('u1', 'kb1', 'nope', CONTENT), (e) => e.code === 'NOT_FOUND');
});

test('recordFailedDocument writes a skipped/error row without content', async () => {
    const row = await helpers.recordFailedDocument({
        tenantId: 'u1', kbId: 'kb1', title: 'x.zip', sourceType: 'upload', sourceUri: 'x.zip',
        error: new Error('Unsupported file type: application/zip'), sourceId: 'src-A', sizeBytes: 10, mime: 'application/zip',
    });
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.status_reason, 'Could not read this file format.');
    assert.strictEqual(row.content_hash, null);
    const skipped = await helpers.recordFailedDocument({ tenantId: 'u1', kbId: 'kb1', title: 'y', sourceType: 'upload', status: 'skipped', reason: 'Blocked by Privacy Shield' });
    assert.strictEqual(skipped.status, 'skipped');
    assert.strictEqual(skipped.status_reason, 'Blocked by Privacy Shield');
});

// ── friendlyError + extraction meta ──────────────────────────────────

test('friendlyError maps the known failure classes and truncates the rest', () => {
    const { friendlyError } = helpers;
    assert.strictEqual(friendlyError(new Error('ETIMEDOUT')), 'Timed out while processing — try again.');
    assert.strictEqual(friendlyError('fetch failed'), 'Could not reach the URL — check the link and try again.');
    assert.strictEqual(friendlyError(new Error('HTTP 403')), 'The URL refused access (login or paywall).');
    assert.strictEqual(friendlyError(new Error('PDF is encrypted')), 'This file looks password-protected — remove protection and re-upload.');
    assert.strictEqual(friendlyError(new Error('Unsupported file type')), 'Could not read this file format.');
    assert.strictEqual(friendlyError(null), 'Unknown error');
    const long = friendlyError(new Error('z'.repeat(400)));
    assert.strictEqual(long.length, 158);
    assert.ok(long.endsWith('…'));
});

test('extractFileContentWithMeta: plain text → { text, meta }; extractFileContent stays the text-only wrapper', async () => {
    const buf = Buffer.from('hello world');
    const r = await helpers.extractFileContentWithMeta(buf, 'text/plain', 'a.txt');
    assert.deepStrictEqual(r, { text: 'hello world', meta: { pageCount: null, sheetNames: null } });
    assert.strictEqual(await helpers.extractFileContent(buf, 'text/plain', 'a.txt'), 'hello world');
    await assert.rejects(() => helpers.extractFileContentWithMeta(Buffer.from('x'), 'application/x-nope', 'a.nope'), /Unsupported file type/);
});

test('extractFileContentWithMeta: XLSX reports sheet names + sheet-aware text', async () => {
    let XLSX;
    try { XLSX = require('@e965/xlsx'); } catch (_) { return; }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'Prijzen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['c'], [3]]), 'Levering');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = await helpers.extractFileContentWithMeta(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'p.xlsx');
    assert.deepStrictEqual(r.meta.sheetNames, ['Prijzen', 'Levering']);
    assert.match(r.text, /Prijzen/);
    assert.strictEqual(r.meta.pageCount, null);
});

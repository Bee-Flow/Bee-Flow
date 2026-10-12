/**
 * Carried knowledge content (design section 2, D15, D20): the listing with its
 * gates, the plan, and the copy inside a transaction on pglite.
 *
 * The schema below is the shape stores/knowledgeBases.js and
 * core/kb/localKBIngest.js create, reduced to the columns that matter, with
 * the NON-pgvector kb_chunks DDL: the copy must work without re-embedding,
 * whatever the chunk table holds.
 *
 * Run: cd server && node --test projects/stages/knowledgeContent.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { listCarriedDocuments, planKnowledge, applyKnowledge, MAX_DOCS } = require('./knowledgeContent');

const { pg, db } = pgliteDb();

const DDL = `
CREATE TABLE knowledge_bases (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE kb_sources (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE, kind TEXT NOT NULL);
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    title TEXT, source_type TEXT DEFAULT 'text', source_uri TEXT, lang TEXT DEFAULT 'unknown',
    content_hash TEXT, chunk_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now(),
    metadata JSONB DEFAULT '{}'::jsonb, original_content TEXT,
    source_id UUID REFERENCES kb_sources(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'processed', external_id TEXT, size_bytes INT, page_count INT, sheet_count INT,
    mime TEXT, pii_status TEXT DEFAULT 'unscanned', pii_categories JSONB, created_by TEXT);
CREATE TABLE kb_chunks (
    id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, knowledge_base_id TEXT NOT NULL,
    document_id TEXT NOT NULL, chunk_id INT NOT NULL, lang TEXT, title TEXT, content TEXT NOT NULL,
    tsv TSVECTOR, source_uri TEXT, chunk_type TEXT DEFAULT 'content', created_at TIMESTAMPTZ DEFAULT now(),
    page_start INT);
`;

const DEV = '11111111-1111-1111-1111-111111111111';
const UAT = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';
const local = { db, usesLocalIngest: async () => true };

async function addDoc(kb, { title, hash, chunks = 2, pii = 'none', status = 'processed', sourceType = 'upload', sourceId = null, metadata = {}, createdBy = 'dev-user', sourceUri = null }) {
    const r = await pg.query(
        `INSERT INTO documents (tenant_id, knowledge_base_id, title, content_hash, chunk_count, pii_status, status,
                                source_type, source_id, metadata, created_by, source_uri, size_bytes, mime, original_content, external_id)
         VALUES ('dev-tenant', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 120, 'text/plain', 'body of ' || $2, 'ext-1')
         RETURNING id::text AS id`,
        [kb, title, hash, chunks, pii, status, sourceType, sourceId, JSON.stringify(metadata), createdBy, sourceUri],
    );
    const id = r.rows[0].id;
    for (let i = 0; i < chunks; i++) {
        await pg.query(
            `INSERT INTO kb_chunks (tenant_id, knowledge_base_id, document_id, chunk_id, title, content, tsv, source_uri, page_start)
             VALUES ('dev-tenant', $1, $2, $3, $4, $5, to_tsvector('simple', $5), 'https://drive/secret', $3 + 1)`,
            [kb, id, i, title, `${title} part ${i}`],
        );
    }
    return id;
}

before(async () => {
    await pg.exec(DDL);
    for (const [id, name] of [[DEV, 'dev'], [UAT, 'uat'], [OTHER, 'other']]) {
        await pg.query(`INSERT INTO knowledge_bases (id, tenant_id, name) VALUES ($1, 't', $2)`, [id, name]);
    }
});

after(async () => { await pg.close(); });

// ── Pure: the plan ─────────────────────────────────────────────────────

test('planKnowledge matches by content hash and removes only what the previous release carried', () => {
    const plan = planKnowledge(
        [{ id: 'a', content_hash: 'h1' }, { id: 'b', content_hash: 'h9' }, { id: 'c', content_hash: null }, { id: 'd', content_hash: 'h-upload' }],
        { docs: [{ contentHash: 'h1' }, { contentHash: 'h2' }, { contentHash: 'h2' }] },
        { docs: [{ contentHash: 'h1' }, { contentHash: 'h9' }] },
    );
    assert.deepStrictEqual(plan.copy.map(d => d.contentHash), ['h2']);
    assert.deepStrictEqual(plan.unchanged.map(d => d.contentHash), ['h1']);
    assert.deepStrictEqual(plan.remove.map(d => d.id), ['b'], 'a direct upload and an unhashed document stay');
    const first = planKnowledge([{ id: 'b', content_hash: 'h9' }], [{ contentHash: 'h1' }]);
    assert.deepStrictEqual(first.remove, [], 'nothing was carried before the first release');
});

test('planKnowledge replaces a stage copy that is not content', () => {
    for (const status of ['error', 'skipped', 'duplicate']) {
        const plan = planKnowledge([{ id: 'a', content_hash: 'h1', status }], [{ contentHash: 'h1' }], [{ contentHash: 'h1' }]);
        assert.deepStrictEqual([plan.copy.length, plan.unchanged.length, plan.remove.map(d => d.id)], [1, 0, ['a']], status);
    }
    const ok = planKnowledge([{ id: 'a', content_hash: 'h1', status: 'redacted' }], [{ contentHash: 'h1' }]);
    assert.deepStrictEqual([ok.copy.length, ok.unchanged.length, ok.remove.length], [0, 1, 0]);
});

// ── The listing and its gates ──────────────────────────────────────────

test('listCarriedDocuments lists active documents only, with no bytes', async () => {
    await addDoc(DEV, { title: 'Handbook', hash: 'h-handbook' });
    await addDoc(DEV, { title: 'Prices', hash: 'h-prices', pii: 'redacted', status: 'redacted' });
    await addDoc(DEV, { title: 'Broken', hash: 'h-broken', status: 'error' });
    const out = await listCarriedDocuments(DEV, local, { ref: 'kb_1' });
    assert.deepStrictEqual(out.findings, []);
    assert.strictEqual(out.kind, 'knowledge_listing');
    assert.strictEqual(out.sourceEntityId, DEV);
    assert.deepStrictEqual(out.payload.docs.map(d => [d.title, d.contentHash, d.piiStatus, d.sizeBytes]), [
        ['Handbook', 'h-handbook', 'none', 120],
        ['Prices', 'h-prices', 'redacted', 120],
    ]);
    assert.deepStrictEqual(Object.keys(out.payload.docs[0]).sort(), ['contentHash', 'docRef', 'piiStatus', 'sizeBytes', 'title']);
    assert.ok(!JSON.stringify(out).includes('body of'), 'the listing never carries content');
    assert.match(out.contentHash, /^[0-9a-f]{64}$/);
});

test('pii found or unscanned without an acknowledgement is kb.personal_data; an ack for that content clears it', async () => {
    const kb = OTHER;
    const found = await addDoc(kb, { title: 'Contacts', hash: 'h-contacts', pii: 'found' });
    const unscanned = await addDoc(kb, { title: 'Notes', hash: 'h-notes', pii: 'unscanned' });
    const out = await listCarriedDocuments(kb, local);
    const fd = out.findings.find(x => x.code === 'kb.personal_data');
    assert.strictEqual(fd.severity, 'blocking');
    assert.strictEqual(fd.acknowledgeable, true);
    assert.deepStrictEqual(fd.documents.map(x => x.docRef).sort(), [found, unscanned].sort());

    const acked = await listCarriedDocuments(kb, local, { acks: [found, { docRef: unscanned, contentHash: 'h-notes' }] });
    assert.ok(!acked.findings.some(x => x.code === 'kb.personal_data'));
    // An ack for other content does not count.
    const stale = await listCarriedDocuments(kb, local, { acks: [{ docRef: found, contentHash: 'h-old' }, unscanned] });
    assert.deepStrictEqual(stale.findings.find(x => x.code === 'kb.personal_data').documents.map(x => x.docRef), [found]);
    await pg.query('DELETE FROM documents WHERE knowledge_base_id = $1', [kb]);
});

test('a synced document is refused: a mail source_type, or a source_id of a synced source', async () => {
    const kb = OTHER;
    const folder = (await pg.query(`INSERT INTO kb_sources (knowledge_base_id, kind) VALUES ($1, 'nextcloud_folder') RETURNING id::text AS id`, [kb])).rows[0].id;
    const upload = (await pg.query(`INSERT INTO kb_sources (knowledge_base_id, kind) VALUES ($1, 'upload') RETURNING id::text AS id`, [kb])).rows[0].id;
    const mail = await addDoc(kb, { title: 'Re: offer', hash: 'h-mail', sourceType: 'mailbox', metadata: { from: 'jan@example.com' } });
    const synced = await addDoc(kb, { title: 'Folder file', hash: 'h-folder', sourceId: folder });
    await addDoc(kb, { title: 'Uploaded', hash: 'h-up', sourceId: upload });
    const out = await listCarriedDocuments(kb, local);
    const fd = out.findings.find(x => x.code === 'kb.synced_source');
    assert.strictEqual(fd.severity, 'blocking');
    assert.deepStrictEqual(fd.docRefs.sort(), [mail, synced].sort(), 'an upload source is hand-made and passes');
    assert.ok(!JSON.stringify(out.findings).includes('jan@example.com'));
    await pg.query('DELETE FROM documents WHERE knowledge_base_id = $1', [kb]);
});

test('more than 500 documents is kb.too_large', async () => {
    const out = await listCarriedDocuments(DEV, local, { maxDocs: 1 });
    assert.ok(out.findings.some(x => x.code === 'kb.too_large' && x.severity === 'blocking' && x.max === 1));
    assert.strictEqual(MAX_DOCS, 500);
});

test('non-local chunks are kb.content_store_remote', async () => {
    const remoteInstance = await listCarriedDocuments(DEV, { db, usesLocalIngest: async () => false });
    assert.ok(remoteInstance.findings.some(x => x.code === 'kb.content_store_remote'));

    const kb = OTHER;
    const id = await addDoc(kb, { title: 'Elsewhere', hash: 'h-remote', chunks: 0 });
    await pg.query('UPDATE documents SET chunk_count = 4 WHERE id = $1', [id]);
    const out = await listCarriedDocuments(kb, local);
    const fd = out.findings.find(x => x.code === 'kb.content_store_remote');
    assert.deepStrictEqual(fd.docRefs, [id]);
    await pg.query('DELETE FROM documents WHERE knowledge_base_id = $1', [kb]);
});

// ── The copy ───────────────────────────────────────────────────────────

test('applyKnowledge copies by hash from the allow-list, keeps redacted, and copies chunks without re-embedding', async () => {
    const listing = await listCarriedDocuments(DEV, local);
    const out = await db.tx((client) => applyKnowledge(client, {
        sourceKbId: DEV, targetKbId: UAT, tenantId: 'uat-tenant', releaseDocs: listing.payload.docs,
    }));
    assert.deepStrictEqual(out, { copied: 2, removed: 0, unchanged: 0 });

    const docs = (await pg.query(
        `SELECT id::text AS id, tenant_id, title, content_hash, status, pii_status, metadata, source_id, external_id,
                source_uri, created_by, source_type, original_content, chunk_count, mime, size_bytes
           FROM documents WHERE knowledge_base_id = $1 ORDER BY title`, [UAT])).rows;
    assert.deepStrictEqual(docs.map(d => d.title), ['Handbook', 'Prices']);
    const prices = docs.find(d => d.title === 'Prices');
    assert.strictEqual(prices.status, 'redacted', 'redacted stays redacted');
    assert.strictEqual(prices.pii_status, 'redacted');
    for (const d of docs) {
        assert.strictEqual(d.tenant_id, 'uat-tenant');
        assert.deepStrictEqual(d.metadata, {}, 'metadata is never copied');
        assert.strictEqual(d.source_id, null);
        assert.strictEqual(d.external_id, null);
        assert.strictEqual(d.source_uri, null);
        assert.strictEqual(d.created_by, null);
        assert.strictEqual(d.original_content, `body of ${d.title}`);
        assert.strictEqual(d.chunk_count, 2);
        assert.strictEqual(d.mime, 'text/plain');
    }

    const chunks = (await pg.query(
        `SELECT document_id, chunk_id, content, tenant_id, source_uri, page_start, tsv IS NOT NULL AS has_tsv
           FROM kb_chunks WHERE knowledge_base_id = $1 ORDER BY content`, [UAT])).rows;
    assert.strictEqual(chunks.length, 4);
    assert.deepStrictEqual(chunks.map(c => c.content), ['Handbook part 0', 'Handbook part 1', 'Prices part 0', 'Prices part 1']);
    assert.ok(chunks.every(c => docs.some(d => d.id === c.document_id)), 'chunks point at the new documents');
    assert.ok(chunks.every(c => c.tenant_id === 'uat-tenant' && c.source_uri === null && c.has_tsv && c.page_start >= 1));

    // Idempotent: a second apply of the same release changes nothing.
    const again = await db.tx((client) => applyKnowledge(client, {
        sourceKbId: DEV, targetKbId: UAT, tenantId: 'uat-tenant', releaseDocs: listing.payload,
    }));
    assert.deepStrictEqual(again, { copied: 0, removed: 0, unchanged: 2 });
});

test('a document whose hash left the release is deleted with its chunks', async () => {
    const listing = await listCarriedDocuments(DEV, local);
    const onlyHandbook = listing.payload.docs.filter(d => d.title === 'Handbook');
    const out = await db.tx((client) => applyKnowledge(client, {
        sourceKbId: DEV, targetKbId: UAT, tenantId: 'uat-tenant', releaseDocs: onlyHandbook, previousDocs: listing.payload,
    }));
    assert.deepStrictEqual(out, { copied: 0, removed: 1, unchanged: 1 });
    const left = (await pg.query(`SELECT title FROM documents WHERE knowledge_base_id = $1`, [UAT])).rows;
    assert.deepStrictEqual(left.map(r => r.title), ['Handbook']);
    const chunks = (await pg.query(`SELECT COUNT(*)::int AS n FROM kb_chunks WHERE knowledge_base_id = $1`, [UAT])).rows[0].n;
    assert.strictEqual(chunks, 2);
});

test('a hash missing from the source stage throws content_drift and the transaction rolls back', async () => {
    const before = (await pg.query(`SELECT COUNT(*)::int AS n FROM documents WHERE knowledge_base_id = $1`, [UAT])).rows[0].n;
    await assert.rejects(
        db.tx((client) => applyKnowledge(client, {
            sourceKbId: DEV, targetKbId: UAT, tenantId: 'uat-tenant',
            releaseDocs: [{ contentHash: 'h-prices' }, { contentHash: 'h-vanished' }],
        })),
        (e) => e.code === 'content_drift' && e.status === 409 && e.details.contentHash === 'h-vanished',
    );
    const afterCount = (await pg.query(`SELECT COUNT(*)::int AS n FROM documents WHERE knowledge_base_id = $1`, [UAT])).rows[0].n;
    assert.strictEqual(afterCount, before, 'nothing of the failed apply remains');
});

'use strict';

/**
 * The KB query log store against a real Postgres (PGlite), through its own SQL and the real
 * sealing: insert, list with filters, review, the answer arriving later, retention, erasure of a
 * person, and the cascade when a knowledge base is deleted.
 *
 * Run: cd server && node --test stores/kb/queryLog/index.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeKbQueryLogStore } = require('./index.mts');
const { KB_QUERY_LOG_COLUMN_DDL, KB_QUERY_LOG_TABLE_DDL } = require('./ddl.mts');
const crypto = require('../../../core/kb/queryLog/crypto.mts');

const { pg, db } = pgliteDb();
const store = makeKbQueryLogStore(db);

const KB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KB_OFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG = 'org1';

const chunk = (over = {}) => ({ chunkId: 'c1', documentId: 'd1', sourceUri: 'doc.pdf', title: 'Doc', score: 0.8, page: 2, text: 'passage text', ...over });
const row = (over = {}) => ({
    searchGroupId: 'g1', organizationId: ORG, kbId: KB_A, userId: 'u1', channel: 'direct_chat', channelRef: { conversationId: 'cv1' },
    query: 'how long is the notice period?', chunks: [chunk()], retrievalMs: 12, outcome: 'no_results', retentionDays: 90, ...over,
});

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 9), sealingEnabled: async () => true });
    await pg.exec(`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT, name TEXT, organization_id TEXT);
        CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE, content_hash TEXT);
        CREATE TABLE kb_document_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL, deleted_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, "displayName" TEXT);`);
    for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql); // idempotent
    await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled) VALUES
        ('${KB_A}', 't', 'A', '${ORG}', true), ('${KB_B}', 't', 'B', '${ORG}', true), ('${KB_OFF}', 't', 'Off', '${ORG}', false);
        UPDATE knowledge_bases SET query_log_attestation = '{"purpose":"ai_quality"}'::jsonb WHERE query_log_enabled;
        INSERT INTO users (id, username, "displayName") VALUES ('u1', 'ann', 'Ann Jansen');`);
});
after(async () => { crypto._setCryptoDeps(null); await pg.close(); });
beforeEach(async () => { await pg.exec('DELETE FROM kb_query_log'); });

const raw = async () => (await pg.query('SELECT * FROM kb_query_log ORDER BY created_at, id')).rows;

test('getLoggingKbs returns only the knowledge bases whose logging is on, and ignores junk ids', async () => {
    assert.deepEqual(await store.getLoggingKbs([KB_A, KB_OFF, 'not-a-uuid']), [{ id: KB_A, organizationId: ORG, retentionDays: 90 }]);
    assert.deepEqual(await store.getLoggingKbs([]), []);
});

test('insertEntries seals the content, keeps metadata in the clear and sets expires_at from the term', async () => {
    assert.equal(await store.insertEntries([row({ retentionDays: 30 })]), 1);
    const [r] = await raw();
    assert.ok(r.query_enc.includes('_bfenc') && !r.query_enc.includes('notice'));
    assert.ok(r.chunks_enc.includes('_bfenc') && !r.chunks_enc.includes('passage'));
    assert.equal(r.chunk_count, 1);
    assert.equal(r.top_score, 0.8);
    assert.equal(r.review_status, 'to_review');
    const days = (new Date(r.expires_at) - new Date(r.created_at)) / 86_400_000;
    assert.equal(Math.round(days), 30);
});

test('a key problem inserts nothing at all (no half-written group)', async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => { throw new Error('down'); }, sealingEnabled: async () => true });
    try {
        await assert.rejects(store.insertEntries([row({ id: 'r1' }), row({ id: 'r2' })]), crypto.KbQueryLogKeyUnavailable);
    } finally {
        crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 9), sealingEnabled: async () => true });
    }
    assert.equal((await raw()).length, 0);
});

test('listEntries decrypts, names the user and filters on metadata', async () => {
    await store.insertEntries([
        row({ id: 'r1', createdAt: '2026-11-01T10:00:00Z' }),
        row({ id: 'r2', searchGroupId: 'g2', userId: 'u2', channel: 'agent_chat', outcome: 'error', createdAt: '2026-11-02T10:00:00Z', query: 'second question' }),
        row({ id: 'r3', searchGroupId: 'g3', kbId: KB_B, createdAt: '2026-11-03T10:00:00Z' }),
    ]);
    const all = await store.listEntries({ kbId: KB_A, orgId: ORG, includeContent: true });
    assert.equal(all.total, 2);
    assert.deepEqual(all.rows.map((r) => r.id), ['r2', 'r1'], 'newest first');
    const r1 = all.rows[1];
    assert.equal(r1.query, 'how long is the notice period?');
    assert.deepEqual(r1.chunks[0].text, 'passage text');
    assert.equal(r1.userName, 'Ann Jansen');
    assert.deepEqual(r1.channelRef, { conversationId: 'cv1' });

    assert.deepEqual((await store.listEntries({ kbId: KB_A, userId: 'u2' })).rows.map((r) => r.id), ['r2']);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, channel: 'direct_chat' })).rows.map((r) => r.id), ['r1']);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, outcome: 'error' })).rows.map((r) => r.id), ['r2']);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, status: 'reviewed' })).rows, []);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, from: '2026-11-02T00:00:00Z' })).rows.map((r) => r.id), ['r2']);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, to: '2026-11-01T23:00:00Z' })).rows.map((r) => r.id), ['r1']);
    assert.equal((await store.listEntries({ orgId: ORG })).total, 3, 'without kbId: the whole organisation');
    assert.equal((await store.listEntries({ orgId: 'other-org' })).total, 0);
    assert.equal((await store.listEntries({ kbId: KB_A, limit: 1, offset: 1 })).rows.length, 1);
});

test('without includeContent no text leaves the store', async () => {
    await store.insertEntries([row({ id: 'r1' })]);
    const { rows } = await store.listEntries({ kbId: KB_A });
    assert.equal(rows[0].query, null);
    assert.deepEqual(rows[0].chunks, []);
    assert.equal(rows[0].answer, null);
    assert.equal(rows[0].chunkCount, 1, 'counts are metadata');
});

test('the text filter looks into question and answer', async () => {
    await store.insertEntries([row({ id: 'r1', query: 'Vakantiedagen opbouwen?' }), row({ id: 'r2', searchGroupId: 'g2', query: 'Ziekmelden' })]);
    await store.finishGroup('g2', { answer: 'Meld je ziek voor 9 uur.', model: 'm', answerMs: 5, outcome: 'answered' });
    assert.deepEqual((await store.listEntries({ kbId: KB_A, q: 'vakantie', includeContent: true })).rows.map((r) => r.id), ['r1']);
    const byAnswer = await store.listEntries({ kbId: KB_A, q: '9 UUR', includeContent: true });
    assert.deepEqual(byAnswer.rows.map((r) => r.id), ['r2']);
    assert.equal(byAnswer.total, 1);
});

test('insertEntries is conditional at write time: logging off, or no organisation, writes no row', async () => {
    assert.equal(await store.insertEntries([row({ id: 'off', kbId: KB_OFF })]), 0, 'this KB does not log');
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false WHERE id = '${KB_A}'`);
    try {
        assert.equal(await store.insertEntries([row({ id: 'switched-off' })]), 0, 'switched off after the recorder cached "on"');
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id = '${KB_A}'`);
    }
    await pg.exec(`UPDATE knowledge_bases SET organization_id = NULL WHERE id = '${KB_A}'`);
    try {
        assert.equal(await store.insertEntries([row({ id: 'orgless' })]), 0, 'a KB without an organisation never logs');
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET organization_id = '${ORG}' WHERE id = '${KB_A}'`);
    }
    assert.equal((await raw()).length, 0);
});

test('the text filter opens only question and answer; the export walks once and never opens passages', async () => {
    const opened = [];
    const spy = { sealField: crypto.sealField, openField: (o, k, id, field, stored) => { opened.push(field); return crypto.openField(o, k, id, field, stored); } };
    const spied = makeKbQueryLogStore(db, spy);
    const sql = [];
    const spiedDb = makeKbQueryLogStore({ query: (q, p) => { sql.push(q); return db.query(q, p); } }, spy);
    await store.insertEntries([
        row({ id: 'r1', query: 'Vakantiedagen opbouwen?', createdAt: '2026-11-01T10:00:00Z' }),
        row({ id: 'r2', searchGroupId: 'g2', query: 'Ziekmelden', createdAt: '2026-11-02T10:00:00Z' }),
        row({ id: 'r3', searchGroupId: 'g3', query: 'Vakantie boeken', createdAt: '2026-11-03T10:00:00Z' }),
    ]);
    await store.setReview(KB_A, 'r1', { status: 'reviewed', note: 'checked', reviewedBy: 'u1' });

    opened.length = 0;
    const found = await spied.listEntries({ kbId: KB_A, q: 'vakantie', includeContent: true, limit: 1 });
    assert.equal(found.total, 2);
    assert.equal(found.rows.length, 1);
    const scan = opened.slice(0, 6);
    assert.ok(scan.every((f) => f === 'query' || f === 'answer'), `only question and answer are opened to match: ${scan}`);
    assert.equal(opened.filter((f) => f === 'chunks').length, 1, 'passages are opened for the returned page only');

    opened.length = 0; sql.length = 0;
    const out = [];
    for await (const r of spiedDb.exportEntries({ kbId: KB_A, q: 'vakantie' }, 50)) out.push(r);
    assert.deepEqual(out.map((r) => r.id).sort(), ['r1', 'r3']);
    assert.equal(out.find((r) => r.id === 'r1').reviewNote, 'checked');
    assert.equal(opened.includes('chunks') || opened.includes('citations'), false, 'passages and citations are never opened');
    assert.equal(sql.filter((q) => q.includes('FROM kb_query_log')).length, 1, 'one scan, no per-page re-scan');
    assert.ok(sql.every((q) => !/SELECT \*/.test(q)));

    const all = [];
    for await (const r of store.exportEntries({ kbId: KB_A }, 2)) all.push(r.id);
    assert.deepEqual(all, ['r3', 'r2'], 'the cap stops the walk, newest first');
});

test('getEntry is scoped to its knowledge base', async () => {
    await store.insertEntries([row({ id: 'r1' })]);
    assert.equal((await store.getEntry(KB_A, 'r1')).query, 'how long is the notice period?');
    assert.equal(await store.getEntry(KB_B, 'r1'), null, 'another KB cannot reach the row');
    assert.equal(await store.getEntry('not-a-uuid', 'r1'), null);
    assert.equal(await store.getEntry(KB_A, 'nope'), null);
});

test('finishGroup updates every row of the search; a KB without passages stays no_results', async () => {
    await store.insertEntries([
        row({ id: 'r1', searchGroupId: 'g1' }),
        row({ id: 'r2', searchGroupId: 'g1', kbId: KB_B, chunks: [] }),
        row({ id: 'r3', searchGroupId: 'other' }),
    ]);
    const n = await store.finishGroup('g1', { answer: 'Two months.', citations: [{ title: 'Doc', n: 1 }], model: 'gpt-x', answerMs: 900, outcome: 'answered' });
    assert.equal(n, 2);
    const r1 = await store.getEntry(KB_A, 'r1');
    assert.equal(r1.answer, 'Two months.');
    assert.deepEqual(r1.citations, [{ title: 'Doc', n: 1 }]);
    assert.equal(r1.model, 'gpt-x');
    assert.equal(r1.answerMs, 900);
    assert.equal(r1.outcome, 'answered');
    assert.ok(r1.answeredAt);
    assert.equal((await store.getEntry(KB_B, 'r2')).outcome, 'no_results');
    assert.equal((await store.getEntry(KB_A, 'r3')).answer, null, 'a different search is untouched');
    assert.equal(await store.finishGroup('missing', { outcome: 'error', errorCode: 'x' }), 0);
});

test('setReview stores status and a sealed note', async () => {
    await store.insertEntries([row({ id: 'r1' })]);
    const out = await store.setReview(KB_A, 'r1', { status: 'needs_addition', note: 'Add the 2026 CAO', reviewedBy: 'mgr1' });
    assert.equal(out.reviewStatus, 'needs_addition');
    assert.equal(out.reviewNote, 'Add the 2026 CAO');
    assert.equal(out.reviewedBy, 'mgr1');
    assert.ok(out.reviewedAt);
    const [r] = await raw();
    assert.ok(r.review_note_enc.includes('_bfenc'));
    assert.equal(await store.setReview(KB_B, 'r1', { status: 'reviewed', reviewedBy: 'x' }), null);
    assert.deepEqual((await store.listEntries({ kbId: KB_A, status: 'needs_addition' })).rows.map((x) => x.id), ['r1']);
});

test('deleteExpired removes only expired rows, in batches', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await store.insertEntries([
        row({ id: 'old1', searchGroupId: 'a', createdAt: old, retentionDays: 30 }),
        row({ id: 'old2', searchGroupId: 'b', createdAt: old, retentionDays: 30 }),
        row({ id: 'old3', searchGroupId: 'c', createdAt: old, retentionDays: 30 }),
        row({ id: 'fresh', searchGroupId: 'd', createdAt: old, retentionDays: 365 }),
    ]);
    assert.equal(await store.deleteExpired(2), 2, 'the batch limit holds');
    assert.equal(await store.deleteExpired(10), 1);
    assert.deepEqual((await raw()).map((r) => r.id), ['fresh']);
    assert.equal(await store.deleteExpired(10), 0);
});

test('recomputeExpiry applies a new term to the existing rows of one KB only', async () => {
    const created = '2026-01-01T00:00:00Z';
    await store.insertEntries([row({ id: 'r1', createdAt: created }), row({ id: 'r2', searchGroupId: 'g2', kbId: KB_B, createdAt: created })]);
    assert.equal(await store.recomputeExpiry(KB_A, 30), 1);
    const byId = Object.fromEntries((await raw()).map((r) => [r.id, r]));
    assert.equal(Math.round((new Date(byId.r1.expires_at) - new Date(created)) / 86_400_000), 30);
    assert.equal(Math.round((new Date(byId.r2.expires_at) - new Date(created)) / 86_400_000), 90);
});

test('deleteForUser erases a person across knowledge bases and clears their name from reviews', async () => {
    await store.insertEntries([
        row({ id: 'r1', userId: 'u1' }), row({ id: 'r2', searchGroupId: 'g2', userId: 'u1', kbId: KB_B }),
        row({ id: 'r3', searchGroupId: 'g3', userId: 'u2' }),
    ]);
    await store.setReview(KB_A, 'r3', { status: 'reviewed', reviewedBy: 'u1' });
    assert.equal(await store.deleteForUser(ORG, 'u1'), 2);
    const left = await raw();
    assert.deepEqual(left.map((r) => r.id), ['r3']);
    assert.equal(left[0].reviewed_by, null, 'the reviewer is detached, the review stays');
    assert.equal(left[0].review_status, 'reviewed');
    await store.insertEntries([row({ id: 'r4', searchGroupId: 'g4', userId: 'u3', organizationId: 'org2' })]);
    assert.equal(await store.deleteForUser(ORG, 'u3'), 0, 'another organisation is out of reach when the org is given');
    assert.equal(await store.deleteForUser(null, 'u3'), 1, 'account erasure passes no org and removes it everywhere');
});

test('deleteForKb and the foreign key cascade remove a KB log', async () => {
    await store.insertEntries([row({ id: 'r1' }), row({ id: 'r2', searchGroupId: 'g2', kbId: KB_B })]);
    assert.equal(await store.deleteForKb(KB_B), 1);
    assert.deepEqual((await raw()).map((r) => r.id), ['r1']);
    await pg.exec(`DELETE FROM knowledge_bases WHERE id = '${KB_A}'`);
    assert.equal((await raw()).length, 0, 'deleting the KB cascades');
    await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled) VALUES ('${KB_A}', 't', 'A', '${ORG}', true);
        UPDATE knowledge_bases SET query_log_attestation = '{"purpose":"ai_quality"}'::jsonb WHERE id = '${KB_A}'`);
});

test('countsByKb and countsForUser give numbers only', async () => {
    await store.insertEntries([
        row({ id: 'r1' }), row({ id: 'r2', searchGroupId: 'g2', outcome: 'error' }), row({ id: 'r3', searchGroupId: 'g3', kbId: KB_B, userId: 'u2' }),
    ]);
    const counts = await store.countsByKb(ORG);
    assert.equal(counts[KB_A].total, 2);
    assert.deepEqual(counts[KB_A].byOutcome, { no_results: 1, error: 1 });
    assert.deepEqual(counts[KB_A].byStatus, { to_review: 2 });
    assert.deepEqual(await store.countsForUser(ORG, 'u1'), { total: 2, byKb: { [KB_A]: 2 } });
    assert.deepEqual(await store.countsForUser(ORG, 'nobody'), { total: 0, byKb: {} });
});

test('settings: old and new values come back, a shorter term recomputes expiry, undefined keeps a value', async () => {
    const created = '2026-01-01T00:00:00Z';
    await store.insertEntries([row({ id: 'r1', createdAt: created })]);
    assert.deepEqual(await store.getQueryLogSettings(KB_OFF), {
        enabled: false, retentionDays: 90, changedAt: null, changedBy: null,
        attestation: null, attestedBy: null, attestedAt: null, showNames: false, aiActHighRisk: false,
    });
    const out = await store.setQueryLogSettings(KB_A, { retentionDays: 30, changedBy: 'mgr1' });
    assert.deepEqual(out, {
        old: { enabled: true, retentionDays: 90, showNames: false, aiActHighRisk: false },
        new: { enabled: true, retentionDays: 30, showNames: false, aiActHighRisk: false },
    });
    const s = await store.getQueryLogSettings(KB_A);
    assert.equal(s.changedBy, 'mgr1');
    assert.ok(s.changedAt);
    assert.equal(Math.round((new Date((await raw())[0].expires_at) - new Date(created)) / 86_400_000), 30);
    const off = await store.setQueryLogSettings(KB_A, { enabled: false, changedBy: 'mgr1' });
    assert.deepEqual(off.new, { enabled: false, retentionDays: 30, showNames: false, aiActHighRisk: false });
    assert.deepEqual(await store.getLoggingKbs([KB_A]), []);
    await store.setQueryLogSettings(KB_A, { enabled: true, retentionDays: 90, changedBy: 'mgr1' });
    assert.equal(await store.setQueryLogSettings('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { enabled: true, changedBy: 'x' }), null);
});

test('a row that cannot be opened comes back with decryptFailed instead of failing the list', async () => {
    await store.insertEntries([row({ id: 'r1' }), row({ id: 'r2', searchGroupId: 'g2' })]);
    await pg.exec(`UPDATE kb_query_log SET query_enc = '{"_bfenc":1,"alg":"A256GCM","iv":"00","tag":"00","ct":"00"}' WHERE id = 'r1'`);
    const { rows } = await store.listEntries({ kbId: KB_A, includeContent: true });
    const bad = rows.find((r) => r.id === 'r1');
    assert.equal(bad.decryptFailed, true);
    assert.equal(bad.query, null);
    assert.equal(rows.find((r) => r.id === 'r2').query, 'how long is the notice period?');
});

test('kbIdsForDocuments maps documents to the knowledge bases asked about', async () => {
    const D1 = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1'; const D2 = 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2';
    await pg.exec(`INSERT INTO documents (id, knowledge_base_id) VALUES ('${D1}', '${KB_A}'), ('${D2}', '${KB_B}')`);
    const m = await store.kbIdsForDocuments([D1, D2, 'junk'], [KB_A]);
    assert.deepEqual([...m], [[D1, KB_A]], 'a document of a KB that was not asked about is absent');
    await pg.exec('DELETE FROM documents');
});

// ── Round 2 ─────────────────────────────────────────────────────────

test('settings: the attestation, names and high-risk flag are stored; an undefined attestation keeps the old one', async () => {
    const att = { purpose: 'ai_quality', dpia: 'not_required', dpiaId: null, worksCouncil: 'not_applicable', worksCouncilReason: 'no_works_council', privacyNoticeUpdated: true };
    const out = await store.setQueryLogSettings(KB_B, { showNames: true, aiActHighRisk: true, retentionDays: 180, attestation: att, changedBy: 'mgr1' });
    assert.deepEqual(out.new, { enabled: true, retentionDays: 180, showNames: true, aiActHighRisk: true });
    let s = await store.getQueryLogSettings(KB_B);
    assert.deepEqual(s.attestation, att);
    assert.equal(s.attestedBy, 'mgr1');
    assert.ok(s.attestedAt);
    await store.setQueryLogSettings(KB_B, { showNames: false, aiActHighRisk: false, retentionDays: 90, changedBy: 'mgr2' });
    s = await store.getQueryLogSettings(KB_B);
    assert.deepEqual(s.attestation, att, 'kept');
    assert.equal(s.attestedBy, 'mgr1', 'still the person who attested');
});

test('acknowledge: only logging bases, valid until the next settings change, counted per base; erasure and KB purge drop them', async () => {
    assert.equal(await store.acknowledge('ua', [KB_A, KB_OFF, 'junk']), 1);
    assert.deepEqual(await store.validAckKbIds('ua', [KB_A, KB_B, KB_OFF]), [KB_A]);
    await store.acknowledge('ub', [KB_A]);
    assert.deepEqual(await store.ackCountsByKb([KB_A, KB_B]), { [KB_A]: 2 });

    await new Promise((r) => setTimeout(r, 5));
    await store.setQueryLogSettings(KB_A, { retentionDays: 90, changedBy: 'm' });
    assert.deepEqual(await store.validAckKbIds('ua', [KB_A]), [], 'a settings change re-asks');
    assert.deepEqual(await store.ackCountsByKb([KB_A]), {});
    await store.acknowledge('ua', [KB_A]);
    assert.deepEqual(await store.validAckKbIds('ua', [KB_A]), [KB_A], 'acknowledging again renews it');

    await store.deleteForUser(null, 'ua');
    assert.deepEqual((await pg.query(`SELECT user_id FROM kb_query_log_ack ORDER BY user_id`)).rows.map((r) => r.user_id), ['ub']);
    await store.deleteForUser(ORG, 'ub');
    assert.equal((await pg.query(`SELECT 1 FROM kb_query_log_ack`)).rows.length, 1, 'an org-scoped erasure of rows (a subject request) keeps the proof of notice');
    await store.deleteForKb(KB_A);
    assert.equal((await pg.query(`SELECT 1 FROM kb_query_log_ack`)).rows.length, 0);
});

test('documentVersions: hash label and the newest snapshot id; unknown documents are absent', async () => {
    const D = 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1';
    await pg.exec(`INSERT INTO documents (id, knowledge_base_id, content_hash) VALUES ('${D}', '${KB_A}', '0123456789abcdefXYZ')`);
    await pg.exec(`INSERT INTO kb_document_versions (id, document_id, deleted_at) VALUES ('11111111-1111-4111-8111-111111111111', '${D}', '2026-01-01'), ('22222222-2222-4222-8222-222222222222', '${D}', '2026-02-01')`);
    const m = await store.documentVersions([D, 'junk', 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1']);
    assert.deepEqual([...m], [[D, { versionId: '22222222-2222-4222-8222-222222222222', label: '0123456789ab' }]]);
    await pg.exec('DELETE FROM kb_document_versions; DELETE FROM documents');
});

test('askersOfKb lists the distinct people who asked', async () => {
    await store.insertEntries([row({ id: 'r1' }), row({ id: 'r2', searchGroupId: 'g2' }), row({ id: 'r3', searchGroupId: 'g3', userId: null })]);
    assert.deepEqual(await store.askersOfKb(KB_A), ['u1']);
});

test('a base that is on but has no organisation attestation logs nothing (switched on before the attestation was required)', async () => {
    await pg.exec(`UPDATE knowledge_bases SET query_log_attestation = NULL WHERE id = '${KB_A}'`);
    try {
        assert.deepEqual(await store.getLoggingKbs([KB_A]), [], 'not offered to the recorder');
        const before = (await raw()).length;
        await store.insertEntries([row({ id: 'r-unattested' })]);
        assert.equal((await raw()).length, before, 'the conditional insert refuses it');
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_attestation = '{"purpose":"ai_quality"}'::jsonb WHERE id = '${KB_A}'`);
    }
});

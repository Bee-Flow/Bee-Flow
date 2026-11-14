'use strict';

/**
 * The recorder over the real store (PGlite) and real sealing: nothing is written while logging is
 * off or the licence is missing, one row per logging KB with only its own passages, the passage
 * text capped, `finish` fills all rows of the search once, and nothing here ever throws.
 *
 * Run: cd server && node --test core/kb/queryLog/recorder.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeKbQueryLogStore } = require('../../../stores/kb/queryLog/index.mts');
const { KB_QUERY_LOG_COLUMN_DDL, KB_QUERY_LOG_TABLE_DDL } = require('../../../stores/kb/queryLog/ddl.mts');
const crypto = require('../../../stores/kb/queryLog/crypto.mts');
const rec = require('./recorder.mts');
const { CHUNK_TEXT_CAP } = require('../../../stores/kb/queryLog/vocab.mts');

const { pg, db } = pgliteDb();
const store = makeKbQueryLogStore(db);

const KB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // logs
const KB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // logs
const KB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // does not log
const DOC_A = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const DOC_B = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
const DOC_C = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';

let licensed = true;
const warnings = [];
const log = { warn: (m) => warnings.push(m) };
const hasFeature = async (_scope, feature) => feature === 'kb_query_log' && licensed;

const search = (over = {}) => ({
    channel: 'direct_chat', channelRef: { conversationId: 'cv1' }, userId: 'u1', orgId: 'org1',
    kbIds: [KB_A, KB_B, KB_C], query: 'what is the notice period?', retrievalMs: 7,
    chunks: [
        { id: 'ca', document_id: DOC_A, source_uri: 'a.pdf', title: 'A', score: 0.9, page_start: 3, content: 'text of A' },
        { id: 'cb', document_id: DOC_B, source_uri: 'b.pdf', title: 'B', score: 0.5, content: 'text of B' },
        { id: 'cc', document_id: DOC_C, source_uri: 'c.pdf', title: 'C', score: 0.4, content: 'text of C, never logged' },
    ],
    ...over,
});
const raw = async () => (await pg.query('SELECT * FROM kb_query_log ORDER BY kb_id')).rows;

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 3), sealingEnabled: async () => true });
    await pg.exec(`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT, name TEXT, organization_id TEXT);
        CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE, content_hash TEXT);
        CREATE TABLE kb_document_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL, deleted_at TIMESTAMPTZ DEFAULT now());`);
    for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
    await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled, query_log_retention_days) VALUES
        ('${KB_A}', 't', 'A', 'org1', true, 30), ('${KB_B}', 't', 'B', 'org1', true, 365), ('${KB_C}', 't', 'C', 'org1', false, 90);
        UPDATE knowledge_bases SET query_log_attestation = '{"purpose":"ai_quality"}'::jsonb WHERE query_log_enabled;
        INSERT INTO documents (id, knowledge_base_id) VALUES ('${DOC_A}', '${KB_A}'), ('${DOC_B}', '${KB_B}'), ('${DOC_C}', '${KB_C}');
        INSERT INTO kb_query_log_ack (user_id, kb_id) SELECT u, k FROM unnest(ARRAY['u1','u2']) AS u, unnest(ARRAY['${KB_A}','${KB_B}']::uuid[]) AS k;`);
});
after(async () => { rec._setRecorderDeps(null); crypto._setCryptoDeps(null); await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log');
    licensed = true;
    warnings.length = 0;
    rec._setRecorderDeps({ store, hasFeature, log });
});

test('logging off for every KB asked: zero rows (a no-op handle on a cold cache, null once it is known)', async () => {
    const h = await rec.beginKbQueryLog(search({ kbIds: [KB_C] }));
    await h?.settled();
    await h?.finish({ outcome: 'answered', answer: 'x' });
    assert.equal((await raw()).length, 0);
    assert.equal(await rec.beginKbQueryLog(search({ kbIds: [KB_C] })), null, 'cached as off: nothing to wait for');
});

test('logging on but no licence: zero rows', async () => {
    licensed = false;
    const h = await rec.beginKbQueryLog(search());
    await h?.settled();
    assert.equal((await raw()).length, 0);
});

test('begin resolves while the lookups are still pending: no database round-trip on the search path', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    rec._setRecorderDeps({ store: { ...store, getLoggingKbs: async (ids) => { await gate; return store.getLoggingKbs(ids); } }, hasFeature, log });
    const h = await rec.beginKbQueryLog(search());
    assert.ok(h, 'a handle comes back although getLoggingKbs has not answered');
    assert.equal((await raw()).length, 0);
    release();
    await h.settled();
    assert.equal((await raw()).length, 2);
});

test('the cache says "logging" but the database says off: no row is written', async () => {
    const first = await rec.beginKbQueryLog(search({ kbIds: [KB_A] }));
    await first.settled();
    await pg.exec('DELETE FROM kb_query_log');
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false WHERE id = '${KB_A}'`);
    try {
        const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A] }));
        assert.ok(h, 'still cached as logging');
        await h.settled();
        await h.finish({ outcome: 'answered', answer: 'x' });
        assert.equal((await raw()).length, 0);
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id = '${KB_A}'`);
        rec.invalidateKbQueryLogCache();
    }
});

test('a user id that is not a person is logged as nobody', async () => {
    for (const id of ['support-ai:inbox:t1', 'guest_abc123', 'guest', 'anonymous']) {
        rec.invalidateKbQueryLogCache();
        await pg.exec('DELETE FROM kb_query_log');
        const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], userId: id, channel: 'support' }));
        await h.settled();
        assert.equal((await raw())[0].user_id, null, id);
    }
    assert.equal(rec.loggableUserId('u-real-1'), 'u-real-1');
    assert.equal(rec.loggableUserId(undefined), null);
});

test('a knowledge base without an organisation is never logged', async () => {
    await pg.exec(`UPDATE knowledge_bases SET organization_id = NULL WHERE id = '${KB_A}'`);
    try {
        rec.invalidateKbQueryLogCache();
        const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], orgId: 'org1' }));
        await h?.settled();
        assert.equal((await raw()).length, 0);
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET organization_id = 'org1' WHERE id = '${KB_A}'`);
        rec.invalidateKbQueryLogCache();
    }
});

test('nothing to log for empty or junk input, and it never throws', async () => {
    assert.equal(await rec.beginKbQueryLog(search({ kbIds: [] })), null);
    assert.equal(await rec.beginKbQueryLog(search({ kbIds: undefined })), null);
    assert.equal(await rec.beginKbQueryLog(undefined), null);
});

test('one row per logging KB, each with only its own passages, sharing one search group', async () => {
    const h = await rec.beginKbQueryLog(search());
    await h.settled();
    const rows = await raw();
    assert.equal(rows.length, 2, 'KB C does not log');
    assert.equal(new Set(rows.map((r) => r.search_group_id)).size, 1);
    assert.equal(rows[0].search_group_id, h.searchGroupId);
    const a = await store.getEntry(KB_A, rows.find((r) => r.kb_id === KB_A).id);
    const b = await store.getEntry(KB_B, rows.find((r) => r.kb_id === KB_B).id);
    assert.deepEqual(a.chunks.map((c) => c.text), ['text of A']);
    assert.deepEqual(b.chunks.map((c) => c.text), ['text of B']);
    assert.equal(a.chunks[0].page, 3);
    assert.equal(a.chunks[0].sourceUri, 'a.pdf');
    assert.equal(a.query, 'what is the notice period?');
    assert.equal(a.channel, 'direct_chat');
    assert.equal(a.userId, 'u1');
    assert.equal(a.retrievalMs, 7);
    assert.ok(!JSON.stringify(rows).includes('never logged'));
    // the retention term is the one of each KB
    const days = (r) => Math.round((new Date(r.expires_at) - new Date(r.created_at)) / 86_400_000);
    assert.equal(days(rows.find((r) => r.kb_id === KB_A)), 30);
    assert.equal(days(rows.find((r) => r.kb_id === KB_B)), 365);
});

test('a KB that gave no passage gets a no_results row', async () => {
    const h = await rec.beginKbQueryLog(search({ chunks: [search().chunks[0]] }));
    await h.settled();
    const byKb = Object.fromEntries((await raw()).map((r) => [r.kb_id, r]));
    assert.equal(byKb[KB_B].chunk_count, 0);
    assert.equal(byKb[KB_B].outcome, 'no_results');
});

test('a search over one KB owns every chunk it returned, even without a document id', async () => {
    const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], chunks: [{ id: 'x', score: 0.7, content: 'no document id' }] }));
    await h.settled();
    const [r] = await raw();
    assert.equal(r.chunk_count, 1);
});

test('the passage text is capped', async () => {
    const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], chunks: [{ id: 'x', document_id: DOC_A, score: 1, content: 'x'.repeat(CHUNK_TEXT_CAP + 500) }] }));
    await h.settled();
    const [r] = await raw();
    assert.equal((await store.getEntry(KB_A, r.id)).chunks[0].text.length, CHUNK_TEXT_CAP);
});

test('retrieval-only channels are answered when there are passages; answering channels wait for finish', async () => {
    let h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], channel: 'api_search' }));
    await h.settled();
    assert.equal((await raw())[0].outcome, 'answered');
    await pg.exec('DELETE FROM kb_query_log');
    h = await rec.beginKbQueryLog(search({ kbIds: [KB_A], channel: 'agent_chat' }));
    await h.settled();
    assert.equal((await raw())[0].outcome, 'no_results');
});

test('finish fills every row of the search, and a second call changes nothing', async () => {
    const h = await rec.beginKbQueryLog(search());
    await h.finish({ answer: 'Two months.', citations: [{ n: 1 }], model: 'm1', answerMs: 400, outcome: 'answered' });
    const rows = await raw();
    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.equal(r.outcome, 'answered');
        assert.equal(r.model, 'm1');
        assert.equal(r.answer_ms, 400);
        assert.ok(r.answer_enc.includes('_bfenc'));
    }
    await h.finish({ answer: 'something else', outcome: 'error', errorCode: 'late' });
    assert.equal((await store.getEntry(KB_A, rows[0].id)).answer, 'Two months.', 'idempotent');
});

test('finish with an error outcome records the code', async () => {
    const h = await rec.beginKbQueryLog(search({ kbIds: [KB_A] }));
    await h.finish({ outcome: 'error', errorCode: 'provider_down' });
    const [r] = await raw();
    assert.equal(r.outcome, 'error');
    assert.equal(r.error_code, 'provider_down');
    assert.equal(r.answer_enc, null);
});

test('the setting is cached for a short while and invalidateKbQueryLogCache drops it', async () => {
    const first = await rec.beginKbQueryLog(search({ kbIds: [KB_A] }));
    await first.settled();
    await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = false WHERE id = '${KB_A}'`);
    try {
        assert.ok(await rec.beginKbQueryLog(search({ kbIds: [KB_A] })), 'still cached as logging');
        rec.invalidateKbQueryLogCache(KB_A);
        const before = (await raw()).length;
        const dropped = await rec.beginKbQueryLog(search({ kbIds: [KB_A] }));
        await dropped?.settled();
        assert.equal((await raw()).length, before, 'dropped, now off: no new row');
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true, query_log_attestation = COALESCE(query_log_attestation, '{"purpose":"ai_quality"}'::jsonb) WHERE id = '${KB_A}'`);
        rec.invalidateKbQueryLogCache();
    }
});

test('a store that throws never reaches the caller', async () => {
    const boom = async () => { throw new Error('db down'); };
    rec._setRecorderDeps({ store: { ...store, getLoggingKbs: boom }, hasFeature, log });
    const h0 = await rec.beginKbQueryLog(search());
    await h0?.settled();
    await h0?.finish({ outcome: 'answered' });
    assert.equal((await raw()).length, 0);

    rec._setRecorderDeps({ store: { ...store, insertEntries: boom }, hasFeature, log });
    const h = await rec.beginKbQueryLog(search());
    assert.ok(h, 'the insert is fire-and-forget, the handle still comes back');
    await h.settled();
    await h.finish({ outcome: 'answered', answer: 'x' }); // no rows were written: nothing to finish, and no throw

    rec._setRecorderDeps({ store: { ...store, finishGroup: boom }, hasFeature, log });
    const h2 = await rec.beginKbQueryLog(search());
    await h2.finish({ outcome: 'answered' });
    assert.ok(warnings.length >= 3, 'each failure is logged');
});

test('a missing encryption key skips the log and warns; the search is not affected', async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => { throw new Error('vault'); }, sealingEnabled: async () => true });
    try {
        const h = await rec.beginKbQueryLog(search());
        await h.settled();
        assert.equal((await raw()).length, 0);
        assert.ok(warnings.some((w) => w.includes('KbQueryLogKeyUnavailable')));
    } finally {
        crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 3), sealingEnabled: async () => true });
    }
});

// ── Round 2: acknowledgement before logging, document version per passage ──

const only = (kbIds, over = {}) => search({ kbIds, chunks: [search().chunks[0]], ...over });

test('ack-required channel: without an acknowledgement nothing is stored; with a valid one the row is written', async () => {
    let h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-new' }));
    await h?.settled();
    assert.equal((await raw()).length, 0, 'no ack, no row');

    assert.equal(await store.acknowledge('u-new', [KB_A, KB_C]), 1, 'only a base that logs can be acknowledged');
    rec.invalidateKbQueryLogAck('u-new', [KB_A]);
    h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-new' }));
    await h.settled();
    const rows = await raw();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'u-new');
});

test('the acknowledgement is per knowledge base: B is skipped while A is logged', async () => {
    await store.acknowledge('u-ab', [KB_A]);
    rec.invalidateKbQueryLogCache();
    const h = await rec.beginKbQueryLog(only([KB_A, KB_B], { userId: 'u-ab' }));
    await h.settled();
    assert.deepEqual((await raw()).map((r) => r.kb_id), [KB_A]);
});

test('an acknowledgement older than the last settings change no longer counts', async () => {
    await store.acknowledge('u-old', [KB_A]);
    await pg.exec(`UPDATE knowledge_bases SET query_log_changed_at = now() + interval '1 hour' WHERE id = '${KB_A}'`);
    rec.invalidateKbQueryLogCache();
    try {
        const h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-old' }));
        await h.settled();
        assert.equal((await raw()).length, 0);
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_changed_at = NULL WHERE id = '${KB_A}'`);
        rec.invalidateKbQueryLogCache();
    }
});

test('an anonymous asker on an ack-required channel is never logged', async () => {
    for (const userId of [null, undefined, 'guest_1', 'anonymous']) {
        const h = await rec.beginKbQueryLog(only([KB_A], { userId, channel: 'webpage' }));
        await h?.settled();
    }
    assert.equal((await raw()).length, 0);
});

test('channels without a person at a Bee Flow screen need no acknowledgement', async () => {
    for (const channel of ['automation_ai_step', 'skill', 'support', 'api_search']) {
        const h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-never-acked', channel }));
        await h.settled();
    }
    assert.equal((await raw()).length, 4);
});

test('an acknowledgement given after a negative lookup is picked up once the cache entry is dropped', async () => {
    let h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-late' }));
    await h?.settled();
    await store.acknowledge('u-late', [KB_A]);
    rec.invalidateKbQueryLogAck('u-late', [KB_A]);
    h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u-late' }));
    await h.settled();
    assert.equal((await raw()).length, 1);
});

test('each passage carries the version of its document at write time', async () => {
    await pg.exec(`UPDATE documents SET content_hash = 'abcdef0123456789ffff' WHERE id = '${DOC_A}'`);
    await pg.exec(`INSERT INTO kb_document_versions (id, document_id) VALUES ('99999999-9999-4999-8999-999999999999', '${DOC_A}')`);
    const h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u1' }));
    await h.settled();
    const [row] = await raw();
    const entry = await store.getEntry(row.kb_id, row.id);
    assert.equal(entry.chunks[0].documentVersion, 'abcdef012345');
    assert.equal(entry.chunks[0].documentVersionId, '99999999-9999-4999-8999-999999999999');
});

test('a failing version lookup does not drop the row', async () => {
    rec._setRecorderDeps({ store: { ...store, documentVersions: async () => { throw new Error('no table'); } }, hasFeature, log });
    const h = await rec.beginKbQueryLog(only([KB_A], { userId: 'u1' }));
    await h.settled();
    const [row] = await raw();
    assert.equal((await store.getEntry(row.kb_id, row.id)).chunks[0].documentVersion, null);
});

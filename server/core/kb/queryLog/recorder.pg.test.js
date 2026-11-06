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
const crypto = require('./crypto.mts');
const rec = require('./recorder.mts');
const { CHUNK_TEXT_CAP } = require('./vocab.mts');

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
        CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE);`);
    for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
    await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled, query_log_retention_days) VALUES
        ('${KB_A}', 't', 'A', 'org1', true, 30), ('${KB_B}', 't', 'B', 'org1', true, 365), ('${KB_C}', 't', 'C', 'org1', false, 90);
        INSERT INTO documents (id, knowledge_base_id) VALUES ('${DOC_A}', '${KB_A}'), ('${DOC_B}', '${KB_B}'), ('${DOC_C}', '${KB_C}');`);
});
after(async () => { rec._setRecorderDeps(null); crypto._setCryptoDeps(null); await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log');
    licensed = true;
    warnings.length = 0;
    rec._setRecorderDeps({ store, hasFeature, log });
});

test('logging off for every KB asked: no handle and zero rows', async () => {
    assert.equal(await rec.beginKbQueryLog(search({ kbIds: [KB_C] })), null);
    assert.equal((await raw()).length, 0);
});

test('logging on but no licence: no handle and zero rows', async () => {
    licensed = false;
    assert.equal(await rec.beginKbQueryLog(search()), null);
    assert.equal((await raw()).length, 0);
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
        assert.equal(await rec.beginKbQueryLog(search({ kbIds: [KB_A] })), null, 'dropped, now off');
    } finally {
        await pg.exec(`UPDATE knowledge_bases SET query_log_enabled = true WHERE id = '${KB_A}'`);
        rec.invalidateKbQueryLogCache();
    }
});

test('a store that throws never reaches the caller', async () => {
    const boom = async () => { throw new Error('db down'); };
    rec._setRecorderDeps({ store: { ...store, getLoggingKbs: boom }, hasFeature, log });
    assert.equal(await rec.beginKbQueryLog(search()), null);

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

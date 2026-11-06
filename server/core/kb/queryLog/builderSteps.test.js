/**
 * The KB query log as a builder step: access matrix, filters, limit cap, review and dry run.
 *
 * Run: cd server && node --test core/kb/queryLog/builderSteps.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const B = require('./builderSteps.mts');

const KB = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';

/** @param {{ managers?: string[], licensed?: boolean }} [o] */
function setup({ managers = ['owner', 'viewer'], licensed = true } = {}) {
    const calls = { list: [], review: [] };
    B._setBuilderDeps({
        getKB: async (id) => (id === KB ? { id: KB, organization_id: 'org1' } : null),
        canManage: async (_kb, userId) => ({ ok: managers.includes(userId) }),
        hasFeature: async () => licensed,
        store: {
            listEntries: async (f) => { calls.list.push(f); return { rows: [{ id: ENTRY, query: 'q', chunks: [{ text: 't' }], answer: 'a', citations: [], chunkCount: 1 }], total: 7 }; },
            setReview: async (kbId, id, p) => { calls.review.push({ kbId, id, ...p }); return { id, reviewStatus: p.status, reviewNote: p.note, reviewedAt: 'now' }; },
        },
    });
    return calls;
}
test.afterEach(() => B._setBuilderDeps(null));

const list = (input = {}, scope = { ownerId: 'owner', viewerId: 'viewer' }) => B.listQueryLog({ kbId: KB, ...input }, scope);
const review = (input = {}, scope = {}) => B.reviewQueryLog({ kbId: KB, entryId: ENTRY, status: 'reviewed', note: 'ok', ...input }, { ownerId: 'owner', viewerId: 'viewer', reviewerId: 'viewer', ...scope });

test('owner and viewer who manage the KB get decrypted rows and the total', async () => {
    const calls = setup();
    const r = await list();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.total, 7);
    assert.strictEqual(r.result.rows[0].answer, 'a');
    assert.strictEqual(calls.list[0].includeContent, true);
    assert.strictEqual(calls.list[0].kbId, KB);
});

test('a viewer who only reads is refused, with the neutral sentence', async () => {
    const calls = setup({ managers: ['owner'] });
    const r = await list();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'kb_query_log_denied');
    assert.strictEqual(calls.list.length, 0);
});

test('an owner who does not manage the KB is refused', async () => {
    const calls = setup({ managers: ['viewer'] });
    assert.strictEqual((await list()).ok, false);
    assert.strictEqual((await review()).ok, false);
    assert.strictEqual(calls.list.length + calls.review.length, 0);
});

test('without the licence both calls are refused with the licence code', async () => {
    const calls = setup({ licensed: false });
    assert.strictEqual((await list()).code, 'kb_query_log_unlicensed');
    assert.strictEqual((await review()).code, 'kb_query_log_unlicensed');
    assert.strictEqual(calls.list.length + calls.review.length, 0);
});

test('an automation (no viewer) needs only the owner', async () => {
    setup({ managers: ['owner'] });
    assert.strictEqual((await list({}, { ownerId: 'owner' })).ok, true);
    assert.strictEqual((await review({}, { viewerId: undefined, reviewerId: 'owner' })).ok, true);
});

test('an unknown or malformed KB id is refused without touching the store', async () => {
    const calls = setup();
    assert.strictEqual((await B.listQueryLog({ kbId: 'nope' }, { ownerId: 'owner' })).code, 'kb_query_log_kb');
    assert.strictEqual((await B.listQueryLog({ kbId: '99999999-9999-4999-8999-999999999999' }, { ownerId: 'owner' })).code, 'kb_query_log_denied');
    assert.strictEqual(calls.list.length, 0);
});

test('filters pass through, limit defaults to 50 and is capped at 200', async () => {
    const calls = setup();
    await list({ filters: { status: 'to_review', outcome: 'no_results', channel: 'agent_chat', userId: 'u9', from: '2026-01-01', to: '2026-02-01', junk: 'x' } });
    assert.deepStrictEqual(
        { s: calls.list[0].status, o: calls.list[0].outcome, c: calls.list[0].channel, u: calls.list[0].userId, f: calls.list[0].from, t: calls.list[0].to, j: calls.list[0].junk, l: calls.list[0].limit },
        { s: 'to_review', o: 'no_results', c: 'agent_chat', u: 'u9', f: '2026-01-01', t: '2026-02-01', j: undefined, l: 50 });
    await list({ limit: 9999 });
    assert.strictEqual(calls.list[1].limit, 200);
    await list({ limit: 5 });
    assert.strictEqual(calls.list[2].limit, 5);
    await list({ limit: 'x' });
    assert.strictEqual(calls.list[3].limit, 50);
});

test('a value outside the vocabulary is an error, an empty one means no filter', async () => {
    const calls = setup();
    assert.strictEqual((await list({ filters: { status: 'bogus' } })).code, 'kb_query_log_filter');
    assert.strictEqual((await list({ filters: { channel: 'bogus' } })).code, 'kb_query_log_filter');
    assert.strictEqual((await list({ filters: { from: 'not a date' } })).code, 'kb_query_log_filter');
    assert.strictEqual((await list({ filters: { status: '', outcome: null } })).ok, true);
    assert.strictEqual(calls.list.at(-1).status, null);
});

test('resultDetail summary drops passages and answers', async () => {
    setup();
    const r = await list({ detail: 'summary' });
    assert.deepStrictEqual([r.result.rows[0].chunks, r.result.rows[0].answer, r.result.rows[0].chunkCount], [[], null, 1]);
});

test('review writes status and note under the reviewer, capped', async () => {
    const calls = setup();
    const r = await review({ note: 'x'.repeat(B.MAX_NOTE_CHARS + 10) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.updated, true);
    assert.strictEqual(calls.review[0].reviewedBy, 'viewer');
    assert.strictEqual(calls.review[0].note.length, B.MAX_NOTE_CHARS);
});

test('a dry run checks access and validates but writes nothing', async () => {
    const calls = setup();
    const r = await review({}, { dryRun: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.updated, false);
    assert.strictEqual(calls.review.length, 0);
    setup({ managers: ['owner'] });
    assert.strictEqual((await review({}, { dryRun: true })).ok, false);
});

test('review rejects a bad status, a bad entry id and a missing row', async () => {
    const calls = setup();
    assert.strictEqual((await review({ status: 'done' })).code, 'kb_query_log_status');
    assert.strictEqual((await review({ entryId: 'x' })).code, 'kb_query_log_entry');
    assert.strictEqual(calls.review.length, 0);
    B._setBuilderDeps({ store: { listEntries: async () => ({ rows: [], total: 0 }), setReview: async () => null } });
    assert.strictEqual((await review()).status, 404);
});

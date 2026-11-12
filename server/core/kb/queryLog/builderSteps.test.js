/**
 * The KB query log as a builder step: access matrix, filters, limit cap, review and dry run.
 *
 * Run: cd server && node --test core/kb/queryLog/builderSteps.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'builder-test-session-secret-0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');
const B = require('./builderSteps.mts');

const KB = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';

/** @param {{ managers?: string[], licensed?: boolean }} [o] */
function setup({ managers = ['owner', 'viewer'], licensed = true, showNames = true, askers = ['u9'], auditFails = false } = {}) {
    const calls = { list: [], review: [], audit: [] };
    B._setBuilderDeps({
        audit: async (entry) => { if (auditFails) throw new Error('audit down'); calls.audit.push(entry); },
        getKB: async (id) => (id === KB ? { id: KB, organization_id: 'org1', query_log_show_names: showNames } : null),
        canManage: async (_kb, userId) => ({ ok: managers.includes(userId) }),
        hasFeature: async () => licensed,
        store: {
            askersOfKb: async () => askers,
            listEntries: async (f) => { calls.list.push(f); return { rows: [{ id: ENTRY, userId: 'u9', userName: 'Una Nine', organizationId: 'org1', query: 'q', chunks: [{ text: 't' }], answer: 'a', citations: [], chunkCount: 1 }], total: 7 }; },
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
    const r = await list({ detail: 'full' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.total, 7);
    assert.strictEqual(r.result.rows[0].answer, 'a');
    assert.strictEqual(calls.list[0].includeContent, true);
    assert.strictEqual(calls.list[0].kbId, KB);
});

test('a full list is recorded in the access audit first; a summary list carries no text and is not', async () => {
    const calls = setup();
    assert.strictEqual((await list({ detail: 'full' })).ok, true);
    assert.strictEqual(calls.audit.length, 1);
    assert.deepStrictEqual(
        { action: calls.audit[0].action, targetId: calls.audit[0].targetId, orgId: calls.audit[0].orgId, actorId: calls.audit[0].actorId },
        { action: 'kb.query_log.content_viewed', targetId: KB, orgId: 'org1', actorId: 'viewer' },
    );
    assert.ok(!JSON.stringify(calls.audit).includes('Una Nine'));
    await list({ detail: 'full' }, { ownerId: 'owner' });
    assert.strictEqual(calls.audit[1].actorId, 'owner', 'an automation run is recorded on its owner');
    const summary = await list();
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(calls.audit.length, 2);
});

test('a full list whose audit cannot be written reads nothing', async () => {
    const calls = setup({ auditFails: true });
    const r = await list({ detail: 'full' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(calls.list.length, 0);
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

test('resultDetail summary drops passages, answers and the question', async () => {
    setup();
    const r = await list({ detail: 'summary' });
    assert.deepStrictEqual([r.result.rows[0].chunks, r.result.rows[0].answer, r.result.rows[0].chunkCount, r.result.rows[0].query], [[], null, 1, null]);
});

test('without a detail the DEFAULT is the summary: no logged text leaves the store', async () => {
    setup();
    const r = await list();
    assert.deepStrictEqual([r.result.rows[0].chunks, r.result.rows[0].answer, r.result.rows[0].query, r.result.rows[0].reviewNote], [[], null, null, null]);
});

test('redactLogStepOutput empties the content of a stored copy and leaves the live one alone', async () => {
    const live = { rows: [{ id: 'e', query: 'secret question', answer: 'secret answer', chunks: [{ text: 'passage' }], citations: [1], reviewNote: 'n', chunkCount: 1, outcome: 'answered' }], total: 1, count: 1, knowledgeBaseId: KB };
    const stored = B.redactLogStepOutput(live);
    assert.doesNotMatch(JSON.stringify(stored), /secret|passage|"n"/);
    assert.strictEqual(stored.rows[0].outcome, 'answered');
    assert.strictEqual(live.rows[0].query, 'secret question');
    const rev = B.redactLogStepOutput({ updated: true, entryId: 'e', note: 'private note', wouldUpdate: { note: 'private note' } });
    assert.doesNotMatch(JSON.stringify(rev), /private/);
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

test('names off (the default): rows carry a stable pseudonym and no user id or name; the person filter takes the pseudonym id', async () => {
    const { askerPseudonym } = require('./askers.mts');
    const calls = setup({ showNames: false });
    const p = askerPseudonym('u9', 'org1');
    const r = await list({ detail: 'full' });
    const row = r.result.rows[0];
    assert.strictEqual('userId' in row, false);
    assert.strictEqual('userName' in row, false);
    assert.strictEqual(row.askerPseudonym, p.label);
    assert.strictEqual(row.askerPseudonymId, p.id);
    assert.match(row.askerPseudonym, /^Member · [A-Z2-9]{4}$/);
    assert.strictEqual(JSON.stringify(r).includes('Una Nine'), false);

    await list({ filters: { userId: p.id } });
    assert.strictEqual(calls.list[1].userId, 'u9', 'resolved to the real person for the query');
    await list({ filters: { userId: 'u9' } });
    assert.notStrictEqual(calls.list[2].userId, 'u9', 'a real user id must not match when names are off');
    await list({ filters: { userId: p.id } });
    const summary = (await list()).result.rows[0];
    assert.strictEqual('userId' in summary, false);
    assert.strictEqual(summary.query, null);
});

test('names on: user id and name come through, and the filter takes the user id', async () => {
    const calls = setup({ showNames: true });
    const row = (await list({ detail: 'full', filters: { userId: 'u9' } })).result.rows[0];
    assert.strictEqual(row.userId, 'u9');
    assert.strictEqual(row.userName, 'Una Nine');
    assert.strictEqual(calls.list[0].userId, 'u9');
});

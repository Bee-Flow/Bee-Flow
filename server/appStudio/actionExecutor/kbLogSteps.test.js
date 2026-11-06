/**
 * kb_log_query / kb_log_review through the real dispatcher: bindings resolve, the viewer is the reviewer,
 * the owner AND the viewer must manage the KB, and app_run_action's dry run reads but never reviews.
 *
 * Run: cd server && node --test appStudio/actionExecutor/kbLogSteps.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../../core/kb/queryLog/builderSteps.mts');
const { executeDataStep } = require('./dispatch');
const { decideStep, MOCKABLE_KINDS } = require('../mcpRunActionPolicy.mts');
const { STEP_SPECS } = require('../componentSpecs');

const KB = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const st = (value) => ({ kind: 'static', value });
const app = { id: 'app1', userId: 'owner', organizationId: 'org1' };

function setup({ managers = ['owner', 'viewer'], licensed = true } = {}) {
    const calls = { list: [], review: [] };
    B._setBuilderDeps({
        getKB: async (id) => (id === KB ? { id: KB, organization_id: 'org1' } : null),
        canManage: async (_kb, userId) => ({ ok: managers.includes(userId) }),
        hasFeature: async () => licensed,
        store: {
            listEntries: async (f) => { calls.list.push(f); return { rows: [{ id: ENTRY, query: 'q', chunks: [], answer: null, citations: [] }], total: 1 }; },
            setReview: async (kbId, id, p) => { calls.review.push({ kbId, id, ...p }); return { id, reviewStatus: p.status, reviewNote: p.note, reviewedAt: 'now' }; },
        },
    });
    return calls;
}
test.afterEach(() => B._setBuilderDeps(null));

const ctx = (extra = {}) => ({ viewerId: 'viewer', formValues: { note: 'fix the FAQ' }, vars: {}, ...extra });
const queryStep = (extra = {}) => ({ kind: 'kb_log_query', kbId: st(KB), filters: { status: st('to_review') }, resultVar: 'queue', ...extra });
const reviewStep = (extra = {}) => ({ kind: 'kb_log_review', kbId: st(KB), entryId: st(ENTRY), status: st('needs_addition'), note: { kind: 'formula', expr: 'form.note' }, ...extra });

test('both kinds are server steps with their own field tables', () => {
    assert.ok(STEP_SPECS.kb_log_query.fields.kbId.required);
    assert.strictEqual(STEP_SPECS.kb_log_query.fields.limit.max, 200);
    assert.ok(STEP_SPECS.kb_log_review.fields.status.required);
});

test('kb_log_query resolves its bindings and returns { rows, total }', async () => {
    const calls = setup();
    const r = await executeDataStep(app, null, queryStep({ limit: 20 }), ctx());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.result.total, 1);
    assert.strictEqual(calls.list[0].status, 'to_review');
    assert.strictEqual(calls.list[0].limit, 20);
});

test('kb_log_review stores the status and the note under the viewer', async () => {
    const calls = setup();
    const r = await executeDataStep(app, null, reviewStep(), ctx());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([calls.review[0].status, calls.review[0].note, calls.review[0].reviewedBy], ['needs_addition', 'fix the FAQ', 'viewer']);
});

test('a viewer who only reads, an owner who does not manage, and a missing licence are all refused', async () => {
    let calls = setup({ managers: ['owner'] });
    for (const s of [queryStep(), reviewStep()]) {
        const r = await executeDataStep(app, null, s, ctx());
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.retryable, false);
    }
    calls = setup({ managers: ['viewer'] });
    assert.strictEqual((await executeDataStep(app, null, queryStep(), ctx())).ok, false);
    calls = setup({ licensed: false });
    assert.strictEqual((await executeDataStep(app, null, reviewStep(), ctx())).code, 'kb_query_log_unlicensed');
    assert.strictEqual(calls.list.length + calls.review.length, 0);
});

test('no viewer at all (an anonymous id never manages) is refused', async () => {
    setup({ managers: ['owner'] });
    assert.strictEqual((await executeDataStep(app, null, queryStep(), ctx({ viewerId: null }))).ok, false);
    assert.strictEqual((await executeDataStep(app, null, queryStep(), ctx({ viewerId: 'anon-1' }))).ok, false);
});

test('ctx.dryRun keeps the review from being written', async () => {
    const calls = setup();
    const r = await executeDataStep(app, null, reviewStep(), ctx({ dryRun: true }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.updated, false);
    assert.strictEqual(calls.review.length, 0);
});

test('app_run_action dry run: the read runs, the review is skipped; live runs refuse both', () => {
    assert.strictEqual(decideStep(queryStep(), true, false).run, true);
    const rev = decideStep(reviewStep(), true, false);
    assert.strictEqual(rev.run, false);
    assert.strictEqual(rev.status, 'skipped');
    assert.strictEqual(decideStep(reviewStep(), false, false).status, 'refused');
    assert.ok(!MOCKABLE_KINDS.includes('kb_log_query'));
});

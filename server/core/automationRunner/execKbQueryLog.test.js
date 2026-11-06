/**
 * The `kb_query_log` automation step: list and review, the owner gate, the licence, dry run, and the
 * builder + validator that make it creatable.
 *
 * Run: cd server && node --test core/automationRunner/execKbQueryLog.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const B = require('../kb/queryLog/builderSteps.mts');
const { execKbQueryLog } = require('./execKbQueryLog.mts');
const { applyAddKbQueryLog } = require('../../automation/builderTools/stepBuilders/kbQueryLogStep.mts');
const { VALID_STEP_TYPES } = require('../automationModel/constants');
const { stepEffect } = require('../automationModel/stepEffect');

const KB = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';

function setup({ managers = ['owner'], licensed = true } = {}) {
    const calls = { list: [], review: [] };
    B._setBuilderDeps({
        getKB: async (id) => (id === KB ? { id: KB, organization_id: 'org1' } : null),
        canManage: async (_kb, userId) => ({ ok: managers.includes(userId) }),
        hasFeature: async () => licensed,
        store: {
            listEntries: async (f) => { calls.list.push(f); return { rows: [{ id: ENTRY, query: 'q' }], total: 3 }; },
            setReview: async (kbId, id, p) => { calls.review.push({ kbId, id, ...p }); return { id, reviewStatus: p.status, reviewNote: p.note, reviewedAt: 'now' }; },
        },
    });
    return calls;
}
test.afterEach(() => B._setBuilderDeps(null));

const ctx = { userId: 'owner', orgId: 'org1' };
const state = { steps: { prev: { output: { id: ENTRY, kb: KB } } }, secrets: { token: 'SECRET' } };

test('list: templates resolve, filters and limit reach the store, output is { rows, total, count }', async () => {
    const calls = setup();
    const r = await execKbQueryLog({ op: 'list', knowledgeBaseId: '{{steps.prev.output.kb}}', filters: { status: 'to_review', outcome: 'no_results' }, limit: 500 }, ctx, state, 'live');
    assert.strictEqual(r.skippedReason, undefined, JSON.stringify(r));
    assert.deepStrictEqual([r.output.total, r.output.count, r.output.knowledgeBaseId], [3, 1, KB]);
    assert.deepStrictEqual([calls.list[0].status, calls.list[0].outcome, calls.list[0].limit], ['to_review', 'no_results', 200]);
});

test('review writes under the owner; a dry run does not', async () => {
    const calls = setup();
    const step = { op: 'review', knowledgeBaseId: KB, entryId: '{{steps.prev.output.id}}', status: 'needs_addition', note: 'add a FAQ' };
    const live = await execKbQueryLog(step, ctx, state, 'live');
    assert.strictEqual(live.output.updated, true);
    assert.deepStrictEqual([calls.review[0].id, calls.review[0].note, calls.review[0].reviewedBy], [ENTRY, 'add a FAQ', 'owner']);
    const dry = await execKbQueryLog(step, ctx, state, 'dry_run');
    assert.strictEqual(dry.output.updated, false);
    assert.strictEqual(dry.dryRunSynthesised, true);
    assert.strictEqual(calls.review.length, 1);
});

test('an owner who does not manage the KB, or a missing licence, skips the step with the reason and bindable keys', async () => {
    let calls = setup({ managers: [] });
    let r = await execKbQueryLog({ op: 'list', knowledgeBaseId: KB }, ctx, state, 'live');
    assert.strictEqual(r.skippedReason, 'kb_query_log_denied');
    assert.deepStrictEqual([r.output.rows, r.output.total], [[], 0]);
    r = await execKbQueryLog({ op: 'review', knowledgeBaseId: KB, entryId: ENTRY, status: 'reviewed' }, ctx, state, 'live');
    assert.strictEqual(r.skippedReason, 'kb_query_log_denied');
    assert.strictEqual(r.output.updated, false);
    calls = setup({ licensed: false });
    r = await execKbQueryLog({ op: 'list', knowledgeBaseId: KB }, ctx, state, 'live');
    assert.strictEqual(r.skippedReason, 'kb_query_log_unlicensed');
    assert.strictEqual(calls.list.length, 0);
});

test('no knowledge base picked skips, a bad filter value skips', async () => {
    setup();
    assert.strictEqual((await execKbQueryLog({ op: 'list', knowledgeBaseId: '' }, ctx, state, 'live')).skippedReason, 'kb_query_log_no_kb');
    assert.strictEqual((await execKbQueryLog({ op: 'list', knowledgeBaseId: KB, filters: { status: 'bogus' } }, ctx, state, 'live')).skippedReason, 'kb_query_log_filter');
});

test('a secret never reaches the query', async () => {
    const calls = setup();
    await execKbQueryLog({ op: 'list', knowledgeBaseId: KB, filters: { userId: '{{secrets.token}}' } }, ctx, state, 'live');
    assert.ok(!JSON.stringify(calls.list[0]).includes('SECRET'));
});

test('the builder makes a valid list and review step, clamps the limit and drops unknown filters', () => {
    const draft = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };
    const a = applyAddKbQueryLog(draft, { op: 'list', knowledgeBaseId: KB, filters: { status: 'to_review', junk: 'x' }, limit: 999 });
    assert.deepStrictEqual([a.added.type, a.added.op, a.added.limit, a.added.filters], ['kb_query_log', 'list', 200, { status: 'to_review' }]);
    const b = applyAddKbQueryLog(draft, { op: 'review', knowledgeBaseId: KB, entryId: { kind: 'ref', path: 'loop.r.id' }, status: 'reviewed' });
    assert.strictEqual(b.added.entryId, '{{loop.r.id}}');
    assert.ok(applyAddKbQueryLog(draft, { op: 'zap' }).error);
    assert.ok(applyAddKbQueryLog(draft, { op: 'list', limit: 0 }).error);
});

test('the type is registered and its effect follows the op', () => {
    assert.ok(VALID_STEP_TYPES.has('kb_query_log'));
    assert.strictEqual(stepEffect({ type: 'kb_query_log', op: 'list' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'kb_query_log', op: 'review' }), 'writes');
});

test('the validator accepts a complete step and names what is missing', () => {
    const { validateDefinition } = require('../../automation/validate');
    const def = (step) => ({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'kb_query_log', ...step }], edges: [{ from: 'trg', to: 's1' }] });
    const codes = (d) => validateDefinition(d).errors.map((e) => e.code);
    assert.deepStrictEqual(codes(def({ op: 'list', knowledgeBaseId: KB, filters: { status: 'to_review' }, limit: 50 })), []);
    assert.ok(codes(def({ op: 'list', knowledgeBaseId: '' })).includes('kb_query_log.kb_required'));
    assert.ok(codes(def({ op: 'review', knowledgeBaseId: KB })).includes('kb_query_log.entryId_required'));
    assert.ok(codes(def({ op: 'list', knowledgeBaseId: KB, limit: 500 })).includes('kb_query_log.limit_invalid'));
    assert.ok(codes(def({ op: 'nope', knowledgeBaseId: KB })).includes('kb_query_log.op_invalid'));
});

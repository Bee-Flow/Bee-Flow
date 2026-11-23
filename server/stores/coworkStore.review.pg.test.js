// @typecheck
/**
 * The review side of the Cowork run history, on the store's own schema and SQL (PGlite behind db.js):
 *
 *   - a run that asked for a review closes as `needs_review` with its reason, question and summary, its own
 *     conversation and its activity (names and counts), and closes ITS OWN row by id, not the newest open one;
 *   - the open reviews are counted per item;
 *   - resolving one is once only, records who and how, and an answer opens the follow-up run in the same
 *     conversation, one step deeper, with the original run's context;
 *   - the figures count a run waiting for review neither as a success nor as a failure.
 *
 * Run: cd server && node --test stores/coworkStore.review.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { coworkStoreOnPglite } = require('./coworkStore.testkit');

const { pg, store } = coworkStoreOnPglite();
const triggerStore = require('./coworkTriggerStore');

const USER = 'u-review';
/** @type {string} */
let scheduleId;

before(async () => {
    const s = await store.createSchedule({ userId: USER, title: 'Mail desk', prompt: 'Answer new mail.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), agentId: 'agent-1' });
    scheduleId = /** @type {{ id: string }} */ (s).id;
});

const REVIEW = { reason: 'The discount is not agreed.', question: 'Which discount applies?', summary: 'Read the mail.' };
const ACTIVITY = { tools: [{ name: 'outlook_create_draft', app: 'outlook', ok: 0, failed: 0, refused: 1, reasons: ['privacy_shield'] }], skills: [{ id: 's1', name: 'Tone', how: 'static' }], toolCalls: 1 };
const CONTEXT = { mail: { provider: 'outlook', messageId: 'm1', threadId: 't1', mailbox: null, readOutside: false }, offeredTools: ['outlook_read', 'outlook_create_draft'], unattended: true };

/** @type {string} */
let reviewRunId;
/** @type {string} */
let followUpRunId;

test('a run that asked for a review closes as needs_review, on its own row, with what it did', async () => {
    reviewRunId = /** @type {string} */ (await store.markRunning(scheduleId));
    // A second run on the same item while the first is busy: a run started by a mail. markRunning itself is one
    // claim per item (./coworkStore.claim.pg.test.js), so the overlap is opened the way it really happens.
    const laterRun = /** @type {string} */ (await triggerStore.claimEventRun({ scheduleId, userId: USER, triggerRef: 'mail-overlap-1' }));
    await store.markCompleted(scheduleId, 'Waiting for your decision.', {
        runId: reviewRunId, review: REVIEW, activity: ACTIVITY, conversationId: 'conv-1', runContext: CONTEXT, mailSubject: 'Offer Q3',
    });
    const runs = await store.listRuns(scheduleId);
    const run = runs.find((r) => r?.id === reviewRunId);
    assert.strictEqual(run?.status, 'needs_review');
    assert.deepStrictEqual(run?.review, { ...REVIEW, resolution: null, resolvedBy: null, resolvedAt: null });
    assert.deepStrictEqual(run?.activity, ACTIVITY);
    assert.strictEqual(run?.conversationId, 'conv-1');
    assert.strictEqual(run?.mailSubject, 'Offer Q3');
    assert.ok(!('runContext' in /** @type {object} */ (run)), 'the run context stays on the server');
    assert.strictEqual(runs.find((r) => r?.id === laterRun)?.status, 'running', 'the newer open run is untouched');
    await store.markCompleted(scheduleId, 'Done.', { runId: laterRun });
});

test('open reviews are counted per item, and the figures count them neither as success nor as failure', async () => {
    assert.deepStrictEqual(await store.getOpenReviewCounts(USER), { [scheduleId]: 1 });
    assert.strictEqual(await store.countOpenReviews(scheduleId), 1);
    const stats = await store.getRunStats(scheduleId);
    assert.deepStrictEqual([stats.total, stats.success, stats.failed, stats.needsReview], [2, 1, 0, 1]);
});

test('the run context of a run is there for the follow-up, and only for its own item', async () => {
    assert.deepStrictEqual((await store.getRunForReview(scheduleId, reviewRunId))?.runContext, CONTEXT);
    assert.strictEqual(await store.getRunForReview('another-item', reviewRunId), null);
});

test('an answer resolves the review once and opens the follow-up in the same conversation, one step deeper', async () => {
    const res = await store.resolveReview({ scheduleId, runId: reviewRunId, userId: USER, resolution: 'answered', followUp: true });
    assert.ok(res?.followUpRunId);
    followUpRunId = /** @type {string} */ (res?.followUpRunId);
    assert.strictEqual(res?.run?.review?.resolution, 'answered');
    assert.strictEqual(res?.run?.review?.resolvedBy, USER);
    assert.ok(res?.run?.review?.resolvedAt);
    const { rows } = await pg.query('SELECT status, trigger_kind, parent_run_id, followup_depth, conversation_id, run_context_json FROM cowork_runs WHERE id = $1', [res?.followUpRunId]);
    assert.deepStrictEqual({ ...rows[0], run_context_json: JSON.parse(rows[0].run_context_json) }, {
        status: 'running', trigger_kind: 'review', parent_run_id: reviewRunId, followup_depth: 1, conversation_id: 'conv-1', run_context_json: CONTEXT,
    });
    assert.strictEqual((await store.getSchedule(scheduleId))?.lastStatus, 'running');
    assert.strictEqual(await store.resolveReview({ scheduleId, runId: reviewRunId, userId: USER, resolution: 'not_needed', followUp: false }), null, 'once only');
    assert.strictEqual(await store.countOpenReviews(scheduleId), 0);
});

test('closing without a follow-up records how, and a run that is not waiting cannot be resolved', async () => {
    // The follow-up of the answer above finishes first: while it holds the item, no other run is claimed.
    assert.strictEqual(await store.markRunning(scheduleId), null);
    await store.markCompleted(scheduleId, 'Answered.', { runId: followUpRunId });
    const runId = /** @type {string} */ (await store.markRunning(scheduleId));
    await store.markCompleted(scheduleId, 'Waiting.', { runId, review: { reason: 'x', question: null, summary: null } });
    const res = await store.resolveReview({ scheduleId, runId, userId: USER, resolution: 'done_myself', followUp: false });
    assert.strictEqual(res?.run?.review?.resolution, 'done_myself');
    assert.strictEqual(res?.followUpRunId, null);
    const plain = /** @type {string} */ (await store.markRunning(scheduleId));
    await store.markCompleted(scheduleId, 'Done.', { runId: plain });
    assert.strictEqual(await store.resolveReview({ scheduleId, runId: plain, userId: USER, resolution: 'not_needed', followUp: false }), null);
});

test('a failed run closes its own row with its activity', async () => {
    const runId = /** @type {string} */ (await store.markRunning(scheduleId));
    await store.markError(scheduleId, new Error('model down'), { runId, activity: ACTIVITY, conversationId: 'conv-9' });
    const run = (await store.listRuns(scheduleId)).find((r) => r?.id === runId);
    assert.deepStrictEqual([run?.status, run?.error, run?.conversationId, run?.activity?.toolCalls], ['error', 'model down', 'conv-9', 1]);
});

test('the runs waiting for their owner: an unhandled review and a plan run waiting for a decision, only the owner\'s own', async () => {
    const s = await store.createSchedule({ userId: 'u-needs', title: 'Waits', prompt: 'P', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const review = /** @type {string} */ (await store.markRunning(s.id, { triggerKind: 'manual' }));
    await store.markCompleted(s.id, 'Look at this.', { runId: review, review: { reason: 'Two invoices look the same.' } });
    const waiting = /** @type {string} */ (await store.markRunning(s.id, { triggerKind: 'manual' }));
    await store.markCompleted(s.id, 'Waiting.', { runId: waiting, waiting: true });
    const plain = /** @type {string} */ (await store.markRunning(s.id, { triggerKind: 'manual' }));
    await store.markCompleted(s.id, 'Done.', { runId: plain });
    const list = await store.listRunsWaitingForOwner('u-needs');
    assert.deepStrictEqual(list.map((r) => [r.runId, r.status]).sort(), [[review, 'needs_review'], [waiting, 'waiting']].sort());
    assert.strictEqual(list.find((r) => r.runId === review)?.reason, 'Two invoices look the same.');
    assert.deepStrictEqual(await store.listRunsWaitingForOwner('someone-else'), []);
});

/**
 * Handling a Cowork run that asked for review: close it without a follow-up, or answer it and continue in the same
 * conversation under the same tool policy (never more), within COWORK_REVIEW_MAX_FOLLOWUPS.
 *
 * The store and the run starter are handed in: no module is mocked.
 *
 * Run: node --test usecases/coworkReview.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const review = require('./coworkReview.mts');

const schedule = { id: 's1', userId: 'u1', agentId: 'a1', title: 'Mail desk', prompt: 'Answer new mail.', lastStatus: 'success', triggerKind: 'app_event' };
const waitingRun = (over = {}) => ({
    id: 'r1', status: 'needs_review', followupDepth: 0, conversationId: 'conv-1', mailSubject: 'Offer Q3',
    review: { reason: 'The discount is not agreed.', question: 'Which discount applies?', summary: null, resolution: null, resolvedBy: null, resolvedAt: null },
    runContext: { offeredTools: ['outlook_read', 'outlook_create_draft'], unattended: true, mail: { provider: 'outlook', messageId: 'm1', threadId: 't1', mailbox: null, readOutside: false } },
    ...over,
});

function fakeDeps(run = waitingRun()) {
    const state = { resolved: [], started: [] };
    return {
        state,
        deps: {
            store: {
                getRunForReview: async (scheduleId, runId) => (scheduleId === 's1' && runId === run.id ? run : null),
                resolveReview: async (p) => { state.resolved.push(p); return { run: { ...run, review: { ...run.review, resolution: p.resolution } }, followUpRunId: p.followUp ? 'f1' : null }; },
            },
            startRun: (task, trigger) => { state.started.push({ task, trigger }); },
            fetchMessage: async () => ({ from_email: 'ann@example.com', to_emails: 'me@example.org', subject: 'Offer Q3', provider_thread_id: 't1' }),
        },
    };
}

afterEach(() => { delete process.env.COWORK_REVIEW_MAX_FOLLOWUPS; });

test('closing without a follow-up records how and starts nothing', async () => {
    const { deps, state } = fakeDeps();
    const res = await review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'done_myself' }, deps);
    assert.deepStrictEqual(state.resolved, [{ scheduleId: 's1', runId: 'r1', userId: 'u1', resolution: 'done_myself', followUp: false }]);
    assert.strictEqual(state.started.length, 0);
    assert.strictEqual(res.followUpRunId, null);
});

test('an answer continues in the same conversation, under the ceiling of the run, with the mail thread and its limits', async () => {
    const { deps, state } = fakeDeps();
    const res = await review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: 'Make a draft anyway, with 5% as agreed by phone.' }, deps);
    assert.strictEqual(res.followUpRunId, 'f1');
    assert.strictEqual(state.resolved[0].resolution, 'answered');
    const { task, trigger } = state.started[0];
    assert.strictEqual(task.conversationId, 'conv-1');
    assert.strictEqual(trigger.runId, 'f1');
    assert.deepStrictEqual(trigger.toolCeiling, ['outlook_read', 'outlook_create_draft']);
    assert.strictEqual(trigger.metadata.unattended, true);
    assert.strictEqual(trigger.metadata.mailTrigger.threadId, 't1');
    assert.strictEqual(trigger.metadata.mailTrigger.messageId, 'm1');
    assert.match(trigger.prompt, /5% as agreed by phone/);
    assert.match(trigger.prompt, /Which discount applies\?/);
    assert.strictEqual(trigger.mailSubject, 'Offer Q3');
});

test('an answer needs text, an agent, a stored ceiling and a conversation', async () => {
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: '  ' }, fakeDeps().deps), { status: 400 });
    await assert.rejects(review.handleRunReview({ schedule: { ...schedule, agentId: null }, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, fakeDeps().deps), { status: 409 });
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, fakeDeps(waitingRun({ runContext: null })).deps), { status: 409 });
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, fakeDeps(waitingRun({ conversationId: null })).deps), { status: 409 });
});

test('a run of another item, one that is not waiting, or one already handled is refused', async () => {
    await assert.rejects(review.handleRunReview({ schedule, runId: 'other', userId: 'u1', action: 'not_needed' }, fakeDeps().deps), { status: 404 });
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'not_needed' }, fakeDeps(waitingRun({ status: 'success' })).deps), { status: 409 });
    const handled = waitingRun();
    handled.review = { ...handled.review, resolution: 'not_needed' };
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'not_needed' }, fakeDeps(handled).deps), { status: 409 });
});

test('the follow-up limit: default 5 answers deep, 0 is unlimited, and closing is always possible', async () => {
    assert.strictEqual(review.maxFollowUps(), 5);
    const deep = waitingRun({ followupDepth: 5 });
    await assert.rejects(review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, fakeDeps(deep).deps), { status: 409, code: 'review_followup_limit' });
    await review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'not_needed' }, fakeDeps(deep).deps);
    process.env.COWORK_REVIEW_MAX_FOLLOWUPS = '0';
    const { deps, state } = fakeDeps(waitingRun({ followupDepth: 50 }));
    await review.handleRunReview({ schedule, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, deps);
    assert.strictEqual(state.started.length, 1);
});

test('an answer while the item is running waits for that run', async () => {
    await assert.rejects(review.handleRunReview({ schedule: { ...schedule, lastStatus: 'running' }, runId: 'r1', userId: 'u1', action: 'answer', answer: 'x' }, fakeDeps().deps), { status: 409, code: 'cowork_running' });
});

test('a follow-up of a run that had outside text starts marked: a mail, an event start, or a read of a mailbox on the way', () => {
    const { hadOutsideText } = require('./coworkReview.mts');
    const base = { id: 'r1', status: 'needs_review', review: null, runContext: null };
    assert.strictEqual(hadOutsideText({ ...base, triggerKind: 'schedule' }), false);
    assert.strictEqual(hadOutsideText({ ...base, triggerKind: 'webhook' }), true);
    assert.strictEqual(hadOutsideText({ ...base, triggerKind: 'schedule', runContext: { mail: { provider: 'gmail', messageId: 'm1' } } }), true);
    assert.strictEqual(hadOutsideText({ ...base, triggerKind: 'manual', activity: { readOutsideText: true } }), true);
});

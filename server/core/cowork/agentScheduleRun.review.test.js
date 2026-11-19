/**
 * A Cowork run as its agent, the parts this round added: the run gets a run context (core/cowork/runActivity.mts) and
 * its own, marked conversation; it closes its own history row with what it did; a review request closes it as one;
 * the notification opens the run in Cowork; a follow-up runs under its ceiling.
 *
 * The collaborators are handed in (deps.services), as in agentScheduleRun.trigger.test.js: no module is mocked.
 *
 * Run: node --test core/cowork/agentScheduleRun.review.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { executeAgentRun } = require('./agentScheduleRun');
const { noteToolOutcome, noteStaticSkills } = require('./runActivity.mts');

const task = { id: 's1', userId: 'u1', agentId: 'a1', title: 'Mail desk', prompt: 'Answer new mail.', conversationId: null, timezone: 'Europe/Amsterdam' };

function fakeStore() {
    const calls = [];
    const rec = (name, answer) => async (...a) => { calls.push([name, ...a]); return answer; };
    return {
        calls,
        markRunning: rec('markRunning', 'run-1'), markCompleted: rec('markCompleted'), markError: rec('markError'),
        updateTask: rec('updateTask'), advanceSchedule: rec('advanceSchedule'),
    };
}

/** A runtime that does what the tool round would: note a call and, when asked, a review. */
const chatThat = (seen, { review = null, offered = ['outlook_read', 'outlook_create_draft'] } = {}) => async (agentId, userId, prompt, auth, onEvent, history, metadata) => {
    seen.metadata = metadata;
    seen.prompt = prompt;
    for (const name of offered) metadata.coworkRun.offered.add(name);
    noteToolOutcome(metadata.coworkRun, { toolName: 'outlook_create_draft', blocked: true, policyReason: 'privacy_shield', toolArgs: { to: 'ann@example.com' } });
    noteStaticSkills(metadata.coworkRun, ['sk1']);
    if (review) metadata.coworkRun.review = review;
    return { message: 'I could not finish this.', conversationId: 'conv-7' };
};

const deps = (seen, chat, failed = []) => ({
    scheduleText: 'x', resolveUserSession: async () => null, isRepeating: () => true,
    failRun: async (t, err, o) => { failed.push({ err: err.message, ...o }); },
    NOTIFICATION: { category: 'cowork', link: null, prefix: '' },
    services: {
        agentStore: { getForRuntime: async () => ({ id: 'a1', name: 'Mail agent', owner_id: 'u1', organization_id: null, config: {} }) },
        notificationStore: { createNotification: async (n) => { seen.notes.push(n); } },
        terminationStore: { logTermination: async () => {} },
        buildUserAuth: async () => ({ accessToken: 't', userId: 'u1' }),
        chatWithAgentStream: chat,
        skillNames: async (ids) => new Map(ids.filter((id) => id === 'sk1').map((id) => [id, 'Tone of voice'])),
    },
});

const REVIEW = { reason: 'The discount is not agreed.', question: 'Which discount applies?', summary: null };

test('the run has a run context, a conversation marked as Cowork, and closes its own row with what it did', async () => {
    const seen = { notes: [] };
    const store = fakeStore();
    await executeAgentRun(task, { store, manual: true }, deps(seen, chatThat(seen)));
    assert.strictEqual(seen.metadata.conversationOrigin, 'cowork');
    assert.strictEqual(seen.metadata.coworkRun.kind, 'cowork_run');
    const [, scheduleId, , close] = store.calls.find((c) => c[0] === 'markCompleted');
    assert.strictEqual(scheduleId, 's1');
    assert.strictEqual(close.runId, 'run-1');
    assert.strictEqual(close.conversationId, 'conv-7');
    assert.strictEqual(close.review, null);
    assert.deepStrictEqual(close.activity.tools.map((t) => [t.name, t.refused, t.reasons]), [['outlook_create_draft', 1, ['privacy_shield']]]);
    assert.deepStrictEqual(close.activity.skills, [{ id: 'sk1', name: 'Tone of voice', how: 'static' }]);
    assert.ok(!JSON.stringify(close).includes('ann@example.com'), 'no tool argument is kept');
    assert.deepStrictEqual(close.runContext.offeredTools, ['outlook_read', 'outlook_create_draft']);
    assert.strictEqual(close.runContext.mail, null);
    assert.strictEqual(seen.notes[0].link, '/app/cowork/s1', 'the notification opens the run in Cowork, not the chat');
});

test('a review request closes the run as one and the notification says so, without the result text', async () => {
    const seen = { notes: [] };
    const store = fakeStore();
    await executeAgentRun(task, { store, manual: true }, deps(seen, chatThat(seen, { review: REVIEW })));
    const close = store.calls.find((c) => c[0] === 'markCompleted')[3];
    assert.deepStrictEqual(close.review, REVIEW);
    assert.match(seen.notes[0].title, /review/i);
    assert.ok(!seen.notes[0].message.includes('could not finish'), seen.notes[0].message);
    assert.strictEqual(seen.notes[0].link, '/app/cowork/s1');
});

test('a mail run closes the row its claim opened, keeps the mail ids (no addresses) and the subject', async () => {
    const seen = { notes: [] };
    const store = fakeStore();
    const trigger = {
        runId: 'claimed-run', mailSubject: 'Offer Q3', prompt: 'TASK + mail',
        metadata: { unattended: true, mailTrigger: { provider: 'outlook', messageId: 'm1', threadId: 'T1', mailbox: null, participants: ['ann@example.com'], outcomes: [] } },
        notification: () => ({ title: 'Mail agent: mail handled for "Offer Q3"', message: 'Mail handled for "Offer Q3".' }),
    };
    await executeAgentRun(task, { store, trigger }, deps(seen, chatThat(seen)));
    assert.ok(!store.calls.some((c) => c[0] === 'markRunning'));
    const close = store.calls.find((c) => c[0] === 'markCompleted')[3];
    assert.strictEqual(close.runId, 'claimed-run');
    assert.strictEqual(close.mailSubject, 'Offer Q3');
    assert.deepStrictEqual(close.runContext.mail, { provider: 'outlook', messageId: 'm1', threadId: 'T1', mailbox: null, readOutside: false });
    assert.strictEqual(close.runContext.unattended, true);
    assert.ok(!JSON.stringify(close.runContext).includes('ann@example.com'));
});

test('a follow-up runs under the ceiling of the run it continues', async () => {
    const seen = { notes: [] };
    const trigger = {
        runId: 'follow-1', toolCeiling: ['outlook_read'], prompt: 'answer',
        metadata: { unattended: false },
        notification: () => ({ title: 't', message: 'm' }),
    };
    await executeAgentRun({ ...task, conversationId: 'conv-7' }, { store: fakeStore(), trigger }, deps(seen, chatThat(seen)));
    assert.deepStrictEqual(seen.metadata.coworkRun.toolCeiling, ['outlook_read']);
    assert.strictEqual(seen.metadata.conversationId, 'conv-7');
});

test('a run continues the item\'s conversation only when it is a Cowork one; a chat the item pointed at stays the person\'s', async () => {
    const runWith = async (conversationId, origin) => {
        const seen = { notes: [] };
        const d = deps(seen, chatThat(seen));
        d.services.agentStore = { ...d.services.agentStore, getConversationOrigin: async (id) => (id === conversationId ? origin : null) };
        await executeAgentRun({ ...task, conversationId }, { store: fakeStore(), manual: true }, d);
        return seen.metadata.conversationId;
    };
    assert.strictEqual(await runWith('conv-cw', 'cowork'), 'conv-cw');
    assert.strictEqual(await runWith('conv-chat', null), undefined, 'a fresh, marked conversation instead');
});

test('a failed run hands its row and what it did to failRun', async () => {
    const seen = { notes: [] };
    const failed = [];
    const chat = async (agentId, userId, prompt, auth, onEvent, history, metadata) => {
        noteToolOutcome(metadata.coworkRun, { toolName: 'outlook_read', finalToolResult: { ok: true } });
        throw new Error('model down');
    };
    await executeAgentRun(task, { store: fakeStore(), manual: true }, deps(seen, chat, failed));
    assert.strictEqual(failed[0].err, 'model down');
    assert.strictEqual(failed[0].close.runId, 'run-1');
    assert.strictEqual(failed[0].close.activity.tools[0].name, 'outlook_read');
});

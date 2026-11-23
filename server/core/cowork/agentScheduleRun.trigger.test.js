const { test } = require('node:test');
const assert = require('node:assert');
const { executeAgentRun } = require('./agentScheduleRun');

const seen = { runtime: null, notes: [] };

const task = { id: 's1', userId: 'u1', agentId: 'a1', title: 'Mail desk', prompt: 'Summarise.', conversationId: null, timezone: 'Europe/Amsterdam' };

function fakeStore() {
    const calls = [];
    const rec = (name) => async (...a) => { calls.push([name, ...a]); return 'x'; };
    return { calls, markRunning: rec('markRunning'), markCompleted: rec('markCompleted'), markError: rec('markError'), updateTask: rec('updateTask'), advanceSchedule: rec('advanceSchedule') };
}
// The collaborators of a run are handed in (deps.services): no module is mocked.
const deps = (failed, chat) => ({
    scheduleText: 'x', resolveUserSession: async () => null, isRepeating: () => false,
    failRun: async (t, err, o) => { failed.push({ err: err.message, manual: o.manual }); },
    NOTIFICATION: { category: 'cowork', link: null, prefix: '' },
    services: {
        agentStore: { getForRuntime: async () => ({ id: 'a1', name: 'Mail agent', owner_id: 'u1', organization_id: null, config: {} }) },
        notificationStore: { createNotification: async (n) => { seen.notes.push(n); } },
        terminationStore: { logTermination: async () => {} },
        buildUserAuth: async () => ({ accessToken: 't', userId: 'u1' }),
        chatWithAgentStream: chat || (async (agentId, userId, prompt, auth, onEvent, history, metadata) => {
            seen.runtime = { agentId, userId, prompt, metadata };
            return { message: 'Done, I summarised it.', conversationId: 'c-new' };
        }),
    },
});
const trigger = {
    prompt: 'TASK + <untrusted_email>...</untrusted_email>',
    metadata: { unattended: true, mailTrigger: { provider: 'gmail', messageId: 'm1', threadId: 'T1' } },
    notification: ({ agentName }) => ({ title: `${agentName}: draft saved for "Hi"`, message: 'Draft saved for "Hi".' }),
};

test('an event run uses its own prompt and metadata, opens no second row and leaves the trigger armed', async () => {
    const store = fakeStore();
    seen.notes.length = 0;
    await executeAgentRun(task, { store, trigger }, deps([]));
    assert.strictEqual(seen.runtime.prompt, trigger.prompt);
    assert.strictEqual(seen.runtime.metadata.unattended, true);
    assert.strictEqual(seen.runtime.metadata.mailTrigger.threadId, 'T1');
    assert.strictEqual(seen.runtime.metadata.autoSend, true);
    const names = store.calls.map(c => c[0]);
    assert.ok(!names.includes('markRunning'));
    assert.ok(names.includes('markCompleted'));
    assert.ok(!names.includes('advanceSchedule'));
    assert.ok(!store.calls.some(c => c[0] === 'updateTask' && c[2] && c[2].isActive === false), 'a finished event run never deactivates the schedule');
    assert.strictEqual(seen.notes.length, 1);
    assert.strictEqual(seen.notes[0].title, 'Mail agent: draft saved for "Hi"');
    assert.ok(!/summarised/.test(seen.notes[0].message), 'the result text is not the notification');
});

test('a schedule run without a trigger behaves as before: opens its row, one-off is deactivated', async () => {
    const store = fakeStore();
    seen.notes.length = 0;
    await executeAgentRun(task, { store }, deps([]));
    assert.ok(store.calls.some(c => c[0] === 'markRunning'));
    assert.strictEqual(seen.runtime.prompt, 'Summarise.');
    assert.ok(store.calls.some(c => c[0] === 'updateTask' && c[2] && c[2].isActive === false));
    assert.match(seen.notes[0].message, /summarised/);
});

test('a failing event run goes through failRun as a manual run, so the trigger is not deactivated', async () => {
    const failed = [];
    const store = fakeStore();
    const chat = async () => { throw new Error('model down'); };
    await executeAgentRun(task, { store, trigger }, deps(failed, chat));
    assert.deepStrictEqual(failed, [{ err: 'model down', manual: true }]);
});

test('reply-all in a mail-started run is the agent owner\'s setting for that mail app, off by default', async () => {
    const withAgent = (config) => {
        const d = deps([]);
        d.services.agentStore = { getForRuntime: async () => ({ id: 'a1', name: 'Mail agent', owner_id: 'u1', organization_id: null, config }) };
        return d;
    };
    const run = async (config, provider = 'gmail') => {
        const t = { ...trigger, metadata: { unattended: true, mailTrigger: { provider, messageId: 'm1', threadId: 'T1' } } };
        await executeAgentRun(task, { store: fakeStore(), trigger: t }, withAgent(config));
        return seen.runtime.metadata.mailTrigger.replyAll;
    };
    assert.strictEqual(await run({}), false);
    assert.strictEqual(await run({ tools: { gmail: { mailAccess: 'send_reply', replyAll: true } } }), true);
    assert.strictEqual(await run({ tools: { gmail: { mailAccess: 'send_reply', replyAll: true } } }, 'outlook'), false);
});

test('an agent that is no longer available to the item\'s user is refused at run time, before the model runs', async () => {
    const failed = [];
    let chatted = false;
    const d = deps(failed, async () => { chatted = true; return { message: 'x' }; });
    d.services.agentStore = { getForRuntime: async () => ({ id: 'a1', name: 'Shared agent', owner_id: 'someone-else', organization_id: null, config: {} }) };
    d.services.canRunAgent = async (agent, userId) => { assert.strictEqual(userId, 'u1'); return false; };
    await executeAgentRun(task, { store: fakeStore() }, d);
    assert.strictEqual(chatted, false);
    assert.match(failed[0].err, /no longer available/);
});

test('a shared agent the item\'s user may chat with runs as that user', async () => {
    const d = deps([]);
    d.services.agentStore = { getForRuntime: async () => ({ id: 'a1', name: 'Shared agent', owner_id: 'someone-else', organization_id: null, config: {} }) };
    d.services.canRunAgent = async () => true;
    seen.runtime = null;
    await executeAgentRun(task, { store: fakeStore() }, d);
    assert.strictEqual(seen.runtime.userId, 'u1');
});

test('the conversation of a run a mail or an event started never becomes the item\'s: its outside text stays out of later runs', async () => {
    for (const t of [trigger, { prompt: 'Webhook data', outsideText: true, metadata: { unattended: true } }]) {
        const store = fakeStore();
        await executeAgentRun({ ...task, conversationId: null }, { store, trigger: t }, deps([]));
        assert.ok(!store.calls.some((c) => c[0] === 'updateTask' && c[2] && 'conversationId' in c[2]), 'no conversation is stored on the item');
    }
    const store = fakeStore();
    await executeAgentRun({ ...task, conversationId: null }, { store, manual: true }, deps([]));
    assert.ok(store.calls.some((c) => c[0] === 'updateTask' && c[2] && c[2].conversationId === 'c-new'), 'an ordinary run keeps its thread');
});

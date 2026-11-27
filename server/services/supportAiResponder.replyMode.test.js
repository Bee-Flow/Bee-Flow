/**
 * supportAiResponder: the company inbox's AI reply mode (`support_ai_reply_mode`).
 *
 * `off` must mean that no model sees the message: no agent turn, no
 * knowledge-base search (an embedding call), no fast-tier tagging. The thread
 * goes straight to staff with a notice. `draft` writes the reply as an internal
 * note and reports it as not sent; nothing stored keeps today's behaviour.
 *
 * The stores and the model calls come in through the responder's init() seam.
 *
 * Run: node --test services/supportAiResponder.replyMode.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const responder = require('./supportAiResponder');

const { runAiAutoResponder, AI_OFF_REASON } = responder;

const state = {
    config: {},
    thread: null,
    messages: [],
    appended: [],
    updates: [],
    events: [],
    // listTags is the first step of the fast-tier tagging, before any model is chosen.
    calls: { chatWithAgent: 0, quickKBSearch: 0, listTags: 0 },
};

function reset({ config = {}, thread = {} } = {}) {
    state.config = config;
    state.thread = {
        id: 't1', subject: 'Help', status: 'open', source: 'marketing', inbox_id: null,
        organization_id: null, requester_user_id: null, assignee_user_id: 'staff-1',
        ai_escalated_reason: null, ai_handled: false, ...thread,
    };
    state.messages = [{ id: 'm1', author_kind: 'requester', body: 'My invoice is wrong, my IBAN is NL00BANK0123456789.' }];
    state.appended = [];
    state.updates = [];
    state.events = [];
    for (const k of Object.keys(state.calls)) state.calls[k] = 0;
}

const restore = responder.init({
    supportStore: {
        getThread: async () => state.thread,
        getThreadMessages: async () => state.messages,
        appendMessage: async (m) => { state.appended.push(m); return { id: `a${state.appended.length}`, ...m }; },
        updateThread: async (id, patch) => { state.updates.push(patch); Object.assign(state.thread, patch); return state.thread; },
        recordThreadEvent: async (e) => { state.events.push(e); },
        listTags: async () => { state.calls.listTags += 1; return []; },
        setThreadTags: async () => {},
    },
    configStore: { getConfig: async (key) => state.config[key] },
    chatWithAgent: async () => { state.calls.chatWithAgent += 1; return { message: 'Here is how to fix the invoice on your account page, step by step.', model: 'm' }; },
    quickKBSearch: async () => { state.calls.quickKBSearch += 1; return [{ title: 'Invoices', content: 'x', score: 0.9 }]; },
});
test.after(() => restore());

/** Let the fire-and-forget tagging (if any) run before counting calls. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const noModelCalls = () => {
    assert.strictEqual(state.calls.chatWithAgent, 0, 'no agent turn');
    assert.strictEqual(state.calls.quickKBSearch, 0, 'no knowledge-base search (embedding call)');
    assert.strictEqual(state.calls.listTags, 0, 'the fast-tier tagging does not start');
};

test('off: no model is called and the thread goes straight to staff', async () => {
    reset({ config: { support_ai_reply_mode: 'off', support_ai_agent_id: 'system-bee-flow-support', support_ai_kb_ids: '["kb1"]' } });

    const result = await runAiAutoResponder('t1');
    await settle();

    assert.strictEqual(result, null);
    noModelCalls();
    assert.strictEqual(state.thread.status, 'awaiting_agent');
    assert.strictEqual(state.thread.ai_handled, false, 'a follow-up must not ask the AI again');
    assert.strictEqual(state.thread.ai_escalated_reason, AI_OFF_REASON);
    assert.ok(!state.updates.some((u) => u.status === 'ai_responding'), 'never shown as "AI is answering"');
    assert.deepStrictEqual(state.appended.map((m) => m.authorKind), ['system']);
    assert.match(state.appended[0].body, /AI replies are off for this inbox/);
    assert.deepStrictEqual(state.events.map((e) => e.action), ['ai_off']);
});

test('off: a second message on a thread already handed off adds no second notice', async () => {
    reset({
        config: { support_ai_reply_mode: 'off' },
        thread: { status: 'awaiting_agent', ai_escalated_reason: AI_OFF_REASON },
    });

    assert.strictEqual(await runAiAutoResponder('t1'), null);
    await settle();

    noModelCalls();
    assert.strictEqual(state.appended.length, 0);
    assert.strictEqual(state.events.length, 0);
});

test('draft: the reply is an internal note for staff and is not sent', async () => {
    reset({ config: { support_ai_reply_mode: 'draft', support_ai_agent_id: 'system-bee-flow-support' } });

    const result = await runAiAutoResponder('t1');
    await settle();

    assert.strictEqual(state.calls.chatWithAgent, 1);
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.mode, 'draft');
    const ai = state.appended.find((m) => m.authorKind === 'ai');
    assert.strictEqual(ai.internalNote, true, 'the requester of a company-inbox thread must not see the draft');
    assert.strictEqual(state.thread.status, 'awaiting_agent');
});

test('nothing stored: the AI answers the customer as before', async () => {
    reset({ config: { support_ai_agent_id: 'system-bee-flow-support' } });

    const result = await runAiAutoResponder('t1');
    await settle();

    assert.strictEqual(state.calls.chatWithAgent, 1);
    assert.strictEqual(result.mode, 'legacy');
    assert.strictEqual(result.sent, true);
    const ai = state.appended.find((m) => m.authorKind === 'ai');
    assert.strictEqual(ai.internalNote, false);
    assert.strictEqual(state.calls.listTags, 1, 'tagging still runs when AI replies are on');
});

test('an unknown stored value counts as the default, not as off', async () => {
    reset({ config: { support_ai_reply_mode: 'sometimes', support_ai_agent_id: 'system-bee-flow-support' } });

    const result = await runAiAutoResponder('t1');

    assert.strictEqual(result.mode, 'legacy');
    assert.strictEqual(state.calls.chatWithAgent, 1);
});

test('a tenant inbox with its own config is not touched by the company switch', async () => {
    reset({ config: { support_ai_reply_mode: 'off' }, thread: { inbox_id: 'inbox-1' } });

    const result = await runAiAutoResponder('t1', { config: { agentId: 'agent-1', replyMode: 'draft' } });

    assert.strictEqual(state.calls.chatWithAgent, 1);
    assert.strictEqual(result.mode, 'draft');
    const ai = state.appended.find((m) => m.authorKind === 'ai');
    assert.strictEqual(ai.internalNote, false, 'a tenant draft stays a mailbox draft');
});

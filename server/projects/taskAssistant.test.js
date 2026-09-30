'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeTaskAssistant, cleanSuggestion, contextAround, meetingPrompt } = require('./taskAssistant');
const { PrivacyBlocked } = require('./chatShield');

const PROJECT = { id: 'p1', name: 'Launch' };
const PEOPLE = [{ id: 'u-ben', name: 'Ben Tester' }, { id: 'u-eva', name: 'Eva Stone' }];
const NOTE = {
    id: 'm1', title: 'Weekly', summary: 'We plan the launch.', decisions: [{ text: 'Ship on Monday' }], speakers: [{ id: 's1', name: 'Ben' }],
    segments: [{ speaker: 'Ben', start: 120, end: 130, text: 'I will send the offer to Acme.' }, { speaker: 'Eva', start: 900, end: 905, text: 'Unrelated.' }],
};
const ITEMS = [
    { id: 'ai-1', text: 'Send the offer', assignee: 'Ben', due: '2026-11-03', timestamp: 125 },
    { id: 'ai-2', text: 'Book a room', assignee: 'Niet toegewezen' },
];

function world(over = {}) {
    const seen = { messages: [], protect: [], usage: [], released: [] };
    const assistant = makeTaskAssistant({
        resolveModel: over.resolveModel || (async () => ({ modelId: 'm-fast', options: { maxTokens: 999 }, providerConfig: {} })),
        shield: {
            resolve: async () => ({ enabled: true }),
            protect: async (a) => {
                seen.protect.push(a);
                if (over.block) throw new PrivacyBlocked('pii_block');
                return over.tokenise ? { text: a.text.replace(/Ben Tester/g, '[person_1]'), tokenMap: { '[person_1]': 'Ben Tester' } } : { text: a.text, tokenMap: null };
            },
            tokenAddendum: (m) => (m ? '\n[TOKENS]' : ''),
            restore: (t, m) => (m ? t.split('[person_1]').join(m['[person_1]']) : t),
            release: (id) => seen.released.push(id),
        },
        llmChat: async (modelId, messages, options) => {
            seen.messages.push({ modelId, messages, options });
            if (over.throws) throw over.throws;
            return { content: over.content ?? JSON.stringify({ items: [] }), usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
        },
        checkLimits: over.checkLimits || (async () => null),
        logUsage: async (e) => { seen.usage.push(e); },
        timeoutMs: over.timeoutMs || 2000,
        newId: () => 'run-1',
    });
    const base = { project: PROJECT, userId: 'ann', orgId: 'org1', limitOrgId: 'org1' };
    return { assistant, seen, base };
}

test('the prompt carries the summary, the decisions, each item with the talk around it, and only members by id', () => {
    const p = meetingPrompt(NOTE, ITEMS, PEOPLE);
    assert.match(p, /We plan the launch\./);
    assert.match(p, /Ship on Monday/);
    assert.match(p, /itemId ai-1: Send the offer \(the notes name: Ben\) \(due 2026-11-03\)\n  Said around it: Ben: I will send the offer to Acme\./);
    assert.ok(!p.includes('Unrelated'), 'talk far from the item stays out');
    assert.match(p, /u-ben: Ben Tester/);
    assert.strictEqual(contextAround(NOTE.segments, undefined), '');
});

test('each item comes back expanded, with a member only when it is one', async () => {
    const content = JSON.stringify({ items: [
        { itemId: 'ai-1', title: 'Send the Acme offer', description: 'Ben sends the offer to Acme.', priority: 'high', labels: ['#Sales', 'sales', 'Acme', 'a', 'b', 'c', 'd'], checklist: ['Draft', { text: 'Send' }, ''], assigneeId: 'u-ben' },
        { itemId: 'ai-2', description: 'Find a room.', priority: 'urgent!!', assigneeId: 'u-stranger' },
        { itemId: 'ai-9', title: 'not an item of this meeting' },
        { itemId: 'ai-1', title: 'twice' },
    ] });
    const { assistant, base, seen } = world({ content });
    const out = await assistant.forMeeting({ ...base, note: NOTE, items: ITEMS, people: PEOPLE });
    assert.deepStrictEqual(out.map((o) => o.itemId), ['ai-1', 'ai-2']);
    assert.strictEqual(out[0].title, 'Send the Acme offer');
    assert.strictEqual(out[0].priority, 'high');
    assert.deepStrictEqual(out[0].labels, ['sales', 'acme', 'a', 'b', 'c'], 'lower case, once, at most five');
    assert.deepStrictEqual(out[0].checklist.map((c) => [c.text, c.done]), [['Draft', false], ['Send', false]]);
    assert.ok(out[0].checklist.every((c) => c.id));
    assert.strictEqual(out[0].assigneeId, 'u-ben');
    assert.strictEqual(out[1].assigneeId, null, 'someone who is not a member is dropped');
    assert.strictEqual(out[1].priority, 'normal');
    assert.strictEqual(out[1].title, 'Book a room', 'no title back: the action item text stays');
    assert.strictEqual(seen.messages[0].modelId, 'm-fast');
    assert.strictEqual(seen.usage[0].source, 'project_task_ai_meeting');
    assert.deepStrictEqual(seen.released, ['project-task-ai-p1-run-1']);
});

test('the notes go to the model through the shield and come back with the real names', async () => {
    const content = JSON.stringify({ items: [{ itemId: 'ai-1', description: '[person_1] sends it.', assigneeId: 'u-ben' }] });
    const { assistant, base, seen } = world({ tokenise: true, content });
    const [one] = await assistant.forMeeting({ ...base, note: NOTE, items: ITEMS, people: PEOPLE });
    assert.ok(!seen.messages[0].messages[1].content.includes('Ben Tester'), 'the model saw the placeholder');
    assert.match(seen.messages[0].messages[0].content, /\[TOKENS\]/);
    assert.strictEqual(one.description, 'Ben Tester sends it.');
});

test('a limit, no model, a shield block, a broken or cut-off answer, and a slow model each end in a clear refusal', async () => {
    const code = async (over, fn = 'forMeeting') => {
        const { assistant, base } = world(over);
        try {
            await (fn === 'forMeeting' ? assistant.forMeeting({ ...base, note: NOTE, items: ITEMS, people: PEOPLE }) : assistant.forTask({ ...base, task: { title: 'T' }, people: PEOPLE }));
        } catch (e) { return [e.status, e.code]; }
        return null;
    };
    assert.deepStrictEqual(await code({ checkLimits: async () => 'Monthly limit' }), [429, 'ai_limit']);
    assert.deepStrictEqual(await code({ resolveModel: async () => null }), [503, 'ai_unavailable']);
    assert.deepStrictEqual(await code({ block: true }), [403, 'privacy_blocked']);
    assert.deepStrictEqual(await code({ content: 'sorry, I cannot' }), [502, 'ai_bad_answer']);
    assert.deepStrictEqual(await code({ content: '{"items":[{"itemId":"ai-1","title":"cut o' }), [502, 'ai_bad_answer']);
    const broken = world({ throws: new Error('upstream 500 host db-3') });
    await assert.rejects(broken.assistant.forTask({ ...broken.base, task: { title: 'T' }, people: PEOPLE }), /upstream 500/, 'a failing model is not swallowed; the route turns it into a generic 500');
});

test('with no action items nothing is asked', async () => {
    const { assistant, base, seen } = world();
    assert.deepStrictEqual(await assistant.forMeeting({ ...base, note: NOTE, items: [], people: PEOPLE }), []);
    assert.strictEqual(seen.messages.length, 0);
});

test('one task is improved, keeping its title when the model gives none, and never gets a stranger as assignee', async () => {
    const content = JSON.stringify({ description: 'Clearer.', priority: 'low', labels: ['ops'], checklist: ['One'], assigneeId: 'u-eva' });
    const { assistant, base } = world({ content });
    const out = await assistant.forTask({ ...base, task: { title: 'Fix the thing', description: 'old', priority: 'normal', labels: [], checklist: [] }, people: PEOPLE });
    assert.deepStrictEqual([out.title, out.description, out.priority, out.labels, out.assigneeId], ['Fix the thing', 'Clearer.', 'low', ['ops'], 'u-eva']);
    assert.strictEqual(cleanSuggestion({ assigneeId: 'x' }, new Set(['u-eva'])).assigneeId, null);
});

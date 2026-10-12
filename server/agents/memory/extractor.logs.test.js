/**
 * The memory extractor logs ids and types, never what the user said.
 *
 * Extraction runs after every direct chat turn. A memory's value, content and
 * evidence quote are what the user said about themselves, often special
 * category data ("I have type 2 diabetes"). In production the logger writes
 * JSON lines with a request id to the log sink, where none of that belongs.
 *
 * The same stubs as extractor.guest.test.js (via testUtils/stubRequire), with
 * a signed-in user.
 * Synthetic data.
 *
 * Run: cd server && node --test agents/memory/extractor.logs.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');

const { preloadStubs } = require('../../testUtils/stubRequire');

// Stubs under the real resolved paths, so the extractor gets them whatever
// relative string it requires them by.
function stub(request, exportsObj) {
    preloadStubs(require, { [request]: exportsObj });
}

const fx = { existingValue: 'none', reply: null, creates: [], updates: [], prompts: [] };

stub('../../stores/memoryStore', {
    createMemory: async (...args) => { fx.creates.push(args); return 'new-id'; },
    findByKey: async (_u, _type, _subject, attribute) => (attribute === 'condition' ? { id: 'm1', value: fx.existingValue } : null),
    findSimilarMemory: async () => null,
    findSimilarMemories: async () => [],
    updateMemoryValue: async () => { fx.updates.push(1); },
    confirmMemory: async () => {},
    addMemorySource: async () => {},
});
// The writer's other collaborators: no consent for sensitive data, no cap work.
stub('../../core/memory/memoryPolicy', {
    isSensitiveOptInForUser: async () => false,
    getOrgMemorySettings: async () => ({ maxPerUser: 1000 }),
});
stub('../../stores/memoryLifecycle', {
    confirm: async () => {}, supersede: async () => {}, enforceCap: async () => 0,
});
stub('../../stores/agentStore', {
    getAgent: async () => null,
    getSystemAgent: async () => ({ model: 'm', config: {} }),
});
stub('../../core/llm/modelResolver', {
    resolveModelWithGlobalFallback: async () => 'model-x',
});
stub('../../core/llm/llmClient', {
    chat: async (_m, msgs) => { fx.prompts.push(msgs); return { content: JSON.stringify({ memories: fx.reply }) }; },
});

const { extractFromConversation } = require('./extractor');

const MESSAGE = 'I have type 2 diabetes and my diabetes study project starts in May';
const MEMORIES = [
    // Matches an existing key with another value: the update path.
    { type: 'personal', subject: 'user', attribute: 'condition', value: 'type 2 diabetes', content: 'User has type 2 diabetes', evidence_quote: 'I have type 2 diabetes', confidence: 0.9 },
    // Its quote is not in the message: the evidence check fails.
    { type: 'personal', subject: 'user', attribute: 'device', value: 'insulin pump', content: 'User wears a diabetes insulin pump', evidence_quote: 'my diabetes insulin pump', confidence: 0.9 },
    // A project memory outside a project: skipped.
    { type: 'project', subject: 'project', attribute: 'study', value: 'diabetes study', content: 'Project is a diabetes study', evidence_quote: 'my diabetes study project', confidence: 0.9 },
    // Task-like: filtered.
    { type: 'personal', content: 'Create a diabetes diet plan', evidence_quote: 'diabetes', confidence: 0.9 },
];

async function captured(fn) {
    const lines = [];
    const saved = {};
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
        saved[m] = console[m];
        console[m] = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    }
    try {
        await fn();
    } finally {
        for (const m of Object.keys(saved)) console[m] = saved[m];
    }
    return lines;
}

function assertNoContent(lines, forbidden = /diabetes|insulin/i) {
    assert.ok(lines.length > 0, 'the extractor logged nothing at all');
    for (const line of lines) {
        assert.ok(!forbidden.test(line), `a log line carries what the user said: ${line}`);
    }
}

test('rejecting (sensitive), skipping and filtering memories logs no memory content', async () => {
    fx.existingValue = 'none';
    fx.reply = MEMORIES;
    const lines = await captured(() => extractFromConversation('usr_42', null, [{ role: 'user', content: MESSAGE }]));
    assert.ok(lines.some(l => l.includes('rejected (art9_no_consent)')), lines.join('\n'));
    assertNoContent(lines);
});

const PROJECT_MESSAGE = 'I am the lead of the Zephyr migration';
const ROLE = { type: 'person', subject: 'user', attribute: 'condition', value: 'Zephyr lead', content: 'User leads the Zephyr migration', evidence_quote: 'lead of the Zephyr migration', confidence: 0.9 };

test('superseding and confirming an existing memory log no memory content', async () => {
    fx.reply = [ROLE];
    fx.existingValue = 'old role';
    let lines = await captured(() => extractFromConversation('usr_42', null, [{ role: 'user', content: PROJECT_MESSAGE }]));
    assert.ok(lines.some(l => l.includes('superseded') && l.includes('new-id')), lines.join('\n'));
    assertNoContent(lines, /zephyr/i);

    fx.existingValue = 'Zephyr lead';
    lines = await captured(() => extractFromConversation('usr_42', null, [{ role: 'user', content: PROJECT_MESSAGE }]));
    assert.ok(lines.some(l => l.includes('confirmed m1')), lines.join('\n'));
    assertNoContent(lines, /zephyr/i);
});

test('a changed value goes through the writer as a new row: never an in-place update', async () => {
    fx.creates = []; fx.updates = []; fx.prompts = [];
    fx.reply = [ROLE]; fx.existingValue = 'old role';
    const out = await extractFromConversation('usr_42', null, [{ role: 'user', content: PROJECT_MESSAGE }], 'conv-1', null, 'org-1');
    assert.equal(fx.updates.length, 0, 'updateMemoryValue is gone from the extractor');
    assert.equal(fx.creates.length, 1);
    const [, , , , , , subject, attribute, value, , , opts] = fx.creates[0];
    assert.deepEqual([subject, attribute, value], ['user', 'condition', 'Zephyr lead']);
    assert.deepEqual(opts, { origin: 'inferred', sourceConversationId: 'conv-1', sensitivity: 'none', status: 'active', confidence: 0.9 });
    assert.equal(out[0].action, 'superseded');
});

test('the prompt carries today\'s date and the sensitivity flag reaches the writer', async () => {
    fx.creates = []; fx.prompts = [];
    fx.existingValue = 'none';
    fx.reply = [{ ...ROLE, attribute: 'goal', sensitivity: 'art9', content: 'User leads the Zephyr migration' }];
    await extractFromConversation('usr_42', null, [{ role: 'user', content: PROJECT_MESSAGE }]);
    const user = fx.prompts[0].find((m) => m.role === 'user').content;
    assert.match(user, /Today's date: \d{4}-\d{2}-\d{2}/);
    assert.equal(fx.creates.length, 0, 'art9 without consent is not stored');
});

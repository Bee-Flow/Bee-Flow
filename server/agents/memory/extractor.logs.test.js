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

const fx = { existingValue: 'none', reply: null };

stub('../../stores/memoryStore', {
    createMemory: async () => 'new-id',
    findByKey: async (_u, _type, _subject, attribute) => (attribute === 'condition' ? { id: 'm1', value: fx.existingValue } : null),
    findSimilarMemory: async () => null,
    updateMemoryValue: async () => {},
    confirmMemory: async () => {},
    addMemorySource: async () => {},
});
stub('../../stores/agentStore', {
    getAgent: async () => null,
    getSystemAgent: async () => ({ model: 'm', config: {} }),
});
stub('../../core/llm/modelResolver', {
    resolveModelWithGlobalFallback: async () => 'model-x',
});
stub('../../core/llm/llmClient', {
    chat: async () => ({ content: JSON.stringify({ memories: fx.reply }) }),
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

function assertNoContent(lines) {
    assert.ok(lines.length > 0, 'the extractor logged nothing at all');
    for (const line of lines) {
        assert.ok(!/diabetes|insulin/i.test(line), `a log line carries what the user said: ${line}`);
    }
}

test('updating, rejecting, skipping and filtering memories logs no memory content', async () => {
    fx.existingValue = 'none';
    fx.reply = MEMORIES;
    const lines = await captured(() => extractFromConversation('usr_42', null, [{ role: 'user', content: MESSAGE }]));
    assert.ok(lines.some(l => l.includes('Updating memory m1')), lines.join('\n'));
    assertNoContent(lines);
});

test('confirming an existing memory logs no memory content', async () => {
    fx.existingValue = 'type 2 diabetes';
    fx.reply = [MEMORIES[0]];
    const lines = await captured(() => extractFromConversation('usr_42', null, [{ role: 'user', content: MESSAGE }]));
    assert.ok(lines.some(l => l.includes('Confirming existing memory m1')), lines.join('\n'));
    assertNoContent(lines);
});

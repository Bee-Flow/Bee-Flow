'use strict';

/**
 * memory_search / memory_remember — the user's own memory as tools.
 *
 * What matters: every call is scoped to context.userId (there is no way to
 * name another user), search honours the type filter and limit, remember
 * validates the type and goes through memoryStore.createMemory (dedupe +
 * supersede live there), and a call without a user is refused.
 *
 * Run: node --test --test-force-exit integrations/memoryTools.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

let searchCalls = [];
let createCalls = [];
let found = [];
mock(path.resolve(__dirname, '../stores/memoryStore'), {
    async findRelevantMemories(userId, agentId, query, tokenLimit, projectId, opts) {
        searchCalls.push({ userId, agentId, query, tokenLimit, projectId, opts });
        return found;
    },
    async createMemory(userId, agentId, type, content, summary, importance, subject, attribute, value, evidence, projectId) {
        createCalls.push({ userId, agentId, type, content, summary, importance, subject, attribute, value, evidence, projectId });
        return 'mem-1';
    },
});

const { MEMORY_TOOLS, isMemoryTool, executeMemoryTool } = require('./memoryTools');

beforeEach(() => { searchCalls = []; createCalls = []; found = []; });

test('declares exactly the two tools, OpenAI function shape', () => {
    assert.deepStrictEqual(MEMORY_TOOLS.map(t => t.function.name), ['memory_search', 'memory_remember']);
    assert.ok(isMemoryTool('memory_search') && isMemoryTool('memory_remember'));
    assert.ok(!isMemoryTool('gmail_search'));
});

test('search is scoped to the calling user, filtered by type and capped by limit', async () => {
    found = [
        { id: 'a', type: 'preference', content: 'Signs off with Groet, Tom', subject: 'email style', attribute: 'signoff', value: 'Groet, Tom', importance: 0.7, last_confirmed_at: 't1' },
        { id: 'b', type: 'person', content: 'Lars is the Dekker Techniek project lead', subject: 'Lars', attribute: 'role', value: 'project lead', importance: 0.5 },
        { id: 'c', type: 'preference', content: 'Prefers short replies', importance: 0.6 },
    ];
    const r = await executeMemoryTool('memory_search', { query: 'how do I sign off', types: ['preference'], limit: 1 }, { userId: 'u1' });
    assert.strictEqual(searchCalls.length, 1);
    assert.strictEqual(searchCalls[0].userId, 'u1');
    assert.strictEqual(searchCalls[0].query, 'how do I sign off');
    assert.deepStrictEqual(r.memories.map(m => m.id), ['a']);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.memories[0].lastConfirmedAt, 't1');
});

test('an empty result says so instead of returning nothing', async () => {
    const r = await executeMemoryTool('memory_search', { query: 'anything' }, { userId: 'u1' });
    assert.strictEqual(r.count, 0);
    assert.match(r.message, /No relevant memories/);
});

test('remember validates the type and stores through createMemory for the calling user', async () => {
    const r = await executeMemoryTool('memory_remember', {
        type: 'instruction', content: 'Sign client mail with "Groet, Tom"', subject: 'email style', attribute: 'signoff', value: 'Groet, Tom', importance: 0.9, evidence: 'weekly review',
    }, { userId: 'u1', agentId: null });
    assert.deepStrictEqual(r, { id: 'mem-1', stored: true, type: 'instruction', content: 'Sign client mail with "Groet, Tom"' });
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].userId, 'u1');
    assert.strictEqual(createCalls[0].subject, 'email style');
    assert.strictEqual(createCalls[0].attribute, 'signoff');
    assert.strictEqual(createCalls[0].importance, 0.9);

    const bad = await executeMemoryTool('memory_remember', { type: 'secret', content: 'x' }, { userId: 'u1' });
    assert.match(bad.error, /type must be one of/);
    assert.strictEqual(createCalls.length, 1, 'nothing stored for an invalid type');
});

test('refuses without a signed-in user — there is no other scope', async () => {
    const r = await executeMemoryTool('memory_search', { query: 'q' }, {});
    assert.match(r.error, /signed-in user/);
    assert.strictEqual(searchCalls.length, 0);
});

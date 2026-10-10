/**
 * resolveMemoryContext honours the memory policy: when the gate says read is
 * off (org or user switch, embed agent, per-chat off) the memory store is never
 * consulted and nothing reaches the prompt. A policy handed in by the turn is
 * used as is, not resolved a second time.
 *
 * Run: cd server && node --test core/agentRuntime/contextEnrichment.memory.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const storeCalls = [];
const policyCalls = [];
let found = [{ id: 'm1', type: 'fact', content: 'likes tea' }];
let policy = { read: true, write: true, reason: 'enabled' };

const restore = installResolveStub({
    './knowledgeSearch': { performKnowledgeSearch: async () => '' },
    '../memory/memoryPolicy': { async resolveMemoryPolicy(opts) { policyCalls.push(opts); return policy; } },
    '../../stores/memoryStore': {
        async findRelevantMemories(...args) { storeCalls.push(args); return found; },
        formatMemoriesForPrompt: (m) => `## Active Memory\n${m.map(x => x.content).join('\n')}`,
    },
    '../../stores/configStore': { async getConfig() { return null; } },
    '../aiAgent': { async getAIConfig() { return { piiDetectionEnabled: false }; } },
});
test.after(() => restore());

const { resolveMemoryContext } = require('./contextEnrichment');

const agent = { id: 'a1', organization_id: 'org1', config: {} };
const base = { agent, agentId: 'a1', userId: 'u1', userMessage: 'hi', validProjectId: null, onEvent: () => {} };

test.beforeEach(() => { found = [{ id: 'm1', type: 'fact', content: 'likes tea' }]; storeCalls.length = 0; policyCalls.length = 0; policy = { read: true, write: true, reason: 'enabled' }; });

test('policy read off: no store lookup and an empty context', async () => {
    for (const reason of ['org_disabled', 'user_disabled', 'chat_off', 'embed_agent']) {
        policy = { read: false, write: false, reason };
        const ctx = await resolveMemoryContext({ ...base, memoryPolicy: policy });
        assert.strictEqual(ctx, '', reason);
    }
    assert.strictEqual(storeCalls.length, 0);
});

test('policy read on: memories are injected, and a passed-in policy is not resolved again', async () => {
    const ctx = await resolveMemoryContext({ ...base, memoryPolicy: policy });
    assert.match(ctx, /likes tea/);
    assert.strictEqual(storeCalls.length, 1);
    assert.strictEqual(policyCalls.length, 0);
});

test('without a passed-in policy the gate is resolved here, for the agent and its org', async () => {
    policy = { read: false, write: false, reason: 'org_disabled' };
    const ctx = await resolveMemoryContext(base);
    assert.strictEqual(ctx, '');
    assert.strictEqual(storeCalls.length, 0);
    assert.deepStrictEqual(policyCalls, [{ userId: 'u1', orgId: 'org1', agent }]);
});

test('memory_used is sent once with ids, types and 120-char previews, and handed back for persistence', async () => {
    found = [
        { id: 'm1', type: 'fact', content: 'x'.repeat(300) },
        { id: 'm2', type: 'instruction', content: 'be  brief' },
    ];
    const events = [];
    const usedOut = {};
    await resolveMemoryContext({ ...base, onEvent: (t, d) => events.push([t, d]), memoryPolicy: policy, usedOut });
    const used = events.filter(([t]) => t === 'memory_used');
    assert.strictEqual(used.length, 1);
    assert.deepStrictEqual(used[0][1].items.map(i => [i.id, i.type]), [['m1', 'fact'], ['m2', 'instruction']]);
    assert.strictEqual(used[0][1].items[0].preview.length, 120);
    assert.strictEqual(used[0][1].items[1].preview, 'be brief');
    assert.deepStrictEqual(usedOut.items, used[0][1].items);
    // before the answer streams: after the lookup phase started, no token event yet
    assert.ok(events.findIndex(([t]) => t === 'memory_used') > events.findIndex(([t]) => t === 'phase'));
});

test('no memories (or read off): no memory_used event', async () => {
    const events = [];
    found = [];
    await resolveMemoryContext({ ...base, onEvent: (t, d) => events.push([t, d]), memoryPolicy: policy });
    policy = { read: false, write: false, reason: 'chat_off' };
    await resolveMemoryContext({ ...base, onEvent: (t, d) => events.push([t, d]), memoryPolicy: policy });
    assert.ok(!events.some(([t]) => t === 'memory_used'));
});

test('includeSensitive follows policy.sensitive, and is off by default', async () => {
    await resolveMemoryContext({ ...base, memoryPolicy: { read: true, write: true, reason: 'enabled' } });
    assert.strictEqual(storeCalls.at(-1)[5].includeSensitive, false);
    await resolveMemoryContext({ ...base, memoryPolicy: { read: true, write: true, reason: 'enabled', sensitive: true } });
    assert.strictEqual(storeCalls.at(-1)[5].includeSensitive, true);
});

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

// The write pipeline has its own tests (agents/memory/memoryWriter.test.js); here
// it records what the tool hands it and answers with a scripted outcome.
let writeCalls = [];
let writeResult = { action: 'created', id: 'mem-1' };
mock(path.resolve(__dirname, '../agents/memory/memoryWriter'), {
    async writeMemory(candidate, ctx) { writeCalls.push({ candidate, ctx }); return writeResult; },
});

// The gate is its own module with its own tests; here it is a switch.
let policy = { read: true, write: true, reason: 'enabled' };
const policyCalls = [];
mock(path.resolve(__dirname, '../core/memory/memoryPolicy'), {
    async resolveMemoryPolicy(opts) { policyCalls.push(opts); return policy; },
});

const { MEMORY_TOOLS, isMemoryTool, executeMemoryTool } = require('./memoryTools');

beforeEach(() => { writeCalls = []; writeResult = { action: 'created', id: 'mem-1' }; searchCalls = []; createCalls = []; found = []; policyCalls.length = 0; policy = { read: true, write: true, reason: 'enabled' }; });

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

test('remember validates the type and writes through the pipeline as the calling user', async () => {
    const r = await executeMemoryTool('memory_remember', {
        type: 'instruction', content: 'Sign client mail with "Groet, Tom"', subject: 'email style', attribute: 'signoff', value: 'Groet, Tom', importance: 0.9, evidence: 'weekly review',
    }, { userId: 'u1', orgId: 'o1', agentId: null, conversationId: 'c1' });
    assert.strictEqual(r.stored, true);
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(r.id, 'mem-1');
    assert.strictEqual(r.content, 'Sign client mail with "Groet, Tom"');
    assert.strictEqual(writeCalls.length, 1);
    assert.deepStrictEqual(writeCalls[0].ctx, { userId: 'u1', orgId: 'o1', agentId: null, projectId: null, conversationId: 'c1', origin: 'tool' });
    assert.strictEqual(writeCalls[0].candidate.subject, 'email style');
    assert.strictEqual(writeCalls[0].candidate.attribute, 'signoff');
    assert.strictEqual(writeCalls[0].candidate.importance, 0.9);
    assert.strictEqual(createCalls.length, 0, 'no direct createMemory any more');

    const bad = await executeMemoryTool('memory_remember', { type: 'secret', content: 'x' }, { userId: 'u1' });
    assert.match(bad.error, /type must be one of/);
    assert.strictEqual(writeCalls.length, 1, 'nothing written for an invalid type');
});

test('the content cap stays at 200 characters', async () => {
    await executeMemoryTool('memory_remember', { type: 'fact', content: 'x'.repeat(500) }, { userId: 'u1' });
    assert.strictEqual(writeCalls[0].candidate.content.length, 200);
});

test('remember tells the model what happened, per action', async () => {
    const run = async (result) => { writeResult = result; return executeMemoryTool('memory_remember', { type: 'fact', content: 'Works in Utrecht' }, { userId: 'u1' }); };

    let r = await run({ action: 'confirmed', id: 'm9' });
    assert.deepStrictEqual([r.stored, r.action], [true, 'confirmed']);
    assert.match(r.message, /Already known/);

    r = await run({ action: 'superseded', id: 'm10', supersededId: 'm2' });
    assert.deepStrictEqual([r.stored, r.replaced], [true, 'm2']);
    assert.match(r.message, /replaces an older/);

    r = await run({ action: 'pending_review', id: 'm11', reason: 'art9_review' });
    assert.deepStrictEqual([r.stored, r.needsReview], [false, true]);
    assert.match(r.message, /Settings → Memory/);

    r = await run({ action: 'pending_review', id: 'm12', reason: 'contradicts_explicit' });
    assert.match(r.message, /wrote themselves/);

    r = await run({ action: 'rejected', reason: 'sensitive_identifier' });
    assert.deepStrictEqual([r.stored, r.reason], [false, 'sensitive_identifier']);
    assert.match(r.message, /Not stored/);

    r = await run({ action: 'rejected', reason: 'art9_no_consent' });
    assert.match(r.message, /Not stored: .*sensitive/);
});

test('refuses without a signed-in user — there is no other scope', async () => {
    const r = await executeMemoryTool('memory_search', { query: 'q' }, {});
    assert.match(r.error, /signed-in user/);
    assert.strictEqual(searchCalls.length, 0);
});

test('memory off: search reads nothing and says so, as a result not an error', async () => {
    policy = { read: false, write: false, reason: 'org_disabled' };
    found = [{ id: 'a', type: 'fact', content: 'secret' }];
    const r = await executeMemoryTool('memory_search', { query: 'q' }, { userId: 'u1', orgId: 'org1', memoryReadEnabled: false });
    assert.strictEqual(searchCalls.length, 0, 'the store is never consulted');
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.count, 0);
    assert.match(r.message, /Memory is turned off/);
    assert.deepStrictEqual(policyCalls[0], { userId: 'u1', orgId: 'org1', perChatReadEnabled: false, perChatWriteEnabled: undefined });
});

test('memory off: remember stores nothing', async () => {
    policy = { read: true, write: false, reason: 'chat_paused' };
    const r = await executeMemoryTool('memory_remember', { type: 'fact', content: 'x' }, { userId: 'u1' });
    assert.strictEqual(writeCalls.length, 0);
    assert.strictEqual(r.stored, false);
    assert.match(r.message, /Memory is turned off/);
});

test('a paused write still lets search read', async () => {
    policy = { read: true, write: false, reason: 'chat_paused' };
    found = [{ id: 'a', type: 'fact', content: 'ok' }];
    const r = await executeMemoryTool('memory_search', { query: 'q' }, { userId: 'u1' });
    assert.strictEqual(r.count, 1);
});

test('memory_search passes includeSensitive from the resolved policy (default off)', async () => {
    await executeMemoryTool('memory_search', { query: 'q' }, { userId: 'u1' });
    assert.strictEqual(searchCalls.at(-1).opts.includeSensitive, false);
    policy = { read: true, write: true, reason: 'enabled', sensitive: true };
    await executeMemoryTool('memory_search', { query: 'q' }, { userId: 'u1' });
    assert.strictEqual(searchCalls.at(-1).opts.includeSensitive, true);
});

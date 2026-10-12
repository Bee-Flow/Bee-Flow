/**
 * finalizeStreamTurn only extracts memories when the memory policy allows a
 * write, and a guardrail violation or a redacted message still blocks it.
 *
 * Run: cd server && node --test core/agentRuntime/finalizeTurn.memory.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const extractCalls = [];
const policyCalls = [];
let policy = { read: true, write: true, reason: 'enabled' };

const restore = installResolveStub({
    '../../stores/agentStore': {},
    '../memory/memoryPolicy': { async resolveMemoryPolicy(opts) { policyCalls.push(opts); return policy; } },
    '../../agents/memory/extractor': {
        async extractFromConversation(...args) { extractCalls.push(args); return []; },
    },
});
test.after(() => restore());

const { finalizeStreamTurn } = require('./finalizeTurn');

function turn(over = {}) {
    return {
        fullResponse: 'Hello', useNativeAdapter: true, onEvent: () => {}, messageMetadata: {},
        _emailDrafts: [], _calendarDrafts: [], _linkedInDrafts: [], _mapEmbeds: [], _audioFiles: [],
        _toolHistory: [], _kbSources: [], _thinkingParts: [], _thinking: '',
        conversation: { id: 'c1' }, durableMessages: [], messages: [], persistDurable: async () => {},
        isEphemeral: false, agent: { id: 'a1', organization_id: 'org1', config: {} }, agentId: 'a1', userId: 'u1',
        guardrailViolation: null, processedUserMessage: 'hi', userMessage: 'hi', userAuth: {},
        extractMemoriesEnabled: false, validProjectId: null, modelToUse: 'm', toolCalls: [],
        _serializeConversationWrite: async (_c, fn) => fn(),
        ...over,
    };
}

test.beforeEach(() => { extractCalls.length = 0; policyCalls.length = 0; policy = { read: true, write: true, reason: 'enabled' }; });

test('write allowed: the extractor runs, with the policy the turn passed in', async () => {
    await finalizeStreamTurn(turn({ memoryPolicy: policy }));
    assert.strictEqual(extractCalls.length, 1);
    assert.strictEqual(policyCalls.length, 0, 'not resolved a second time');
});

test('write off (org, user, chat): the extractor never runs', async () => {
    for (const reason of ['org_disabled', 'user_disabled', 'chat_off', 'chat_paused', 'embed_agent']) {
        await finalizeStreamTurn(turn({ memoryPolicy: { read: false, write: false, reason } }));
    }
    assert.strictEqual(extractCalls.length, 0);
});

test('write allowed but the message was redacted or blocked: still no extraction', async () => {
    await finalizeStreamTurn(turn({ memoryPolicy: policy, processedUserMessage: 'hi [REDACTED]' }));
    await finalizeStreamTurn(turn({ memoryPolicy: policy, guardrailViolation: { type: 'x' } }));
    assert.strictEqual(extractCalls.length, 0);
});

test('without a passed-in policy the per-chat flags go into the resolver', async () => {
    policy = { read: true, write: false, reason: 'chat_paused' };
    await finalizeStreamTurn(turn({ messageMetadata: { memoryWriteEnabled: false, memoryReadEnabled: true, userOrgId: 'org9' } }));
    assert.strictEqual(extractCalls.length, 0);
    assert.strictEqual(policyCalls[0].orgId, 'org9');
    assert.strictEqual(policyCalls[0].perChatWriteEnabled, false);
    assert.strictEqual(policyCalls[0].perChatReadEnabled, true);
});

test('an ephemeral turn never extracts', async () => {
    await finalizeStreamTurn(turn({ memoryPolicy: policy, isEphemeral: true }));
    assert.strictEqual(extractCalls.length, 0);
});

test('the memories used this turn ride on the assistant message', async () => {
    const memoryUsed = [{ id: 'm1', type: 'fact', preview: 'likes tea', why: 'relevant' }];
    const withMemory = turn({ memoryPolicy: policy, memoryUsed });
    await finalizeStreamTurn(withMemory);
    assert.deepStrictEqual(withMemory.durableMessages.at(-1).memoryUsed, [{ id: 'm1', type: 'fact', why: 'relevant' }], 'ids, types and why only: no memory text in the stored message');
    assert.ok(!JSON.stringify(withMemory.durableMessages).includes('likes tea'));

    const without = turn({ memoryPolicy: policy, memoryUsed: [] });
    await finalizeStreamTurn(without);
    assert.ok(!('memoryUsed' in without.durableMessages.at(-1)));
});

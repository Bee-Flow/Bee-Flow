/**
 * Direct chat's end-of-turn memory extraction obeys the memory policy that
 * promptAssembly resolved for the turn: write off (org, user, chat) means the
 * extractor never runs; a moderation violation still blocks it.
 *
 * Run: cd server && node --test routes/ai/directChat/finalizeTurn.memory.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const extractCalls = [];
const policyCalls = [];
let policy = { read: true, write: true, reason: 'enabled' };

// Persistence is not under test: every store call is an async no-op.
const anyAsync = () => new Proxy({}, { get: () => async () => null });
// ...except that the saved conversation is recorded.
const savedConversations = [];
const recordingStore = () => new Proxy({}, {
    get: (_t, name) => async (...args) => {
        if (name === 'updateDirectConversation') savedConversations.push(args);
        if (name === 'getDirectConversation') return { id: 'c1', messages: [], meta: {} };
        return null;
    },
});

const restore = installResolveStub({
    '../../../stores/agentStore': recordingStore(),
    '../../../stores/configStore': anyAsync(),
    '../../../core/memory/memoryPolicy': { async resolveMemoryPolicy(opts) { policyCalls.push(opts); return policy; } },
    '../../../agents/memory/extractor': {
        async extractFromConversation(...args) { extractCalls.push(args); return []; },
    },
});
test.after(() => restore());

const { finalizeDirectChatTurn } = require('./finalizeTurn');

function turn(over = {}) {
    return {
        req: { body: {}, session: { user: { id: 'u1' } } }, send: () => {}, userId: 'u1', convId: 'c1',
        userOrgForTiers: 'org1', messages: [{ role: 'user', content: 'hi' }],
        moderationViolation: false, extractMemoriesEnabled: false, validProjectId: null,
        modelId: 'm', config: { providerType: 'test' }, fullContent: 'Hello', toolCallRounds: 0, collectedToolHistory: [], streamContentFlush: () => {},
        displaySegments: { hasSegments: () => false },
        // what the save branch reads
        clearInterruptedTurnHook: () => {}, persistedAttachments: [], generatedImages: [], generatedAudio: [], collectedEmailDrafts: [], collectedCalendarDrafts: [], collectedMapEmbeds: [], thinkingParts: [], thinkingContent: "", tiers: {}, activatedToolGroups: new Set(), activatedLibrarySkillIds: [], sessionSkills: [],
        ...over,
    };
}

test.beforeEach(() => { extractCalls.length = 0; policyCalls.length = 0; policy = { read: true, write: true, reason: 'enabled' }; });

test('write allowed: the extractor runs with the policy promptAssembly resolved', async () => {
    await finalizeDirectChatTurn(turn({ memoryPolicy: policy }));
    assert.strictEqual(extractCalls.length, 1);
    assert.strictEqual(policyCalls.length, 0, 'not resolved a second time');
});

test('write off (org, user, chat): the extractor never runs', async () => {
    for (const reason of ['org_disabled', 'user_disabled', 'chat_off', 'chat_paused']) {
        await finalizeDirectChatTurn(turn({ memoryPolicy: { read: false, write: false, reason } }));
    }
    assert.strictEqual(extractCalls.length, 0);
});

test('write allowed but a moderation violation: still no extraction', async () => {
    await finalizeDirectChatTurn(turn({ memoryPolicy: policy, moderationViolation: true }));
    assert.strictEqual(extractCalls.length, 0);
});

test('without a resolved policy the request flags go into the resolver', async () => {
    policy = { read: false, write: false, reason: 'chat_off' };
    await finalizeDirectChatTurn(turn({ req: { body: { memoryReadEnabled: false, memoryWriteEnabled: true } } }));
    assert.strictEqual(extractCalls.length, 0);
    assert.deepStrictEqual(policyCalls[0], { userId: 'u1', orgId: 'org1', perChatReadEnabled: false, perChatWriteEnabled: true });
});

const savedAssistant = () => savedConversations.at(-1)?.[1].find((m) => m.role === 'assistant');

test('the memories used this turn are persisted on the assistant message', async () => {
    savedConversations.length = 0;
    const memoryUsed = [{ id: 'm1', type: 'fact', preview: 'likes tea', why: 'relevant' }];
    await finalizeDirectChatTurn(turn({ memoryPolicy: policy, memoryUsed }));
    assert.deepStrictEqual(savedAssistant().memoryUsed, [{ id: 'm1', type: 'fact', why: 'relevant' }], 'ids, types and why only');
    assert.ok(!JSON.stringify(savedConversations).includes('likes tea'), 'no memory text in the stored message');
});

test('no memories used: the assistant message carries no memoryUsed field', async () => {
    savedConversations.length = 0;
    await finalizeDirectChatTurn(turn({ memoryPolicy: policy, memoryUsed: [] }));
    assert.ok(savedAssistant());
    assert.ok(!('memoryUsed' in savedAssistant()));
});

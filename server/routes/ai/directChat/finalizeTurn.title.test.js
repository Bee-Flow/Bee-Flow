/**
 * The title promise comes back unawaited (routes/ai/directChat/finalizeTurn.js).
 *
 * persistTurn is async; returning the bare pendingTitle promise from it made
 * the caller's `await` adopt that promise, so `done` waited for the title
 * model call. finalizeDirectChatTurn must resolve while the title is pending.
 *
 * Run: cd server && node --test routes/ai/directChat/finalizeTurn.title.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const store = new Proxy({}, {
    get: (_t, name) => async () => (name === 'getDirectConversation' ? { id: 'c1', messages: [], meta: {} } : null),
});
const pendingTitle = new Promise(() => {}); // a title call that never answers

const restore = installResolveStub({
    '../../../stores/agentStore': store,
    '../../../stores/configStore': new Proxy({}, { get: () => async () => null }),
    './finalizeAftercare': {
        async scheduleTitle() { return { pendingTitle }; },
        async extractTurnMemories() {},
    },
});
test.after(() => restore());

const { finalizeDirectChatTurn } = require('./finalizeTurn');

test('the turn resolves while the title is still pending, and hands that promise back', async () => {
    const turn = {
        req: { body: {}, session: { user: { id: 'u1' } } }, send: () => {}, userId: 'u1', convId: 'c1',
        userOrgForTiers: 'org1', messages: [{ role: 'user', content: 'hi' }],
        moderationViolation: false, modelId: 'm', config: { providerType: 'test' }, fullContent: 'Hello',
        toolCallRounds: 0, collectedToolHistory: [], streamContentFlush: () => {},
        displaySegments: { hasSegments: () => false },
        clearInterruptedTurnHook: () => {}, persistedAttachments: [], generatedImages: [], generatedAudio: [],
        collectedEmailDrafts: [], collectedCalendarDrafts: [], collectedMapEmbeds: [], thinkingParts: [],
        thinkingContent: '', tiers: {}, activatedToolGroups: new Set(), activatedLibrarySkillIds: [], sessionSkills: [],
    };
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, 2000, 'timeout'); });
    const out = await Promise.race([finalizeDirectChatTurn(turn), timeout]);
    clearTimeout(timer);
    assert.notStrictEqual(out, 'timeout', 'finalize waited for the title');
    assert.strictEqual(out.convId, 'c1');
    assert.strictEqual(out.pendingTitle, pendingTitle);
});

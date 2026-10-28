// @typecheck strict
/**
 * The title promise comes back unawaited (routes/ai/directChat/finalizeTurn.js).
 *
 * persistTurn is async; returning the bare pendingTitle promise from it made
 * the caller's `await` adopt that promise, so `done` waited for the title
 * model call. finalizeDirectChatTurn must resolve while the title is pending.
 *
 * Also where the finished turn lands in the stored conversation (the tests
 * after the title one): see placeTurnRows in core/conversation/historyMerge.js.
 *
 * Run: cd server && node --test routes/ai/directChat/finalizeTurn.title.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../testUtils/stubRequire');

/** @type {{ stored: Record<string, unknown>[], saved: Record<string, unknown>[] | null, placeable: boolean, placed: unknown[] | null }} */
const fx = { stored: [], saved: null, placeable: false, placed: null };
const store = new Proxy({}, {
    get: (_t, name) => async (/** @type {unknown[]} */ ...args) => {
        if (name === 'getDirectConversation') return { id: 'c1', messages: fx.stored, meta: {} };
        if (name === 'updateDirectConversation') { fx.saved = /** @type {Record<string, unknown>[]} */ (args[1]); return true; }
        // The store's turn save (rows after the anchor, under the row lock);
        // false = a legacy-blob conversation, the whole array is written instead.
        if (name === 'placeDirectConversationTurn') { if (fx.placeable) fx.placed = args; return fx.placeable; }
        return null;
    },
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

// ── Where the turn lands ────────────────────────────────────────────────────
//
// Direct chat saves a turn once, at its end, on top of the conversation as it
// is stored at that moment. When another turn on the same conversation
// finished in between (a second tab or device, the Nextcloud embed next to the
// web app, or the question asked again after a dropped stream while the
// server was still answering the first), the slower turn was appended BELOW
// the faster one: the question asked first then sat under a later question and
// its answer. A turn belongs right after the last stored message it was asked on.

/** @param {Record<string, unknown>} over */
function turnOf(over) {
    return {
        req: { body: {}, session: { user: { id: 'u1' } } }, send: () => {}, userId: 'u1', convId: 'c1',
        userOrgForTiers: 'org1', messages: [{ role: 'user', content: 'second question' }],
        tokenizedMessage: 'second question',
        moderationViolation: false, modelId: 'm', config: { providerType: 'test' }, fullContent: 'second answer',
        toolCallRounds: 0, collectedToolHistory: [], streamContentFlush: () => {},
        displaySegments: { hasSegments: () => false },
        clearInterruptedTurnHook: () => {}, persistedAttachments: [], generatedImages: [], generatedAudio: [],
        collectedEmailDrafts: [], collectedCalendarDrafts: [], collectedMapEmbeds: [], thinkingParts: [],
        thinkingContent: '', tiers: {}, activatedToolGroups: new Set(), activatedLibrarySkillIds: [], sessionSkills: [],
        ...over,
    };
}

const asked = [
    { id: 'r1', role: 'user', content: 'first question' },
    { id: 'r2', role: 'assistant', content: 'first answer' },
];
const overtook = [
    { id: 'r3', role: 'user', content: 'third question' },
    { id: 'r4', role: 'assistant', content: 'third answer' },
];

/** @param {Record<string, unknown>[] | null} rows */
const contents = (rows) => (rows || []).map((m) => m.content);

test('a turn another turn overtook is saved where it was asked, not below the faster one', async () => {
    fx.stored = [...asked, ...overtook];
    fx.saved = null;
    // The history this turn was asked on is what the DB held when it began.
    await finalizeDirectChatTurn(turnOf({ resolvedHistory: asked, clientHistoryProvided: false }));
    assert.deepStrictEqual(contents(fx.saved), [
        'first question', 'first answer',
        'second question', 'second answer',
        'third question', 'third answer',
    ]);
});

test('a turn nothing overtook is appended at the end, as before', async () => {
    fx.stored = [...asked];
    fx.saved = null;
    await finalizeDirectChatTurn(turnOf({ resolvedHistory: asked, clientHistoryProvided: false }));
    assert.deepStrictEqual(contents(fx.saved), ['first question', 'first answer', 'second question', 'second answer']);
});

test('a turn whose anchor is gone (an edit cut the chat) is appended at the end', async () => {
    fx.stored = [{ id: 'other', role: 'user', content: 'edited' }];
    fx.saved = null;
    await finalizeDirectChatTurn(turnOf({ resolvedHistory: asked, clientHistoryProvided: false }));
    assert.deepStrictEqual(contents(fx.saved), ['edited', 'second question', 'second answer']);
});

test('a shared thread keeps appending: its store write diffs the tail, and a turn lock already orders it', async () => {
    fx.stored = [...asked, ...overtook];
    fx.saved = null;
    await finalizeDirectChatTurn(turnOf({
        resolvedHistory: asked, clientHistoryProvided: false,
        _sharedThread: { projectId: 'p1' },
    }));
    assert.deepStrictEqual(contents(fx.saved).slice(-2), ['second question', 'second answer']);
});

test('a turn on the stored history is saved as its own rows after its anchor, not as a full rewrite', async () => {
    fx.stored = [...asked, ...overtook];
    fx.saved = null;
    fx.placeable = true;
    fx.placed = null;
    try {
        await finalizeDirectChatTurn(turnOf({ resolvedHistory: asked, clientHistoryProvided: false }));
    } finally { fx.placeable = false; }
    assert.strictEqual(fx.saved, null, 'no whole-array write');
    const [convId, { rows, anchorId }] = /** @type {[string, { rows: Record<string, unknown>[], anchorId: string }]} */ (/** @type {unknown} */ (fx.placed));
    assert.strictEqual(convId, 'c1');
    assert.strictEqual(anchorId, 'r2');
    assert.deepStrictEqual(contents(rows), ['second question', 'second answer']);
});

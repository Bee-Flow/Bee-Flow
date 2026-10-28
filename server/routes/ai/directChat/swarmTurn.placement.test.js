// @typecheck
/**
 * Where a finished Swarm turn lands in the stored conversation (issue #420).
 *
 * The Swarm branch of direct chat (./swarmTurn.js) runs long and saved its
 * question and answer at the END of the conversation as stored when it
 * finished. A turn that finished on the same conversation in the meantime then
 * sat above the swarm question that was asked before it. The swarm turn now
 * goes right after the last stored message it was asked on, under the row
 * lock, like every other direct-chat turn (placeDirectConversationTurn).
 *
 * The real swarm branch. The direct store is swapped on its module object
 * (testUtils/swaps.js) for an in-memory conversation that places and replaces
 * exactly as the real one does (placeTurnRows; the store side runs against
 * Postgres in stores/agent/conversationTurns.pg.test.js), and so are the swarm
 * runtime, the beta gate and the tier model.
 *
 * Run: cd server && node --test routes/ai/directChat/swarmTurn.placement.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeSwaps } = require('../../../testUtils/swaps');

const agentStore = require('../../../stores/agentStore');
const swarmRuntime = require('../../../core/swarms/swarmRuntime');
const betaFeatures = require('../../../core/entitlements/betaFeatures');
const modelResolver = require('../../../core/llm/modelResolver');
const userStore = require('../../../stores/userStore');
const { placeTurnRows } = require('../../../core/conversation/historyMerge');
const { runSwarmTierTurn } = require('./swarmTurn');

const USER = 'u-swarm';
const { swap, restore } = makeSwaps();

/** @typedef {{ id?: string, role: string, content: string }} Msg */
/** The stored conversation, and the meta written with it. */
const db = { /** @type {Msg[]} */ messages: [], /** @type {Record<string, unknown>} */ meta: {} };

before(() => {
    swap(betaFeatures, 'userHasBetaFeature', async () => true);
    swap(swarmRuntime, 'loadSwarmById', () => ({ id: 'builtin:research_swarm' }));
    swap(modelResolver, 'resolveModelForTier', async () => 'model-x');
    swap(userStore, 'getUser', async () => ({ id: USER, organizationId: null }));
    swap(agentStore, 'getDirectConversation', async () => ({ id: 'c1', messages: [...db.messages], ...db.meta }));
    swap(agentStore, 'updateDirectConversation', async (/** @type {string} */ _id, /** @type {Msg[]} */ messages, /** @type {string} */ _u, /** @type {Record<string, unknown>} */ meta) => {
        db.messages = [...messages];
        db.meta = { ...db.meta, ...meta };
        return true;
    });
    swap(agentStore, 'placeDirectConversationTurn', async (/** @type {string} */ _id, /** @type {{ rows: Msg[], anchorId: string | null }} */ { rows, anchorId }, /** @type {string} */ _u, /** @type {Record<string, unknown> | null} */ meta) => {
        db.messages = placeTurnRows(db.messages, rows, anchorId);
        db.meta = { ...db.meta, ...(meta || {}) };
        return true;
    });
});
after(restore);

function fakeRes() {
    return {
        statusCode: 200, ended: false, /** @type {unknown[]} */ events: [],
        /** @param {number} c */
        status(c) { this.statusCode = c; return this; },
        /** @param {unknown} _b */
        json(_b) { this.ended = true; return this; },
        /** @param {number} c */
        writeHead(c) { this.statusCode = c; },
        setHeader() {},
        flushHeaders() {},
        /** @param {unknown} chunk */
        write(chunk) { this.events.push(chunk); return true; },
        end() { this.ended = true; },
    };
}

test('a turn that finished while the swarm ran stays below the swarm question', async () => {
    db.messages = [
        { id: 'h1', role: 'user', content: 'first question' },
        { id: 'h2', role: 'assistant', content: 'first answer' },
    ];
    db.meta = {};
    const undo = swap(swarmRuntime, 'runSwarmTurn', async () => {
        // Another tab asks and gets its answer while the swarm is still working.
        db.messages = [...db.messages, { id: 'b-q', role: 'user', content: 'question B' }, { id: 'b-a', role: 'assistant', content: 'answer B' }];
        return { paused: false, finalText: 'swarm answer', hiveMind: { notes: 1 }, snapshot: null };
    });
    try {
        await runSwarmTierTurn({
            req: { body: {}, session: { user: { id: USER } } }, res: fakeRes(),
            userId: USER, message: 'swarm question', conversationId: 'c1', attachments: [],
        });
    } finally { undo(); }

    assert.deepEqual(db.messages.map((m) => m.content), [
        'first question', 'first answer',
        'swarm question', 'swarm answer',
        'question B', 'answer B',
    ]);
    assert.deepEqual(db.meta.hiveMind, { notes: 1 }, 'the swarm state is saved with the turn');
});

/**
 * The team chat as a participation surface, end to end below the model: the
 * real chat store and participation store over PGlite, the real sealing with
 * an injected project key, the real chat assistant with the model, shield,
 * lock and feed injected, and the real engine with an injected gate.
 *
 * Proven:
 *   - loadContext opens the recent messages, leaves out notices and deleted
 *     messages, and flags mentions; readByOthers counts other readers;
 *   - a watch that comes due and passes the gate is answered as `auto_quiet`
 *     with the gate's reason code stored on the answer, and nothing but the
 *     answer reaches the feed;
 *   - a member who posts while the answer is being written wins: the answer
 *     is dropped by the store, under the chat lock, and the decision says
 *     `stale`.
 *
 * Run: cd server && node --test projects/participation/chatSurface.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const chatStoreModule = require('../../stores/projectChatStore');
const participationStoreModule = require('../../stores/projectAiParticipationStore');
const { makeChatCrypto } = require('../chatCrypto');
const { makeChatAssistant } = require('../chatAssistant');
const { makeChatSurface } = require('./chatSurface');
const { makeParticipationEngine } = require('./engine');
const { makePolicy } = require('./policy');

const { pg, db } = pgliteDb(new PGlite());
const chats = chatStoreModule.makeProjectChatStore(db);
const participationStore = participationStoreModule.makeProjectAiParticipationStore(db);
const KEY = crypto.randomBytes(32);
const chatCrypto = makeChatCrypto({ getProjectKey: async () => KEY });
const PROJECT = { id: 'p1', name: 'Launch', organizationId: 'org1', ownerId: 'olga', knowledgeBaseIds: [] };

const feed = [];
let whileAnswering = null;
let n = 0;

const assistant = makeChatAssistant({
    store: chats,
    chatCrypto,
    locks: { acquireTurn: async () => ({ acquired: true }), releaseTurn: async () => true },
    shield: {
        resolve: async () => ({ enabled: false }),
        protect: async ({ text }) => ({ text, tokenMap: null }),
        tokenAddendum: () => '',
        restore: (t) => t,
        release: () => {},
    },
    llmChat: async () => {
        if (whileAnswering) await whileAnswering();
        return { content: 'Annual plans are refundable within 30 days.', usage: {} };
    },
    resolveModel: async () => ({ modelId: 'fast-1', options: { maxTokens: 4096 } }),
    resolvePersona: async () => null,
    searchKnowledge: async () => '',
    listAudience: async () => ['olga', 'ann', 'bob'],
    getUser: async (id) => ({ id, displayName: id }),
    checkLimits: async () => null,
    emit: async (projectId, ev) => { feed.push(ev); },
    publishTransient: async (projectId, ev) => { feed.push(ev); },
    logUsage: async () => {},
    recordReply: async () => {},
    newId: () => `a-${++n}`,
});

const surface = makeChatSurface({
    store: chats,
    getProject: async (id) => (id === 'p1' ? PROJECT : null),
    getProjectShares: async () => [{ sharedWithType: 'user', sharedWithId: 'ann' }, { sharedWithType: 'user', sharedWithId: 'bob' }],
    chatCrypto,
    assistant,
});

const engine = makeParticipationEngine({
    store: participationStore,
    policy: makePolicy({ getConfig: async () => null, setConfig: async () => true, env: {} }),
    gate: async () => ({
        available: true, model: 'fast-1', outcome: 'reply',
        verdict: { shouldReply: true, confidence: 0.9, addressedTo: 'group', isOpenQuestion: true, waitForHumans: false, reasonCode: 'open_question_answerable' },
    }),
    checkLimits: async () => null,
    isLockHeld: async () => false,
});
engine.registerSurface('chat', surface);

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(chatStoreModule.DDL);
    await pg.exec(participationStoreModule.DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'Launch', 'olga')`);
});
after(async () => { await pg.close(); });

async function newChat(id) {
    const box = await chatCrypto.forProject(PROJECT);
    return chats.createChat({ id, projectId: 'p1', title: box.sealTitle(id, 'Launch chat'), createdBy: 'olga', aiMode: 'auto' });
}
async function post(chatId, userId, text, extra = {}) {
    const box = await chatCrypto.forProject(PROJECT);
    const id = `m-${++n}`;
    const saved = await chats.appendMessage({
        id, projectId: 'p1', chatId, authorKind: 'user', authorUserId: userId, content: box.sealContent(chatId, id, text), ...extra,
    });
    return saved.message;
}

test('loadContext: opened messages, no notices or deleted ones, mention flags, readers', async () => {
    await newChat('c-ctx');
    await chats.appendMessage({ id: 'notice-1', projectId: 'p1', chatId: 'c-ctx', authorKind: 'system', authorUserId: 'olga', content: '', notice: 'ai_auto_on' });
    const hello = await post('c-ctx', 'ann', 'Hello @ai, are you there?');
    const gone = await post('c-ctx', 'bob', 'Oops wrong chat');
    await chats.softDeleteMessage('c-ctx', gone.id);
    await post('c-ctx', 'bob', 'Ann, can you check it?', { mentions: ['ann'] });
    await chats.markRead('c-ctx', 'olga', 10);

    const ctx = await surface.loadContext('c-ctx');
    assert.strictEqual(ctx.projectId, 'p1');
    assert.strictEqual(ctx.orgId, 'org1');
    assert.strictEqual(ctx.aiMode, 'auto');
    assert.strictEqual(ctx.memberCount, 3);
    assert.deepStrictEqual(ctx.messages.map((m) => [m.authorUserId, m.text, m.mentionsAi, m.mentionsHuman]), [
        ['ann', 'Hello @ai, are you there?', true, false],
        ['bob', 'Ann, can you check it?', false, true],
    ]);
    assert.strictEqual(await ctx.readByOthers(ctx.messages[0]), 2, 'olga read past it, bob wrote after it; ann is its author');
    assert.strictEqual(await surface.loadContext('no-such-chat'), null);
    assert.ok(hello);
});

test('a due watch that passes the gate is answered as auto_quiet, with its reason, silently', async () => {
    await newChat('c-auto');
    const q = await post('c-auto', 'ann', 'Does anyone know the refund policy for annual plans?');
    const told = await engine.onHumanMessage({ surface: 'chat', containerId: 'c-auto', messageId: q.id, authorUserId: 'ann', orgId: 'org1', limitOrgId: 'org1', projectId: 'p1' });
    assert.deepStrictEqual(told, { watched: true });
    await pg.query(`UPDATE project_ai_watch SET due_at = NOW() WHERE container_id = 'c-auto'`);
    const [w] = await participationStore.claimDue(1, { claimId: 'x' });
    feed.length = 0;
    const out = await engine.processWatch(w);
    assert.strictEqual(out.decision, 'replied');

    const { messages } = await chats.listMessages('c-auto');
    const answer = messages.at(-1);
    assert.strictEqual(answer.authorKind, 'assistant');
    assert.strictEqual(answer.aiTrigger, 'auto_quiet');
    assert.strictEqual(answer.aiReason, 'open_question_answerable');
    assert.strictEqual(answer.replyTo, q.id);
    const box = await chatCrypto.forProject(PROJECT);
    assert.strictEqual(box.openContent('c-auto', answer.id, answer.content), 'Annual plans are refundable within 30 days.');
    assert.deepStrictEqual(feed.map((e) => e.kind), ['chat.message.created'], 'no chat.ai.* events');
    const [decision] = await participationStore.listDecisions('c-auto');
    assert.strictEqual(decision.decision, 'replied');
    assert.strictEqual(decision.replyMessageId, answer.id);
});

test('a member posting while the answer is written wins: the answer is dropped as stale', async () => {
    await newChat('c-stale');
    const q = await post('c-stale', 'ann', 'Does anyone know the refund policy for annual plans?');
    await engine.onHumanMessage({ surface: 'chat', containerId: 'c-stale', messageId: q.id, authorUserId: 'ann', orgId: 'org1', limitOrgId: 'org1', projectId: 'p1' });
    await pg.query(`UPDATE project_ai_watch SET due_at = NOW() WHERE container_id = 'c-stale'`);
    const [w] = await participationStore.claimDue(1, { claimId: 'y' });
    whileAnswering = async () => { await post('c-stale', 'bob', 'It is 30 days, I just checked.'); };
    feed.length = 0;
    try {
        const out = await engine.processWatch(w);
        assert.deepStrictEqual(out, { decision: 'skipped', skipReason: 'stale' });
    } finally {
        whileAnswering = null;
    }
    const { messages } = await chats.listMessages('c-stale');
    assert.ok(messages.every((m) => m.authorKind === 'user'), 'no answer was stored');
    assert.deepStrictEqual(feed, []);
});

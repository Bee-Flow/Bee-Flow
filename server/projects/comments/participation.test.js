/**
 * The comment surface inside the real participation engine
 * (projects/participation/engine.js + answerWriter.js): a contract test from
 * a person's question in an `auto` thread to the AI's stored answer. The
 * engine's store, policy, gate, model, lock and shield are fakes; the comment
 * store (PGlite), the sealing and the surface are real.
 *
 * Proven:
 *   - the engine accepts the comment surface;
 *   - a question in an `auto` thread starts a watch; one in a `mention`
 *     thread does not;
 *   - when the gate says "reply", the answer is written through the surface:
 *     sealed, from the assistant, replying to the question, marked as joining
 *     on its own, and announced with ids only; the passage reached the model
 *     through the shield inside a single fence;
 *   - a person answering before the AI's answer is stored makes it stale:
 *     nothing is stored.
 *
 * Run: cd server && node --test projects/comments/participation.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeProjectCommentStore, DDL } = require('../../stores/projectCommentStore');
const { makeCommentCrypto } = require('./commentCrypto');
const { makeCommentSurface, ensureCommentSurface } = require('./surface');
const { makeParticipationEngine } = require('../participation/engine');
const { makeAnswerWriter } = require('../participation/answerWriter');
const { normalizeOrgPolicy } = require('../participation/policy');

const { pg, db } = pgliteDb();
const store = makeProjectCommentStore(db);
const KEY = crypto.randomBytes(32);
const commentCrypto = makeCommentCrypto({ getProjectKey: async () => KEY });
const PROJECT = { id: 'p1', name: 'Launch', organizationId: 'org1' };

let events;
let watches;
let decisions;
let prompts;
let beforeStore;

const surface = makeCommentSurface({
    store,
    commentCrypto,
    getProject: async (id) => (id === 'p1' ? PROJECT : null),
    itemReader: { read: async () => ({ name: 'Research', markdown: '# Budget\nThe budget is 40k for Q3.\n# Other\nx', sectionMarkdown: '' }) },
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
});

const writer = makeAnswerWriter({
    getProject: async () => PROJECT,
    getUser: async () => ({ displayName: 'Ann' }),
    locks: { acquireTurn: async () => ({ acquired: true }), releaseTurn: async () => {} },
    resolveModel: async () => ({ modelId: 'fast-model' }),
    searchKnowledge: async () => '',
    listAudience: async () => null,
    shieldFor: () => ({
        resolve: async () => ({ enabled: false }),
        protect: async ({ text }) => ({ text, tokenMap: null }),
        tokenAddendum: () => '',
        restore: (text) => text,
        release: () => {},
    }),
    llmChat: async (modelId, messages) => {
        prompts.push(messages);
        if (beforeStore) await beforeStore();
        return { content: 'It comes from the Q3 plan.', usage: {} };
    },
    logUsage: async () => {},
});

const engine = makeParticipationEngine({
    store: {
        cancelPending: async () => 0,
        getPendingWatch: async () => null,
        capsFor: async () => ({}),
        postponeWatch: async () => {},
        upsertWatch: async (w) => { watches.push(w); },
        reserveGate: async () => ({ id: `r-${decisions.length}` }),
        completeDecision: async (id, d) => { decisions.push(d); },
        recordDecision: async (d) => { decisions.push(d); },
    },
    policy: {
        resolveOrgPolicy: async () => normalizeOrgPolicy({}, { env: {} }),
        resolveUserPreference: async () => ({ autoJoinOnMyMessages: true }),
    },
    gate: async () => ({ available: true, outcome: 'reply', verdict: { reasonCode: 'open_question_answerable', confidence: 0.9 }, model: 'fast-model' }),
    checkLimits: async () => null,
    isLockHeld: async () => false,
    writer,
});

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT);
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE studio_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT FALSE);
    `);
    await pg.exec(DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('p1', 'p1', 'olga', 'org1')`);
    await pg.query(`INSERT INTO notebooks (id, name, project_id) VALUES ('nb1', 'Research', 'p1')`);
    assert.strictEqual(ensureCommentSurface({ engine, surface }), true, 'the engine accepts the surface');
});
after(async () => { await pg.close(); });
beforeEach(() => { events = []; watches = []; decisions = []; prompts = []; beforeStore = null; });

let n = 0;
async function question(aiMode) {
    const box = await commentCrypto.forProject(PROJECT);
    const threadId = `pt-${++n}`;
    const commentId = `pc-${n}`;
    await store.createThread({
        id: threadId, projectId: 'p1', targetType: 'notebook', targetId: 'nb1', aiMode, createdBy: 'ann',
        anchor: box.sealAnchor(threadId, { quote: 'budget is 40k' }),
        comment: { id: commentId, content: box.sealContent(threadId, commentId, 'Where does the 40k come from?') },
    });
    return { threadId, commentId, box };
}

const notice = (threadId, commentId) => ({
    surface: 'comment', containerId: threadId, messageId: commentId, authorUserId: 'ann', orgId: 'org1', limitOrgId: 'org1', projectId: 'p1',
});

test('a question in an auto thread is watched, and the AI\'s answer lands in the thread', async () => {
    const { threadId, commentId, box } = await question('auto');
    assert.deepStrictEqual(await engine.onHumanMessage(notice(threadId, commentId)), { watched: true });
    assert.strictEqual(watches.length, 1);
    assert.strictEqual(watches[0].surface, 'comment');
    assert.strictEqual(watches[0].containerId, threadId);

    const out = await engine.processWatch({ id: 'w1', ...watches[0] });
    assert.strictEqual(out.decision, 'replied');
    const answer = await store.getComment(threadId, out.messageId);
    assert.strictEqual(answer.authorKind, 'assistant');
    assert.strictEqual(answer.replyTo, commentId);
    assert.strictEqual(answer.aiTrigger, 'auto_quiet');
    assert.strictEqual(box.openContent(threadId, answer.id, answer.content), 'It comes from the Q3 plan.');
    assert.deepStrictEqual(events.map((e) => [e.kind, e.payload.commentId]), [['comment.created', answer.id]]);

    const sent = prompts[0][1].content;
    assert.match(sent, /anchored to this passage:\nbudget is 40k/);
    assert.strictEqual(sent.split('<passage>').length, 2, 'the passage sits in one fence, not two');
});

test('a mention-mode thread never starts a watch', async () => {
    const { threadId, commentId } = await question('mention');
    const out = await engine.onHumanMessage(notice(threadId, commentId));
    assert.strictEqual(out.watched, false);
    assert.strictEqual(watches.length, 0);
});

test('a person answering while the AI writes makes the AI\'s answer stale', async () => {
    const { threadId, commentId, box } = await question('auto');
    await engine.onHumanMessage(notice(threadId, commentId));
    beforeStore = async () => {
        await store.appendComment('p1', threadId, { id: 'human-2', authorUserId: 'bob', content: box.sealContent(threadId, 'human-2', 'Finance set it.') });
    };
    const out = await engine.processWatch({ id: 'w2', ...watches[0] });
    assert.notStrictEqual(out.decision, 'replied');
    const comments = await store.listComments(threadId);
    assert.ok(comments.every((c) => c.authorKind === 'user'), 'no answer was stored');
    assert.strictEqual(events.length, 0);
});

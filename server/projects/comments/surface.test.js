/**
 * projects/comments/surface.js — comment threads as a surface of the AI
 * participation engine, with the real store over PGlite, the real sealing,
 * and a fake engine, item reader and feed.
 *
 * Proven:
 *   - loadContext opens the thread for the engine: mode, org, comments with
 *     their AI/human mention flags, and the passage as extraContext read with
 *     the latest human commenter's access — except on the rules-only read
 *     (`light`), which never reads the item;
 *   - a resolved thread reads as closed; a missing one, or one whose item
 *     left the project, is gone (null) and nothing of it is opened;
 *   - postAnswer stores a sealed assistant comment with its trigger, replies
 *     only inside the thread, and announces ids only; it reports stale once
 *     the thread is resolved or a person commented after the gate's view;
 *   - registration is defensive without an engine; the human notice and the
 *     cancel carry ids only and never throw.
 *
 * Run: cd server && node --test projects/comments/surface.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeProjectCommentStore, DDL } = require('../../stores/projectCommentStore');
const { makeCommentCrypto } = require('./commentCrypto');
const { makeCommentSurface, ensureCommentSurface, notifyHumanComment, cancelCommentThread, SURFACE, LOCK_TYPE } = require('./surface');

const { pg, db } = pgliteDb();
const store = makeProjectCommentStore(db);
const KEY = crypto.randomBytes(32);
const commentCrypto = makeCommentCrypto({ getProjectKey: async () => KEY });
const PROJECTS = { p1: { id: 'p1', name: 'Launch', organizationId: 'org1' } };

let events;
let reads;

const surface = makeCommentSurface({
    store,
    commentCrypto,
    getProject: async (id) => PROJECTS[id] || null,
    itemReader: {
        read: async (args) => {
            reads.push(args);
            return { name: 'Research', markdown: '# Budget\nThe budget is 40k.\n# Other\nx', sectionMarkdown: '' };
        },
    },
    emit: async (projectId, event) => { events.push({ projectId, ...event }); },
});

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT);
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE studio_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT FALSE);
    `);
    await pg.exec(DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'p1', 'olga')`);
    await pg.query(`INSERT INTO notebooks (id, name, project_id) VALUES ('nb1', 'Research', 'p1'), ('nb-out', 'Moved', 'p2')`);
});
after(async () => { await pg.close(); });
beforeEach(() => { events = []; reads = []; });

let n = 0;
async function seedThread({ targetId = 'nb1', aiMode = 'auto', comments = [['ann', 'Where does 40k come from?', []]] } = {}) {
    const box = await commentCrypto.forProject(PROJECTS.p1);
    const threadId = `st-${++n}`;
    const [author, text, mentions] = comments[0];
    const firstId = `sc-${n}-0`;
    await store.createThread({
        id: threadId, projectId: 'p1', targetType: 'notebook', targetId, aiMode, createdBy: author,
        anchor: box.sealAnchor(threadId, { quote: 'budget is 40k' }),
        comment: { id: firstId, content: box.sealContent(threadId, firstId, text), mentions },
    });
    const ids = [firstId];
    for (let i = 1; i < comments.length; i++) {
        const [who, body, men] = comments[i];
        const id = `sc-${n}-${i}`;
        await store.appendComment('p1', threadId, {
            id, authorKind: who ? 'user' : 'assistant', authorUserId: who, content: box.sealContent(threadId, id, body), mentions: men,
        });
        ids.push(id);
    }
    return { threadId, ids, box };
}

test('the surface names itself and its lock type', () => {
    assert.strictEqual(SURFACE, 'comment');
    assert.strictEqual(LOCK_TYPE, 'project_comment');
    assert.strictEqual(surface.lockType, 'project_comment');
});

test('loadContext opens the thread for the engine, with the passage read as the latest commenter', async () => {
    const { threadId, ids } = await seedThread({
        comments: [['ann', 'Where does 40k come from?', []], [null, 'From the plan.', []], ['bob', '@ai and travel? cc @cy', ['cy']]],
    });
    const ctx = await surface.loadContext(threadId);
    assert.strictEqual(ctx.projectId, 'p1');
    assert.strictEqual(ctx.orgId, 'org1');
    assert.strictEqual(ctx.aiMode, 'auto');
    assert.strictEqual(ctx.closed, false);
    assert.strictEqual(ctx.autoPausedUntil, null);
    assert.deepStrictEqual(ctx.messages.map((m) => [m.id, m.seq, m.authorKind, m.authorUserId, m.text, m.mentionsAi, m.mentionsHuman]), [
        [ids[0], 1, 'user', 'ann', 'Where does 40k come from?', false, false],
        [ids[1], 2, 'assistant', null, 'From the plan.', false, false],
        [ids[2], 3, 'user', 'bob', '@ai and travel? cc @cy', true, true],
    ]);
    assert.deepStrictEqual(reads, [{ projectId: 'p1', targetType: 'notebook', targetId: 'nb1', userId: 'bob', sectionId: null }]);
    assert.match(ctx.extraContext, /anchored to this passage:\nbudget is 40k\n/);
    assert.doesNotMatch(ctx.extraContext, /<passage>/, 'plain labels: the engine fences the whole context itself');
    assert.match(ctx.extraContext, /section "Budget"/);
});

test('the rules-only read (the post path) opens the comments but never reads the item', async () => {
    const { threadId, ids } = await seedThread({ comments: [['ann', 'Where does 40k come from?', []], ['bob', 'No idea, anyone?', []]] });
    const ctx = await surface.loadContext(threadId, { light: true });
    assert.deepStrictEqual(ctx.messages.map((m) => m.id), ids);
    assert.strictEqual(ctx.aiMode, 'auto');
    assert.deepStrictEqual(reads, [], 'no document read or conversion for a comment that only needs the rules');
    assert.strictEqual(ctx.extraContext, undefined);
});

test('a resolved thread reads as closed; a missing or moved-out one as gone', async () => {
    const resolved = await seedThread();
    await store.setStatus('p1', resolved.threadId, 'resolved', 'ann');
    assert.strictEqual((await surface.loadContext(resolved.threadId)).closed, true);
    await store.setAutoPausedUntil(resolved.threadId, new Date('2026-10-01T00:00:00Z'));
    assert.strictEqual((await surface.loadContext(resolved.threadId)).autoPausedUntil, '2026-10-01T00:00:00.000Z', 'the engine sees the pause');

    assert.strictEqual(await surface.loadContext('no-such-thread'), null, 'a gone thread is gone for the engine');
    const moved = await seedThread({ targetId: 'nb-out' });
    assert.strictEqual(await surface.loadContext(moved.threadId), null, 'nothing is opened for an item that left the project');
});

test('postAnswer stores a sealed assistant comment and announces ids only', async () => {
    const { threadId, ids, box } = await seedThread();
    const out = await surface.postAnswer({ containerId: threadId, text: '  It comes from the Q3 plan.  ', replyTo: ids[0], trigger: 'auto_unanswered' });
    const stored = await store.getComment(threadId, out.messageId);
    assert.strictEqual(stored.authorKind, 'assistant');
    assert.strictEqual(stored.replyTo, ids[0]);
    assert.strictEqual(stored.aiTrigger, 'auto_unanswered');
    assert.ok(!stored.content.includes('Q3'));
    assert.strictEqual(box.openContent(threadId, stored.id, stored.content), 'It comes from the Q3 plan.');
    assert.deepStrictEqual(events.map((e) => [e.kind, e.payload.commentId, e.payload.authorKind]), [['comment.created', stored.id, 'assistant']]);
    assert.ok(!JSON.stringify(events).includes('Q3'));

    const other = await seedThread();
    const foreign = await surface.postAnswer({ containerId: threadId, text: 'x', replyTo: other.ids[0] });
    assert.strictEqual((await store.getComment(threadId, foreign.messageId)).replyTo, null, 'a reply target outside the thread is dropped');
});

test('postAnswer reports stale for a resolved thread or a newer human comment, and nothing for a gone one', async () => {
    const resolved = await seedThread();
    await store.setStatus('p1', resolved.threadId, 'resolved', 'ann');
    assert.deepStrictEqual(await surface.postAnswer({ containerId: resolved.threadId, text: 'late' }), { stale: true });

    const busy = await seedThread({ comments: [['ann', 'Question?', []], ['bob', 'I can answer that.', []]] });
    assert.deepStrictEqual(await surface.postAnswer({ containerId: busy.threadId, text: 'AI answer', afterSeq: 1 }), { stale: true },
        'a person answered after the conversation the gate read');
    const fresh = await surface.postAnswer({ containerId: busy.threadId, text: 'AI answer', afterSeq: 2 });
    assert.ok(fresh.messageId, 'nothing newer: the answer is stored');

    assert.strictEqual(await surface.postAnswer({ containerId: 'nope', text: 'x' }), null);
    const moved = await seedThread({ targetId: 'nb-out' });
    assert.strictEqual(await surface.postAnswer({ containerId: moved.threadId, text: 'x' }), null);
    const open = await seedThread();
    assert.strictEqual(await surface.postAnswer({ containerId: open.threadId, text: '   ' }), null);
    assert.deepStrictEqual(events.map((e) => e.payload.commentId), [fresh.messageId], 'only the stored answer is announced');
});

test('registration is defensive, and the human notice carries ids only and never throws', async () => {
    assert.strictEqual(ensureCommentSurface({ engine: null }), false, 'no engine: nothing registered');
    assert.strictEqual(ensureCommentSurface({ engine: {} }), false, 'an engine of another shape');
    const registered = [];
    const engine = { registerSurface: (name, s) => registered.push([name, typeof s.loadContext, typeof s.postAnswer, s.lockType]) };
    assert.strictEqual(ensureCommentSurface({ engine, surface }), true);
    assert.deepStrictEqual(registered, [['comment', 'function', 'function', 'project_comment']]);
    assert.strictEqual(ensureCommentSurface({ engine: { registerSurface: () => { throw new Error('dup'); } } }), false);

    const seen = [];
    const notice = { threadId: 't1', commentId: 'c1', authorUserId: 'ann', orgId: 'org1', limitOrgId: 'org1', projectId: 'p1', explicit: true };
    assert.strictEqual(await notifyHumanComment(notice, { engine: { onHumanMessage: async (m) => { seen.push(m); } } }), true);
    assert.deepStrictEqual(seen, [{
        surface: 'comment', containerId: 't1', messageId: 'c1', authorUserId: 'ann', orgId: 'org1', limitOrgId: 'org1', projectId: 'p1', explicit: true,
    }]);
    const cancelled = [];
    assert.strictEqual(await cancelCommentThread('t1', { engine: { cancelContainer: async (...a) => { cancelled.push(a); } } }), true);
    assert.deepStrictEqual(cancelled, [['comment', 't1']]);
    assert.strictEqual(await cancelCommentThread('t1', { engine: { cancelContainer: async () => { throw new Error('down'); } } }), false);
    assert.strictEqual(await cancelCommentThread('t1', { engine: null }), false);
    assert.strictEqual(await notifyHumanComment(notice, { engine: { onHumanMessage: async () => { throw new Error('queue down'); } } }), false);
    assert.strictEqual(await notifyHumanComment(notice, { engine: null }), false);
});

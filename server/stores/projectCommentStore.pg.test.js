/**
 * project_comment_threads / project_comments against a real Postgres
 * (@electric-sql/pglite, in-process). The store is built with
 * makeProjectCommentStore over the PGlite handle: no module mocking.
 *
 * Proven:
 *   - the DDL runs twice without complaint (boot runs it on every start);
 *   - a thread starts with its first comment at seq 1, and seq stays gapless
 *     per thread, also for replies that race;
 *   - a retried clientThreadId / clientMsgId answers what exists instead of a
 *     copy, and the same id from another author is refused;
 *   - replyTo must point into the same thread; a reply reopens a resolved
 *     thread, an answer that requires an open thread is refused, and an
 *     answer older than a human comment is not stored;
 *   - a busy item: comments are capped per thread (the first and the latest,
 *     with a count of those left out), never by cutting whole threads off;
 *   - resolve/reopen report whether anything changed; the AI mode and the
 *     status are checked;
 *   - edit is author-only and not on a deleted comment; delete blanks the
 *     content and keeps the seq;
 *   - a thread is only found through its own project; deleting the project,
 *     the thread, or the item removes what hangs off it;
 *   - lookupTarget names the item and its project, and ignores templates and
 *     archived documents;
 *   - the data subject: counts per organisation, erasure blanks their
 *     comments and takes them out of other people's mentions.
 *
 * Run: cd server && node --test stores/projectCommentStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeProjectCommentStore, DDL } = require('./projectCommentStore');

const { pg, db } = pgliteDb();
const store = makeProjectCommentStore(db);

let n = 0;
const nextId = (p) => `${p}-${++n}`;

async function newThread(projectId, extra = {}) {
    const { comment = {}, ...rest } = extra;
    return store.createThread({
        id: nextId('thread'),
        projectId,
        targetType: 'notebook',
        targetId: 'nb1',
        anchor: 'sealed-anchor',
        createdBy: 'ann',
        ...rest,
        comment: { id: nextId('c'), content: 'sealed-first', ...comment },
    });
}

async function reply(projectId, threadId, authorUserId, extra = {}, opts) {
    return store.appendComment(projectId, threadId, {
        id: nextId('c'), authorKind: 'user', authorUserId, content: `sealed-${n}`, ...extra,
    }, opts);
}

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, organization_id TEXT);
        CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE TABLE project_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL);
        CREATE TABLE studio_documents (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'document', archived BOOLEAN NOT NULL DEFAULT FALSE
        );
    `);
    await pg.exec(DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES
        ('p1', 'p1', 'owner', 'org1'), ('p2', 'p2', 'owner', 'org1'), ('p3', 'p3', 'owner', 'org2')`);
});

after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
    const r = await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'project_comment%' ORDER BY table_name`);
    assert.deepStrictEqual(r.rows.map((x) => x.table_name), ['project_comment_threads', 'project_comments']);
});

test('a thread starts with its first comment, reachable through its own project only', async () => {
    const out = await newThread('p1', { aiMode: 'auto', comment: { mentions: ['bob'], mentionsAi: true } });
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.thread.projectId, 'p1');
    assert.strictEqual(out.thread.status, 'open');
    assert.strictEqual(out.thread.aiMode, 'auto');
    assert.strictEqual(out.thread.anchor, 'sealed-anchor');
    assert.strictEqual(out.thread.commentCount, 1);
    assert.strictEqual(out.thread.lastSeq, 1);
    assert.strictEqual(out.comment.seq, 1);
    assert.strictEqual(out.comment.authorUserId, 'ann');
    assert.strictEqual(out.comment.authorKind, 'user');
    assert.deepStrictEqual(out.comment.mentions, ['bob']);
    assert.strictEqual(out.comment.mentionsAi, true);

    assert.ok(await store.getThread('p1', out.thread.id));
    assert.strictEqual(await store.getThread('p2', out.thread.id), null, 'another project cannot reach the thread');
    assert.strictEqual((await store.getThreadById(out.thread.id)).id, out.thread.id);
    assert.strictEqual(await store.appendComment('p2', out.thread.id, { id: nextId('c'), authorUserId: 'ann', content: 'x' }), null);

    const general = await newThread('p1', { anchor: null });
    assert.strictEqual(general.thread.anchor, null, 'a comment on the whole item has no anchor');
    assert.strictEqual(general.thread.aiMode, 'mention', 'the default AI mode');
});

test('seq is gapless per thread, also when replies race', async () => {
    const { thread } = await newThread('p1');
    const other = await newThread('p1');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => reply('p1', thread.id, i % 2 ? 'ann' : 'bob')));
    const seqs = results.map((r) => r.comment.seq).sort((a, b) => a - b);
    assert.deepStrictEqual(seqs, [2, 3, 4, 5, 6, 7, 8, 9]);
    const again = await reply('p1', other.thread.id, 'ann');
    assert.strictEqual(again.comment.seq, 2, 'another thread counts on its own');
    const t = await store.getThread('p1', thread.id);
    assert.strictEqual(t.lastSeq, 9);
    assert.strictEqual(t.commentCount, 9);
    const listed = await store.listComments(thread.id, { limit: 3 });
    assert.deepStrictEqual(listed.map((c) => c.seq), [7, 8, 9], 'the latest ones, ascending');
});

test('a retried clientThreadId answers the thread that exists, another author is refused', async () => {
    const first = await newThread('p1', { clientThreadId: 'client-t1' });
    const retry = await newThread('p1', { clientThreadId: 'client-t1' });
    assert.strictEqual(retry.created, false);
    assert.strictEqual(retry.thread.id, first.thread.id);
    assert.strictEqual(retry.comment.id, first.comment.id);
    await assert.rejects(newThread('p1', { clientThreadId: 'client-t1', createdBy: 'bob' }), { code: 'CLIENT_ID_TAKEN' });
    const elsewhere = await newThread('p2', { clientThreadId: 'client-t1' });
    assert.strictEqual(elsewhere.created, true, 'the id is unique per project');
});

test('a retried clientMsgId answers the comment that exists, another author is refused', async () => {
    const { thread } = await newThread('p1');
    const a = await reply('p1', thread.id, 'ann', { clientMsgId: 'm-1' });
    const b = await reply('p1', thread.id, 'ann', { clientMsgId: 'm-1' });
    assert.strictEqual(a.created, true);
    assert.strictEqual(b.created, false);
    assert.strictEqual(b.comment.id, a.comment.id);
    await assert.rejects(reply('p1', thread.id, 'bob', { clientMsgId: 'm-1' }), { code: 'CLIENT_ID_TAKEN' });
    assert.strictEqual((await store.getThread('p1', thread.id)).commentCount, 2, 'no copy was stored');
});

test('replyTo must be a comment in the same thread', async () => {
    const one = await newThread('p1');
    const two = await newThread('p1');
    await assert.rejects(reply('p1', one.thread.id, 'ann', { replyTo: two.comment.id }), { code: 'REPLY_TARGET_NOT_FOUND' });
    const ok = await reply('p1', one.thread.id, 'ann', { replyTo: one.comment.id });
    assert.strictEqual(ok.comment.replyTo, one.comment.id);
});

test('resolve and reopen report a change once; a reply reopens, an answer needing an open thread is refused', async () => {
    const { thread } = await newThread('p1');
    const resolved = await store.setStatus('p1', thread.id, 'resolved', 'bob');
    assert.strictEqual(resolved.changed, true);
    assert.strictEqual(resolved.thread.status, 'resolved');
    assert.strictEqual(resolved.thread.resolvedBy, 'bob');
    assert.ok(resolved.thread.resolvedAt);
    assert.strictEqual((await store.setStatus('p1', thread.id, 'resolved', 'ann')).changed, false);
    assert.strictEqual(await store.setStatus('p2', thread.id, 'open', 'ann'), null, 'not through another project');

    await assert.rejects(
        reply('p1', thread.id, null, { authorKind: 'assistant', authorUserId: null }, { requireOpen: true }),
        { code: 'THREAD_RESOLVED' },
    );
    const back = await reply('p1', thread.id, 'ann');
    assert.strictEqual(back.reopened, true);
    const t = await store.getThread('p1', thread.id);
    assert.strictEqual(t.status, 'open');
    assert.strictEqual(t.resolvedBy, null);

    const reopened = await store.setStatus('p1', thread.id, 'open', 'ann');
    assert.strictEqual(reopened.changed, false);
    await assert.rejects(store.setStatus('p1', thread.id, 'closed', 'ann'), { code: 'INVALID_STATUS' });
});

test('an answer that would come after a newer human comment is not stored', async () => {
    const { thread } = await newThread('p1');
    await reply('p1', thread.id, 'bob');
    const ai = { id: nextId('c'), authorKind: 'assistant', authorUserId: null, content: 'sealed-ai' };
    const stale = await store.appendComment('p1', thread.id, ai, { requireOpen: true, staleAfterSeq: 1 });
    assert.deepStrictEqual(stale, { comment: null, created: false, reopened: false, stale: true });
    assert.strictEqual((await store.getThread('p1', thread.id)).lastSeq, 2, 'nothing was stored');
    const fresh = await store.appendComment('p1', thread.id, ai, { requireOpen: true, staleAfterSeq: 2 });
    assert.strictEqual(fresh.stale, false);
    assert.strictEqual(fresh.comment.seq, 3);
    const afterAi = await store.appendComment('p1', thread.id, { ...ai, id: nextId('c') }, { staleAfterSeq: 2 });
    assert.strictEqual(afterAi.stale, false, 'the AI\'s own comments never make an answer stale');
});

test('the automatic-answer pause is set and lifted', async () => {
    const { thread } = await newThread('p1');
    assert.strictEqual(thread.autoPausedUntil, null);
    const until = new Date('2026-10-01T10:00:00Z');
    assert.strictEqual((await store.setAutoPausedUntil(thread.id, until)).autoPausedUntil, until.toISOString());
    assert.strictEqual((await store.getThread('p1', thread.id)).autoPausedUntil, until.toISOString());
    assert.strictEqual((await store.setAutoPausedUntil(thread.id, null)).autoPausedUntil, null);
    assert.strictEqual(await store.setAutoPausedUntil('nope', until), null);
});

test('the AI mode changes only to a known mode', async () => {
    const { thread } = await newThread('p1');
    assert.strictEqual((await store.setAiMode('p1', thread.id, 'off')).aiMode, 'off');
    assert.strictEqual(await store.setAiMode('p2', thread.id, 'auto'), null);
    await assert.rejects(store.setAiMode('p1', thread.id, 'always'), { code: 'INVALID_AI_MODE' });
    await assert.rejects(newThread('p1', { aiMode: 'loud' }), { code: 'INVALID_AI_MODE' });
    await assert.rejects(newThread('p1', { targetType: 'meeting' }), { code: 'INVALID_TARGET_TYPE' });
});

test('edit is the author\'s own; delete blanks the content and keeps the seq', async () => {
    const { thread, comment } = await newThread('p1');
    assert.strictEqual(await store.editComment(thread.id, comment.id, 'bob', { content: 'hijack' }), null);
    const edited = await store.editComment(thread.id, comment.id, 'ann', { content: 'sealed-edit', mentions: ['cy'], mentionsAi: true });
    assert.strictEqual(edited.content, 'sealed-edit');
    assert.deepStrictEqual(edited.mentions, ['cy']);
    assert.ok(edited.editedAt);

    const deleted = await store.softDeleteComment(thread.id, comment.id);
    assert.strictEqual(deleted.content, '');
    assert.deepStrictEqual(deleted.mentions, []);
    assert.strictEqual(deleted.seq, 1);
    assert.ok(deleted.deletedAt);
    assert.strictEqual(await store.softDeleteComment(thread.id, comment.id), null, 'once');
    assert.strictEqual(await store.editComment(thread.id, comment.id, 'ann', { content: 'again' }), null, 'no edit after delete');
    assert.strictEqual((await store.getThread('p1', thread.id)).commentCount, 0);
    const next = await reply('p1', thread.id, 'ann');
    assert.strictEqual(next.comment.seq, 2, 'the deleted comment keeps its number');
});

test('listing is per item, with the comments of each thread and a status filter', async () => {
    const a = await newThread('p1', { targetType: 'document', targetId: 'doc-list' });
    const b = await newThread('p1', { targetType: 'document', targetId: 'doc-list' });
    await newThread('p1', { targetType: 'document', targetId: 'doc-other' });
    await newThread('p2', { targetType: 'document', targetId: 'doc-list' });
    await reply('p1', a.thread.id, 'bob');
    await store.setStatus('p1', b.thread.id, 'resolved', 'ann');

    const all = await store.listThreads('p1', { targetType: 'document', targetId: 'doc-list' });
    assert.deepStrictEqual(all.map((t) => t.id), [a.thread.id, b.thread.id]);
    assert.deepStrictEqual(all[0].comments.map((c) => c.seq), [1, 2]);
    assert.deepStrictEqual(all[1].comments.map((c) => c.seq), [1]);
    const open = await store.listThreads('p1', { targetType: 'document', targetId: 'doc-list', status: 'open' });
    assert.deepStrictEqual(open.map((t) => t.id), [a.thread.id]);
    const resolved = await store.listThreads('p1', { targetType: 'document', targetId: 'doc-list', status: 'resolved' });
    assert.deepStrictEqual(resolved.map((t) => t.id), [b.thread.id]);
    assert.deepStrictEqual(await store.listThreads('p1', { targetType: 'notebook', targetId: 'doc-list' }), []);
});

test('a busy item keeps every thread readable: its first comment, its latest, and how many are left out', async () => {
    // A list answer of 30 comments over three threads: 10 each at most.
    const small = makeProjectCommentStore(db, { maxCommentsListed: 30 });
    const thread = (id) => newThread('p1', { id, targetType: 'document', targetId: 'doc-busy' });
    // Thread ids sort busy first: a cut in id order would starve the others.
    const busy = await thread('a-busy');
    for (let i = 0; i < 39; i++) await reply('p1', busy.thread.id, i % 2 ? 'bob' : 'ann');
    const short = await thread('z-short');
    for (let i = 0; i < 2; i++) await reply('p1', short.thread.id, 'bob');
    const last = await thread('zz-last');
    for (let i = 0; i < 4; i++) await reply('p1', last.thread.id, 'ann');

    const listed = await small.listThreads('p1', { targetType: 'document', targetId: 'doc-busy' });
    const byId = new Map(listed.map((t) => [t.id, t]));
    const seqs = (id) => byId.get(id).comments.map((c) => c.seq);
    assert.deepStrictEqual(seqs('a-busy'), [1, 32, 33, 34, 35, 36, 37, 38, 39, 40], 'the question that started it, then the latest');
    assert.strictEqual(byId.get('a-busy').omittedComments, 30);
    assert.strictEqual(byId.get('a-busy').commentCount, 40);
    assert.deepStrictEqual(seqs('z-short'), [1, 2, 3]);
    assert.deepStrictEqual(seqs('zz-last'), [1, 2, 3, 4, 5], 'the thread that sorts last keeps all of its comments');
    assert.strictEqual(byId.get('zz-last').omittedComments, 0);
    assert.ok(listed.reduce((sum, t) => sum + t.comments.length, 0) <= 30, 'the answer stays within its cap');

    // The default cap: few threads on an item are listed whole.
    const whole = await store.listThreads('p1', { targetType: 'document', targetId: 'doc-busy' });
    assert.strictEqual(whole.find((t) => t.id === 'a-busy').comments.length, 40);
});

test('deleting a thread, an item or a project removes what hangs off it', async () => {
    await pg.query(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('gone', 'gone', 'owner', 'org1')`);
    const t1 = await newThread('gone', { targetId: 'nb-gone' });
    await reply('gone', t1.thread.id, 'bob');
    const t2 = await newThread('p1', { targetId: 'nb-del' });
    const t3 = await newThread('p2', { targetId: 'nb-del' });
    const t4 = await newThread('p1', { targetId: 'nb-detach' });

    assert.strictEqual(await store.deleteThread('p2', t2.thread.id), false, 'not through another project');
    assert.strictEqual(await store.deleteForTargetInProject('p2', 'notebook', 'nb-detach'), 0);
    assert.strictEqual(await store.deleteForTargetInProject('p1', 'notebook', 'nb-detach'), 1);
    assert.strictEqual(await store.getThread('p1', t4.thread.id), null);
    assert.strictEqual(await store.deleteForTarget('notebook', 'nb-del'), 2);
    assert.strictEqual(await store.getThread('p1', t2.thread.id), null);
    assert.strictEqual(await store.getThread('p2', t3.thread.id), null);

    await pg.query(`DELETE FROM projects WHERE id = 'gone'`);
    const left = await pg.query('SELECT COUNT(*)::int AS n FROM project_comments WHERE thread_id = $1', [t1.thread.id]);
    assert.strictEqual(left.rows[0].n, 0, 'the comments cascade with the project');
    assert.strictEqual(await store.getThreadById(t1.thread.id), null);
});

test('lookupTarget names the item and its project, and skips templates and archived documents', async () => {
    await pg.query(`INSERT INTO notebooks (id, name, project_id) VALUES ('nb-look', 'Research', 'p1'), ('nb-free', 'Mine', NULL)`);
    await pg.query(`INSERT INTO studio_documents (id, name, project_id, kind, archived) VALUES
        ('doc-look', 'Proposal', 'p1', 'document', FALSE),
        ('doc-tpl', 'Template', 'p1', 'template', FALSE),
        ('doc-old', 'Old', 'p1', 'document', TRUE)`);
    assert.deepStrictEqual(await store.lookupTarget('notebook', 'nb-look'), { id: 'nb-look', projectId: 'p1', name: 'Research' });
    assert.deepStrictEqual(await store.lookupTarget('notebook', 'nb-free'), { id: 'nb-free', projectId: null, name: 'Mine' });
    assert.deepStrictEqual(await store.lookupTarget('document', 'doc-look'), { id: 'doc-look', projectId: 'p1', name: 'Proposal' });
    assert.strictEqual(await store.lookupTarget('document', 'doc-tpl'), null);
    assert.strictEqual(await store.lookupTarget('document', 'doc-old'), null);
    assert.strictEqual(await store.lookupTarget('document', 'nb-look'), null);
    assert.strictEqual(await store.lookupTarget('meeting', 'x'), null);
});

test('a thread can be on a task, whose name is left for the reader to open; a table from before still takes the new type', async () => {
    await pg.query(`INSERT INTO project_tasks (id, project_id, title) VALUES ('task-1', 'p1', 'sealed-title')`);
    assert.deepStrictEqual(await store.lookupTarget('task', 'task-1'), { id: 'task-1', projectId: 'p1', name: '' });
    const out = await newThread('p1', { targetType: 'task', targetId: 'task-1', anchor: null });
    assert.strictEqual(out.thread.targetType, 'task');
    assert.strictEqual(await store.deleteForTarget('task', 'task-1'), 1);
    // A table made when only notebooks and documents were allowed: the boot DDL widens it, once.
    await pg.exec(`ALTER TABLE project_comment_threads DROP CONSTRAINT project_comment_threads_target_type_check;
                   ALTER TABLE project_comment_threads ADD CONSTRAINT project_comment_threads_target_type_check CHECK (target_type IN ('notebook', 'document'));`);
    await assert.rejects(newThread('p1', { targetType: 'task', targetId: 'task-1', anchor: null }));
    await pg.exec(DDL);
    assert.ok((await newThread('p1', { targetType: 'task', targetId: 'task-1', anchor: null })).created);
});

test('the data subject: a count per organisation, and erasure blanks their comments and mentions', async () => {
    const { thread } = await newThread('p1', { createdBy: 'zed', targetId: 'nb-dsr' });
    await reply('p1', thread.id, 'zed');
    await reply('p1', thread.id, 'amy', { mentions: ['zed', 'bob'] });
    const other = await newThread('p3', { createdBy: 'zed', targetId: 'nb-dsr' });
    assert.strictEqual(await store.countCommentsByAuthor('zed', { organizationId: 'org1' }), 2);
    assert.strictEqual(await store.countCommentsByAuthor('zed', { organizationId: 'org2' }), 1);
    assert.strictEqual(await store.countCommentsByAuthor('zed', { organizationId: '' }), 0);

    const erased = await store.eraseAuthor('zed');
    assert.deepStrictEqual(erased, { comments: 3, mentions: 1 });
    const rows = (await store.listThreads('p1', { targetType: 'notebook', targetId: 'nb-dsr' }))[0].comments;
    assert.deepStrictEqual(rows.map((c) => [c.authorUserId, c.content, !!c.deletedAt]), [
        ['zed', '', true], ['zed', '', true], ['amy', rows[2].content, false],
    ]);
    assert.deepStrictEqual(rows[2].mentions, ['bob'], 'taken out of the mention list');
    assert.strictEqual((await store.getThread('p1', thread.id)).commentCount, 1);
    assert.strictEqual((await store.getThread('p3', other.thread.id)).commentCount, 0);
    assert.deepStrictEqual(await store.eraseAuthor(''), { comments: 0, mentions: 0 });
});

/**
 * project_chats / project_chat_messages / project_chat_reads against a real
 * Postgres (@electric-sql/pglite, in-process). The store is built with
 * makeProjectChatStore over the PGlite handle: no module mocking.
 *
 * Proven:
 *   - the DDL runs twice without complaint (boot runs it on every start);
 *   - seq is gapless per chat, also for posts that race, and independent
 *     between chats;
 *   - a retried clientMsgId answers the existing message instead of a copy,
 *     and the same id from another author is refused;
 *   - replyTo must point into the same chat;
 *   - unread counts other people's messages after the read marker, never one's
 *     own, and the marker never moves backwards or past the end;
 *   - paging after/before/latest with hasMore;
 *   - edit is author-only and not on a deleted message; delete blanks the
 *     content and keeps the seq;
 *   - a chat is only found through its own project, and deleting the project
 *     removes chats, messages and read markers;
 *   - a title taken from a message goes with that message (delete, erasure of
 *     its author) and follows an edit; a rename keeps the chosen name.
 *
 * Run: cd server && node --test stores/projectChatStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeProjectChatStore, DDL } = require('./projectChatStore');

const { pg, db } = pgliteDb();
const store = makeProjectChatStore(db);

let n = 0;
const nextId = (p) => `${p}-${++n}`;

async function seedProject(id) {
    await pg.query('INSERT INTO projects (id, name, owner_id) VALUES ($1, $1, $2)', [id, 'owner']);
}

async function newChat(projectId, extra = {}) {
    return store.createChat({ id: nextId('chat'), projectId, title: 'sealed-title', createdBy: 'ann', ...extra });
}

async function post(projectId, chatId, authorUserId, extra = {}) {
    return store.appendMessage({
        id: nextId('msg'), projectId, chatId, authorKind: 'user', authorUserId, content: `sealed-${n}`, ...extra,
    });
}

before(async () => {
    await pg.exec(`
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_id TEXT NOT NULL
        );
    `);
    await pg.exec(DDL);
    await seedProject('p1');
    await seedProject('p2');
});

after(async () => { await pg.close(); });

test('the schema can be created again without changes', async () => {
    await pg.exec(DDL);
    const r = await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'project_chat%' ORDER BY table_name`);
    assert.deepStrictEqual(r.rows.map((x) => x.table_name), ['project_chat_messages', 'project_chat_reads', 'project_chats']);
});

test('create and read a chat through its own project only', async () => {
    const chat = await newChat('p1', { aiMode: 'always', agentId: 'agent-1' });
    assert.strictEqual(chat.projectId, 'p1');
    assert.strictEqual(chat.aiMode, 'always');
    assert.strictEqual(chat.agentId, 'agent-1');
    assert.strictEqual(chat.archived, false);
    assert.strictEqual(chat.lastSeq, 0);
    assert.ok((await store.getChat('p1', chat.id)));
    assert.strictEqual(await store.getChat('p2', chat.id), null, 'another project cannot reach the chat');
    await assert.rejects(() => store.createChat({ id: nextId('chat'), projectId: 'p1', title: 't', createdBy: 'ann', aiMode: 'sometimes' }), { code: 'INVALID_AI_MODE' });
});

test('seq is gapless per chat, also when posts race', async () => {
    const a = await newChat('p1');
    const b = await newChat('p1');
    const results = await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => post('p1', a.id, i % 2 ? 'ann' : 'bob')),
        ...Array.from({ length: 3 }, () => post('p1', b.id, 'ann')),
    ]);
    assert.ok(results.every((r) => r && r.created));
    const seqsA = (await store.listMessages(a.id, { limit: 200 })).messages.map((m) => m.seq);
    const seqsB = (await store.listMessages(b.id, { limit: 200 })).messages.map((m) => m.seq);
    assert.deepStrictEqual(seqsA, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.deepStrictEqual(seqsB, [1, 2, 3]);
    const chat = await store.getChat('p1', a.id);
    assert.strictEqual(chat.lastSeq, 10);
    assert.strictEqual(chat.messageCount, 10);
    assert.ok(chat.lastMessageAt);
});

test('posting into a chat of another project finds nothing', async () => {
    const chat = await newChat('p1');
    assert.strictEqual(await post('p2', chat.id, 'ann'), null);
    assert.strictEqual((await store.listMessages(chat.id)).messages.length, 0);
});

test('a retried clientMsgId returns the existing message; another author may not reuse it', async () => {
    const chat = await newChat('p1');
    const first = await post('p1', chat.id, 'ann', { clientMsgId: 'c-1' });
    const again = await post('p1', chat.id, 'ann', { clientMsgId: 'c-1' });
    assert.strictEqual(first.created, true);
    assert.strictEqual(again.created, false);
    assert.strictEqual(again.message.id, first.message.id);
    assert.strictEqual(again.message.seq, first.message.seq);
    await assert.rejects(() => post('p1', chat.id, 'bob', { clientMsgId: 'c-1' }), { code: 'CLIENT_MSG_ID_TAKEN' });
    const { messages } = await store.listMessages(chat.id);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual((await store.getChat('p1', chat.id)).messageCount, 1);
});

test('replyTo must be a message in the same chat', async () => {
    const chat = await newChat('p1');
    const other = await newChat('p1');
    const inOther = await post('p1', other.id, 'ann');
    await assert.rejects(() => post('p1', chat.id, 'ann', { replyTo: inOther.message.id }), { code: 'REPLY_TARGET_NOT_FOUND' });
    const target = await post('p1', chat.id, 'ann');
    const reply = await post('p1', chat.id, 'bob', { replyTo: target.message.id, mentions: ['ann'] });
    assert.strictEqual(reply.message.replyTo, target.message.id);
    assert.deepStrictEqual(reply.message.mentions, ['ann']);
});

test('unread counts other people\'s messages after the read marker', async () => {
    const chat = await newChat('p1');
    await post('p1', chat.id, 'ann');
    await post('p1', chat.id, 'bob');
    await store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed-ai' });
    const forAnn = (await store.listChats('p1', { userId: 'ann' })).find((c) => c.id === chat.id);
    const forBob = (await store.listChats('p1', { userId: 'bob' })).find((c) => c.id === chat.id);
    const forCai = (await store.listChats('p1', { userId: 'cai' })).find((c) => c.id === chat.id);
    // Ann read up to her own post (seq 1); Bob's post and the answer are new.
    assert.strictEqual(forAnn.unread, 2);
    // Bob's own post moved his marker to 2; only the answer is new.
    assert.strictEqual(forBob.unread, 1);
    assert.strictEqual(forCai.unread, 3);
    assert.deepStrictEqual(
        { authorKind: forCai.lastMessage.authorKind, authorUserId: forCai.lastMessage.authorUserId, content: forCai.lastMessage.content },
        { authorKind: 'assistant', authorUserId: null, content: 'sealed-ai' },
    );

    assert.strictEqual(await store.markRead(chat.id, 'cai', 2), 2);
    assert.strictEqual((await store.listChats('p1', { userId: 'cai' })).find((c) => c.id === chat.id).unread, 1);
    assert.strictEqual(await store.markRead(chat.id, 'cai', 1), 2, 'the marker never moves back');
    assert.strictEqual(await store.markRead(chat.id, 'cai', 999), 3, 'the marker stops at the last message');
    assert.strictEqual((await store.listChats('p1', { userId: 'cai' })).find((c) => c.id === chat.id).unread, 0);
    assert.strictEqual(await store.markRead('no-such-chat', 'cai', 1), null);
});

test('list is per project, split by archived, latest activity first', async () => {
    const quiet = await newChat('p2');
    const busy = await newChat('p2');
    await post('p2', busy.id, 'ann');
    const archived = await newChat('p2');
    await store.updateChat('p2', archived.id, { archived: true });
    const open = await store.listChats('p2', { userId: 'ann' });
    assert.deepStrictEqual(open.map((c) => c.id), [busy.id, quiet.id]);
    assert.strictEqual(open[1].lastMessage, null);
    const done = await store.listChats('p2', { userId: 'ann', archived: true });
    assert.deepStrictEqual(done.map((c) => c.id), [archived.id]);
});

test('update changes only what was asked and clears the agent on null', async () => {
    const chat = await newChat('p1', { agentId: 'agent-1' });
    const renamed = await store.updateChat('p1', chat.id, { title: 'sealed-2' });
    assert.strictEqual(renamed.title, 'sealed-2');
    assert.strictEqual(renamed.agentId, 'agent-1');
    const cleared = await store.updateChat('p1', chat.id, { agentId: null, aiMode: 'off' });
    assert.strictEqual(cleared.agentId, null);
    assert.strictEqual(cleared.aiMode, 'off');
    assert.strictEqual(await store.updateChat('p2', chat.id, { title: 'x' }), null, 'another project cannot change it');
    await assert.rejects(() => store.updateChat('p1', chat.id, { aiMode: 'loud' }), { code: 'INVALID_AI_MODE' });
});

test('paging: latest, before, after and between', async () => {
    const chat = await newChat('p1');
    for (let i = 0; i < 7; i++) await post('p1', chat.id, 'ann');
    const latest = await store.listMessages(chat.id, { limit: 3 });
    assert.deepStrictEqual(latest.messages.map((m) => m.seq), [5, 6, 7]);
    assert.strictEqual(latest.hasMore, true);
    const older = await store.listMessages(chat.id, { before: 5, limit: 3 });
    assert.deepStrictEqual(older.messages.map((m) => m.seq), [2, 3, 4]);
    assert.strictEqual(older.hasMore, true);
    const oldest = await store.listMessages(chat.id, { before: 2, limit: 3 });
    assert.deepStrictEqual(oldest.messages.map((m) => m.seq), [1]);
    assert.strictEqual(oldest.hasMore, false);
    const newer = await store.listMessages(chat.id, { after: 4, limit: 2 });
    assert.deepStrictEqual(newer.messages.map((m) => m.seq), [5, 6]);
    assert.strictEqual(newer.hasMore, true);
    const tail = await store.listMessages(chat.id, { after: 6, limit: 2 });
    assert.deepStrictEqual(tail.messages.map((m) => m.seq), [7]);
    assert.strictEqual(tail.hasMore, false);
    const between = await store.listMessages(chat.id, { after: 2, before: 5 });
    assert.deepStrictEqual(between.messages.map((m) => m.seq), [3, 4]);
});

test('edit is the author\'s own, not-deleted message; delete blanks it and keeps the seq', async () => {
    const chat = await newChat('p1');
    const { message } = await post('p1', chat.id, 'ann', { mentions: ['bob'] });
    await post('p1', chat.id, 'bob');
    assert.strictEqual(await store.editMessage(chat.id, message.id, 'bob', 'sealed-bob'), null, 'not the author');
    const edited = await store.editMessage(chat.id, message.id, 'ann', 'sealed-edit');
    assert.strictEqual(edited.content, 'sealed-edit');
    assert.ok(edited.editedAt);

    const deleted = await store.softDeleteMessage(chat.id, message.id);
    assert.strictEqual(deleted.content, '');
    assert.deepStrictEqual(deleted.mentions, []);
    assert.ok(deleted.deletedAt);
    assert.strictEqual(deleted.seq, 1);
    assert.strictEqual(await store.softDeleteMessage(chat.id, message.id), null, 'already deleted');
    assert.strictEqual(await store.editMessage(chat.id, message.id, 'ann', 'sealed-again'), null, 'a deleted message cannot be edited');
    const { messages } = await store.listMessages(chat.id);
    assert.deepStrictEqual(messages.map((m) => m.seq), [1, 2]);
    assert.strictEqual((await store.getChat('p1', chat.id)).messageCount, 1);
    const stored = await pg.query('SELECT content FROM project_chat_messages WHERE id = $1', [message.id]);
    assert.strictEqual(stored.rows[0].content, '', 'the ciphertext is gone, not just hidden');
});

test('assistant messages need no author; user messages do', async () => {
    const chat = await newChat('p1');
    await assert.rejects(() => store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'user', content: 'x' }));
    const ai = await store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', agentId: 'agent-9', content: 'x' });
    assert.strictEqual(ai.message.authorKind, 'assistant');
    assert.strictEqual(ai.message.agentId, 'agent-9');
});

test('deleting the chat or the project removes everything under it', async () => {
    const chat = await newChat('p1');
    await post('p1', chat.id, 'ann');
    await store.markRead(chat.id, 'bob', 1);
    assert.strictEqual(await store.deleteChat('p2', chat.id), false, 'another project cannot delete it');
    assert.strictEqual(await store.deleteChat('p1', chat.id), true);
    const left = await pg.query('SELECT (SELECT COUNT(*) FROM project_chat_messages WHERE chat_id = $1)::int AS m, (SELECT COUNT(*) FROM project_chat_reads WHERE chat_id = $1)::int AS r', [chat.id]);
    assert.deepStrictEqual(left.rows[0], { m: 0, r: 0 });

    await seedProject('p-gone');
    const doomed = await newChat('p-gone');
    await post('p-gone', doomed.id, 'ann');
    await store.markRead(doomed.id, 'bob', 1);
    await pg.query('DELETE FROM projects WHERE id = $1', ['p-gone']);
    const after = await pg.query(`SELECT
        (SELECT COUNT(*) FROM project_chats WHERE project_id = 'p-gone')::int AS c,
        (SELECT COUNT(*) FROM project_chat_messages WHERE project_id = 'p-gone')::int AS m,
        (SELECT COUNT(*) FROM project_chat_reads WHERE chat_id = $1)::int AS r`, [doomed.id]);
    assert.deepStrictEqual(after.rows[0], { c: 0, m: 0, r: 0 });
});

// ── The data subject ────────────────────────────────────────────────────

test('a person\'s messages are counted within one organisation only', async () => {
    await pg.exec(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT ''`);
    await pg.query(`INSERT INTO projects (id, name, owner_id, organization_id) VALUES ('p-org-a', 'A', 'owner', 'org-a'), ('p-org-b', 'B', 'owner', 'org-b')`);
    const inA = await newChat('p-org-a');
    const inB = await newChat('p-org-b');
    await post('p-org-a', inA.id, 'dora');
    const gone = await post('p-org-a', inA.id, 'dora');
    await post('p-org-a', inA.id, 'eve');
    await post('p-org-b', inB.id, 'dora');
    await store.softDeleteMessage(inA.id, gone.message.id);

    // The deleted one still says who wrote it and when.
    assert.strictEqual(await store.countMessagesByAuthor('dora', { organizationId: 'org-a' }), 2);
    assert.strictEqual(await store.countMessagesByAuthor('dora', { organizationId: 'org-b' }), 1);
    assert.strictEqual(await store.countMessagesByAuthor('dora', { organizationId: 'org-c' }), 0);
    assert.strictEqual(await store.countMessagesByAuthor('dora', { organizationId: '' }), 0, 'no org, no count');
});

test('erasing a deleted account blanks what they wrote and keeps everybody else\'s', async () => {
    await seedProject('p-erase');
    const chat = await newChat('p-erase');
    await post('p-erase', chat.id, 'frank', { mentions: ['gina'] });
    await post('p-erase', chat.id, 'gina');
    await post('p-erase', chat.id, 'frank');
    await store.markRead(chat.id, 'frank', 3);
    await store.markRead(chat.id, 'gina', 3);

    const erased = await store.eraseAuthor('frank');
    assert.deepStrictEqual(erased, { messages: 2, reads: 1, titles: 0 });

    const rows = (await pg.query('SELECT seq, author_user_id, content, mentions, deleted_at FROM project_chat_messages WHERE chat_id = $1 ORDER BY seq', [chat.id])).rows;
    assert.deepStrictEqual(rows.map(r => r.seq).map(Number), [1, 2, 3], 'the seq stays gapless');
    for (const r of rows.filter(x => x.author_user_id === 'frank')) {
        assert.strictEqual(r.content, '');
        assert.deepStrictEqual(r.mentions, []);
        assert.ok(r.deleted_at);
    }
    assert.notStrictEqual(rows[1].content, '', 'a colleague\'s message is untouched');
    const counted = (await pg.query('SELECT message_count FROM project_chats WHERE id = $1', [chat.id])).rows[0];
    assert.strictEqual(Number(counted.message_count), 1);
    const reads = (await pg.query('SELECT user_id FROM project_chat_reads WHERE chat_id = $1', [chat.id])).rows;
    assert.deepStrictEqual(reads.map(r => r.user_id), ['gina']);

    assert.deepStrictEqual(await store.eraseAuthor('frank'), { messages: 0, reads: 0, titles: 0 }, 'running it again changes nothing');
});

test('a title taken from a message goes when the message is deleted or its author erased, and follows an edit', async () => {
    await seedProject('p-titles');
    const titleOf = async (id) => (await pg.query('SELECT title, title_from_message_id FROM project_chats WHERE id = $1', [id])).rows[0];

    // Deleted by its author: the title is reset in the same step, and said so.
    const byDelete = await newChat('p-titles', { title: 'sealed-from-first', titleFromMessageId: 'first-a' });
    assert.strictEqual(byDelete.titleFromMessageId, 'first-a');
    await post('p-titles', byDelete.id, 'ann', { id: 'first-a' });
    const later = await post('p-titles', byDelete.id, 'bob');
    const other = await store.softDeleteMessage(byDelete.id, later.message.id);
    assert.strictEqual(other.titleReset, false, 'another message leaves the title alone');
    assert.strictEqual((await titleOf(byDelete.id)).title, 'sealed-from-first');
    const first = await store.softDeleteMessage(byDelete.id, 'first-a');
    assert.strictEqual(first.titleReset, true);
    assert.deepStrictEqual(await titleOf(byDelete.id), { title: '', title_from_message_id: null });

    // Edited: the route seals a new title from the new words.
    const byEdit = await newChat('p-titles', { title: 'sealed-old-words', titleFromMessageId: 'first-b' });
    await post('p-titles', byEdit.id, 'ann', { id: 'first-b' });
    assert.strictEqual(await store.retitleFromMessage(byEdit.id, 'someone-else', 'sealed-x'), false);
    assert.strictEqual(await store.retitleFromMessage(byEdit.id, 'first-b', 'sealed-new-words'), true);
    assert.strictEqual((await titleOf(byEdit.id)).title, 'sealed-new-words');

    // Renamed: a chosen name is no longer the message's, so nothing resets it later.
    const renamed = await newChat('p-titles', { title: 'sealed-derived', titleFromMessageId: 'first-c' });
    await post('p-titles', renamed.id, 'ann', { id: 'first-c' });
    await store.updateChat('p-titles', renamed.id, { title: 'sealed-chosen' });
    assert.strictEqual((await store.softDeleteMessage(renamed.id, 'first-c')).titleReset, false);
    assert.deepStrictEqual(await titleOf(renamed.id), { title: 'sealed-chosen', title_from_message_id: null });

    // The author's account is erased: their words leave the title too.
    const byErase = await newChat('p-titles', { title: 'sealed-hanna-words', titleFromMessageId: 'first-d', createdBy: 'hanna' });
    await post('p-titles', byErase.id, 'hanna', { id: 'first-d' });
    const named = await newChat('p-titles', { title: 'sealed-chosen-by-hanna', createdBy: 'hanna' });
    await post('p-titles', named.id, 'hanna');
    assert.deepStrictEqual(await store.eraseAuthor('hanna'), { messages: 2, reads: 2, titles: 1 });
    assert.deepStrictEqual(await titleOf(byErase.id), { title: '', title_from_message_id: null });
    assert.strictEqual((await titleOf(named.id)).title, 'sealed-chosen-by-hanna', 'a title they typed is the project\'s');
});

test('a thread reply hangs off a main-conversation message, never off another reply', async () => {
    const chat = await newChat('p1');
    const root = (await post('p1', chat.id, 'ann')).message;
    const reply = (await post('p1', chat.id, 'ben', { threadId: root.id })).message;
    assert.strictEqual(reply.threadId, root.id);
    assert.strictEqual(root.threadId, null);
    await assert.rejects(post('p1', chat.id, 'ann', { threadId: reply.id }), { code: 'THREAD_NOT_FOUND' });
    const other = await newChat('p1');
    await assert.rejects(post('p1', other.id, 'ann', { threadId: root.id }), { code: 'THREAD_NOT_FOUND' });
});

test('tagged documents and notebooks are kept as kind and id only, and go with a deleted message', async () => {
    const chat = await newChat('p1');
    const m = (await post('p1', chat.id, 'ann', { refs: [{ kind: 'document', id: 'd1' }, { kind: 'notebook', id: 'n1' }] })).message;
    assert.deepStrictEqual(m.refs, [{ kind: 'document', id: 'd1' }, { kind: 'notebook', id: 'n1' }]);
    await store.softDeleteMessage(chat.id, m.id);
    assert.deepStrictEqual((await store.getMessage(chat.id, m.id)).refs, []);
});

test('an answer carries how it was made: tier and a count of replaced values, allow-listed', async () => {
    const chat = await newChat('p1');
    const saved = await store.appendMessage({
        id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed',
        aiMeta: { tier: 'pro', requestedTier: 'auto', redacted: 2, categories: ['EMAIL'], value: 'a@b.c' },
    });
    assert.deepStrictEqual(saved.message.aiMeta, { tier: 'pro', requestedTier: 'auto', redacted: 2, categories: ['EMAIL'] });
    const human = (await post('p1', chat.id, 'ann', { aiMeta: { tier: 'pro' } })).message;
    assert.strictEqual(human.aiMeta, null);
});

test('editing a message drops the trace of the answers to it: it holds the old words', async () => {
    const chat = await newChat('p1');
    const ask = (await post('p1', chat.id, 'ann')).message;
    const answer = (await store.appendMessage({
        id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed', replyTo: ask.id,
        aiMeta: { tier: 'fast', redacted: 1 }, aiTrace: 'sealed-trace',
    })).message;
    assert.strictEqual(answer.aiTrace, 'sealed-trace');
    await store.editMessage(chat.id, ask.id, 'bob', 'sealed-not-the-author');
    assert.strictEqual((await store.getMessage(chat.id, answer.id)).aiTrace, 'sealed-trace', 'a refused edit changes nothing');
    await store.editMessage(chat.id, ask.id, 'ann', 'sealed-edit');
    assert.strictEqual((await store.getMessage(chat.id, answer.id)).aiTrace, null);
});

test('the trace of an answer goes with the message it answered, or with the answer', async () => {
    const chat = await newChat('p1');
    const ask = (await post('p1', chat.id, 'ann')).message;
    const answer = async () => (await store.appendMessage({
        id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed', replyTo: ask.id,
        aiMeta: { tier: 'fast', redacted: 1 }, aiTrace: 'sealed-trace',
    })).message;
    const a1 = await answer();
    assert.strictEqual(a1.aiTrace, 'sealed-trace');
    const human = (await post('p1', chat.id, 'ben', { aiTrace: 'sneaky' })).message;
    assert.strictEqual(human.aiTrace, null, 'only an answer has one');
    await store.softDeleteMessage(chat.id, ask.id);
    assert.strictEqual((await store.getMessage(chat.id, a1.id)).aiTrace, null, 'the asking message is gone');
    const ask2 = (await post('p1', chat.id, 'erika')).message;
    const a2 = (await store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed', replyTo: ask2.id, aiTrace: 'sealed-2' })).message;
    await store.eraseAuthor('erika');
    assert.strictEqual((await store.getMessage(chat.id, a2.id)).aiTrace, null, 'their account was erased');
    const a3 = (await store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed', aiTrace: 'sealed-3' })).message;
    await store.softDeleteMessage(chat.id, a3.id);
    assert.strictEqual((await store.getMessage(chat.id, a3.id)).aiTrace, null, 'the answer itself is deleted');
});

test('a system notice written for a member does not move that member\'s read marker', async () => {
    const chat = await newChat('p1');
    await post('p1', chat.id, 'bob');
    await post('p1', chat.id, 'bob');
    await store.appendMessage({ id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'system', authorUserId: 'carol', content: '', notice: 'ai_auto_on' });
    const forCarol = (await store.listChats('p1', { userId: 'carol' })).find((c) => c.id === chat.id);
    assert.strictEqual(forCarol.unread, 2, 'her two unread messages stay unread');
    assert.strictEqual(await store.markRead(chat.id, 'carol', 1), 1, 'and no marker was written past them');
});

test('listMessages can narrow to the main conversation or to one thread by its root', async () => {
    const chat = await newChat('p1');
    const rootA = (await post('p1', chat.id, 'ann')).message;
    const rootB = (await post('p1', chat.id, 'ann')).message;
    const replyA = (await post('p1', chat.id, 'ben', { threadId: rootA.id })).message;
    const main = (await post('p1', chat.id, 'ann')).message;
    const replyB = (await post('p1', chat.id, 'ben', { threadId: rootB.id })).message;
    const ids = async (opts) => (await store.listMessages(chat.id, opts)).messages.map((m) => m.id);

    assert.deepStrictEqual(await ids({}), [rootA.id, rootB.id, replyA.id, main.id, replyB.id], 'left out: everything, in seq order');
    assert.deepStrictEqual(await ids({ threadId: null }), [rootA.id, rootB.id, main.id]);
    assert.deepStrictEqual(await ids({ threadId: rootA.id }), [rootA.id, replyA.id]);
    assert.deepStrictEqual(await ids({ threadId: rootB.id, limit: 1 }), [replyB.id], 'the limit applies inside the thread');
    assert.deepStrictEqual(await ids({ threadId: null, after: rootA.seq }), [rootB.id, main.id]);
    assert.deepStrictEqual(await ids({ threadId: rootA.id, before: replyA.seq }), [rootA.id]);
});

test('a thread reply does not make an automatic answer stale; a main post does', async () => {
    const chat = await newChat('p1', { aiMode: 'auto' });
    const question = (await post('p1', chat.id, 'ann')).message;
    const root = (await post('p1', chat.id, 'ann')).message;
    await post('p1', chat.id, 'ben', { threadId: root.id });
    const answer = () => store.appendMessage({
        id: nextId('msg'), projectId: 'p1', chatId: chat.id, authorKind: 'assistant', content: 'sealed-ai',
        replyTo: question.id, aiTrigger: 'auto_quiet', unlessHumanAfterSeq: root.seq,
    });
    const first = await answer();
    assert.strictEqual(first.stale, false, 'only a thread reply came after what the gate read');
    await post('p1', chat.id, 'ben');
    assert.deepStrictEqual(await answer(), { stale: true });
});

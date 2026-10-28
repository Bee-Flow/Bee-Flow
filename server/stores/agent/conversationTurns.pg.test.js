// @typecheck strict
/**
 * Saving a finished chat turn, against a real Postgres (PGlite behind db.js,
 * testUtils/pglitePool.js): ./conversationTurns.js (saveConversationTurn for
 * agent chat, placeDirectConversationTurn for direct chat) on the stores' own
 * schema and SQL.
 *
 * A turn used to be saved as a FULL REPLACE of the history it started with
 * plus its own rows. When another turn on the same conversation finished in
 * between (a second tab or device, the Nextcloud embed next to the web app, a
 * question asked again after a dropped stream while the server was still
 * answering), that turn was not in the array, so the replace deleted its
 * question and answer (issue #419). A turn now writes only its own rows,
 * right after the last stored message it read as history, under the
 * conversation's row lock.
 *
 * Run: cd server && node --test stores/agent/conversationTurns.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./initSchema');
const convMessages = require('./conversationMessages');
const agentConversations = require('./agentConversations');
const directConversations = require('./directConversations');
const { saveConversationTurn, placeDirectConversationTurn } = require('./conversationTurns');

const USER = 'user-1';

before(async () => {
    await initDB();
    await convMessages.initDB();
    await pg.query("INSERT INTO agents (id, name, owner_id) VALUES ('agent-1', 'Agent', $1)", [USER]);
});
after(close);

/** @typedef {{ id?: string, role: string, content: string }} Msg */

/**
 * Message rows, their ids unique per conversation (`id` is the table's
 * primary key across all conversations).
 * @param {string} convId
 */
const rowsOf = (convId) => /** @type {(id: string, role: string, content: string) => Msg} */ (
    (id, role, content) => ({ id: `${convId}:${id}`, role, content }));

/** A conversation the turns read their history from: two stored messages, migrated. */
async function agentConversationWithHistory() {
    const conv = await agentConversations.createConversation('agent-1', USER, 'Chat');
    const msg = rowsOf(conv.id);
    await agentConversations.updateConversation(conv.id, [
        msg('h1', 'user', 'first question'),
        msg('h2', 'assistant', 'first answer'),
    ], null, USER);
    await pg.query('UPDATE agent_conversations SET messages_migrated = TRUE WHERE id = $1', [conv.id]);
    return conv.id;
}

/** @param {string} id */
async function storedAgent(id) {
    const conv = await agentConversations.getConversationById(id, null, { restore: false });
    return (conv?.messages || []).map((/** @type {Msg} */ m) => m.content);
}

/** A turn's anchor: the last stored message of the history it read when it started. */
const anchorOf = (/** @type {string} */ convId) => `${convId}:h2`;

test('two overlapping agent turns, B finishing first: both survive, in the order they were asked', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    // A is asked, then B; both read [h1, h2]. B finishes first.
    await saveConversationTurn(id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, null, USER);
    await saveConversationTurn(id, { rows: [msg('a-q', 'user', 'question A'), msg('a-a', 'assistant', 'answer A')], anchorId: ANCHOR }, null, USER);
    assert.deepStrictEqual(await storedAgent(id), [
        'first question', 'first answer',
        'question A', 'answer A',
        'question B', 'answer B',
    ]);
});

test('a turn saved after a tool round and again at its end keeps one copy of its rows, and the other turn stays', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    // A saves after its tool round: the question and the tool-call round so far.
    await saveConversationTurn(id, { rows: [msg('a-q', 'user', 'question A'), msg('a-t', 'assistant', 'calling a tool')], anchorId: ANCHOR }, null, USER);
    // B, asked meanwhile on the same history, finishes.
    await saveConversationTurn(id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, null, USER);
    // A ends: the same ids again, plus its final answer.
    await saveConversationTurn(id, { rows: [
        msg('a-q', 'user', 'question A'), msg('a-t', 'assistant', 'calling a tool'), msg('a-a', 'assistant', 'answer A'),
    ], anchorId: ANCHOR }, null, USER);
    assert.deepStrictEqual(await storedAgent(id), [
        'first question', 'first answer',
        'question A', 'calling a tool', 'answer A',
        'question B', 'answer B',
    ]);
});

test('a retry after a dropped stream: the answer the server was still writing is kept next to the retry', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    // The stream of turn A drops on the client; the server keeps answering.
    // The user asks the same question again (turn A2) on the same history,
    // and A2 finishes before A.
    await saveConversationTurn(id, { rows: [msg('a2-q', 'user', 'same question'), msg('a2-a', 'assistant', 'retry answer')], anchorId: ANCHOR }, null, USER);
    await saveConversationTurn(id, { rows: [msg('a-q', 'user', 'same question'), msg('a-a', 'assistant', 'late answer')], anchorId: ANCHOR }, null, USER);
    assert.deepStrictEqual(await storedAgent(id), [
        'first question', 'first answer',
        'same question', 'late answer',
        'same question', 'retry answer',
    ]);
});

test('a turn nothing overtook is appended, and a turn with no stored history (a new chat) too', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    await saveConversationTurn(id, { rows: [msg('c-q', 'user', 'next'), msg('c-a', 'assistant', 'reply')], anchorId: ANCHOR }, null, USER);
    assert.deepStrictEqual(await storedAgent(id), ['first question', 'first answer', 'next', 'reply']);

    const fresh = await agentConversations.createConversation('agent-1', USER, 'New');
    const freshMsg = rowsOf(fresh.id);
    await pg.query('UPDATE agent_conversations SET messages_migrated = TRUE WHERE id = $1', [fresh.id]);
    await saveConversationTurn(fresh.id, { rows: [freshMsg('n-q', 'user', 'hello'), freshMsg('n-a', 'assistant', 'hi')], anchorId: null }, null, USER);
    assert.deepStrictEqual(await storedAgent(fresh.id), ['hello', 'hi']);
});

test('the seq column follows the placement: dense, with no two rows on one seq', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    await saveConversationTurn(id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, null, USER);
    await saveConversationTurn(id, { rows: [msg('a-q', 'user', 'question A'), msg('a-a', 'assistant', 'answer A')], anchorId: ANCHOR }, null, USER);
    const { rows } = await pg.query('SELECT id, seq FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq', [id]);
    assert.deepStrictEqual(rows.map((r) => /** @type {{ id: string, seq: number }} */ (r)).map((r) => [r.id, r.seq]), [
        ['h1', 0], ['h2', 1], ['a-q', 2], ['a-a', 3], ['b-q', 4], ['b-a', 5],
    ].map(([name, seq]) => [`${id}:${name}`, seq]));
});

test('a conversation still on its legacy blob: the whole array, built on what is stored now, keeps the other turn', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    await pg.query('UPDATE agent_conversations SET messages_migrated = FALSE WHERE id = $1', [id]);
    await saveConversationTurn(id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, null, USER);
    await saveConversationTurn(id, { rows: [msg('a-q', 'user', 'question A'), msg('a-a', 'assistant', 'answer A')], anchorId: ANCHOR }, null, USER);
    await pg.query('UPDATE agent_conversations SET messages_migrated = TRUE WHERE id = $1', [id]);
    assert.deepStrictEqual(await storedAgent(id), [
        'first question', 'first answer',
        'question A', 'answer A',
        'question B', 'answer B',
    ]);
});

test('an edit still rewrites the history on purpose (updateConversation), under the row lock', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const ANCHOR = anchorOf(id);
    await saveConversationTurn(id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, null, USER);
    await agentConversations.updateConversation(id, [msg('h1', 'user', 'first question'), msg('e-a', 'assistant', 'edited')], null, USER);
    assert.deepStrictEqual(await storedAgent(id), ['first question', 'edited']);
});

test('direct chat places a turn by the same rule, and writes its meta', async () => {
    const conv = await directConversations.createDirectConversation(USER, 'fast');
    const msg = rowsOf(conv.id);
    const ANCHOR = anchorOf(conv.id);
    await directConversations.updateDirectConversation(conv.id, [msg('h1', 'user', 'first question'), msg('h2', 'assistant', 'first answer')], USER);
    await pg.query('UPDATE direct_conversations SET messages_migrated = TRUE WHERE id = $1', [conv.id]);

    assert.strictEqual(await placeDirectConversationTurn(conv.id, { rows: [msg('b-q', 'user', 'question B'), msg('b-a', 'assistant', 'answer B')], anchorId: ANCHOR }, USER), true);
    assert.strictEqual(await placeDirectConversationTurn(conv.id, { rows: [msg('a-q', 'user', 'question A'), msg('a-a', 'assistant', 'answer A')], anchorId: ANCHOR }, USER, { lastModel: 'm-a' }), true);

    const stored = await directConversations.getDirectConversation(conv.id, USER, { restore: false });
    assert.deepStrictEqual((stored?.messages || []).map((/** @type {Msg} */ m) => m.content), [
        'first question', 'first answer',
        'question A', 'answer A',
        'question B', 'answer B',
    ]);
    assert.strictEqual(stored?.meta?.lastModel, 'm-a');
});

test('direct chat on a legacy-blob conversation leaves the write to the caller', async () => {
    const conv = await directConversations.createDirectConversation(USER, 'fast');
    const msg = rowsOf(conv.id);
    const ANCHOR = anchorOf(conv.id);
    await directConversations.updateDirectConversation(conv.id, [msg('h1', 'user', 'q'), msg('h2', 'assistant', 'a')], USER);
    await pg.query('UPDATE direct_conversations SET messages_migrated = FALSE WHERE id = $1', [conv.id]);
    assert.strictEqual(await placeDirectConversationTurn(conv.id, { rows: [msg('x', 'user', 'later')], anchorId: ANCHOR }, USER), false);
    const { rows } = await pg.query('SELECT id FROM conversation_messages WHERE conversation_id = $1', [conv.id]);
    assert.strictEqual(rows.length, 2, 'nothing written');
});

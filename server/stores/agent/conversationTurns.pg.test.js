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

/**
 * A turn of conversation `convId`: a question and an answer, anchored on the
 * stored history, asked at `askedAt` (seconds past a fixed minute).
 * @param {string} convId
 * @param {string} name
 * @param {number | null} askedAt  null: a turn without a mark
 * @param {string} [question]
 */
function turnOf(convId, name, askedAt, question = `question ${name}`) {
    const msg = rowsOf(convId);
    return {
        rows: [msg(`${name}-q`, 'user', question), msg(`${name}-a`, 'assistant', `answer ${name}`)],
        anchorId: anchorOf(convId),
        ...(askedAt === null ? {} : { turnId: `${convId}:${name}`, askedAt: new Date(Date.UTC(2026, 9, 28, 12, 0, askedAt)).toISOString() }),
    };
}

/** @param {string} id @param {...ReturnType<typeof turnOf>} turns  saved in this order */
async function saveAll(id, ...turns) {
    for (const turn of turns) await saveConversationTurn(id, turn, null, USER);
}

const HISTORY = ['first question', 'first answer'];

test('asked first and finished first, then a later turn on the same history: the order asked', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, '1', 1), turnOf(id, '2', 2));
    assert.deepStrictEqual(await storedAgent(id), [...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2']);
});

test('the later turn finishes first: still the order asked, and nothing lost', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, '2', 2), turnOf(id, '1', 1));
    assert.deepStrictEqual(await storedAgent(id), [...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2']);
});

test('three overlapping turns finishing 3, 1, 2 read back 1, 2, 3', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, '3', 3), turnOf(id, '1', 1), turnOf(id, '2', 2));
    assert.deepStrictEqual(await storedAgent(id), [
        ...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3',
    ]);
});

test('two turns asked at the same instant: the turn id decides, whichever finishes first', async () => {
    const one = await agentConversationWithHistory();
    await saveAll(one, turnOf(one, 'x', 5), turnOf(one, 'y', 5));
    const other = await agentConversationWithHistory();
    await saveAll(other, turnOf(other, 'y', 5), turnOf(other, 'x', 5));
    const expected = [...HISTORY, 'question x', 'answer x', 'question y', 'answer y'];
    assert.deepStrictEqual(await storedAgent(one), expected);
    assert.deepStrictEqual(await storedAgent(other), expected);
});

test('a retry after a dropped stream: both answers kept, the first try first', async () => {
    const id = await agentConversationWithHistory();
    // The stream of try 1 drops on the client while the server keeps
    // answering; the same question asked again (try 2) finishes first.
    await saveAll(id, turnOf(id, 'try2', 2, 'same question'), turnOf(id, 'try1', 1, 'same question'));
    assert.deepStrictEqual(await storedAgent(id), [
        ...HISTORY, 'same question', 'answer try1', 'same question', 'answer try2',
    ]);
});

test('a turn saved after a tool round and again at its end keeps one copy of its rows, and the other turn stays', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    const first = turnOf(id, '1', 1);
    // Turn 1 saves after its tool round: the question and the tool-call round so far.
    await saveAll(id, { ...first, rows: [first.rows[0], msg('1-t', 'assistant', 'calling a tool')] });
    // Turn 2, asked later on the same history, finishes.
    await saveAll(id, turnOf(id, '2', 2));
    // Turn 1 ends: the same ids again, plus its final answer.
    await saveAll(id, { ...first, rows: [first.rows[0], msg('1-t', 'assistant', 'calling a tool'), first.rows[1]] });
    assert.deepStrictEqual(await storedAgent(id), [
        ...HISTORY, 'question 1', 'calling a tool', 'answer 1', 'question 2', 'answer 2',
    ]);
});

test('rows without a mark keep the plain rule: right after the anchor', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, '1', null), turnOf(id, '2', null));
    assert.deepStrictEqual(await storedAgent(id), [...HISTORY, 'question 2', 'answer 2', 'question 1', 'answer 1']);
    // A marked turn, however late it was asked, does not skip an unmarked one.
    await saveAll(id, turnOf(id, '9', 9));
    assert.deepStrictEqual((await storedAgent(id)).slice(2, 4), ['question 9', 'answer 9']);
});

test('a turn nothing overtook is appended; a brand-new chat switches to the table at its first turn', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, 'next', 1));
    assert.deepStrictEqual(await storedAgent(id), [...HISTORY, 'question next', 'answer next']);

    const fresh = await agentConversations.createConversation('agent-1', USER, 'New');
    await saveConversationTurn(fresh.id, { ...turnOf(fresh.id, 'n', 1), anchorId: null }, null, USER);
    assert.deepStrictEqual(await storedAgent(fresh.id), ['question n', 'answer n']);
    const { rows } = await pg.query('SELECT messages_migrated FROM agent_conversations WHERE id = $1', [fresh.id]);
    assert.strictEqual(/** @type {{ messages_migrated: boolean }} */ (rows[0]).messages_migrated, true);
});

test('the seq column follows the placement, and every row carries its turn', async () => {
    const id = await agentConversationWithHistory();
    await saveAll(id, turnOf(id, '2', 2), turnOf(id, '1', 1));
    const { rows } = await pg.query('SELECT id, seq, turn_id FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq', [id]);
    assert.deepStrictEqual(rows.map((r) => /** @type {{ id: string, seq: number, turn_id: string | null }} */ (r)).map((r) => [r.id, r.seq, r.turn_id]), [
        ['h1', 0, null], ['h2', 1, null], ['1-q', 2, '1'], ['1-a', 3, '1'], ['2-q', 4, '2'], ['2-a', 5, '2'],
    ].map(([name, seq, turn]) => [`${id}:${name}`, seq, turn === null ? null : `${id}:${turn}`]));
});

test('a conversation still on its legacy blob is migrated under the lock, then the turn is placed', async () => {
    const id = await agentConversationWithHistory();
    await pg.query('UPDATE agent_conversations SET messages_migrated = FALSE WHERE id = $1', [id]);
    await saveAll(id, turnOf(id, '2', 2), turnOf(id, '1', 1));
    const { rows } = await pg.query('SELECT messages_migrated FROM agent_conversations WHERE id = $1', [id]);
    assert.strictEqual(/** @type {{ messages_migrated: boolean }} */ (rows[0]).messages_migrated, true);
    assert.deepStrictEqual(await storedAgent(id), [...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2']);
});

test('an edit still rewrites the history on purpose (updateConversation), under the row lock', async () => {
    const id = await agentConversationWithHistory();
    const msg = rowsOf(id);
    await saveAll(id, turnOf(id, '2', 2));
    await agentConversations.updateConversation(id, [msg('h1', 'user', 'first question'), msg('e-a', 'assistant', 'edited')], null, USER);
    assert.deepStrictEqual(await storedAgent(id), ['first question', 'edited']);
});

/** A direct conversation with the same stored history. */
async function directConversationWithHistory(migrated = true) {
    const conv = await directConversations.createDirectConversation(USER, 'fast');
    const msg = rowsOf(conv.id);
    await directConversations.updateDirectConversation(conv.id, [msg('h1', 'user', 'first question'), msg('h2', 'assistant', 'first answer')], USER);
    await pg.query('UPDATE direct_conversations SET messages_migrated = $2 WHERE id = $1', [conv.id, migrated]);
    return conv.id;
}

/** @param {string} id */
async function storedDirect(id) {
    const stored = await directConversations.getDirectConversation(id, USER, { restore: false });
    return { contents: (stored?.messages || []).map((/** @type {Msg} */ m) => m.content), meta: stored?.meta };
}

test('direct chat places a turn by the same rule, and writes its meta', async () => {
    const id = await directConversationWithHistory();
    assert.strictEqual(await placeDirectConversationTurn(id, turnOf(id, '1', 1), USER), true);
    assert.strictEqual(await placeDirectConversationTurn(id, turnOf(id, '2', 2), USER, { lastModel: 'm-2' }), true);
    const { contents, meta } = await storedDirect(id);
    assert.deepStrictEqual(contents, [...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2']);
    assert.strictEqual(meta?.lastModel, 'm-2');
});

test('direct chat on a legacy-blob conversation is migrated under the lock, then written', async () => {
    const id = await directConversationWithHistory(false);
    assert.strictEqual(await placeDirectConversationTurn(id, turnOf(id, '2', 2), USER), true);
    assert.strictEqual(await placeDirectConversationTurn(id, turnOf(id, '1', 1), USER), true);
    assert.deepStrictEqual((await storedDirect(id)).contents, [...HISTORY, 'question 1', 'answer 1', 'question 2', 'answer 2']);
});

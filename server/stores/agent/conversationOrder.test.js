// @typecheck
/**
 * The order a conversation reads back in, against a real Postgres (PGlite).
 *
 * Every reader (the chat view on web, the Nextcloud embed and mobile, the
 * model's history for the next turn, export) reads conversation_messages with
 * READ_ORDER (stores/agent/conversationMessages.js). `seq` alone did not make
 * that order total: two rows on one seq (written by two unserialised writers)
 * came back in heap order, and an UPDATE of either row flips heap order.
 *
 * Run: cd server && node --test stores/agent/conversationOrder.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { READ_ORDER, lockConversation } = require('./conversationOrder.mts');

const pg = new PGlite();

test.before(async () => {
    await pg.exec(`
        CREATE TABLE conversation_messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
            seq INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX idx_conv_messages_conv_seq ON conversation_messages(conversation_id, seq ASC);
    `);
    // The question was written first and the answer a moment later, both on
    // seq 1. The heap holds them the other way round, as it does after either
    // row was rewritten (an UPDATE puts the new row version at the end).
    const rows = [
        ['m0', 'user', 'first question', 0, '2026-10-28T10:00:00.000Z'],
        ['z-later', 'assistant', 'the answer', 1, '2026-10-28T10:00:05.000Z'],
        ['a-earlier', 'user', 'the question', 1, '2026-10-28T10:00:01.000Z'],
    ];
    for (const r of rows) {
        await pg.query(
            `INSERT INTO conversation_messages (id, conversation_id, role, content, seq, created_at) VALUES ($1, 'c1', $2, $3, $4, $5)`,
            r,
        );
    }
});
test.after(async () => { await pg.close(); });

/** @param {string} order */
async function contents(order) {
    const { rows } = await pg.query(`SELECT content FROM conversation_messages WHERE conversation_id = $1 ${order}`, ['c1']);
    return rows.map((r) => /** @type {{ content: string }} */ (r).content);
}

test('READ_ORDER breaks a seq tie in the order the rows were written', async () => {
    // `ORDER BY seq ASC` alone returns this fixture as
    // ['first question', 'the answer', 'the question']: heap order.
    assert.deepStrictEqual(await contents(READ_ORDER), ['first question', 'the question', 'the answer']);
});

test('READ_ORDER is total: rows equal on seq and created_at fall back to id', async () => {
    await pg.query(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, seq, created_at)
         VALUES ('b', 'c2', 'assistant', 'second', 0, '2026-10-28T10:00:00Z'), ('a', 'c2', 'user', 'first', 0, '2026-10-28T10:00:00Z')`,
    );
    const { rows } = await pg.query(`SELECT id FROM conversation_messages WHERE conversation_id = 'c2' ${READ_ORDER}`);
    assert.deepStrictEqual(rows.map((r) => /** @type {{ id: string }} */ (r).id), ['a', 'b']);
});

test('lockConversation locks the parent row of the right table', async () => {
    /** @type {Array<[string, unknown[] | undefined]>} */
    const seen = [];
    const client = { query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => { seen.push([sql, params]); return { rows: [] }; } };
    await lockConversation(client, 'direct', 'c1');
    await lockConversation(client, 'agent', 'c2');
    assert.deepStrictEqual(seen, [
        ['SELECT id FROM direct_conversations WHERE id = $1 FOR UPDATE', ['c1']],
        ['SELECT id FROM agent_conversations WHERE id = $1 FOR UPDATE', ['c2']],
    ]);
});

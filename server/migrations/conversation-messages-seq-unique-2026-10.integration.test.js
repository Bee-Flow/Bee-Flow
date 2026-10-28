// @typecheck strict
/**
 * conversation-messages-seq-unique-2026-10 against real Postgres (PGlite),
 * handed to up() through its `db` seam.
 *
 * Under test:
 *   - rows sharing a seq are renumbered 0..n-1 in read order (seq, created_at,
 *     id), a conversation without a tie is left alone, small batches too;
 *   - the unique (conversation_id, seq) index exists and is valid afterwards,
 *     and refuses a second row on a taken seq;
 *   - a second run is a no-op;
 *   - an INVALID index left by a failed build is dropped and built again;
 *   - writers keep seq unique with the index in place: a turn placed
 *     mid-conversation moves the rows after it without tripping the index.
 *
 * Run: cd server && node --test migrations/conversation-messages-seq-unique-2026-10.integration.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const { pgliteQuery } = require('../testUtils/pglitePool');
const { writeTurnRows } = require('../stores/agent/conversationOrder.mts');

const { up, INDEX_NAME } = require('./conversation-messages-seq-unique-2026-10');

const pg = new PGlite();
const query = pgliteQuery(pg);
/** @type {import('./conversation-messages-seq-unique-2026-10').MigrationDb} */
const db = {
    getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await query(sql, params)).rows,
    withTransaction: async (fn) => {
        await query('BEGIN');
        try {
            const out = await fn({ query });
            await query('COMMIT');
            return out;
        } catch (e) {
            await query('ROLLBACK');
            throw e;
        }
    },
    getClient: async () => ({ query, release() {} }),
};

before(async () => {
    await pg.exec(`
        CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, messages_migrated BOOLEAN DEFAULT TRUE, messages_json TEXT);
        CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, messages_migrated BOOLEAN DEFAULT TRUE, messages_json TEXT);
        CREATE TABLE conversation_messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, conversation_type TEXT NOT NULL DEFAULT 'agent',
            role TEXT NOT NULL, content TEXT, seq INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),
            turn_id TEXT, turn_asked_at TIMESTAMPTZ
        );
        INSERT INTO agent_conversations (id) VALUES ('tied'), ('clean'), ('also-tied');
        INSERT INTO direct_conversations (id) VALUES ('direct-tied');
    `);
    /** @type {[string, string, number, string][]} id, conversation, seq, created_at */
    const rows = [
        // Two unserialised writers left 'b' and 'c' on seq 1; 'c' was written first.
        ['tied-a', 'tied', 0, '2026-10-28T10:00:00Z'],
        ['tied-b', 'tied', 1, '2026-10-28T10:00:05Z'],
        ['tied-c', 'tied', 1, '2026-10-28T10:00:01Z'],
        ['tied-d', 'tied', 2, '2026-10-28T10:00:09Z'],
        // Same seq AND same created_at: the id decides.
        ['also-y', 'also-tied', 0, '2026-10-28T10:00:00Z'],
        ['also-x', 'also-tied', 0, '2026-10-28T10:00:00Z'],
        ['direct-1', 'direct-tied', 3, '2026-10-28T10:00:00Z'],
        ['direct-2', 'direct-tied', 3, '2026-10-28T10:00:02Z'],
        // No tie, and gaps in seq: left exactly as it is.
        ['clean-1', 'clean', 0, '2026-10-28T10:00:00Z'],
        ['clean-2', 'clean', 5, '2026-10-28T10:00:01Z'],
    ];
    for (const [id, conv, seq, at] of rows) {
        await pg.query(
            `INSERT INTO conversation_messages (id, conversation_id, conversation_type, role, content, seq, created_at)
             VALUES ($1, $2, $3, 'user', $1, $4, $5)`,
            [id, conv, conv.startsWith('direct') ? 'direct' : 'agent', seq, at],
        );
    }
});
after(async () => { await pg.close(); });

/** @param {string} conv */
async function seqs(conv) {
    const { rows } = await pg.query('SELECT id, seq FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq', [conv]);
    return rows.map((r) => /** @type {{ id: string, seq: number }} */ (r)).map((r) => [r.id, r.seq]);
}

async function indexValid() {
    const { rows } = await pg.query(
        'SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1', [INDEX_NAME]);
    return rows.length === 0 ? null : /** @type {{ valid: boolean }} */ (rows[0]).valid;
}

test('ties are renumbered in read order, untied conversations are untouched, and the index is built', async () => {
    const out = await up({ db, batchSize: 2 });
    assert.deepStrictEqual(out, { conversations: 3, rows: 5, index: 'built' });
    assert.deepStrictEqual(await seqs('tied'), [['tied-a', 0], ['tied-c', 1], ['tied-b', 2], ['tied-d', 3]]);
    assert.deepStrictEqual(await seqs('also-tied'), [['also-x', 0], ['also-y', 1]]);
    assert.deepStrictEqual(await seqs('direct-tied'), [['direct-1', 0], ['direct-2', 1]]);
    assert.deepStrictEqual(await seqs('clean'), [['clean-1', 0], ['clean-2', 5]]);
    assert.strictEqual(await indexValid(), true);
});

test('the index refuses a second row on a taken seq', async () => {
    await assert.rejects(
        pg.query(`INSERT INTO conversation_messages (id, conversation_id, role, seq) VALUES ('dup', 'tied', 'user', 1)`),
        (/** @type {{ code?: string }} */ err) => err.code === '23505',
    );
});

test('a second run changes nothing', async () => {
    assert.deepStrictEqual(await up({ db }), { conversations: 0, rows: 0, index: 'present' });
    assert.deepStrictEqual(await seqs('tied'), [['tied-a', 0], ['tied-c', 1], ['tied-b', 2], ['tied-d', 3]]);
});

test('an INVALID index from a failed build is dropped and built again', async () => {
    await pg.query(`UPDATE pg_index SET indisvalid = FALSE WHERE indexrelid = $1::regclass`, [INDEX_NAME]);
    assert.strictEqual(await indexValid(), false);
    assert.deepStrictEqual((await up({ db })).index, 'rebuilt');
    assert.strictEqual(await indexValid(), true);
});

test('with the index in place, a turn placed mid-conversation moves the later rows without tripping it', async () => {
    // tied: a, c, b, d. A turn asked on 'tied-a' goes right after it.
    const placed = await db.withTransaction((client) => writeTurnRows(client, {
        type: 'agent', conversationId: 'tied', anchorId: 'tied-a', mark: null, turnIds: ['t-q', 't-a'],
        insertRows: async (startSeq) => {
            await client.query(
                `INSERT INTO conversation_messages (id, conversation_id, role, seq) VALUES ('t-q', 'tied', 'user', $1), ('t-a', 'tied', 'assistant', $2)`,
                [startSeq, startSeq + 1],
            );
        },
    }));
    assert.strictEqual(placed, true);
    assert.deepStrictEqual(await seqs('tied'), [
        ['tied-a', 0], ['t-q', 1], ['t-a', 2], ['tied-c', 3], ['tied-b', 4], ['tied-d', 5],
    ]);
});

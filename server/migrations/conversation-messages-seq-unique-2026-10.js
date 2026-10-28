// @typecheck strict
/**
 * Migration: one `seq` per row in a conversation, enforced by a unique index
 * on conversation_messages (conversation_id, seq).
 *
 * Every writer of a conversation's rows takes the conversation row lock
 * (stores/agent/conversationOrder.mts lockConversation) and keeps seq unique:
 * replace and rekey write 0..n-1, append takes MAX(seq)+1, the turn write
 * renumbers densely. Rows written before that lock existed can still share a
 * seq. Readers break such a tie by (seq, created_at, id), READ_ORDER; this
 * migration makes that order the stored one and then lets the database
 * refuse a tie.
 *
 * 1. Renumber. The conversations that have a tie are found in one pass, then
 *    renumbered in batches (one transaction per batch, under the same row
 *    locks as the writers), each 0..n-1 in READ_ORDER. A conversation without
 *    a tie is not touched, so its rows keep their seq.
 * 2. The index, built CONCURRENTLY on its own connection (outside a
 *    transaction, without the pool's 30 s statement_timeout), so a large
 *    table stays writable while it builds. A build that failed half-way
 *    leaves an INVALID index that IF NOT EXISTS would skip for good; that one
 *    is dropped first and built again.
 *
 * Idempotent: once there are no ties and the index is valid, a run changes
 * nothing. Registered in boot/bootMigrations.js LOOSE_MIGRATIONS (ledger
 * `schema_migrations`). Standalone: node migrations/conversation-messages-seq-unique-2026-10.js
 */

'use strict';

const { bestEffort } = require('../utils/bestEffort');

const INDEX_NAME = 'idx_conv_messages_conv_seq_unique';
const INDEX_SQL = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ON conversation_messages (conversation_id, seq)`;

/** Conversations with two rows on one seq. */
const TIED_SQL = `
    SELECT DISTINCT conversation_id
      FROM conversation_messages
     GROUP BY conversation_id, seq
    HAVING COUNT(*) > 1`;

/** 0..n-1 in READ_ORDER for the given conversations; only rows whose seq changes are written. */
const RENUMBER_SQL = `
    UPDATE conversation_messages AS m SET seq = r.next_seq
      FROM (SELECT id, (ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY seq ASC, created_at ASC, id ASC) - 1)::int AS next_seq
              FROM conversation_messages
             WHERE conversation_id = ANY($1::text[])) AS r
     WHERE m.id = r.id AND m.seq <> r.next_seq`;

/**
 * @typedef {{ query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[], rowCount?: number | null }> }} QueryClient
 * @typedef {{
 *   getOne(sql: string, params?: unknown[]): Promise<Record<string, unknown> | null>,
 *   getAll(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>,
 *   withTransaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T>,
 *   getClient(): Promise<QueryClient & { release(destroy?: boolean): void }>,
 * }} MigrationDb
 */

/**
 * Renumber the tied conversations, a batch per transaction, under their row locks.
 * @param {MigrationDb} db
 * @param {number} batchSize
 * @returns {Promise<{ conversations: number, rows: number }>}
 */
async function renumberTies(db, batchSize) {
    const tied = await db.getAll(TIED_SQL);
    let rows = 0;
    for (let i = 0; i < tied.length; i += batchSize) {
        const batch = tied.slice(i, i + batchSize);
        const ids = batch.map((r) => String(r.conversation_id)).sort();
        rows += await db.withTransaction(async (client) => {
            // The writers' lock (lockConversation), taken in id order.
            for (const table of ['agent_conversations', 'direct_conversations']) {
                await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids]);
            }
            const res = await client.query(RENUMBER_SQL, [ids]);
            return Number(res.rowCount) || 0;
        });
    }
    return { conversations: tied.length, rows };
}

/** @param {MigrationDb} db @returns {Promise<boolean | null>} null: no index; else whether it is valid */
async function indexState(db) {
    const row = await db.getOne(
        `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`,
        [INDEX_NAME],
    );
    return row ? row.valid === true : null;
}

/**
 * Run statements on a connection of their own: CONCURRENTLY cannot run in a
 * transaction, and the pool's statement_timeout would cut a long build.
 * @param {MigrationDb} db
 * @param {string[]} statements
 */
async function onOwnConnection(db, statements) {
    const client = await db.getClient();
    try {
        await client.query('SET statement_timeout = 0');
        for (const sql of statements) await client.query(sql);
    } finally {
        // Back to its default (the pool's 30 s); a connection that cannot
        // even do that is not given back to the pool but closed.
        const reset = await client.query('RESET statement_timeout').then(() => true,
            (e) => { bestEffort('migrations/conversation-messages-seq-unique-2026-10:reset', e); return false; });
        client.release(!reset);
    }
}

/**
 * @param {{ db?: MigrationDb, batchSize?: number }} [opts]  `db` is the seam
 *   for the integration test; the boot ladder calls up() without arguments.
 * @returns {Promise<{ conversations: number, rows: number, index: string, skipped?: string }>}
 */
async function up({ db = /** @type {MigrationDb} */ (/** @type {unknown} */ (require('../db'))), batchSize = 200 } = {}) {
    // The table is created by the conversation store; a fresh install that
    // has not run that init yet has nothing to renumber.
    const present = await db.getOne(`SELECT to_regclass('conversation_messages') IS NOT NULL AS ok`);
    if (!present || present.ok !== true) return { conversations: 0, rows: 0, index: 'none', skipped: 'no conversation_messages table' };
    // A build that failed half-way left an INVALID index: IF NOT EXISTS would
    // skip it for good, and it would still check the renumbering below. Gone first.
    const state = await indexState(db);
    if (state === false) await onOwnConnection(db, [`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`]);
    const renumbered = await renumberTies(db, batchSize);
    if (state !== true) await onOwnConnection(db, [INDEX_SQL]);
    return { ...renumbered, index: state === true ? 'present' : state === false ? 'rebuilt' : 'built' };
}

module.exports = { up, INDEX_NAME, INDEX_SQL };

if (require.main === module) {
    up().then((out) => {
        console.log('[Migration] conversation-messages-seq-unique-2026-10', out);
        process.exit(0);
    }, (err) => {
        console.error('[Migration] conversation-messages-seq-unique-2026-10 failed:', err);
        process.exit(1);
    });
}

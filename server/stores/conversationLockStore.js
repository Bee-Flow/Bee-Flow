// @typecheck
/**
 * One AI run at a time, per conversation.
 *
 * ── Why a lock at all ───────────────────────────────────────────────────────
 *
 * In a private chat the UI is the lock: one person, one send button. A shared
 * thread has no such guarantee. Two members hitting send within a second of
 * each other would start two runs against the same history, each unaware of the
 * other's turn, and the transcript would interleave two half-answers to two
 * different questions.
 *
 * ── Why a TABLE and not pg_advisory_lock ────────────────────────────────────
 *
 * An advisory lock is invisible: no other replica can tell you WHO holds it, so
 * the UI could not say "Anna is asking the AI…" — and that message is most of
 * the value. It also dies with its session, which sounds convenient until a pod
 * restart leaves a lock nobody can explain. A row with `expires_at` is
 * inspectable from anywhere and self-heals on a fixed schedule.
 *
 * ── Contention is a queue, not an error ─────────────────────────────────────
 *
 * The route persists the second member's message immediately (so everyone sees
 * it arrive), shows it as queued, and retries the lock. A hard 409 on a shared
 * thread reads as "the app is broken" rather than "someone else is talking".
 */

const { run, getOne, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

// Long enough for a slow model answer with tool calls; short enough that a pod
// killed mid-run frees the thread on a human timescale. The holder extends it
// on each heartbeat, so a genuinely long run is never cut off — only an
// abandoned one expires.
const DEFAULT_TTL_MS = 120_000;

const initDB = makeStoreInit('ConversationLockStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS conversation_turn_locks (
            conversation_id   TEXT PRIMARY KEY,
            conversation_type TEXT NOT NULL DEFAULT 'direct',
            project_id        TEXT,
            holder_user_id    TEXT NOT NULL,
            run_id            TEXT NOT NULL,
            acquired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at        TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_turn_locks_expires ON conversation_turn_locks(expires_at);
        CREATE INDEX IF NOT EXISTS idx_turn_locks_project ON conversation_turn_locks(project_id)
            WHERE project_id IS NOT NULL;
    `);
    log.info('[ConversationLockStore] PostgreSQL initialized');
}

/**
 * Try to claim the turn.
 *
 * A single INSERT ... ON CONFLICT DO UPDATE with a WHERE on the conflict target:
 * the row is taken over only when the incumbent has expired. One statement, so
 * two replicas racing cannot both win.
 *
 * @returns {Promise<{acquired: true, runId: string}|{acquired: false, holder: object}>}
 */
async function acquireTurn({ conversationId, conversationType = 'direct', projectId = null, userId, runId, ttlMs = DEFAULT_TTL_MS }) {
    await initDB();
    if (!conversationId || !userId || !runId) throw new Error('conversationId, userId and runId are required');

    const { rowCount } = await run(`
        INSERT INTO conversation_turn_locks
            (conversation_id, conversation_type, project_id, holder_user_id, run_id, acquired_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + ($6 || ' milliseconds')::interval)
        ON CONFLICT (conversation_id) DO UPDATE
            SET holder_user_id = EXCLUDED.holder_user_id,
                run_id         = EXCLUDED.run_id,
                conversation_type = EXCLUDED.conversation_type,
                project_id     = EXCLUDED.project_id,
                acquired_at    = NOW(),
                expires_at     = EXCLUDED.expires_at
          WHERE conversation_turn_locks.expires_at < NOW()
    `, [conversationId, conversationType, projectId, userId, runId, String(Math.max(1000, ttlMs))]);

    if (rowCount > 0) return { acquired: true, runId };
    return { acquired: false, holder: await getTurn(conversationId) };
}

/**
 * Push the expiry out. Called from the streaming route's heartbeat.
 *
 * Scoped to the run id so a stale heartbeat from an abandoned run cannot keep
 * a lock alive that has already been taken over by someone else.
 */
async function extendTurn({ conversationId, runId, ttlMs = DEFAULT_TTL_MS }) {
    await initDB();
    const { rowCount } = await run(`
        UPDATE conversation_turn_locks
           SET expires_at = NOW() + ($3 || ' milliseconds')::interval
         WHERE conversation_id = $1 AND run_id = $2
    `, [conversationId, runId, String(Math.max(1000, ttlMs))]);
    return rowCount > 0;
}

/**
 * Release. Also scoped to the run id: a late `finally` from a run that already
 * lost its lock must not free the turn out from under its successor.
 */
async function releaseTurn({ conversationId, runId }) {
    await initDB();
    const { rowCount } = await run(
        'DELETE FROM conversation_turn_locks WHERE conversation_id = $1 AND run_id = $2',
        [conversationId, runId]
    );
    return rowCount > 0;
}

/** Who holds the turn, if anyone. Expired rows read as free. */
async function getTurn(conversationId) {
    await initDB();
    const row = await getOne(
        'SELECT * FROM conversation_turn_locks WHERE conversation_id = $1 AND expires_at > NOW()',
        [conversationId]
    );
    if (!row) return null;
    return {
        conversationId: row.conversation_id,
        conversationType: row.conversation_type,
        projectId: row.project_id,
        holderUserId: row.holder_user_id,
        runId: row.run_id,
        acquiredAt: row.acquired_at,
        expiresAt: row.expires_at,
    };
}

/** Housekeeping. Expired rows are already ignored by getTurn; this is tidiness. */
async function pruneExpiredTurns() {
    await initDB();
    const { rowCount } = await run('DELETE FROM conversation_turn_locks WHERE expires_at < NOW() - INTERVAL \'1 hour\'');
    return rowCount;
}

module.exports = {
    initDB,
    acquireTurn,
    extendTurn,
    releaseTurn,
    getTurn,
    pruneExpiredTurns,
    DEFAULT_TTL_MS,
};

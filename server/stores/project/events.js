// @typecheck
/**
 * stores/project/events.js — the activity feed (audit rows) and the live
 * event log behind GET /:id/stream (gapless per-project seq, replay, prune).
 * Split out of stores/projectStore.js; built per store by makeProjectStore.
 */

const crypto = require('crypto');
const log = require('../../telemetry/log');
const { mapActivityRow } = require('../projectChanges');

// How many events a reconnecting client may replay in one go. Beyond this the
// stream tells it to resync from scratch rather than dribbling out a backlog:
// a client that was away that long is better off refetching than replaying.
const EVENT_REPLAY_LIMIT = 500;

/**
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<any>,
 *   initDB: () => Promise<unknown>,
 * }} ctx  the store's db facade and schema init (built by makeProjectStore)
 */
function makeEventFns({ run, getAll, getOne, getClient, initDB }) {
    // ── Activity feed ────────────────────────────────────────

    async function logActivity(projectId, actorId, action, details = {}) {
        await initDB();
        if (!projectId || !actorId || !action) return null;
        const id = crypto.randomUUID();
        const targetType = details.targetType || null;
        const targetId = details.targetId || null;
        try {
            await run(
                `INSERT INTO project_activity (id, project_id, actor_id, action, target_type, target_id, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, projectId, actorId, action, targetType, targetId, JSON.stringify(details)]
            );
        } catch (err) {
            log.warn('[ProjectStore] logActivity failed:', err.message);
            return null;
        }
        return id;
    }

    // ── Live events ──────────────────────────────────────────────────────
    // (EVENT_REPLAY_LIMIT, the replay cap, is defined above makeEventFns.)

    /**
     * Append an event and return its project-scoped sequence number.
     *
     * The counter lives on the projects row and is incremented inside the same
     * transaction as the INSERT, so the UPDATE's row lock serialises writers for
     * this project. That is what makes the sequence gapless and commit-ordered —
     * see the project_events DDL for why a BIGSERIAL cannot give that.
     *
     * Best-effort by design: a live-feed notification must never fail the action it
     * is reporting. Failures are logged and swallowed, and a client that misses an
     * event still converges via its next reconnect or refetch.
     *
     * @returns {Promise<{seq: number, id: string}|null>}
     * @param projectId
     * @param {{ kind?: string, actorId?: string|null, targetType?: string|null, targetId?: string|null, payload?: object }} [opts]
     */
    async function appendProjectEvent(projectId, { kind, actorId = null, targetType = null, targetId = null, payload = {} } = {}) {
        await initDB();
        if (!projectId || !kind) return null;

        const client = await getClient();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                'UPDATE projects SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq',
                [projectId]
            );
            if (rows.length === 0) {          // project vanished mid-flight
                await client.query('ROLLBACK');
                return null;
            }
            const seq = Number(rows[0].event_seq);
            const id = crypto.randomUUID();
            await client.query(
                `INSERT INTO project_events (id, project_id, seq, kind, actor_id, target_type, target_id, payload)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [id, projectId, seq, kind, actorId, targetType, targetId, JSON.stringify(payload || {})]
            );
            await client.query('COMMIT');
            return { seq, id };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (err) { log.debug('connection already gone', err); }
            log.warn('[ProjectStore] appendProjectEvent failed:', err.message);
            return null;
        } finally {
            client.release();
        }
    }

    /**
     * Events after `sinceSeq`, oldest first: the reconnect catch-up query.
     *
     * `truncated` asks the stream for a resync (the client refetches instead
     * of replaying): more follow than one replay carries, or the cursor
     * points into a stretch that was pruned (jobs/projectEventsPrune.js).
     * Seqs are gapless, allocated with their row in one transaction, so a
     * first surviving seq past `sinceSeq + 1` means rows were deleted. When
     * nothing after the cursor survives while the project's counter moved
     * on, the answer is ONE durable `resync` event at the head: the stream's
     * cursor, and the client's, then move past the hole, so it is said once
     * and not on every poll. The head is read in the same statement (one
     * snapshot), so an event committed in between never looks like a hole.
     */
    async function listProjectEvents(projectId, sinceSeq = 0, limit = EVENT_REPLAY_LIMIT) {
        await initDB();
        const capped = Math.min(Math.max(1, limit), EVENT_REPLAY_LIMIT);
        const since = Number(sinceSeq) || 0;
        const rows = await getAll(
            `SELECT p.event_seq AS head_seq, e.*
               FROM projects p
               LEFT JOIN LATERAL (
                   SELECT id, seq, kind, actor_id, target_type, target_id, payload, created_at
                     FROM project_events
                    WHERE project_id = p.id AND seq > $2
                    ORDER BY seq ASC
                    LIMIT $3
               ) e ON true
              WHERE p.id = $1
              ORDER BY e.seq ASC`,
            [projectId, since, capped + 1]
        );
        const head = rows.length ? Number(rows[0].head_seq) || 0 : 0;
        const found = rows.filter(r => r.id != null);
        if (since > 0 && !found.length && head > since) {
            return {
                events: [{ id: null, seq: head, kind: 'resync', actorId: null, targetType: null, targetId: null, payload: { reason: 'pruned' }, createdAt: null }],
                truncated: false,
            };
        }
        const truncated = found.length > capped || (since > 0 && found.length > 0 && Number(found[0].seq) > since + 1);
        return {
            events: found.slice(0, capped).map(r => ({
                id: r.id,
                seq: Number(r.seq),
                kind: r.kind,
                actorId: r.actor_id,
                targetType: r.target_type,
                targetId: r.target_id,
                payload: r.payload || {},
                createdAt: r.created_at,
            })),
            truncated,
        };
    }

    /** Current head, so a fresh subscriber can start from "now" and miss nothing. */
    async function getProjectEventSeq(projectId) {
        await initDB();
        const row = await getOne('SELECT event_seq FROM projects WHERE id = $1', [projectId]);
        return row ? Number(row.event_seq) : 0;
    }

    /** Housekeeping: drop events older than `days`. The audit trail is elsewhere. */
    async function pruneProjectEvents(days = 7) {
        await initDB();
        const { rowCount } = await run(
            `DELETE FROM project_events WHERE created_at < NOW() - ($1 || ' days')::interval`,
            [String(Math.max(1, days))]
        );
        return rowCount;
    }

    async function listActivity(projectId, limit = 50, offset = 0) {
        await initDB();
        const rows = await getAll(
            `SELECT * FROM project_activity
             WHERE project_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [projectId, limit, offset]
        );
        // actorKind, itemType/itemId, versionId and updatedAt come with the
        // change feed (stores/projectChanges.js); older rows read as a
        // person's action that was never folded.
        return rows.map(mapActivityRow);
    }

    return {
        logActivity,
        listActivity,
        appendProjectEvent,
        listProjectEvents,
        getProjectEventSeq,
        pruneProjectEvents,
    };
}

module.exports = { EVENT_REPLAY_LIMIT, makeEventFns };

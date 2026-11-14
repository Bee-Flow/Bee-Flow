// @typecheck
/**
 * The project store's "what changed" half: content-change sessions in
 * `project_activity`, each member's visit and seen marks
 * (`project_member_state`) and what they last saw of each item
 * (`project_item_reads`). The schema is part of projectStore's
 * `applyProjectSchema`; these functions are composed into `makeProjectStore`
 * over the same database facade, so one pglite test runs both.
 *
 * ── One row per editing session ────────────────────────────────────────────
 *
 * A notebook or document is saved many times a minute while somebody types.
 * The feed wants "Anna edited the launch brief", not four hundred rows, so an
 * edit folds into the row of the same person on the same item while their
 * previous edit is less than a session gap old; after a pause a new row
 * starts. The row is updated IN PLACE: counts are added, the latest version
 * id replaces the previous one, `updated_at` moves.
 *
 * ── The row and its live event in one transaction ──────────────────────────
 *
 * Every write here that tells the members something appends the
 * `project_events` row in the SAME transaction as the activity row, under the
 * project row's lock, and stamps the activity row with that event's `seq`.
 * The two can then never disagree (an audit row nobody was told about, or an
 * event whose row failed). A folded edit re-emits only when its previous
 * event is older than `emitEveryMs`, so a typing session does not wake every
 * member's page on every autosave. The caller rings the doorbell after the
 * commit (core/projectFeed's rule: persist first, then publish).
 *
 * ── Counts only ────────────────────────────────────────────────────────────
 *
 * `details` holds ids, counts and flags, never text: titles are resolved when
 * the feed is READ, with the reader's access (a title copied here would leak
 * after the item left the project, and team-chat titles are encrypted).
 */

'use strict';

const crypto = require('crypto');
const log = require('../telemetry/log');
const { makeSeenFns } = require('./projectChangeSeen');
const { rollback } = require('../utils/txRollback');

/** Activity actions that describe content (the "Changes only" view and the change feed). */
const CONTENT_ACTIONS = Object.freeze([
    'content.edited', 'content.created', 'content.renamed', 'content.moved_in', 'content.moved_out',
    'content.restored', 'content.version_named',
]);

/** Filing actions that are about an item too (written by the project routes). */
const FILING_ACTIONS = Object.freeze(['resource_added', 'resource_removed']);

/** The item kinds the change feed follows. */
const CHANGE_ITEM_TYPES = Object.freeze(['notebook', 'document', 'meeting']);

const ACTOR_KINDS = new Set(['user', 'ai', 'system']);

/** A row of project_activity as the API speaks it. */
function mapActivityRow(r) {
    return {
        id: r.id,
        projectId: r.project_id,
        actorId: r.actor_id || null,
        actorKind: r.actor_kind || 'user',
        action: r.action,
        targetType: r.target_type || null,
        targetId: r.target_id || null,
        itemType: r.item_type || null,
        itemId: r.item_id || null,
        versionId: r.version_id || null,
        seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
        details: r.details || {},
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
    };
}

/**
 * Writing a change: the activity row and its live event in one transaction.
 * @param {Parameters<typeof makeProjectChangeFns>[0]} ctx
 */
function makeRecordingFns({ withTransaction, ready }) {
    /**
     * Run `fn(client)` in one transaction; null when it throws (logged, never
     * raised) or answers null (rolled back).
     * @param {string} label
     */
    async function inTransaction(label, fn) {
        try {
            return await withTransaction(async (client) => {
                const out = await fn(client);
                return out === null ? rollback(null) : out;
            });
        } catch (err) {
            log.warn(`[ProjectStore] ${label} failed:`, /** @type {Error} */ (err).message);
            return null;
        }
    }

    /**
     * Next event seq on the (already locked or lockable) project row, or null when it is gone.
     * @param {string} projectId
     */
    async function nextSeq(client, projectId) {
        const { rows } = await client.query(
            'UPDATE projects SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq',
            [projectId],
        );
        return rows.length ? Number(rows[0].event_seq) : null;
    }

    /**
     * @param {string} projectId
     * @param {number} seq
     */
    async function insertEvent(client, projectId, seq, ev) {
        const id = crypto.randomUUID();
        await client.query(
            `INSERT INTO project_events (id, project_id, seq, kind, actor_id, target_type, target_id, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, projectId, seq, ev.kind, ev.actorId || null, ev.targetType || null, ev.targetId || null, JSON.stringify(ev.payload || {})],
        );
        return { id, seq, kind: ev.kind, actorId: ev.actorId || null, targetType: ev.targetType || null, targetId: ev.targetId || null, payload: ev.payload || {} };
    }

    /**
     * The audit row and its live event, written together.
     *
     * @param {string} projectId
     * @param {{ action: string, actorId?: string|null, actorKind?: string, targetType?: string|null,
     *   targetId?: string|null, itemType?: string|null, itemId?: string|null, versionId?: string|null,
     *   details?: object, eventKind?: string, payload?: object }} entry
     * @returns {Promise<{ activityId: string, event: object } | null>}  null when the project is gone or the write failed
     */
    async function recordActivityEvent(projectId, entry) {
        await ready();
        if (!projectId || !entry || !entry.action) return null;
        const actorKind = ACTOR_KINDS.has(String(entry.actorKind)) ? entry.actorKind : 'user';
        const details = entry.details || {};
        return inTransaction('recordActivityEvent', async (client) => {
            const seq = await nextSeq(client, projectId);
            if (seq === null) return null;
            const activityId = crypto.randomUUID();
            await client.query(
                `INSERT INTO project_activity (id, project_id, actor_id, actor_kind, action, target_type, target_id,
                                               item_type, item_id, version_id, details, seq, updated_at, emitted_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
                [activityId, projectId, entry.actorId || null, actorKind, entry.action, entry.targetType || null,
                    entry.targetId || null, entry.itemType || null, entry.itemId || null, entry.versionId || null,
                    JSON.stringify(details), seq],
            );
            const event = await insertEvent(client, projectId, seq, {
                kind: entry.eventKind || entry.action,
                actorId: entry.actorId,
                targetType: entry.targetType,
                targetId: entry.targetId,
                payload: entry.payload || details,
            });
            return { activityId, event };
        });
    }

    /**
     * Fold one content edit into the editing session of this actor on this item,
     * or start a new session. See the header for the rules.
     *
     * @param {string} projectId
     * @param {{ itemType: string, itemId: string, actorId?: string|null, actorKind?: string,
     *   versionId?: string|null, sessionGapMs: number, emitEveryMs: number,
     *   merge: (previous: object|null) => object,
     *   eventOf: (details: object, activityId: string) => { kind: string, payload: object } }} entry
     * @returns {Promise<{ activityId: string, folded: boolean, details: object, event: object|null } | null>}
     */
    async function recordContentSession(projectId, entry) {
        await ready();
        if (!projectId || !entry || !entry.itemType || !entry.itemId) return null;
        const actorKind = ACTOR_KINDS.has(String(entry.actorKind)) ? entry.actorKind : 'user';
        const actorId = entry.actorId || null;
        return inTransaction('recordContentSession', async (client) => {
            // The project row's lock serialises every writer of this project's
            // feed, so two saves of one session cannot both start a new row.
            const locked = await client.query('SELECT event_seq FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
            if (!locked.rows.length) return null;
            const { rows } = await client.query(
                `SELECT id, details, (emitted_at IS NULL OR emitted_at < NOW() - ($6::int * INTERVAL '1 millisecond')) AS due
                   FROM project_activity
                  WHERE project_id = $1 AND action = 'content.edited'
                    AND item_type = $2 AND item_id = $3
                    AND actor_kind = $4 AND actor_id IS NOT DISTINCT FROM $5
                    AND COALESCE(updated_at, created_at) > NOW() - ($7::int * INTERVAL '1 millisecond')
                  ORDER BY COALESCE(updated_at, created_at) DESC
                  LIMIT 1
                  FOR UPDATE`,
                [projectId, entry.itemType, entry.itemId, actorKind, actorId,
                    Math.max(0, Math.round(entry.emitEveryMs)), Math.max(1, Math.round(entry.sessionGapMs))],
            );
            const open = rows[0] || null;
            const details = entry.merge(open ? (open.details || {}) : null);
            const activityId = open ? open.id : crypto.randomUUID();
            const emit = !open || open.due === true;
            let event = null;
            /** @type {number | null} */
            let seq = null;
            if (emit) {
                seq = await nextSeq(client, projectId);
                if (seq === null) return null;
                const ev = entry.eventOf(details, activityId);
                event = await insertEvent(client, projectId, seq, {
                    kind: ev.kind, actorId, targetType: entry.itemType, targetId: entry.itemId, payload: ev.payload,
                });
            }
            if (open) {
                await client.query(
                    `UPDATE project_activity
                        SET details = $2, version_id = COALESCE($3, version_id), updated_at = NOW(),
                            seq = COALESCE($4, seq), emitted_at = CASE WHEN $4::bigint IS NULL THEN emitted_at ELSE NOW() END
                      WHERE id = $1`,
                    [activityId, JSON.stringify(details), entry.versionId || null, seq],
                );
            } else {
                await client.query(
                    `INSERT INTO project_activity (id, project_id, actor_id, actor_kind, action, target_type, target_id,
                                                   item_type, item_id, version_id, details, seq, updated_at, emitted_at)
                     VALUES ($1, $2, $3, $4, 'content.edited', $5, $6, $5, $6, $7, $8, $9, NOW(), NOW())`,
                    [activityId, projectId, actorId, actorKind, entry.itemType, entry.itemId,
                        entry.versionId || null, JSON.stringify(details), seq],
                );
            }
            return { activityId, folded: !!open, details, event };
        });
    }

    return { recordActivityEvent, recordContentSession };
}

/**
 * Reading the change feed and the change log, and erasing a person's marks.
 * @param {Parameters<typeof makeProjectChangeFns>[0]} ctx
 */
function makeFeedReadFns({ getAll, run, ready }) {
    /**
     * Content-change rows touched after `sinceAt`, newest first: sessions and
     * the other content actions, plus filing of items the feed follows.
     * `excludeActorId` hides the reader's own changes (their AI's included).
     *
     * @param {string} projectId
     * @param {{ sinceAt?: string|null, excludeActorId?: string|null, limit?: number }} [opts]
     */
    async function listChangeRows(projectId, { sinceAt = null, excludeActorId = null, limit = 500 } = {}) {
        await ready();
        if (!projectId || !sinceAt) return [];
        const rows = await getAll(
            `SELECT * FROM project_activity
              WHERE project_id = $1
                AND COALESCE(updated_at, created_at) > $2
                AND actor_id IS DISTINCT FROM $3
                AND (action = ANY($4::text[])
                     OR (action = ANY($5::text[]) AND target_type = ANY($6::text[])))
              ORDER BY COALESCE(updated_at, created_at) DESC
              LIMIT $7`,
            [projectId, sinceAt, excludeActorId, CONTENT_ACTIONS, FILING_ACTIONS, CHANGE_ITEM_TYPES,
                Math.min(Math.max(1, limit), 2000)],
        );
        return rows.map(mapActivityRow);
    }

    /** The "Changes only" activity page: content rows, newest session first. */
    async function listChangeLog(projectId, { limit = 50, offset = 0 } = {}) {
        await ready();
        if (!projectId) return [];
        const rows = await getAll(
            `SELECT * FROM project_activity
              WHERE project_id = $1
                AND (action = ANY($2::text[])
                     OR (action = ANY($3::text[]) AND target_type = ANY($4::text[])))
              ORDER BY created_at DESC, id
              LIMIT $5 OFFSET $6`,
            [projectId, CONTENT_ACTIONS, FILING_ACTIONS, CHANGE_ITEM_TYPES,
                Math.min(Math.max(1, limit), 200), Math.max(0, offset)],
        );
        return rows.map(mapActivityRow);
    }

    /**
     * A member's traces in the change feed's read state, for account erasure:
     * their visit marks and what they last saw. Audit rows they authored stay
     * (they carry an id and counts, and the feed shows an erased author as a
     * former member).
     */
    // stepwise: account erasure; each step is idempotent and reported, and erasing again finishes a failed one
    async function eraseUserChangeState(userId) {
        await ready();
        if (!userId) return { memberState: 0, itemReads: 0 };
        const a = await run('DELETE FROM project_member_state WHERE user_id = $1', [userId]);
        const b = await run('DELETE FROM project_item_reads WHERE user_id = $1', [userId]);
        return { memberState: a.rowCount || 0, itemReads: b.rowCount || 0 };
    }

    return { listChangeRows, listChangeLog, eraseUserChangeState };
}

/**
 * @param {{
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   run: (sql: string, params?: any[]) => Promise<{ rowCount: number }>,
 *   withTransaction: (fn: (client: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }) => Promise<any>) => Promise<any>,
 *   ready: () => Promise<unknown>,
 * }} db
 */
function makeProjectChangeFns(db) {
    return { ...makeRecordingFns(db), ...makeSeenFns(db), ...makeFeedReadFns(db) };
}

module.exports = {
    makeProjectChangeFns,
    mapActivityRow,
    CONTENT_ACTIONS,
    FILING_ACTIONS,
    CHANGE_ITEM_TYPES,
};

/** @typedef {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} TxClient */

// @typecheck strict
/**
 * A member's visit and seen marks in a project (`project_member_state`) and
 * what they last saw of each item (`project_item_reads`): the reading side of
 * stores/projectChanges.js, which composes these functions into its own.
 */

'use strict';

/** @param {unknown} v */
const iso = (v) => (v instanceof Date ? v.toISOString() : (typeof v === 'string' && v ? new Date(v).toISOString() : null));

/** @param {import('pg').QueryResultRow | null | undefined} r */
function mapMemberState(r) {
    if (!r) return null;
    return {
        seenSeq: Number(r.seen_seq) || 0,
        seenAt: iso(r.seen_at),
        prevVisitSeq: Number(r.prev_visit_seq) || 0,
        prevVisitAt: iso(r.prev_visit_at),
        visitStartedAt: iso(r.visit_started_at),
        lastVisitAt: iso(r.last_visit_at),
        firstVisitAt: iso(r.first_visit_at),
    };
}

/**
 * @param {{
 *   getOne: (sql: string, params?: unknown[]) => Promise<import('pg').QueryResultRow | null | undefined>,
 *   getAll: (sql: string, params?: unknown[]) => Promise<import('pg').QueryResultRow[]>,
 *   ready: () => Promise<unknown>,
 * }} db
 */
function makeSeenFns({ getOne, getAll, ready }) {
    /**
     * A member opened the project. A visit that starts more than `gapMs` after
     * the previous ping begins a NEW visit: what the previous one last saw
     * becomes `prevVisitAt`, the stable "since your last visit" line for the
     * whole of this one. A ping inside a visit only extends it.
     *
     * @param {string} projectId
     * @param {string} userId
     * @param {{ gapMs?: number }} [opts]
     * @returns {Promise<object|null>} the member state after the visit
     */
    async function recordVisit(projectId, userId, { gapMs = 30 * 60 * 1000 } = {}) {
        await ready();
        if (!projectId || !userId) return null;
        const row = await getOne(
            `INSERT INTO project_member_state AS s
                    (project_id, user_id, first_visit_at, visit_started_at, last_visit_at, last_visit_seq)
             SELECT p.id, $2, NOW(), NOW(), NOW(), p.event_seq FROM projects p WHERE p.id = $1
             ON CONFLICT (project_id, user_id) DO UPDATE SET
                prev_visit_at = CASE WHEN s.last_visit_at IS NULL OR s.last_visit_at < NOW() - ($3::int * INTERVAL '1 millisecond')
                                     THEN s.last_visit_at ELSE s.prev_visit_at END,
                prev_visit_seq = CASE WHEN s.last_visit_at IS NULL OR s.last_visit_at < NOW() - ($3::int * INTERVAL '1 millisecond')
                                      THEN s.last_visit_seq ELSE s.prev_visit_seq END,
                visit_started_at = CASE WHEN s.last_visit_at IS NULL OR s.last_visit_at < NOW() - ($3::int * INTERVAL '1 millisecond')
                                        THEN NOW() ELSE s.visit_started_at END,
                last_visit_at = NOW(),
                last_visit_seq = EXCLUDED.last_visit_seq
             RETURNING *`,
            [projectId, userId, Math.max(1, Math.round(gapMs))],
        );
        return mapMemberState(row);
    }

    /**
     * "Mark everything as seen": the watermark moves to now and to the feed head.
     * @param {string} projectId
     * @param {string} userId
     */
    async function markAllSeen(projectId, userId) {
        await ready();
        if (!projectId || !userId) return null;
        const row = await getOne(
            `INSERT INTO project_member_state AS s (project_id, user_id, first_visit_at, seen_at, seen_seq)
             SELECT p.id, $2, NOW(), NOW(), p.event_seq FROM projects p WHERE p.id = $1
             ON CONFLICT (project_id, user_id) DO UPDATE SET
                seen_at = NOW(), seen_seq = GREATEST(s.seen_seq, EXCLUDED.seen_seq)
             RETURNING *`,
            [projectId, userId],
        );
        return mapMemberState(row);
    }

    /**
     * @param {string} projectId
     * @param {string} userId
     */
    async function getMemberState(projectId, userId) {
        await ready();
        if (!projectId || !userId) return null;
        return mapMemberState(await getOne(
            'SELECT * FROM project_member_state WHERE project_id = $1 AND user_id = $2',
            [projectId, userId],
        ));
    }

    /**
     * The member has seen this item now. `versionId` is the version they were
     * shown; without one, the latest version the change feed knows for the
     * item stands in, so "Show changes" later starts from what they saw.
     * @param {string} projectId
     * @param {string} userId
     * @param {string} itemType
     * @param {string} itemId
     * @param {string | null} [versionId]
     */
    async function markItemSeen(projectId, userId, itemType, itemId, versionId = null) {
        await ready();
        if (!projectId || !userId || !itemType || !itemId) return null;
        const row = await getOne(
            `INSERT INTO project_item_reads AS r (project_id, user_id, item_type, item_id, seen_at, seen_version_id)
             VALUES ($1, $2, $3, $4, NOW(), COALESCE($5, (
                 SELECT a.version_id FROM project_activity a
                  WHERE a.project_id = $1 AND a.item_type = $3 AND a.item_id = $4 AND a.version_id IS NOT NULL
                  ORDER BY COALESCE(a.updated_at, a.created_at) DESC LIMIT 1)))
             ON CONFLICT (project_id, user_id, item_type, item_id) DO UPDATE SET
                seen_at = NOW(), seen_version_id = COALESCE(EXCLUDED.seen_version_id, r.seen_version_id)
             RETURNING seen_at, seen_version_id`,
            [projectId, userId, itemType, itemId, versionId || null],
        );
        return row ? { seenAt: iso(row.seen_at), seenVersionId: row.seen_version_id || null } : null;
    }

    /**
     * What this member last saw of these items, keyed `type:id`.
     * @param {string} projectId
     * @param {string} userId
     * @param {Array<{ type: string, id: string }>} items
     */
    async function listItemReads(projectId, userId, items) {
        await ready();
        const out = new Map();
        const list = Array.isArray(items) ? items.filter((i) => i && i.type && i.id) : [];
        if (!projectId || !userId || !list.length) return out;
        const rows = await getAll(
            `SELECT item_type, item_id, seen_at, seen_version_id FROM project_item_reads
              WHERE project_id = $1 AND user_id = $2
                AND (item_type || ':' || item_id) = ANY($3::text[])`,
            [projectId, userId, list.map((i) => `${i.type}:${i.id}`)],
        );
        for (const r of rows) out.set(`${r.item_type}:${r.item_id}`, { seenAt: iso(r.seen_at), seenVersionId: r.seen_version_id || null });
        return out;
    }

    return { recordVisit, markAllSeen, getMemberState, markItemSeen, listItemReads };
}

module.exports = { makeSeenFns };

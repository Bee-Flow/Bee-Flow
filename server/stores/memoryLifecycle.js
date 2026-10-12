'use strict';

/**
 * Memory lifecycle — the status transitions of a user_memories row.
 *
 *   active ──supersede──▶ superseded      (a newer value replaced it; kept as history)
 *   superseded ◀─restorePredecessorOf──   (the new row was undone; only if it is the chain head)
 *   active ──archive──▶ archived ──restore──▶ active
 *   pending_review ──approve──▶ active
 *
 * Store layer: plain SQL over the db facade, no core/ requires. Nothing here
 * reads or writes the sealed text columns, so none of it needs the encryption
 * context. The db is injectable (`createLifecycle(db)`) so the transitions can
 * be tested against pglite without module mocks; the module exports are bound
 * to the real db lazily.
 *
 * `userId` arguments are optional ownership guards: pass one wherever the id
 * comes from a request, leave it out for system jobs.
 */

const SCHEDULE_COVERAGE_TYPE = 'schedule_coverage';

/** Same decay as the rest of memory scoring: a month halves the recency term. */
const RECENCY_SQL = `1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - COALESCE(last_used_at, last_confirmed_at, created_at))) / 2592000.0)`;

function createLifecycle(db) {
    const owner = (params, userId) => {
        if (!userId) return '';
        params.push(userId);
        return ` AND user_id = $${params.length}`;
    };
    const idList = (ids) => (Array.isArray(ids) ? ids : [ids]).filter((i) => typeof i === 'string' && i);

    /** old → superseded by new, valid until now. Only an active/pending row moves. */
    async function supersede(oldId, newId) {
        if (!oldId || !newId || oldId === newId) return 0;
        const r = await db.run(
            `UPDATE user_memories SET status = 'superseded', superseded_by = $2, valid_to = NOW(), updated_at = NOW()
              WHERE id = $1 AND status = 'active'`, [oldId, newId]);
        return r?.rowCount || 0;
    }

    /**
     * The chat chip's Undo deletes the new row `memoryId`; this puts the fact it
     * replaced back. CALL IT BEFORE THE DELETE: it has to read the row's status.
     *
     *  - the row is the active head of its chain: its predecessors become active
     *    again, unless another active row already holds the same key in the same
     *    scope (never two active rows for one key);
     *  - the row is itself superseded (A -> B -> C, B deleted): nothing is
     *    reactivated, the predecessors are re-pointed at B's successor
     *    (A.superseded_by = C), so the chain stays consistent;
     *  - any other status (archived, pending_review) or a row that is gone: nothing.
     *
     * Returns the number of predecessors reactivated.
     */
    async function restorePredecessorOf(memoryId, userId = null) {
        if (!memoryId) return 0;
        const params = [memoryId];
        const own = owner(params, userId);
        const r = await db.run(
            `UPDATE user_memories p SET status = 'active', valid_to = NULL, superseded_by = NULL, updated_at = NOW()
               FROM user_memories d
              WHERE d.id = $1 AND d.status = 'active'${own.replace('user_id', 'd.user_id')}
                AND p.superseded_by = d.id AND p.status = 'superseded'
                AND NOT EXISTS (
                    SELECT 1 FROM user_memories x
                     WHERE x.status = 'active' AND x.id <> d.id AND x.id <> p.id
                       AND d.key_hash IS NOT NULL AND x.key_hash = d.key_hash AND x.type = d.type
                       AND x.user_id = d.user_id AND x.project_id IS NOT DISTINCT FROM d.project_id
                       AND x.agent_id IS NOT DISTINCT FROM d.agent_id)`, params);
        const params2 = [memoryId];
        const own2 = owner(params2, userId);
        await db.run(
            `UPDATE user_memories p SET superseded_by = d.superseded_by, updated_at = NOW()
               FROM user_memories d
              WHERE d.id = $1 AND d.status = 'superseded' AND d.superseded_by IS NOT NULL${own2.replace('user_id', 'd.user_id')}
                AND p.superseded_by = d.id AND p.status = 'superseded'`, params2);
        return r?.rowCount || 0;
    }

    async function archive(ids, userId = null) {
        const list = idList(ids);
        if (list.length === 0) return 0;
        const params = [list];
        const r = await db.run(
            `UPDATE user_memories SET status = 'archived', archived_at = NOW(), updated_at = NOW()
              WHERE id = ANY($1::text[]) AND status = 'active'${owner(params, userId)}`, params);
        return r?.rowCount || 0;
    }

    async function restore(id, userId = null) {
        if (!id) return 0;
        const params = [id];
        const r = await db.run(
            `UPDATE user_memories SET status = 'active', archived_at = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'archived'${owner(params, userId)}`, params);
        return r?.rowCount || 0;
    }

    /**
     * pending_review → active. The approved row is the newer statement, so an
     * active row with the same key in the same scope is superseded by it.
     * Two guarded statements: the approval first (it decides whether we are
     * the one who activates), then the predecessor, which excludes the row
     * itself and only moves an active row.
     */
    async function approve(id, userId = null) {
        if (!id) return 0;
        const params = [id];
        const r = await db.run(
            `UPDATE user_memories SET status = 'active', updated_at = NOW()
              WHERE id = $1 AND status = 'pending_review'${owner(params, userId)}`, params);
        const n = r?.rowCount || 0;
        if (n > 0) {
            await db.run(
                `UPDATE user_memories o SET status = 'superseded', superseded_by = n.id, valid_to = NOW(), updated_at = NOW()
                   FROM user_memories n
                  WHERE n.id = $1 AND n.key_hash IS NOT NULL AND o.id <> n.id AND o.status = 'active'
                    AND o.key_hash = n.key_hash AND o.type = n.type
                    AND o.user_id = n.user_id AND o.project_id IS NOT DISTINCT FROM n.project_id
                    AND o.agent_id IS NOT DISTINCT FROM n.agent_id`, [id]);
            // A pending row that waited against an explicit memory without a
            // canonical key (judge path) names the row it replaces; the same
            // user's still-active row is superseded now. Never a second active row.
            await db.run(
                `UPDATE user_memories o SET status = 'superseded', superseded_by = n.id, valid_to = NOW(), updated_at = NOW()
                   FROM user_memories n
                  WHERE n.id = $1 AND n.replaces_id IS NOT NULL AND o.id = n.replaces_id
                    AND o.id <> n.id AND o.status = 'active' AND o.user_id = n.user_id`, [id]);
        }
        return n;
    }

    /** Seen again: a little more confidence, and the clock for retention restarts. */
    async function confirm(id, userId = null) {
        if (!id) return 0;
        const params = [id];
        const r = await db.run(
            `UPDATE user_memories SET last_confirmed_at = NOW(), confidence = LEAST(1.0, COALESCE(confidence, 0.8) + 0.05), updated_at = NOW()
              WHERE id = $1 AND status IN ('active', 'pending_review')${owner(params, userId)}`, params);
        return r?.rowCount || 0;
    }

    /**
     * Keep a user's personal active memories at or under `maxPerUser`: archive
     * the lowest-value ones beyond it (score = importance + recency). Explicit
     * memories and instructions are never touched, so a user who wrote more
     * than the cap keeps all of it. Returns the number archived.
     */
    async function enforceCap(userId, maxPerUser) {
        const cap = Math.floor(Number(maxPerUser));
        if (!userId || !Number.isFinite(cap) || cap < 0) return 0;
        const r = await db.run(
            `UPDATE user_memories SET status = 'archived', archived_at = NOW(), updated_at = NOW()
              WHERE id IN (
                SELECT id FROM user_memories
                 WHERE user_id = $1 AND project_id IS NULL AND status = 'active' AND type <> $3
                   AND COALESCE(origin, 'inferred') <> 'explicit' AND type <> 'instruction'
                 ORDER BY (COALESCE(importance, 0.5) + ${RECENCY_SQL}) ASC, created_at ASC
                 LIMIT GREATEST(0, (SELECT COUNT(*) FROM user_memories
                                     WHERE user_id = $1 AND project_id IS NULL AND status = 'active' AND type <> $3) - $2)
              )`, [userId, cap, SCHEDULE_COVERAGE_TYPE]);
        return r?.rowCount || 0;
    }

    return { supersede, restorePredecessorOf, archive, restore, approve, confirm, enforceCap };
}

let _real = null;
const real = () => (_real ||= createLifecycle(require('../db')));

module.exports = {
    createLifecycle,
    supersede: (...a) => real().supersede(...a),
    restorePredecessorOf: (...a) => real().restorePredecessorOf(...a),
    archive: (...a) => real().archive(...a),
    restore: (...a) => real().restore(...a),
    approve: (...a) => real().approve(...a),
    confirm: (...a) => real().confirm(...a),
    enforceCap: (...a) => real().enforceCap(...a),
};

// @typecheck
/**
 * automation_shares — who a routine is shared with, and in which role
 * (Studio → Automations handoff 5). The table comes from
 * migrations/automation-handoff5-2026-09.js; the rules about what a role
 * allows live in automation/access.js, not here.
 *
 * Built by a factory over a `{ query, tx }` handle, like lifecycle.js, so the
 * pg test can run it against PGlite without mocking the module system.
 */

'use strict';

const crypto = require('crypto');
const { AUTOMATION_SELECT } = require('./lifecycle');

const ROLE_RANK_SQL = `CASE s.role WHEN 'edit' THEN 3 WHEN 'view' THEN 2 WHEN 'run' THEN 1 ELSE 0 END`;
const RANK_ROLE = { 3: 'edit', 2: 'view', 1: 'run' };

function rowToShare(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        principalType: r.principal_type,
        principalId: r.principal_id,
        role: r.role,
        createdBy: r.created_by ?? null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/**
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeSharesStore(db, { ready = async () => {} } = {}) {
    const { rowToAutomation } = require('./rowMappers');

    /** Every share of one routine, oldest first. */
    async function listSharesForAutomation(automationId) {
        await ready();
        const r = await db.query(
            `SELECT * FROM automation_shares WHERE automation_id = $1 ORDER BY created_at ASC, id ASC`,
            [automationId],
        );
        return r.rows.map(rowToShare);
    }

    /**
     * Replace the whole share list of one routine in one transaction. The
     * route has validated every principal; this writes what it is given.
     * A share that stays the same keeps its row (and its created_at/by).
     *
     * @param {string} automationId
     * @param {Array<{ principalType: 'user'|'group', principalId: string, role: 'run'|'view'|'edit' }>} shares
     * @param {string|null} byUserId
     */
    async function replaceSharesForAutomation(automationId, shares, byUserId = null) {
        await ready();
        await db.tx(async (q) => {
            const keep = shares.map(s => `${s.principalType}:${s.principalId}`);
            await q.query(
                `DELETE FROM automation_shares
                  WHERE automation_id = $1
                    AND NOT ((principal_type || ':' || principal_id) = ANY($2::text[]))`,
                [automationId, keep],
            );
            for (const s of shares) {
                await q.query(
                    // clock_timestamp(), not the column default NOW(): NOW() is
                    // the transaction's start, so every row of one save would
                    // share it and "oldest first" would fall back to random ids.
                    `INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role, created_by, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
                     ON CONFLICT (automation_id, principal_type, principal_id) DO UPDATE SET role = EXCLUDED.role`,
                    [crypto.randomUUID(), automationId, s.principalType, s.principalId, s.role, byUserId],
                );
            }
        });
        return listSharesForAutomation(automationId);
    }

    /**
     * The routines shared with one person — directly or through one of their
     * groups — in their own organisation, not in the trash, not their own.
     * Each row is an automation plus `myRole` (the strongest matching share)
     * and `owner: { userId, name }`.
     *
     * @param {string} userId
     * @param {{ orgId?: string|null, groupIds?: string[] }} [opts]
     */
    async function listAutomationsSharedWithUser(userId, { orgId, groupIds = [] } = {}) {
        await ready();
        if (!userId || !orgId) return [];
        const r = await db.query(
            `SELECT base.*, sr.rank AS share_rank,
                    COALESCE(NULLIF(o."displayName", ''), o.username) AS owner_name
               FROM (${AUTOMATION_SELECT}
                      WHERE a.deleted_at IS NULL
                        AND COALESCE(a.kind, 'automation') = 'automation'
                        AND a.user_id <> $1) base
               JOIN (SELECT s.automation_id, MAX(${ROLE_RANK_SQL}) AS rank
                       FROM automation_shares s
                      WHERE (s.principal_type = 'user' AND s.principal_id = $1)
                         OR (s.principal_type = 'group' AND s.principal_id = ANY($2::text[]))
                      GROUP BY s.automation_id) sr ON sr.automation_id = base.id
               LEFT JOIN users o ON o.id = base.user_id
              WHERE COALESCE(base.organization_id, o."organizationId") = $3
              ORDER BY base.updated_at DESC`,
            [userId, groupIds, orgId],
        );
        // Assigned onto the mapped row, not spread: a spread drops the row's
        // non-enumerable live copy (rowMappers.js), and a run-only caller's
        // list row shows the triggers of the LIVE definition (access.js).
        return r.rows.map((row) => {
            // The list row carries two extra fields the mapped row type lacks.
            const a = /** @type {ReturnType<typeof rowToAutomation> & { myRole?: string | null, owner?: { userId: string, name: string | null } }} */ (rowToAutomation(row));
            a.myRole = RANK_ROLE[row.share_rank] || null;
            a.owner = { userId: row.user_id, name: row.owner_name || null };
            return a;
        }).filter(a => a.myRole);
    }

    /**
     * How many active members of `orgId` belong to each group. A `users.groups`
     * value that is not a JSON array counts as no groups. Returns a Map.
     *
     * @param {string} orgId
     * @param {string[]} groupIds
     */
    async function countGroupMembers(orgId, groupIds) {
        await ready();
        const out = new Map();
        if (!orgId || !groupIds?.length) return out;
        const r = await db.query(
            `SELECT g.gid, COUNT(*)::int AS n
               FROM users u
              CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN u.groups IS NOT NULL AND u.groups::text ~ '^\\s*\\[.*\\]\\s*$'
                         THEN u.groups::jsonb ELSE '[]'::jsonb END) AS g(gid)
              WHERE u."organizationId" = $1
                AND COALESCE(u.status, 'active') = 'active'
                AND g.gid = ANY($2::text[])
              GROUP BY g.gid`,
            [orgId, groupIds],
        );
        for (const row of r.rows) out.set(row.gid, Number(row.n) || 0);
        return out;
    }

    /**
     * Hand a routine to someone else. One transaction:
     *   - automations.user_id becomes the new owner (runs execute as them);
     *   - the new owner's own user share goes (they own it now);
     *   - the previous owner keeps `edit`, so they are not locked out of work
     *     they built. The new owner can take that away like any other share.
     *
     * Answers null when the routine is gone, trashed, or no longer owned by
     * `fromUserId` (a concurrent transfer won).
     *
     * @param {string} automationId
     * @param {{ fromUserId: string, toUserId: string, byUserId?: string|null }} who
     */
    async function transferAutomationOwner(automationId, { fromUserId, toUserId, byUserId = null }) {
        await ready();
        const moved = await db.tx(async (q) => {
            const upd = await q.query(
                `UPDATE automations SET user_id = $2, updated_at = NOW()
                  WHERE id = $1 AND user_id = $3 AND deleted_at IS NULL
                  RETURNING id`,
                [automationId, toUserId, fromUserId],
            );
            if (!upd.rows.length) return false;
            await q.query(
                `DELETE FROM automation_shares
                  WHERE automation_id = $1 AND principal_type = 'user' AND principal_id = $2`,
                [automationId, toUserId],
            );
            await q.query(
                `INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role, created_by)
                 VALUES ($1, $2, 'user', $3, 'edit', $4)
                 ON CONFLICT (automation_id, principal_type, principal_id) DO UPDATE SET role = 'edit'`,
                [crypto.randomUUID(), automationId, fromUserId, byUserId],
            );
            return true;
        });
        if (!moved) return null;
        const r = await db.query(`${AUTOMATION_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [automationId]);
        return rowToAutomation(r.rows[0] || null);
    }

    return {
        listSharesForAutomation,
        replaceSharesForAutomation,
        listAutomationsSharedWithUser,
        countGroupMembers,
        transferAutomationOwner,
    };
}

// The instance the app uses: the pool, behind the store's schema init.
const { initDB, pool, getClient } = require('./core');
const defaultStore = makeSharesStore({
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            const out = await fn({ query: (sql, params) => client.query(sql, params) });
            await client.query('COMMIT');
            return out;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    },
}, { ready: initDB });

module.exports = {
    makeSharesStore,
    rowToShare,
    listSharesForAutomation: defaultStore.listSharesForAutomation,
    replaceSharesForAutomation: defaultStore.replaceSharesForAutomation,
    listAutomationsSharedWithUser: defaultStore.listAutomationsSharedWithUser,
    countGroupMembers: defaultStore.countGroupMembers,
    transferAutomationOwner: defaultStore.transferAutomationOwner,
};

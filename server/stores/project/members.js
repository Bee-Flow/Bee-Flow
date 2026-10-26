// @typecheck strict
/**
 * stores/project/members.js — sharing (invite, role, revoke), ownership
 * hand-over and transfer, and the access check. Split out of
 * stores/projectStore.js; built per store by makeProjectStore.
 */

const crypto = require('crypto');
const { normalizePermission } = require('./rows');

/**
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<any>,
 *   initDB: () => Promise<unknown>,
 *   refuseStageBound: (projectId: string) => Promise<void>,
 * }} ctx  the store's db facade and schema init (built by makeProjectStore)
 */
function makeMemberFns({ run, getOne, getAll, initDB, refuseStageBound }) {
    // ── Sharing ──────────────────────────────────────────────

    /**
     * Invite a user or group, or change their permission if already invited.
     *
     * A single upsert, not check-then-insert. The old shape raced: two concurrent
     * invites both saw "no existing row" and both inserted, producing a duplicate
     * membership that made a later revocation a no-op (unshareProject removes one
     * row by id; getProjectRole picks the best of whatever remains).
     *
     * Returns the share id — the existing one when this was an update.
     * @param {string} [permission]
     * @param {string} projectId
     * @param {string} sharedWithType
     * @param {string} sharedWithId
     */
    async function shareProject(projectId, sharedWithType, sharedWithId, permission = 'viewer', invitedBy = null) {
        await initDB();
        const perm = normalizePermission(permission);
        const id = crypto.randomUUID();
        const row = await getOne(
            `INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission, invited_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (project_id, shared_with_type, shared_with_id)
             DO UPDATE SET permission = EXCLUDED.permission
             RETURNING id`,
            [id, projectId, sharedWithType, sharedWithId, perm, invitedBy]
        );
        return row?.id || id;
    }

    /** @param {string} shareId */
    async function getShareById(shareId) {
        await initDB();
        const r = await getOne('SELECT * FROM project_shares WHERE id = $1', [shareId]);
        if (!r) return null;
        return {
            id: r.id,
            projectId: r.project_id,
            sharedWithType: r.shared_with_type,
            sharedWithId: r.shared_with_id,
            permission: r.permission,
            invitedBy: r.invited_by,
            createdAt: r.created_at,
        };
    }

    /**
     * @param {string} role
     * @param {string} shareId
     */
    async function updateMemberRole(shareId, role) {
        await initDB();
        const perm = normalizePermission(role);
        const { rowCount } = await run(
            'UPDATE project_shares SET permission = $1 WHERE id = $2',
            [perm, shareId]
        );
        return rowCount > 0;
    }

    /**
     * Hand a project over when its owner goes away: the longest-standing EDITOR (a person, by when they were
     * added) becomes the owner, and their share row goes, since the owner is not also a member. Nobody is
     * promoted over their head: a project with no editor returns null and the caller decides.
     *
     * One statement, so two hand-overs cannot pick different people, and the owner is only replaced while
     * still the one being erased.
     *
     * @param {string} projectId
     * @param {string} fromOwnerId  the owner being replaced
     * @returns {Promise<string|null>} the new owner's id
     */
    async function handOverProject(projectId, fromOwnerId) {
        await initDB();
        // A stage runs as its Solution owner, so neither a stage nor a Dev
        // project with stages changes hands this way (the stages first).
        await refuseStageBound(projectId);
        const { rows } = await run(
            `WITH heir AS (
                 SELECT id, shared_with_id FROM project_shares
                  WHERE project_id = $1 AND shared_with_type = 'user' AND permission = 'editor'
                    AND shared_with_id <> $2
                  ORDER BY created_at, id LIMIT 1
             ), moved AS (
                 UPDATE projects SET owner_id = (SELECT shared_with_id FROM heir), updated_at = NOW()
                  WHERE id = $1 AND owner_id = $2 AND EXISTS (SELECT 1 FROM heir)
                  RETURNING owner_id
             ), dropped AS (
                 DELETE FROM project_shares WHERE id IN (SELECT id FROM heir) AND EXISTS (SELECT 1 FROM moved)
             )
             SELECT owner_id FROM moved`,
            [projectId, fromOwnerId]
        );
        return rows?.[0]?.owner_id || null;
    }

    /**
     * Hand a project to a named person (the owner's own choice, or an org admin's rescue of an orphan).
     * One statement, so the owner is only replaced while still the one the caller saw: a concurrent
     * transfer leaves this one a no-op ({ ok: false, reason: 'owner_changed' }) and writes nothing.
     *
     * The new owner is not also a member, so their user share goes; the old owner stays on as
     * `keepFromAs` ('editor' | 'viewer'), or not at all ('none'). A stage-bound project refuses (409),
     * as for handOverProject.
     *
     * @param {{ projectId: string, fromUserId: string, toUserId: string, keepFromAs?: 'editor'|'viewer'|'none' }} args
     * @returns {Promise<{ ok: true } | { ok: false, reason: 'owner_changed' }>}
     */
    async function transferOwner({ projectId, fromUserId, toUserId, keepFromAs = 'none' }) {
        await initDB();
        await refuseStageBound(projectId);
        const keep = keepFromAs === 'editor' || keepFromAs === 'viewer' ? keepFromAs : null;
        const { rows } = await run(
            `WITH moved AS (
                 UPDATE projects SET owner_id = $3, updated_at = NOW(), version = COALESCE(version, 0) + 1
                  WHERE id = $1 AND owner_id = $2
                  RETURNING id
             ), dropped AS (
                 DELETE FROM project_shares
                  WHERE project_id = $1 AND shared_with_type = 'user' AND shared_with_id = $3
                    AND EXISTS (SELECT 1 FROM moved)
             ), kept AS (
                 INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission, invited_by)
                 SELECT $4::text, $1, 'user', $2, $5::text, $3
                  WHERE $5::text IS NOT NULL AND EXISTS (SELECT 1 FROM moved)
                 ON CONFLICT (project_id, shared_with_type, shared_with_id)
                 DO UPDATE SET permission = EXCLUDED.permission
             )
             SELECT id FROM moved`,
            [projectId, fromUserId, toUserId, crypto.randomUUID(), keep]
        );
        return rows?.length ? { ok: true } : { ok: false, reason: 'owner_changed' };
    }

    /** @param {string} shareId */
    async function unshareProject(shareId) {
        await initDB();
        const { rowCount } = await run('DELETE FROM project_shares WHERE id = $1', [shareId]);
        return rowCount > 0;
    }

    /** @param {string} projectId */
    async function getProjectShares(projectId) {
        await initDB();
        const rows = await getAll('SELECT * FROM project_shares WHERE project_id = $1 ORDER BY created_at', [projectId]);
        return rows.map(r => ({
            id: r.id,
            projectId: r.project_id,
            sharedWithType: r.shared_with_type,
            sharedWithId: r.shared_with_id,
            permission: r.permission,
            createdAt: r.created_at,
        }));
    }

    // ── Access check ─────────────────────────────────────────

    /**
     * Returns the user's effective role on a project: 'owner' | 'editor' | 'viewer' | null.
     * Owner trumps any share. For non-owners, returns the highest matching share permission
     * across direct user shares and group shares.
     *
     * @param {string} userId
     * @param {string} projectId
     * @param {string[]} groupIds - groups the user belongs to
     */
    async function getProjectRole(userId, projectId, groupIds = []) {
        await initDB();
        if (!userId || !projectId) return null;
        const project = await getOne('SELECT owner_id FROM projects WHERE id = $1', [projectId]);
        if (!project) return null;
        if (project.owner_id === userId) return 'owner';

        const groupArr = (groupIds && groupIds.length > 0) ? groupIds : [''];
        const row = await getOne(`
            SELECT permission FROM project_shares
            WHERE project_id = $1
              AND ((shared_with_type = 'user'  AND shared_with_id = $2)
                OR (shared_with_type = 'group' AND shared_with_id = ANY($3::text[])))
            ORDER BY CASE permission WHEN 'editor' THEN 0 ELSE 1 END
            LIMIT 1
        `, [projectId, userId, groupArr]);
        return row?.permission || null;
    }

    /**
     * Backwards-compatible boolean wrapper. New code should call getProjectRole.
     * @param {string} userId
     * @param {string} projectId
     * @param {string[]} [groupIds]
     */
    async function userHasAccess(userId, projectId, groupIds = []) {
        const role = await getProjectRole(userId, projectId, groupIds);
        return role !== null;
    }

    return {
        shareProject,
        unshareProject,
        handOverProject,
        transferOwner,
        getProjectShares,
        getShareById,
        updateMemberRole,
        getProjectRole,
        userHasAccess,
    };
}

module.exports = { makeMemberFns };

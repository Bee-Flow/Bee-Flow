// @typecheck
/**
 * Who may READ a meeting note: the single-row and list predicate (owner,
 * legacy share, org publish, group publish) and the second path through
 * project membership. Writes stay with the owner and live elsewhere.
 *
 * The predicate builders are pure. The project path asks
 * stores/lib/projectRole.js, which sits in the server's big import cycle, so
 * the barrel (stores/transcriptionStore.js) hands `projectRoleOf` in and the
 * cycle does not grow by the files the store was split into.
 */

const { getOne } = require('../../db');
const { initDB } = require('./schema');

/**
 * The single-row read ACL, as `{ clauses, params }` over `$1 = id`.
 * Factored out so `getTranscription` and `canReadTranscription` cannot drift —
 * a second hand-written copy of this predicate is how "readable" and "actually
 * returned" end up disagreeing.
 */
function buildReadAcl(id, userId, ctx = {}) {
    const acl = readAclClauses(userId, ctx, 1);   // $1 is the id
    return { clauses: acl.clauses, params: [id, ...acl.params] };
}

/**
 * The read predicate on its own, so a LIST can apply the same rule a single
 * row does.
 *
 * `startIdx` is how many placeholders the caller has already used, because a
 * list query binds a tag (and maybe a date) before the ACL. Passing it wrong
 * silently shifts every clause onto the wrong parameter — which for an ACL
 * means comparing `user_id` against a tag name and returning nothing, or
 * worse, against something that matches.
 */
function readAclClauses(userId, { orgIds = [], userGroupIds = [] } = {}, startIdx = 0) {
    const params = [userId, JSON.stringify([userId])];
    const p = (n) => `$${startIdx + n}`;
    const clauses = [`user_id = ${p(1)}`, `shared_with @> ${p(2)}::jsonb`];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgParamIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupParamIdx = params.length;
            clauses.push(
                `(is_published = true AND organization_id = ANY(${p(orgParamIdx)}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| ${p(groupParamIdx)}::text[]))`
            );
        } else {
            clauses.push(
                `(is_published = true AND organization_id = ANY(${p(orgParamIdx)}::text[]) AND shared_groups = '[]'::jsonb)`
            );
        }
    }
    return { clauses, params };
}

/**
 * @param {{ projectRoleOf: (userId: string, projectId: string) => Promise<string|null> }} deps
 */
function createProjectAcl({ projectRoleOf }) {
    /**
     * A note filed into a project the caller is a member of (ANY role; reading is
     * all membership buys here), as `{ row, role }`, or null.
     *
     * @param {string} id
     * @param {string} userId
     * @param {string} columns  what to select; the detail read wants the whole row
     */
    async function readableThroughProject(id, userId, columns = 'id, project_id') {
        if (!id || !userId) return null;
        const row = await getOne(`SELECT ${columns} FROM transcriptions WHERE id = $1 AND project_id IS NOT NULL`, [id]);
        if (!row) return null;
        const role = await projectRoleOf(userId, row.project_id);
        return role ? { row, role } : null;
    }

    /**
     * Can `userId` open this note? Same predicate as `getTranscription`, without
     * paying to shape the row.
     *
     * Used by the import dedup paths: a `source_uri` hit means *somebody* already
     * imported this recording, which is not the same as the caller being allowed
     * to read the result.
     */
    async function canReadTranscription(id, userId, ctx = {}) {
        if (!id) return false;
        await initDB();
        if (ctx.isSuperAdmin) return true;
        const { clauses, params } = buildReadAcl(id, userId, ctx);
        const r = await getOne(
            `SELECT 1 AS ok FROM transcriptions WHERE id = $1 AND (${clauses.join(' OR ')})`,
            params
        );
        if (r) return true;
        // The same second path getTranscription takes, so "readable" and "actually
        // returned" cannot disagree about a project member.
        return !!(await readableThroughProject(id, userId));
    }

    return { readableThroughProject, canReadTranscription };
}

module.exports = { buildReadAcl, readAclClauses, createProjectAcl };

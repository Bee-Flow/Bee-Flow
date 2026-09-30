// @typecheck
/**
 * "What role does this person hold on that project?", for the stores whose
 * rows can be filed into a project (documents, meeting notes).
 *
 * The answer is auth/projectAccess.getProjectRole: groups read fresh from the
 * database and the same owner > editor > viewer ladder every project route
 * enforces. It is required at call time, so loading a store does not load the
 * user and project stores with it.
 *
 * `lookup` is the seam a store test swaps (testUtils/swaps.js) to hand in a
 * role table, instead of reaching into the module system.
 */

const lookup = {
    /**
     * @param {string} userId
     * @param {string} projectId
     * @returns {Promise<'owner'|'editor'|'viewer'|null>}
     */
    roleOf: (userId, projectId) => require('../../auth/projectAccess').getProjectRole(userId, projectId),
};

/**
 * The caller's role on a project, or null for no role, no caller or no project.
 *
 * @param {string|null|undefined} userId
 * @param {string|null|undefined} projectId
 * @returns {Promise<'owner'|'editor'|'viewer'|null>}
 */
async function projectRoleOf(userId, projectId) {
    if (!userId || !projectId) return null;
    return (await lookup.roleOf(userId, projectId)) || null;
}

/** Roles that may change a project's content. */
function canEditAs(role) {
    return role === 'editor' || role === 'owner';
}

module.exports = { projectRoleOf, canEditAs, lookup };

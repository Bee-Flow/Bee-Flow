// @typecheck
/**
 * The shared project role gate (auth/projectAccess.requireProjectRole), bound
 * on first use, for the factory routers under routes/projects/.
 *
 * Bound lazily so that requiring a router file (its default instance) loads
 * no store. The middleware carries the gate's own name, `requireProjectRoleMw`,
 * which is what the project route-table baseline (routes/projects.routetable
 * .test.js) records: a route that loses its gate shows up there.
 *
 *   const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
 *   router.get('/:id/things', requireRole('viewer'), handler);
 */

'use strict';

/** @param {'viewer'|'editor'|'owner'} minRole */
function lazyProjectRoleGate(minRole) {
    /** @type {Function|null} */
    let gate = null;
    return function requireProjectRoleMw(/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) {
        if (!gate) gate = require('../../auth/projectAccess').requireProjectRole(minRole);
        return /** @type {Function} */ (gate)(req, res, next);
    };
}

/**
 * The access trio a project sub-router starts with: the gate, the caller's
 * role, and the project row. Injected in tests, the real ones (loaded on first
 * use) otherwise. `requireRole` is the gate itself, not a wrapper, so the
 * route-table baseline still sees its name.
 *
 * @param {{requireProjectRole?: Function, getProjectRole?: Function, getProject?: Function}} deps
 */
function projectAccessDeps(deps) {
    return {
        requireRole: deps.requireProjectRole || lazyProjectRoleGate,
        getProjectRole: deps.getProjectRole
            || ((/** @type {string} */ userId, /** @type {string} */ projectId) => require('../../auth/projectAccess').getProjectRole(userId, projectId)),
        getProject: deps.getProject || ((/** @type {string} */ id) => require('../../stores/projectStore').getProject(id)),
    };
}

module.exports = { lazyProjectRoleGate, projectAccessDeps };

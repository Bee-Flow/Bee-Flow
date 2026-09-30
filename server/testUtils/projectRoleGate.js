'use strict';

/**
 * A stand-in for the project role gate (routes/projects.js requireProjectRole)
 * for route tests that mount one project sub-router: 401 without a session
 * user, 404 for someone with no role in the project, 403 below the required
 * role, and `req.projectRole` set on the way through.
 *
 * @param {Object<string, Object<string, 'viewer'|'editor'|'owner'>>} roles
 *        project id → (user id → role)
 */
const ORDER = { viewer: 0, editor: 1, owner: 2 };

function fakeRequireProjectRole(roles) {
    return function requireProjectRole(minRole) {
        return function requireProjectRoleMw(req, res, next) {
            const userId = req.session?.user?.id;
            if (!userId) return res.status(401).json({ error: 'Not authenticated' });
            const role = roles[req.params.id]?.[userId];
            if (!role) return res.status(404).json({ error: 'Not found' });
            if (ORDER[role] < ORDER[minRole]) return res.status(403).json({ error: 'Insufficient permissions' });
            req.projectRole = role;
            return next();
        };
    };
}

/** A session user of org1, the organisation these tests' projects belong to. */
function projectUser(id) {
    return { id, organizationId: 'org1', role: 'user', email: `${id}@example.test` };
}

module.exports = { fakeRequireProjectRole, projectUser };

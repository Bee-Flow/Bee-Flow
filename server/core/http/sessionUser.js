// @typecheck strict
'use strict';
/**
 * The signed-in user of a request that went through requireAuth.
 *
 * requireAuth guarantees a session user, but the session type cannot say so: it
 * is shared with the sign-in and OAuth flows, where there is none yet. A route
 * reads the user through here, so a request that somehow got past the gate
 * ends as a 401 rather than as a TypeError (a 500) on `.id` of undefined.
 */

const { unauthorized } = require('./errors');

/**
 * @param {{ session?: { user?: Express.Session['user'] } }} req
 * @returns {NonNullable<Express.Session['user']>}
 */
function sessionUser(req) {
    const user = req.session?.user;
    if (!user) throw unauthorized();
    return user;
}

module.exports = { sessionUser };

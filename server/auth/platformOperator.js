// @typecheck
'use strict';

/**
 * The platform operator: the one built-in account an installation is set up
 * with, under the fixed user id `admin` (auth/login/setupRoutes.js,
 * boot-init.js; finalizeLogin and the MFA routes materialise its users row
 * from config when it is missing).
 *
 * Not the same question as "is this a super admin" (permissionsOrgGates
 * isSuperAdmin: `session.isAdmin` or `users.role === 'admin'`), which any number
 * of accounts can answer yes to. This one is about the single account the
 * install cannot be without: it cannot be deleted or demoted, it is listed
 * from config rather than from its row, it is no member of an organisation's
 * learning overview, and it alone sees raw token and message counts instead of
 * the marked-up cost (routes/usage.js, the org subscription view). New
 * accounts take their id from the username, so the same check reserves the
 * name `admin` at signup and user creation.
 *
 * The count-ratchet metric `admin-id-literal` keeps the literal comparison in
 * this file only.
 */

const PLATFORM_OPERATOR_ID = 'admin';

/**
 * @param {string | { id?: string | null } | null | undefined} userOrId a user (row or
 *   session user) or a bare user id / username
 * @returns {boolean}
 */
function isPlatformOperator(userOrId) {
    const id = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    return id === PLATFORM_OPERATOR_ID;
}

module.exports = { isPlatformOperator, PLATFORM_OPERATOR_ID };

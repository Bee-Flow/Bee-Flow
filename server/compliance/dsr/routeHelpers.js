// @typecheck strict
/**
 * What the admin DSR routes share: which organisation an admin reads, and
 * what a handler's catch rethrows.
 */
'use strict';

const userStore = require('../../stores/userStore');
const { HttpError } = require('../../core/http/errors');
const { deploymentMode } = require('../../license');
const { StoreInputError } = require('../../stores/lib/storeInputError');

/**
 * @typedef {{ getUser: (id: string) => Promise<{ organizationId?: string | null } | null | undefined>,
 *   mode: () => string,
 *   holds: (userId: string, permission: string, orgId: string, session: unknown) => Promise<boolean> }} AdminOrgDeps
 */

/** @type {AdminOrgDeps} */
const DEFAULT_DEPS = {
    getUser: (id) => userStore.getUser(id),
    mode: deploymentMode,
    holds: (userId, permission, orgId, session) => require('../../auth/permissions').hasPermissionInOrg(userId, permission, orgId, /** @type {import('../../core/entitlements/entitlementTypes').SessionLike | null} */ (session)),
};

/** The permission every admin DSR route is gated on. */
const ADMIN_PERMISSION = 'admin_compliance';

/**
 * The organisation whose register an admin reads. A failed lookup is a 503:
 * 'default' would show this admin another tenant's requests. 'default' is the
 * single-tenant install's org key; on a shared instance an admin without a
 * home organisation (a group-only membership) has no bucket of their own, and
 * the shared one is nobody's to read.
 *
 * The routes' gate checks `admin_compliance` held in ANY organisation the
 * caller is in; the register is the home organisation's only when the caller
 * holds it THERE (auth/permissionGrants.mts), else 403.
 * @param {{ session?: { user?: { id?: string } } }} req
 * @param {AdminOrgDeps} [deps]
 */
async function resolveAdminOrgId(req, deps = DEFAULT_DEPS) {
    const userId = req.session?.user?.id;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'Not authenticated');
    const u = await deps.getUser(userId).catch((/** @type {{ code?: string } | null} */ e) => {
        throw new HttpError(503, 'org_unavailable', `organisation lookup failed (${e?.code || 'error'})`);
    });
    if (!u?.organizationId) {
        if (deps.mode() === 'self-hosted') return 'default';
        throw new HttpError(403, 'org_required', 'This action needs a home organisation.');
    }
    if (!(await deps.holds(userId, ADMIN_PERMISSION, u.organizationId, req.session))) {
        throw new HttpError(403, 'permission_required', 'This needs the compliance permission in this organisation.');
    }
    return u.organizationId;
}

/**
 * What a handler's catch rethrows: input the store refused becomes a 400 with
 * its message, an HttpError passes through, anything else is a fault for the
 * terminal handler (500 with a correlation id, the message stays in the log).
 * @param {unknown} e
 */
function requestError(e) {
    if (e instanceof StoreInputError) return new HttpError(400, 'bad_request', e.message);
    return e;
}

module.exports = { resolveAdminOrgId, requestError };

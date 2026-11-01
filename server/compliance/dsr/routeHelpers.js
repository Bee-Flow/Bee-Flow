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
 *   mode: () => string }} AdminOrgDeps
 */

/**
 * The organisation whose register an admin reads. A failed lookup is a 503:
 * 'default' would show this admin another tenant's requests. 'default' is the
 * single-tenant install's org key; on a shared instance an admin without a
 * home organisation (a group-only membership) has no bucket of their own, and
 * the shared one is nobody's to read.
 * @param {{ session?: { user?: { id?: string } } }} req
 * @param {AdminOrgDeps} [deps]
 */
async function resolveAdminOrgId(req, deps = { getUser: (id) => userStore.getUser(id), mode: deploymentMode }) {
    const userId = req.session?.user?.id;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'Not authenticated');
    const u = await deps.getUser(userId).catch((/** @type {{ code?: string } | null} */ e) => {
        throw new HttpError(503, 'org_unavailable', `organisation lookup failed (${e?.code || 'error'})`);
    });
    if (u?.organizationId) return u.organizationId;
    if (deps.mode() === 'self-hosted') return 'default';
    throw new HttpError(403, 'org_required', 'This action needs a home organisation.');
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

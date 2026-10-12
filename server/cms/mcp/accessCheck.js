/**
 * The access decision for an upload URL, asked again at PUT time.
 *
 * A ticket outlives the request that issued it by up to 15 minutes, and the
 * world can change in between: the token revoked or downgraded, the account
 * suspended, the organisation tightening its policy. So the PUT does not trust
 * the ticket alone; it re-runs the same decision the gate makes for any request
 * (auth/mcpAccess/gate.evaluateAccessForOrgs, against the policy of every org
 * the user belongs to, group-only members included) for the token the ticket was issued
 * under, plus the token's scope for the tool that issued it, the CMS admin test,
 * and that the user is still in the organisation the ticket was bound to.
 *
 * Collaborators are injected; routes/mcpCms.js wires the real ones.
 *
 * @returns {(bound: object, ip: string) => Promise<{ ok: true } | { ok: false, reason: string }>}
 */

'use strict';

/**
 * @param {object} deps
 * @param {(id: string) => Promise<object|null>} deps.getTokenById
 * @param {(userId: string) => Promise<object|null>} deps.getUser
 * @param {(user: object) => Promise<{ primary: string|null, all: string[] }>} deps.resolveOrgs  auth/mcpAccess/orgResolve
 * @param {(orgId: string|null) => Promise<object>} deps.getOrgPolicy
 * @param {Function} deps.evaluateAccessForOrgs auth/mcpAccess/gate
 * @param {(user: object|null) => boolean} deps.isActiveAccount
 * @param {Function} deps.scopeAllowsTool
 * @param {(user: object) => Promise<boolean>} deps.isAdmin
 */
function createAccessCheck(deps) {
    return async function checkAccess(bound, ip) {
        try {
            // Upload URLs are not issued to legacy tokens (cms_request_upload says so),
            // so a ticket without a named token behind it is not honoured.
            if (bound.legacy || !bound.tokenId) return { ok: false, reason: 'legacy_ticket' };
            const token = await deps.getTokenById(bound.tokenId);
            if (token && token.userId !== bound.userId) return { ok: false, reason: 'token_user_mismatch' };
            const user = await deps.getUser(bound.userId);
            // Every org the user belongs to (home or through a group). A failure to
            // resolve throws and lands in the catch below: refused.
            const orgs = user ? await deps.resolveOrgs(user) : { primary: null, all: [] };
            const orgId = orgs.primary || token?.orgId || null;
            if (user && (bound.orgId || null) !== orgId) return { ok: false, reason: 'org_changed' };
            const policies = !user ? []
                : orgs.all.length > 0 ? await Promise.all(orgs.all.map((id) => deps.getOrgPolicy(id)))
                    : [await deps.getOrgPolicy(null)];

            const decision = deps.evaluateAccessForOrgs({
                token, user, orgIds: orgs.all, accountActive: deps.isActiveAccount(user), policies, ip, server: 'cms',
            });
            if (!decision.ok) return { ok: false, reason: decision.reason };

            if (!deps.scopeAllowsTool(token.scopes, 'cms', 'cms_request_upload', { readOnly: false })) {
                return { ok: false, reason: 'scope_removed' };
            }
            if (!(await deps.isAdmin(user))) return { ok: false, reason: 'not_cms_admin' };
            return { ok: true };
        } catch (err) {
            return { ok: false, reason: `check_failed: ${err.message}` };
        }
    };
}

module.exports = { createAccessCheck };

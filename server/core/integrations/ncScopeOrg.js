// @typecheck
/**
 * Which organisation's ceiling applies to a Nextcloud scope check.
 * Split out of ncScopeGuard.js (file budget); behaviour unchanged.
 */

'use strict';

const ORG_MEMO_TTL_MS = 15_000; // same as the guard's scope cache

// Last-resort org lookup.
//
// The session fallbacks in resolveScopeOrg only work for a session that carries connector
// fields or a `user` object — and the background callers are exactly the ones
// that carry neither: triggerBus.loadSession returns
// {accessToken, refreshToken, oauthProvider, automationProviders, _source} on its
// two non-connector paths. With org null, resolveNcScope skips the org layer
// entirely (it reads the org doc only `orgId ? ... : null`), so an org that had
// switched an integration off had that decision silently dropped for every
// OAuth and app-password user — the ceiling gone while the user layer still
// looked enforced. Memoised on the same TTL as the scope itself.
const _orgMemo = new Map();

async function _orgForUser(userId) {
    if (!userId) return null;
    const hit = _orgMemo.get(userId);
    if (hit && Date.now() - hit.at < ORG_MEMO_TTL_MS) return hit.orgId;
    // No catch: a failed lookup must surface (the guard then denies), never be
    // memoised as "no org", which would drop the org ceiling for the TTL. Only a
    // user row that EXISTS without an org is memoised as null.
    const row = await require('../../stores/userStore').getUser(userId);
    const orgId = row?.organizationId || row?.organization_id || null;
    _orgMemo.set(userId, { at: Date.now(), orgId });
    return orgId;
}

/**
 * The org whose ceiling applies to a call: the one the caller named, else the
 * session's (connector or login), else the user's stored row. checkToolCall and
 * filterResult call it, so a caller that passes no orgId (the /mcp integrations
 * surface does not) still gets the org layer. THROWS when the user row cannot
 * be read; the guard turns that into a denial.
 */
async function resolveScopeOrg({ orgId = null, session = null, userId = null } = {}) {
    return orgId || session?.connectorOrgId || session?.user?.organizationId || await _orgForUser(userId);
}

function clearOrgMemo(userId) {
    if (!userId) { _orgMemo.clear(); return; }
    _orgMemo.delete(String(userId));
    _orgMemo.delete(userId);
}

module.exports = { resolveScopeOrg, clearOrgMemo };

// @typecheck strict
/**
 * Shared shapes for the entitlement resolvers (types only; nothing is exported at runtime).
 *
 * @typedef {import('./betaFeatures').SessionLike} SessionLike  an express session, or a synthetic one with the fields a caller has
 * @typedef {{ session?: SessionLike | null }} EntitlementRequest  a request, or just `{ session }`: the resolvers read only the session
 * @typedef {{ userId?: string | null, orgId?: string | null, session?: SessionLike | null, req?: EntitlementRequest | null, tierHint?: string | null }} EntitlementCtx  who is asking, and what is already known about them
 */

module.exports = {};

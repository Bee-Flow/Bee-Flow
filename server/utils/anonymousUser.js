// @typecheck
/**
 * Is this caller an anonymous visitor rather than a real account?
 *
 * `getEffectiveUserId` (utils/routeHelpers.js) never returns null — for a
 * caller with no session user it mints `guest_<random>` so guest chat has
 * continuity. That is fine for conversations and wrong for anything that
 * accumulates personal data: a `guest_*` id has no data subject behind it, so
 * nobody can ever exercise access or erasure against rows written under it.
 *
 * Lives in `utils/` rather than next to the memory policy that uses it so both
 * `stores/` (platform) and `core/` can call it without an upward edge — see
 * `server/layering.test.js`.
 */
function isAnonymousUserId(userId) {
    return !userId || typeof userId !== 'string' || userId.startsWith('guest_');
}

module.exports = { isAnonymousUserId };

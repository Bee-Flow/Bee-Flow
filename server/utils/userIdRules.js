// @typecheck strict
/**
 * What a new user id may look like.
 *
 * A new account takes its id from the username it was created with, and that
 * id is later used as a path segment (`data/templates_filled/<id>/`), as an
 * object-storage prefix (`users/<id>/`) and as a URL segment
 * (`/subscriptions/consumer/<id>/…`). An id that carries a separator or an
 * escape therefore names somebody else's files or routes: `alice/uploads`
 * nests inside alice's storage prefix, `../../x` climbs out of a directory and
 * `vic%74im` decodes to `victim` after a gate compared the raw text.
 *
 * `system` and `swarm` are the owner ids of the built-in agents every
 * organisation shares; an account with that id would own them. `anonymous`
 * is the owner written for content that has no user.
 *
 * Plain string operations on purpose: the username is request text.
 */

const FORBIDDEN_CHARS = ['/', '\\', '%', '?', '#'];
const RESERVED_OWNER_IDS = ['system', 'swarm', 'anonymous'];
// Per-user config keys are `<family>_<userId>` with these suffixes for their
// markers, so the id `alice_revoked` would share a key with alice's marker.
const RESERVED_SUFFIXES = ['_revoked', '_issued'];

/**
 * @param {unknown} id
 * @returns {'empty' | 'dots' | 'character' | 'reserved' | null} why the id is refused, or null when it is fine
 */
function userIdProblem(id) {
    if (typeof id !== 'string' || id.length === 0) return 'empty';
    if (id === '.' || id === '..') return 'dots';
    for (const ch of id) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f || FORBIDDEN_CHARS.includes(ch)) return 'character';
    }
    const lower = id.trim().toLowerCase();
    if (RESERVED_OWNER_IDS.includes(lower) || RESERVED_SUFFIXES.some(s => lower.endsWith(s))) return 'reserved';
    return null;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
function isAllowedUserId(id) {
    return userIdProblem(id) === null;
}

module.exports = { userIdProblem, isAllowedUserId };

// @typecheck
/**
 * A list of knowledge-base ids, normalised. Nothing else.
 *
 * Deliberately DEPENDENCY-FREE. It is required by the conversation store as
 * well as by the policy layer, and a store must not have to pull the whole
 * knowledge-base domain (and through it the database module) into memory just
 * to trim some strings — `stores/agent/directConversations.crypto.test.js`
 * cuts that store off from `server/db.js` at the require seam and asserts the
 * real one never loads, which is exactly the coupling this file avoids.
 *
 * The policy lives next door in `kbSelection.js`, which re-exports these so
 * there is still one name and one cap for the whole product.
 */

/**
 * How many bases one conversation / one request may name.
 *
 * Same cap the project linker enforces (routes/projects.js MAX_KB_IDS): each
 * id costs a sequential `getKB`, so an unbounded list is an unbounded number
 * of round-trips from a single request body.
 */
const MAX_ATTACHED_KB_IDS = 50;

/**
 * Ids only: non-strings, blanks and duplicates never reach the store.
 *
 * It can only ever SHRINK a list — there is no input that makes this return
 * something the caller did not pass in, and an unreadable input (a string, an
 * object, null) becomes an EMPTY list rather than passing itself through.
 *
 * @param {*} ids
 * @param {{max?: number}} [opts]
 * @returns {string[]}
 */
function normaliseKbIds(ids, { max = MAX_ATTACHED_KB_IDS } = {}) {
    if (!Array.isArray(ids)) return [];
    const out = new Set();
    for (const id of ids) {
        if (typeof id !== 'string') continue;
        const trimmed = id.trim();
        if (!trimmed) continue;
        out.add(trimmed);
        if (out.size >= max) break;
    }
    return [...out];
}

module.exports = { normaliseKbIds, MAX_ATTACHED_KB_IDS };

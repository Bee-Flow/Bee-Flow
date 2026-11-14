// @typecheck strict
/**
 * A small cache for the content keys of connector sessions.
 *
 * Deriving one costs a PBKDF2 run, too slow for every request, so the result
 * is kept. It is kept briefly and in bounded number: a secret that sits in the
 * process for its whole lifetime is readable from a memory dump long after
 * the user's last request.
 */

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;

/**
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
function createKeyCache({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
    /** @type {Map<string, { value: string, at: number }>} */
    const entries = new Map();
    return {
        /**
         * @param {string} userId
         * @returns {string | null}
         */
        get(userId) {
            const hit = entries.get(userId);
            if (!hit) return null;
            if (now() - hit.at > ttlMs) { entries.delete(userId); return null; }
            return hit.value;
        },
        /**
         * @param {string} userId
         * @param {string} value
         */
        set(userId, value) {
            entries.delete(userId);
            // Insertion order is age: the first entry is the oldest.
            while (entries.size >= maxEntries) entries.delete(/** @type {string} */ (entries.keys().next().value));
            entries.set(userId, { value, at: now() });
        },
        clear() { entries.clear(); },
        get size() { return entries.size; },
    };
}

module.exports = { createKeyCache };

// @typecheck strict
/**
 * The JSONB array columns of a transcriptions row, read tolerantly and written
 * coerced. Pure.
 */

/**
 * Read a JSONB column that is supposed to hold an array.
 *
 * Every one of these used to be an inline `JSON.parse` with no guard, inside a
 * `rows.map`. A single row whose column held a JSON scalar — `PATCH {"tags":
 * "urgent"}` was enough, since the write side did not validate either — threw
 * and took out the ENTIRE list response, for the owner, for every org member
 * the note was published to, and for super admins. One bad row, everyone's
 * library gone.
 * @param {string} value
 */
function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
}

/**
 * Coerce an inbound array field on the WRITE side, so rows never go bad.
 * @param {unknown} value
 */
function toArray(value) {
    return Array.isArray(value) ? value : [];
}

module.exports = { parseJsonArray, toArray };

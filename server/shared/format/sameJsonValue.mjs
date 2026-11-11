// @typecheck strict
/**
 * Do two values stand for the same JSON, whatever the order of their object keys?
 *
 * The validator asks "is this stored value already what the canonicalizer would keep" by cleaning
 * it again and comparing. Comparing JSON.stringify texts made that answer depend on key order,
 * and Postgres JSONB hands a stored definition back with its keys in another order (shorter keys
 * first), so a clean v3 definition read from the database got errors it did not have.
 *
 * Equal here means what equal JSON.stringify texts meant, without the key order: object keys in
 * any order, arrays element by element in order (their order is meaning), a key whose value
 * JSON leaves out (undefined, a function) counts as absent, an array slot JSON writes as null
 * counts as null, and a number JSON cannot write (NaN, Infinity) counts as null.
 *
 * Shared by the server (validate) and the web editor through the generated copy in
 * agent-hub/src/shared/format/.
 */

/** @param {unknown} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v */
const leftOut = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * A value that is not an object or an array, as JSON writes it.
 * @param {unknown} v
 */
const leaf = (v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v);

/**
 * @param {Record<string, unknown>} o
 * @returns {string[]}
 */
const presentKeys = (o) => Object.keys(o).filter((k) => !leftOut(o[k]));

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameJsonValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => sameJsonValue(leftOut(x) ? null : x, leftOut(b[i]) ? null : b[i]));
    }
    if (isObject(a) && isObject(b)) {
        const ra = /** @type {Record<string, unknown>} */ (a);
        const rb = /** @type {Record<string, unknown>} */ (b);
        const keys = presentKeys(ra);
        if (keys.length !== presentKeys(rb).length) return false;
        return keys.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && !leftOut(rb[k]) && sameJsonValue(ra[k], rb[k]));
    }
    if (isObject(a) || isObject(b)) return false;
    return leaf(a) === leaf(b);
}

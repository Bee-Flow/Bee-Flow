// @typecheck strict
/**
 * Assertions on the result of a test case: a CLOSED vocabulary evaluated in
 * plain JS. Nothing here evaluates text: a path is read with the shared
 * expression grammar (shared/expr getRelativePath) and an assertion is data.
 *
 *   {id, op, path, value?}
 *     op      equals | not_equals | contains | has_key | type_is | count_is
 *     path    relative path into the result; '' is the whole result
 *     value   equals / not_equals: any JSON
 *             contains: string | number | boolean | object | array
 *             has_key: a non-empty string
 *             type_is: string | number | boolean | object | array | null
 *             count_is: {cmp: 'eq' | 'gte' | 'lte', n: integer >= 0}
 *
 * Results carry a CODE and params, never a sentence, so the screen words them
 * in the viewer's language. Values in params are JSON text cut to 200
 * characters: a failing assertion cannot dump a whole payload into a response.
 *
 * Pure.
 */

'use strict';

const { envCap } = require('../mcpRunReadCaps');

const OPS = Object.freeze(['equals', 'not_equals', 'contains', 'has_key', 'type_is', 'count_is']);
const TYPE_NAMES = Object.freeze(['string', 'number', 'boolean', 'object', 'array', 'null']);
const CMPS = Object.freeze(['eq', 'gte', 'lte']);
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_PATH_CHARS = 500;
const MAX_ID_CHARS = 40;
const CUT_CHARS = 200;
const MAX_DEPTH = 100;

const maxAssertions = () => envCap('AUTOMATION_TEST_ASSERTIONS_MAX', 50);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/**
 * @param {unknown} o  an object (hasOwnProperty.call takes any receiver)
 * @param {PropertyKey} k
 */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** @returns {typeof import('../../shared/expr/index.mjs')} */
const expr = () => require('../../shared/expr/index.mjs');

/**
 * JSON text of a value, cut to CUT_CHARS.
 * @param {unknown} value
 */
function cut(value) {
    let text;
    try { text = JSON.stringify(value); } catch { text = undefined; }
    if (text === undefined) text = String(value);
    return text.length > CUT_CHARS ? `${text.slice(0, CUT_CHARS)}…` : text;
}

/**
 * Deep equality with JSON semantics: key order is irrelevant.
 * @param {unknown} a
 * @param {unknown} b
 * @param {number} [depth]
 * @returns {boolean}
 */
function deepEqual(a, b, depth = 0) {
    if (a === b) return true;
    if (depth > MAX_DEPTH || typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    // From here both are non-null objects, and b is an array exactly when a is.
    if (Array.isArray(a)) {
        const bl = /** @type {unknown[]} */ (b);
        return a.length === bl.length && a.every((/** @type {unknown} */ x, /** @type {number} */ i) => deepEqual(x, bl[i], depth + 1));
    }
    const ra = /** @type {Record<string, unknown>} */ (a);
    const rb = /** @type {Record<string, unknown>} */ (b);
    const ka = Object.keys(ra);
    if (ka.length !== Object.keys(rb).length) return false;
    return ka.every((k) => hasOwn(rb, k) && deepEqual(ra[k], rb[k], depth + 1));
}

/**
 * Every key of `part` is in `whole` with an equal value.
 * @param {Record<string, any>} part
 * @param {Record<string, any>} whole
 */
const isSubset = (part, whole) => Object.keys(part).every((k) => hasOwn(whole, k) && deepEqual(part[k], whole[k]));

/**
 * Is `wanted` contained in `actual` (a string, an array or an object)? null when `actual` cannot contain anything.
 * @param {unknown} actual
 * @param {unknown} wanted
 */
function containsValue(actual, wanted) {
    if (typeof actual === 'string') return typeof wanted === 'string' && actual.includes(wanted);
    if (Array.isArray(actual)) {
        return actual.some((el) => deepEqual(el, wanted) || (isObject(wanted) && isObject(el) && isSubset(wanted, el)));
    }
    if (isObject(actual)) return isObject(wanted) && isSubset(wanted, actual);
    return null;
}

/**
 * The size of a string, array or object, or null for anything else.
 * @param {unknown} v
 */
function sizeOf(v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    return isObject(v) ? Object.keys(v).length : null;
}

/**
 * Is `path` a path the shared grammar reads? '' and '$' are the whole value.
 * @param {unknown} path
 */
function isReadablePath(path) {
    const p = String(path).trim();
    if (p === '' || p === '$') return true;
    let q = p;
    if (q.startsWith('$.')) q = q.slice(2);
    else if (q.startsWith('$[')) q = q.slice(1);
    return expr().parsePath(q.startsWith('[') ? `$${q}` : `$.${q}`) !== null;
}

/** @param {unknown} v */
function byteSize(v) {
    try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'); } catch { return Infinity; }
}

/**
 * The problem with an assertion's `value` for its op, or null.
 * @param {string} op
 * @param {unknown} value
 */
function valueProblem(op, value) {
    if (op === 'equals' || op === 'not_equals') {
        return value === undefined ? 'needs a value' : null;
    }
    if (op === 'contains') {
        return ['string', 'number', 'boolean', 'object', 'array'].includes(typeOf(value)) ? null : 'must be text, a number, true/false, a list or an object';
    }
    if (op === 'has_key') return typeof value === 'string' && value !== '' ? null : 'must be a non-empty key name';
    if (op === 'type_is') return /** @type {readonly unknown[]} */ (TYPE_NAMES).includes(value) ? null : `must be one of ${TYPE_NAMES.join(', ')}`;
    if (op === 'count_is') {
        return isObject(value) && CMPS.includes(value.cmp) && Number.isInteger(value.n) && value.n >= 0
            ? null : 'must be {cmp: eq|gte|lte, n: a whole number from 0}';
    }
    return null;
}

/**
 * @param {unknown} list
 * @returns {{ ok: boolean, errors: Array<{ index: number, message: string }> }}
 */
function validateAssertions(list) {
    /** @type {Array<{ index: number, message: string }>} */
    const errors = [];
    if (!Array.isArray(list)) return { ok: false, errors: [{ index: -1, message: 'assertions must be a list' }] };
    const max = maxAssertions();
    if (max > 0 && list.length > max) errors.push({ index: -1, message: `at most ${max} assertions` });
    const seen = new Set();
    list.forEach((a, index) => {
        /** @param {string} message */
        const fail = (message) => errors.push({ index, message });
        if (!isObject(a)) return fail('must be an object');
        const id = a.id;
        if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_CHARS) fail(`id must be 1 to ${MAX_ID_CHARS} characters`);
        else if (seen.has(id)) fail('id is used twice');
        else seen.add(id);
        if (!OPS.includes(a.op)) return fail(`op must be one of ${OPS.join(', ')}`);
        const path = a.path === undefined ? '' : a.path;
        if (typeof path !== 'string' || path.length > MAX_PATH_CHARS) fail(`path must be text of at most ${MAX_PATH_CHARS} characters`);
        else if (!isReadablePath(path)) fail('path is not a valid path');
        if (a.value !== undefined && byteSize(a.value) > MAX_VALUE_BYTES) return fail('value is larger than 16 KB');
        const problem = valueProblem(a.op, a.value);
        if (problem) fail(`value ${problem}`);
    });
    return { ok: errors.length === 0, errors };
}

/**
 * @typedef {{ id: string, ok: boolean, code: string, params: { path: string, expected?: string, actual?: string } }} AssertionResult
 */

/**
 * @param {unknown} target
 * @param {{ id: string, op: string, path?: unknown, value?: any }} a
 * @returns {AssertionResult}
 */
function evaluateOne(target, a) {
    const path = typeof a.path === 'string' ? a.path : '';
    /**
     * @param {boolean} ok
     * @param {string} code
     * @param {unknown} [expected]
     * @param {unknown} [actual]
     */
    const result = (ok, code, expected, actual) => ({
        id: a.id,
        ok,
        code,
        params: {
            path,
            ...(expected !== undefined ? { expected: cut(expected) } : {}),
            ...(actual !== undefined ? { actual: cut(actual) } : {}),
        },
    });
    const actual = expr().getRelativePath(target, path);
    if (actual === undefined) return result(false, 'path_missing');
    switch (a.op) {
        case 'equals':
            return deepEqual(actual, a.value) ? result(true, 'ok') : result(false, 'not_equal', a.value, actual);
        case 'not_equals':
            return deepEqual(actual, a.value) ? result(false, 'equal', a.value, actual) : result(true, 'ok');
        case 'contains': {
            const found = containsValue(actual, a.value);
            if (found === null) return result(false, 'wrong_type', 'string, list or object', typeOf(actual));
            return found ? result(true, 'ok') : result(false, 'not_contained', a.value, actual);
        }
        case 'has_key': {
            if (!isObject(actual)) return result(false, 'wrong_type', 'object', typeOf(actual));
            return hasOwn(actual, a.value) ? result(true, 'ok') : result(false, 'key_missing', a.value);
        }
        case 'type_is':
            return typeOf(actual) === a.value ? result(true, 'ok') : result(false, 'wrong_type', a.value, typeOf(actual));
        case 'count_is': {
            const size = sizeOf(actual);
            if (size === null) return result(false, 'not_countable', undefined, typeOf(actual));
            const { cmp, n } = a.value;
            const ok = cmp === 'eq' ? size === n : cmp === 'gte' ? size >= n : size <= n;
            return ok ? result(true, 'ok') : result(false, 'wrong_count', a.value, size);
        }
        default:
            return result(false, 'wrong_type', undefined, undefined);
    }
}

/**
 * @param {unknown} target  the case's result (or {message} for an expected error)
 * @param {Array<any>} list  validated assertions
 * @returns {AssertionResult[]}
 */
function evaluateAssertions(target, list) {
    return (Array.isArray(list) ? list : []).map((a) => evaluateOne(target, a));
}

module.exports = { validateAssertions, evaluateAssertions, deepEqual, OPS, TYPE_NAMES, MAX_VALUE_BYTES };

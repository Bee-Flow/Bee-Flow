// @typecheck strict
'use strict';
/**
 * The small zod pieces every route schema needs, so that each refusal reads
 * as a sentence to whoever sent the request (see validate.js for the two
 * traps: the bare "Required" and the enum's "Invalid enum value").
 *
 *   const { z, worded, bodyOf, queryOf, choice } = require('../core/http/schemaParts');
 *   const RenameBody = bodyOf({ name: worded('A template needs a name.').trim().min(1, '…') }, 'Renaming a template');
 *
 * `bodyOf` / `queryOf` are closed: a key the route does not read is refused
 * by name, with the keys it does take. A misspelled key must not be ignored
 * under a 200, which is how most of the bugs in the validation batches
 * happened (a typo in a narrowing option meant "everyone").
 */

const { z, typeError, onUnknownKeys } = require('../../utils/zod');

/**
 * A string whose every refusal — including "you left it out" — is a sentence.
 * @param {string} message
 */
const worded = (message) => z.string({ error: message });

// How many unknown keys a refusal names, and how much of each: the names are
// the caller's own input, echoed back.
const NAMED_KEYS = 3;
const KEY_ECHO = 40;

/**
 * @param {readonly string[]} keys
 * @param {readonly string[]} known
 * @param {string} subject
 */
function unknownKeysText(keys, known, subject) {
    const named = keys.slice(0, NAMED_KEYS).map((k) => `"${String(k).slice(0, KEY_ECHO)}"`);
    const rest = keys.length - named.length;
    const list = rest > 0
        ? `${named.join(', ')} and ${rest} more`
        : named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
    return `${subject} does not take ${list}. ${known.length ? `It takes: ${known.join(', ')}.` : 'It takes no fields.'}`;
}

/**
 * An object that refuses a key it does not know, naming what `subject` does take.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 * @param {string} [subject]
 */
const closedObject = (shape, subject = 'This request') => {
    const known = Object.keys(shape);
    const error = (/** @type {import('zod').core.$ZodRawIssue} */ iss) => (iss.code === 'unrecognized_keys'
        ? unknownKeysText(iss.keys, known, subject)
        : iss.code === 'invalid_type' ? `${subject} takes a JSON object.` : undefined);
    return z.object(shape, { error }).strict();
};

/**
 * Express 5 leaves `req.body` undefined without a body; read that as `{}`.
 * @param {import('zod').ZodType} schema
 */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

/**
 * A closed body that also accepts no body at all.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 * @param {string} [subject]
 */
const bodyOf = (shape, subject = 'This request') => orEmpty(closedObject(shape, subject));

/**
 * A closed query string.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 * @param {string} [subject]

 */
const queryOf = (shape, subject = 'This request') => orEmpty(closedObject(shape, subject));

/**
 * One of a fixed list, refused with the list rather than zod's enum text.
 * @param {string[] | readonly string[] | [string, ...string[]]} values
 * @param {string} message
 */
const choice = (values, message) => z.enum(values, { error: () => message });

/**
 * An on/off flag. Only the booleans and their exact spellings count: the
 * string "false" would read as true wherever a handler wrote `!!x`.
 * @param {string} message
 */
const flag = (message) => z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean({ error: message }),
);

/**
 * A whole number within [min, max], from JSON or from the digits of a query string.
 * @param {string} message
 */
const wholeNumber = (message, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => z.preprocess(
    (v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v),
    z.number({ error: message }).int(message).min(min, message).max(max, message),
);

/**
 * A list of ids, each a non-empty string.
 * @param {string} message
 * @param {number} [max]
 */
const idList = (message, max = 200) => z.array(worded(message).trim().min(1, message).max(200, message), { error: message }).max(max, message);

/**
 * A monthly AI budget in EUR: a positive number, or null to clear it. Zero,
 * negative and non-finite values are refused (no limit is null, not 0).
 */
const costLimit = (message = 'A budget must be a number above zero, or empty for no limit.') =>
    z.number({ error: message }).positive(message).nullable().optional();

const IMAGE_LIMIT_TEXT = 'An image limit is a whole number from 0 (no limit) to 1,000,000, or empty when not set.';
const imageLimitWindow = () => z.number({ error: IMAGE_LIMIT_TEXT }).int(IMAGE_LIMIT_TEXT).min(0, IMAGE_LIMIT_TEXT).max(1_000_000, IMAGE_LIMIT_TEXT).nullable().optional();

/**
 * Image limits per rolling window (core/entitlements/imageLimit.mts):
 * `{ hour, day, week, month }`, each a whole number or absent; null clears
 * them all. 0 in a window means "no limit" on purpose.
 */
const imageLimits = () => z.object({
    hour: imageLimitWindow(), day: imageLimitWindow(), week: imageLimitWindow(), month: imageLimitWindow(),
}, { error: 'Image limits are an object with hour, day, week and month.' }).strict().nullable().optional();

/**
 * Image limits as the store takes them: undefined when the request did not
 * carry the field, null when no window is set, otherwise only the set windows.
 * @param {Record<string, number | null | undefined> | null | undefined} value
 * @returns {Record<string, number> | null | undefined}
 */
function storedImageLimits(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    /** @type {Record<string, number>} */
    const out = {};
    for (const [window, n] of Object.entries(value)) {
        if (typeof n === 'number') out[window] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Middleware for a body that carries image limits in `field`: refuses a bad
 * value (400 `invalid_image_limits`) and replaces a good one with what the
 * column holds: JSON text of the set windows, or null when none is set. A body
 * without the field passes untouched.
 * @param {string} field
 * @returns {import('express').RequestHandler}
 */
function imageLimitsColumnBody(field) {
    const schema = imageLimits();
    return (req, res, next) => {
        if (!req.body || req.body[field] === undefined) return next();
        const check = schema.safeParse(req.body[field]);
        if (!check.success) {
            return res.status(400).json({ error: check.error.issues[0]?.message || 'Invalid image limits', code: 'invalid_image_limits' });
        }
        const limits = storedImageLimits(check.data);
        req.body[field] = limits ? JSON.stringify(limits) : null;
        return next();
    };
}

module.exports = { z, typeError, onUnknownKeys, worded, closedObject, orEmpty, bodyOf, queryOf, choice, flag, wholeNumber, idList, unknownKeysText, costLimit, imageLimits, storedImageLimits, imageLimitsColumnBody };

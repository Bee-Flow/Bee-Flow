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
 * by name, with the keys it does take. A misspelled key used to be ignored
 * under a 200, which is how most of the bugs in the validation batches
 * happened (a typo in a narrowing option meant "everyone").
 */

const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

// How many unknown keys a refusal names, and how much of each: the names are
// the caller's own input, echoed back.
const NAMED_KEYS = 3;
const KEY_ECHO = 40;

function unknownKeysText(keys, known, subject) {
    const named = keys.slice(0, NAMED_KEYS).map((k) => `"${String(k).slice(0, KEY_ECHO)}"`);
    const rest = keys.length - named.length;
    const list = rest > 0
        ? `${named.join(', ')} and ${rest} more`
        : named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}` : named[0];
    return `${subject} does not take ${list}. ${known.length ? `It takes: ${known.join(', ')}.` : 'It takes no fields.'}`;
}

/** An object that refuses a key it does not know, naming what `subject` does take. */
const closedObject = (shape, subject = 'This request') => {
    const known = Object.keys(shape);
    const errorMap = (issue, ctx) => (issue.code === 'unrecognized_keys'
        ? { message: unknownKeysText(issue.keys, known, subject) }
        : issue.code === 'invalid_type'
            ? { message: `${subject} takes a JSON object.` }
            : { message: ctx.defaultError });
    return z.object(shape, { errorMap }).strict();
};

/** Express 5 leaves `req.body` undefined without a body; read that as `{}`. */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

/** A closed body that also accepts no body at all. */
const bodyOf = (shape, subject = 'This request') => orEmpty(closedObject(shape, subject));

/** A closed query string. */
const queryOf = (shape, subject = 'This request') => orEmpty(closedObject(shape, subject));

/** One of a fixed list, refused with the list rather than zod's enum text. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

/**
 * An on/off flag. Only the booleans and their exact spellings count: the
 * string "false" used to read as true wherever a handler wrote `!!x`.
 */
const flag = (message) => z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean({ required_error: message, invalid_type_error: message }),
);

/** A whole number within [min, max], from JSON or from the digits of a query string. */
const wholeNumber = (message, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => z.preprocess(
    (v) => (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v),
    z.number({ required_error: message, invalid_type_error: message }).int(message).min(min, message).max(max, message),
);

/** A list of ids, each a non-empty string. */
const idList = (message, max = 200) => z.array(worded(message).trim().min(1, message).max(200, message), {
    required_error: message, invalid_type_error: message,
}).max(max, message);

module.exports = { z, worded, closedObject, orEmpty, bodyOf, queryOf, choice, flag, wholeNumber, idList, unknownKeysText };

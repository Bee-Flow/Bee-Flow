// @typecheck strict
/**
 * The zod vocabulary from which the request schemas of this router are built.
 *
 * Every body below is `.strict()`. On a router that RECORDS meetings that is not a
 * question of form: two of the silent fallbacks it contained switched a recording
 * ON that someone had just switched off, and one published a note to the whole
 * organisation while only one group had been chosen.
 *
 * Three traps are closed here once, so that no single route reopens them:
 *
 *   • `worded()` — without `required_error` zod answers a missing field with the
 *     bare word "Required", and a caller must never read that.
 *   • enums — `invalid_type_error` only covers a wrong TYPE, never a wrong VALUE.
 *     Every enum here therefore carries an `errorMap`; see the header of
 *     core/http/validate.js.
 *   • `flag()` — the "yes" in the query string. A URL carries no booleans, so both
 *     spellings that a client really sends count, and everything else is a 400
 *     instead of silently "no".
 */

'use strict';

const { z, typeError } = require('../../utils/zod');
const { worded, choice } = require('../../core/http/schemaParts');

/**
 * A body that also accepts no body: Express 5 then leaves `req.body` undefined.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 */
const bodyOf = (shape) =>
 z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

/**
 * Een "ja" op de query string. `?confirm=1` en `?confirm=true` allebei.
 * @param {string} message
 */
const flag = (message) => choice(['true', '1', 'false', '0'], message)
    .transform((v) => v === 'true' || v === '1')
    .optional();

/**
 * Een geheel getal op de query string.
 * @param {string} name
 */
const whole = (name) => z.coerce.number({ error: typeError({ invalid: `${name} is een getal.` }) })
    .int(`${name} is een heel getal.`)
    .optional();

/**
 * Een lijst van id's — wat er ín staat is aan de store om te toetsen.
 * @param {string} message
 */
const idList = (message) => z.array(worded(message).trim().min(1, message), { error: message });

/**
 * A real boolean, never a string.
 *
 * Two routes wrote `record: !!record` directly into the recording preference of a
 * meeting. `"false"` is true, so whoever switched recording OFF with a text instead
 * of a boolean switched it ON — and `{}` or a typo switched it off. On this router
 * that is the difference between a meeting that is recorded and one that is not.
 * @param {string} message
 */
const bool = (message) => z.boolean({ error: message });

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}).strict();
const NOTHING = bodyOf({});

module.exports = { worded, bodyOf, choice, flag, whole, idList, bool, NO_QUERY, NOTHING };

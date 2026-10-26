// @typecheck strict
/**
 * Request-schema pieces the transcription and webpage routes share
 * (routes/transcriptions/schemas.js, routes/webpages/schemas.js).
 *
 * They differ on purpose from the general helpers in schemaParts.js: a flag
 * here also reads `1` / `0` from a query string, and a body may be absent
 * altogether. Moving these routes onto schemaParts would change the answers
 * their callers get, so the two route families keep these, once.
 */

'use strict';

const { z, typeError } = require('../../utils/zod');
const { worded, choice } = require('./schemaParts');

/**
 * A body that also accepts no body: Express 5 then leaves `req.body` undefined.
 * @template {import('zod').ZodRawShape} S
 * @param {S} shape
 */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

/**
 * A "yes" on the query string: `?confirm=1` and `?confirm=true` both count.
 * @param {string} message
 */
const flag = (message) => choice(['true', '1', 'false', '0'], message)
    .transform((v) => v === 'true' || v === '1')
    .optional();

/**
 * A whole number on the query string.
 * @param {string} name
 */
const whole = (name) => z.coerce.number({ error: typeError({ invalid: `${name} is een getal.` }) })
    .int(`${name} is een heel getal.`)
    .optional();

/**
 * A list of ids; whether each id exists is the store's to check.
 * @param {string} message
 */
const idList = (message) => z.array(worded(message).trim().min(1, message), { error: message });

module.exports = { bodyOf, flag, whole, idList };

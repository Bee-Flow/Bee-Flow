// @typecheck strict
/**
 * The zod vocabulary from which the request schemas of this router are built.
 *
 * Every body below is `.strict()`, and on this router that is the whole point:
 * a key that nobody read dropped off the list, under a 200 that looked like "saved".
 * In three places it did more than that — it WIPED something (the chat history), or made
 * a published page private again without saying so.
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

const { z, onUnknownKeys } = require('../../utils/zod');
const { worded, choice } = require('../../core/http/schemaParts');
const { bodyOf, flag, whole, idList } = require('../../core/http/queryStringParts');

/**
 * Text that a person types: trimmed, not empty.
 * @param {string} message
 * @param {number} [max]
 */
const text = (message, max = 2000) => worded(message).trim().min(1, message).max(max, message);

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}, { error: onUnknownKeys('Dit accepteert geen queryparameters.') }).strict();
const NOTHING = bodyOf({});

module.exports = { worded, bodyOf, choice, flag, text, whole, idList, NO_QUERY, NOTHING };

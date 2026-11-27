// @typecheck strict
'use strict';
/**
 * The two text shapes the connection settings of POST /ai/user-settings are built from, shared by
 * the route (routes/ai/config/userSettings.js) and the field files of the integration modules
 * beside this one, so a value is checked the same way wherever its field lives.
 */

const { z, typeError } = require('../../../utils/zod');

/**
 * Text that must match `re` unless it is '' (not set: disconnect).
 * @param {RegExp} re
 * @param {string} message
 * @param {boolean} [trim]
 */
const shaped = (re, message, trim = true) => {
    const base = z.string({ error: typeError({ invalid: message }) });
    return (trim ? base.trim() : base).refine((v) => v === '' || re.test(v), message).nullable();
};

/**
 * One of `values`, case-insensitive; '' clears it.
 * @param {string[]} values
 * @param {string} message
 */
const oneOf = (values, message) => z.string({ error: typeError({ invalid: message }) })
    .trim().toLowerCase().pipe(z.enum(values, { error: () => message })).nullable();

module.exports = { shaped, oneOf };

// @typecheck strict
/**
 * stores/lib/storeError.js: the error a store throws for the client to see.
 *
 * A store may not require core/http/errors.js (platform does not reach into
 * core), so the error carries its own `{status, code, errorClass, expose,
 * details}`, which the terminal handler passes through.
 *
 * A leaf on purpose: defining it in stores/lib/managedParts.js would make every
 * store that only wants the error pull in the stage write guard (and its
 * reach into projectStore and solutionStageStore) with it.
 */

'use strict';

/**
 * An error a store throws for the client to see: status, code and details
 * pass through the terminal handler because `expose` is true. `errorClass`
 * repeats the code for routes that answer `code: err.errorClass`.
 *
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>} [details]
 */
function storeError(status, code, message, details) {
    return Object.assign(new Error(message), {
        status, code, errorClass: code, expose: true,
        ...(details ? { details } : {}),
    });
}

module.exports = { storeError };

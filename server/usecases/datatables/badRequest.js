// @typecheck strict
/**
 * The 400 a datatable request is refused with.
 *
 * Thrown from anywhere in the validation of a request: the list descriptor
 * (./rowDescriptor.js) and the handlers of routes/datatables/, which reach it
 * through routes/datatables/refusals.js. The router's error answer
 * (answerDatatableError there) reads `status` and `code` off the error.
 */

'use strict';

/**
 * @param {string} message
 * @param {string} [code]
 */
function bad(message, code) {
    const e = new Error(message);
    e.status = 400;
    if (code) e.code = code;
    throw e;
}

module.exports = { bad };

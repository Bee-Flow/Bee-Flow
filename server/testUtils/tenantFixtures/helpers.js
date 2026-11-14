// @typecheck strict
/**
 * What the tenant-isolation kinds share (testUtils/tenantFixtures.js): a body
 * the gate needs to see, and the check that a store created what it was asked to.
 */

'use strict';

/**
 * A multipart body with one small text file, and the text fields beside it, for a route whose upload guard reads
 * the file before its gate (testUtils/routeHarness.js sends a FormData as multipart).
 * @param {string} [field]
 * @param {Record<string, string>} [fields]
 */
function oneFile(field = 'file', fields = {}) {
    const form = new FormData();
    form.append(field, new Blob(['Text that must not land here.'], { type: 'text/plain' }), 'matrix.txt');
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return form;
}

/**
 * The row a store created, or a throw naming what it did not create: a kind without its resource would drive nothing.
 * @template T
 * @param {T | null | undefined} row
 * @param {string} what
 * @returns {T}
 */
function present(row, what) {
    if (row === null || row === undefined) throw new Error(`${what} answered nothing`);
    return row;
}

/**
 * A string handed to a store parameter whose JSDoc type was inferred from a `= null` default.
 * @param {string} value
 * @returns {null}
 */
const asNullTyped = (value) => /** @type {null} */ (/** @type {unknown} */ (value));

module.exports = { oneFile, present, asNullTyped };

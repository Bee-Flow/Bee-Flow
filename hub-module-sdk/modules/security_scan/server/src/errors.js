'use strict';
/**
 * `catch (e)` hands over `unknown` (anything can be thrown); a handler that wants the text of it
 * goes through here.
 */

/**
 * The message of an Error, else the text of whatever was thrown.
 * @param {unknown} e
 * @returns {string}
 */
function errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * The HTTP status code dockerode (and other http clients) put on the errors they throw.
 * @param {unknown} e
 * @returns {number | undefined}
 */
function statusCodeOf(e) {
    return typeof e === 'object' && e !== null && 'statusCode' in e && typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
}

module.exports = { errMessage, statusCodeOf };

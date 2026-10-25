// @typecheck noImplicitAny
'use strict';

/**
 * The message a page author or a page may see for a failed database call.
 * SQL errors (syntax, constraint, missing table) and our own refusals are
 * useful to the author and pass through. Anything from the file system or the
 * server's storage, or any text that looks like a path, is replaced by a
 * generic message; the detail goes to the log.
 */

const log = require('../../telemetry/log');

const GENERIC_MESSAGE = 'The page database could not complete this request';
const PATH_LIKE = /(?:[A-Za-z]:)?[\\/][\w.@~ -]+[\\/]|\.db\b|\bENOENT\b|\bEACCES\b|\bEPERM\b/;

/**
 * @param {unknown} err
 * @returns {string}
 */
function publicDbErrorMessage(err) {
    const e = /** @type {any} */ (err);
    const message = String(e?.message || '');
    const code = typeof e?.code === 'string' ? e.code : '';
    const foreign = (code && !code.startsWith('SQLITE_')) || PATH_LIKE.test(message);
    if (!foreign) return message;
    log.warn('[PageDB] request failed', { code: code || undefined, message });
    return GENERIC_MESSAGE;
}

module.exports = { publicDbErrorMessage, GENERIC_MESSAGE };

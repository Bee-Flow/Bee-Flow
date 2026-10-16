// @typecheck
'use strict';

const { HttpError } = require('../../../core/http/errors');

/**
 * An unexpected failure on a public form keeps the sentence the visitor read
 * before these routes moved to the terminal handler, instead of a bare
 * "Internal server error" (the form prints `error` as is). The terminal
 * handler logs the cause; an HttpError keeps its own answer.
 * @param {(req: any, res: any, next: any) => unknown} handler
 * @param {string} code
 * @param {string} message
 */
function friendly(handler, code, message) {
    return async (req, res, next) => {
        try {
            return await handler(req, res, next);
        } catch (err) {
            if (err instanceof HttpError) throw err;
            throw Object.assign(new HttpError(500, code, message), { cause: err });
        }
    };
}

module.exports = { friendly };

// @typecheck
'use strict';
/**
 * The last middleware in the chain: every error a route throws or passes to
 * next() ends here.
 *
 * The operator's log gets the entire error; the client gets a generic sentence
 * plus a correlation id it can quote in a support ticket. The id is the only
 * thing that ties the two together. Express's built-in handler wrote err.stack
 * into the response body outside NODE_ENV=production, and a pentester used one
 * malformed JSON body to read the deployment root and the middleware chain.
 *
 * What the client sees:
 *   HttpError (errors.js)  { error: message, code, details?, correlationId },
 *                          any status: the route wrote that message
 *   other 4xx              { error: message, correlationId }
 *   other 5xx              { error: 'Internal server error', correlationId }
 *   bad or huge body       400 / 413, counted rather than logged per request
 */

const { randomUUID } = require('node:crypto');
const { safeForLog } = require('../../utils/safeForLog');
const defaultLog = require('../../telemetry/log');

function createTerminalErrorHandler({ log = defaultLog, now = Date.now } = {}) {
    // A malformed or oversized body costs an attacker nothing to produce, so one
    // log line per rejection would hand any anonymous client a write primitive
    // against the log storage. Count them; emit at most one line per minute.
    let badBodyCount = 0;
    let badBodyLoggedAt = 0;
    function noteRejectedBody(kind, req) {
        badBodyCount += 1;
        const t = now();
        if (t - badBodyLoggedAt < 60_000) return;
        badBodyLoggedAt = t;
        log.warn(`[HTTP] ${badBodyCount} malformed/oversized request bodies rejected (latest: ${kind} ${safeForLog(req?.method, 10)} ${safeForLog(req?.path, 200)})`);
        badBodyCount = 0;
    }

    return function terminalErrorHandler(err, req, res, next) {
        // Response already on the wire (SSE streams, sendFile, a proxied
        // response): nothing left to replace, so Express destroys the socket
        // instead of appending JSON to a half-sent response.
        if (res.headersSent) return next(err);

        const isParseFailure = err?.type === 'entity.parse.failed'
            || (err instanceof SyntaxError && /** @type {any} */ (err).status === 400 && 'body' in err);
        if (isParseFailure) {
            noteRejectedBody('parse', req);
            return res.status(400).json({ error: 'Invalid JSON body' });
        }
        if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
            noteRejectedBody('too-large', req);
            return res.status(413).json({ error: 'Request body too large' });
        }

        const declared = Number(err?.status || err?.statusCode) || 500;
        const status = declared >= 400 && declared <= 599 ? declared : 500;
        const correlationId = req?.id || randomUUID();
        const where = `${safeForLog(req?.method, 10)} ${safeForLog(req?.originalUrl || req?.path, 200)}`;

        if (status >= 500 && err?.expose !== true) {
            log.error(`[HTTP] ${status} ${where} correlationId=${correlationId}`, err);
            return res.status(status).json({ error: 'Internal server error', correlationId });
        }
        if (status >= 500) log.error(`[HTTP] ${status} ${where} correlationId=${correlationId}`, err);

        // A 4xx the application raised on purpose carries a message written for
        // the caller. Without one, a generic sentence rather than err.toString(),
        // which would drag in the class name and, for wrapped driver errors,
        // fragments of a query. Capped so an echoed value cannot become the payload.
        const raw = typeof err?.message === 'string' ? err.message.trim() : '';
        const message = raw ? raw.slice(0, 300) : 'Request could not be processed';
        if (status < 500) log.warn(`[HTTP] ${status} ${where} correlationId=${correlationId}: ${safeForLog(message, 300)}`);
        const body = { error: message, correlationId };
        if (err?.expose === true) {
            if (typeof err.code === 'string') body.code = err.code;
            if (err.details !== undefined) body.details = err.details;
        }
        return res.status(status).json(body);
    };
}

module.exports = { createTerminalErrorHandler, terminalErrorHandler: createTerminalErrorHandler() };

// @typecheck
'use strict';
/**
 * An error a route wants the client to see.
 *
 *   throw new HttpError(404, 'agent_not_found', 'Agent not found');
 *
 * The terminal error handler (terminalErrorHandler.js) answers with the given
 * status and `{ error: message, code, correlationId }`, whatever the status:
 * the route wrote that message for the caller. Any other error becomes a 500
 * with a generic message, or keeps its message only when it set a 4xx status.
 */

class HttpError extends Error {
    constructor(status, code, message, details) {
        super(message || code || `HTTP ${status}`);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
        this.expose = true;
        if (details !== undefined) this.details = details;
    }
}

const badRequest = (code, message, details) => new HttpError(400, code, message, details);
const unauthorized = (code = 'unauthorized', message = 'Authentication required') => new HttpError(401, code, message);
const forbidden = (code = 'forbidden', message = 'Forbidden') => new HttpError(403, code, message);
const notFound = (code = 'not_found', message = 'Not found') => new HttpError(404, code, message);
const conflict = (code, message) => new HttpError(409, code, message);
const unavailable = (code = 'unavailable', message = 'Service unavailable') => new HttpError(503, code, message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, unavailable };

// @typecheck
'use strict';
/**
 * One id per request, on the response header and on every log line the
 * request produces.
 *
 * An incoming `X-Request-Id` (the ingress sets one) is kept when it looks like
 * an id, so ingress and application logs can be joined; anything else gets a
 * fresh UUID. The terminal error handler echoes the same id as `correlationId`.
 */

const { randomUUID } = require('node:crypto');
const { runWithRequestId } = require('../../telemetry/log');

const ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

function requestIdFrom(header) {
    return typeof header === 'string' && ID_SHAPE.test(header) ? header : randomUUID();
}

function withRequestId(req, res, next) {
    const id = requestIdFrom(req.headers['x-request-id']);
    req.id = id;
    res.setHeader('X-Request-Id', id);
    runWithRequestId(id, next);
}

module.exports = { withRequestId, requestIdFrom };

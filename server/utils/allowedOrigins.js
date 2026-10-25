// @typecheck strict
/**
 * The CORS_ORIGIN allow-list and the membership test against it: one
 * implementation for the global CORS dispatcher (boot/httpMiddleware.js) and
 * for routes that check an Origin themselves (routes/cmsForms.js).
 */

'use strict';

/** @param {string | undefined} raw the CORS_ORIGIN value, comma separated */
function parseAllowedOrigins(raw) {
    return (raw || 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Trailing-slash-insensitive membership test.
 * @param {string} origin
 * @param {string[]} allowed
 */
function isAllowedOrigin(origin, allowed) {
    const normalized = origin.endsWith('/') ? origin.slice(0, -1) : origin;
    return allowed.some((o) => (o.endsWith('/') ? o.slice(0, -1) : o) === normalized);
}

module.exports = { parseAllowedOrigins, isAllowedOrigin };

/** @typedef {import('express-serve-static-core').Express} Express */
// @typecheck
'use strict';
/**
 * The HTTP front of the middleware chain, moved verbatim out of server/index.js.
 * index.js calls these in this order, with the process error handlers between
 * the first and the second, exactly where the code used to sit inline:
 *
 *   applyRequestIdAndSecurityHeaders  X-Request-Id, then helmet / Permissions-Policy /
 *                                     API cache-control (boot/securityHeaders.js)
 *   applyCors                         the CORS allow-list dispatcher: a disallowed
 *                                     Origin gets a 403 here, for every method
 *   applyBodyParsers                  the Stripe webhook's raw body, then the global
 *                                     JSON parser that keeps req.rawBody
 *
 * The CORS warning state lives in the closure applyCors builds, so each call is
 * one independent dispatcher: index.js makes one, index.errorHandler.test.js
 * makes a fresh one per case with its own CORS_ORIGIN and log.
 */
const express = require('express');
const cors = require('cors');
const { parseAllowedOrigins, isAllowedOrigin: matchesAllowedOrigin } = require('../utils/allowedOrigins');
const defaultLog = require('../telemetry/log');
const { safeForLog } = require('../utils/safeForLog');

/**
 * The first two layers of the chain.
 * @param {Express} app
 */
function applyRequestIdAndSecurityHeaders(app) {
    // One id per request: on the X-Request-Id response header, on every log line
    // the request writes, and echoed as correlationId by the error handler below.
    app.use(require('../core/http/requestId').withRequestId);

    // ── Security headers, Permissions-Policy and API cache-control ───────────────
    // The first middleware in the chain — see boot/securityHeaders.js.
    require('./securityHeaders').applySecurityHeaders(app);
}

// The one message an operator actually needs from here is "a legitimate
// front-end is missing from CORS_ORIGIN". Everything else is noise, and the
// origin is attacker-chosen, so a line per rejection hands any anonymous client
// a write primitive against our log storage and buries the useful line.
//
// TWO limits, because per-key deduplication alone does not bound anything: a
// client sending a million DISTINCT origins gets a million log lines out of a
// per-origin rule. So there is also an aggregate ceiling per window — beyond it
// the warnings stop entirely and one summary line is emitted when the window
// rolls over. The tracking map is capped separately: its keys are
// attacker-chosen too, so it must not be growable into a memory-exhaustion
// vector.
const CORS_WARN_WINDOW_MS = 10 * 60 * 1000;
const CORS_WARN_MAX_TRACKED = 200;
const CORS_WARN_MAX_PER_WINDOW = 20;

/**
 * Mount the CORS dispatcher (exactly one layer) and return its helpers.
 * ALLOWED_ORIGINS is read from CORS_ORIGIN when this runs.
 * @param {{ use: Function }} app
 * @param {{ log?: { warn: Function } }} [opts]
 */
function applyCors(app, { log = defaultLog } = {}) {
    const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ORIGIN);

    /**
     * Trailing-slash-insensitive membership test against the allow-list.
     * @param {string} origin
     */
    const isAllowedOrigin = (origin) => matchesAllowedOrigin(origin, ALLOWED_ORIGINS);

    // The counters behind the ceilings above, one set per dispatcher.
    const _corsWarnedAt = new Map();
    let _corsWarnWindowStart = 0;
    let _corsWarnCount = 0;
    let _corsSuppressed = 0;
    /** @param {string} origin */
    function warnRejectedOrigin(origin) {
        const now = Date.now();

        // Roll the aggregate window, reporting anything we swallowed in the last one.
        if (now - _corsWarnWindowStart >= CORS_WARN_WINDOW_MS) {
            if (_corsSuppressed > 0) {
                log.warn(`[CORS] ${_corsSuppressed} further origin rejections were suppressed in the previous window.`);
            }
            _corsWarnWindowStart = now;
            _corsWarnCount = 0;
            _corsSuppressed = 0;
        }

        const last = _corsWarnedAt.get(origin);
        if (last !== undefined && now - last < CORS_WARN_WINDOW_MS) return;

        if (_corsWarnedAt.size >= CORS_WARN_MAX_TRACKED) {
            for (const [key, ts] of _corsWarnedAt) {
                if (now - ts >= CORS_WARN_WINDOW_MS) _corsWarnedAt.delete(key);
            }
            // Still full ⇒ evict the oldest insertion (Map preserves insertion order).
            if (_corsWarnedAt.size >= CORS_WARN_MAX_TRACKED) {
                _corsWarnedAt.delete(_corsWarnedAt.keys().next().value);
            }
        }
        _corsWarnedAt.set(origin, now);

        if (_corsWarnCount >= CORS_WARN_MAX_PER_WINDOW) {
            _corsSuppressed++;
            return;
        }
        _corsWarnCount++;
        log.warn(`[CORS] Rejected origin: ${safeForLog(origin)}. Allowed:`, ALLOWED_ORIGINS);
    }

    const globalCors = cors({
        origin: (/** @type {string | undefined} */ origin, /** @type {(err: Error | null, allow?: boolean) => void} */ cb) => {
            // Same-origin / curl / server-to-server (no Origin header)
            if (!origin) return cb(null, true);
            if (isAllowedOrigin(origin)) return cb(null, true);

            // Fail closed, WITHOUT throwing. Two earlier shapes of this callback were
            // both wrong. `cb(null, origin)` reflected ANY origin and — combined with
            // credentials:true — let arbitrary websites issue authenticated XHRs
            // against this API. `cb(new Error(...))` did block the browser, but it
            // threw into Express, so every disallowed preflight became a 500 whose
            // body carried a Node stack trace (this file's path and line numbers, the
            // middleware chain, dependency versions) back to an anonymous caller.
            // `cb(null, false)` is what actually blocks: the cors package then omits
            // Access-Control-Allow-Origin entirely and the browser refuses the
            // response — and nothing is thrown.
            warnRejectedOrigin(origin);
            return cb(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        // X-Beeflow-Client must be listed or the browser refuses the preflight and
        // NO cross-origin call gets through — authFetch sets it on every request
        // (agent-hub/src/utils/helpers.ts). Production never caught this because
        // the SPA and the API share an origin there, so nothing pre-flights; it
        // breaks exactly the split-origin setups — the dev server on :5176 talking
        // to :3001, and self-hosts serving the app from a separate host.
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-Beeflow-Client']
    });

    // Sandboxed preview iframes have an opaque origin (`Origin: null`) and never
    // carry cookies. Auth on /api/webpages-preview/* is HMAC bearer tokens scoped
    // to (userId, webpageId), so the origin check buys nothing — we just need
    // permissive CORS so the browser doesn't pre-flight-block the calls.
    const previewCors = cors({
        origin: true,           // reflect whatever Origin the iframe sends, including 'null'
        credentials: false,     // never send cookies; the bearer token is the trust anchor
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.use((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        if (req.path.startsWith('/api/webpages-preview/')) return previewCors(req, res, next);
        // Anonymous public-share AI bridge — same opaque-origin/bearer-token model
        // as the preview bridge, so the same permissive CORS applies.
        if (req.path.startsWith('/api/public-share/')) return previewCors(req, res, next);

        // A request carrying a disallowed Origin is refused HERE, for every method
        // — not just OPTIONS.
        //
        // That "not just OPTIONS" is the whole point, and getting it wrong is
        // subtle. Omitting Access-Control-Allow-Origin stops the attacker's page
        // from READING the response, but it does not stop the request from being
        // SENT: a CORS-simple request (multipart/form-data,
        // application/x-www-form-urlencoded, text/plain, or any POST acting on path
        // params alone) is never preflighted, so with an OPTIONS-only refusal the
        // route still executes with the victim's cookies attached. Uploads, CMS
        // writes and model-spend endpoints all qualify, this API has no global CSRF
        // token, and production renders COOKIE_SAMESITE=none — so "unreadable
        // response" is not a defence there.
        //
        // The old `cb(new Error(...))` blocked the request itself, at the cost of a
        // 500 with a stack trace. This keeps the blocking and drops the stack trace:
        // an early, explicit 403 before the session, DB and rate-limit middleware
        // ever run. It is also honest in a proxy log, where the router's automatic
        // 204 for a rejected preflight read as success.
        //
        // Requests with NO Origin header (curl, the Nextcloud connector, Stripe,
        // server-to-server) are untouched — browsers are the only thing that sets
        // it, and it is the browser this protects. Same-origin browser traffic is
        // covered because a deployment's own front-end origin is in CORS_ORIGIN; it
        // has to be, since the previous behaviour already failed those requests
        // (with a 500) if it was not. `Vary: Origin` keeps a shared cache from
        // replaying this refusal to a legitimate origin.
        const origin = req.headers.origin;
        if (origin && !isAllowedOrigin(origin)) {
            warnRejectedOrigin(origin);
            res.setHeader('Vary', 'Origin');
            return res.status(403).json({ error: 'Origin not allowed' });
        }
        return globalCors(req, res, next);
    });

    return { ALLOWED_ORIGINS, isAllowedOrigin, safeForLog, warnRejectedOrigin };
}

/**
 * Whether a request can need `req.rawBody`. Keeping a string copy of every JSON
 * body doubles the memory of large payloads; only two readers exist:
 *   - auth/connectorSig.js verifies the HMAC of a request carrying X-Beeflow-Sig
 *   - routes/cmsForms.js sizeGuard measures the public website-form body
 * (the GitHub / Nextcloud webhook routes capture their own, route-level.)
 * @param {import('http').IncomingMessage & { originalUrl?: string }} req
 */
function needsRawBody(req) {
    if (req.headers && req.headers['x-beeflow-sig']) return true;
    const url = String(req.originalUrl || req.url || '');
    return url.includes('/forms/');
}

/**
 * The raw Stripe-webhook body, then the global JSON parser.
 * @param {Express} app
 */
function applyBodyParsers(app) {
    // Stripe webhook needs raw body for signature verification — must be BEFORE express.json
    app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
    // Capture the raw JSON bytes on every request. The Nextcloud connector's
    // HMAC endpoints (task-processing/execute, automation/events/nextcloud) sign
    // over the exact request body and verify against `req.rawBody`; their own
    // route-level raw-capture never fires because this global parser consumes the
    // stream first, so the signature was checked against an empty body and every
    // connector→SaaS call 401'd. Storing the raw string here (a no-op for parsing)
    // makes `req.rawBody` available to those verifiers.
    app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { if (needsRawBody(req)) req.rawBody = buf.toString('utf8'); } }));
}

module.exports = { applyRequestIdAndSecurityHeaders, applyCors, applyBodyParsers, needsRawBody };

// @typecheck
'use strict';
/**
 * The session layers of the middleware chain, moved verbatim out of
 * server/index.js. index.js calls them in this order, with the Nextcloud
 * connector's JWT layer (auth/connectorJwt.js) between the two, exactly where
 * the code used to sit inline:
 *
 *   applyCookieSession  PostgreSQL session store with the Redis read-through cache,
 *                       the refuse-to-boot secret checks, the cookie session, then
 *                       the per-request client tag and the document-crypto session
 *   applySessionBridge  the X-Session-Token bridge (popup→iframe handoff for
 *                       embedded mode), then the Microsoft login-identity recheck
 *
 * GET /api/session-token, which MINTS the bridge tokens, stays in index.js: the
 * route-surface sweep (auth/accessRegistry.sweep.test.js) reads the app-level
 * routes there.
 *
 * `deps` is the test seam (boot/bootChain.characterisation.test.js): every
 * collaborator falls back to the module the inline code required, at the moment
 * it required it — the two inside the bridge stay lazy, per request.
 */
const session = require('express-session');
const defaultLog = require('../telemetry/log');

/**
 * @param {{ use: Function }} app
 * @param {any} [deps]
 */
function applyCookieSession(app, deps = {}) {
    const log = deps.log || defaultLog;

    const pgSession = (deps.connectPgSimple || require('connect-pg-simple'))(session);
    const { pool, getRedis } = deps.db || require('../db');
    const { installRedisCacheWhenReady } = deps.sessionCache || require('../auth/sessionCache');

    // Sessions: PostgreSQL is the durable source of truth (survives Redis restarts).
    // Redis is wired as a read-through cache layer on top — cache hit avoids a DB
    // round-trip for the session lookup that happens on every authenticated request.
    // Primary: PostgreSQL (persistent via beeflow-pgdata volume)
    const pgStore = new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 900 });
    log.info('[Sessions] Using PostgreSQL session store (persistent across deploys)');
    const sessionStore = pgStore;

    // Redis session cache — read-through layer over pgStore, on the shared ioredis
    // client from db.js (TLS, reconnects and fail-fast are configured there). It
    // activates once that client is connected; without Redis, or when Redis is not
    // reachable at boot, sessions stay PG-only.
    installRedisCacheWhenReady(sessionStore, pgStore, getRedis());

    // Session lifetime and whether it slides — see auth/sessionLifetime.js for
    // what these two values actually were versus what the docs claimed.
    const { sessionMaxAgeMs, sessionRolling } = require('../auth/sessionLifetime');

    if (!process.env.MASTER_ENCRYPTION_KEY || process.env.MASTER_ENCRYPTION_KEY.length < 32) {
        throw new Error('MASTER_ENCRYPTION_KEY must be set to a random value of at least 32 characters; it keys everything encrypted at rest. See .env.example. Generate with: openssl rand -hex 32');
    }
    app.use((deps.session || session)({
        store: sessionStore,
        name: process.env.COOKIE_NAME || 'connect.sid',
        secret: (() => {
            const s = process.env.SESSION_SECRET;
            if (!s || s.length < 32) {
                throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters. See .env.example. Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
            }
            return s;
        })(),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.COOKIE_SECURE === 'false' ? false : (process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'),
            httpOnly: true,
            // Session lifetime. THIRTY days, and FIXED — `rolling` is off, so the
            // window runs from sign-in and does not extend with activity. Signing in
            // on the 1st means signing in again on the 31st however much you used
            // it, and a session idle since the 1st is still valid on the 30th.
            //
            // The API reference described this as "14 days, sliding, refreshed on
            // every successful API call". Wrong on all three counts, and the reason
            // that matters is not tidiness: an organisation writing "sessions expire
            // after 14 days of inactivity" into its ISO access-control policy
            // (A.5.17, A.8.5) would be documenting a control it does not have.
            //
            // Configurable now, because a session timeout is a policy an
            // organisation sets rather than one a vendor picks for them. The default
            // is unchanged — shortening it for everyone has a cost (people signed
            // out sooner) that belongs to whoever runs the installation.
            maxAge: sessionMaxAgeMs(),
            sameSite: process.env.COOKIE_SAMESITE || 'lax',
            ...(process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
        },
        // Off by default, matching the behaviour that has always been in place. Set
        // SESSION_ROLLING=true for an inactivity timeout instead of a fixed window,
        // which is what most access-control policies actually describe.
        rolling: sessionRolling(),
    }));

    // Which client is this? Every client sends X-Beeflow-Client and until now
    // nothing read it, so no query could tell a phone turn from a browser one.
    // Mounted before the auth layers so it covers every route including the
    // unauthenticated ones, and held in AsyncLocalStorage so `logUsage` can read
    // it without forty call sites growing a parameter.
    const { withRequestClient } = require('../telemetry/requestClient');
    app.use(withRequestClient);
    app.use((deps.documentCrypto || require('../stores/lib/documentCrypto')).withDocumentEncryptionSession);
}

/**
 * @param {{ use: Function }} app
 * @param {any} [deps]
 */
function applySessionBridge(app, deps = {}) {
    const log = deps.log || defaultLog;

    // ── Session-token bridge (popup→iframe handoff for embedded mode) ──
    // Helpers live in utils/sessionToken so OAuth callback can mint pickup tokens.
    const { getSessionToken } = deps.sessionToken || require('../utils/sessionToken');

    app.use(async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        const sessionToken = req.headers['x-session-token'];
        if (sessionToken) {
            // Wrapped because this is an async middleware: under Express 5 a
            // rejection here goes to the error handler, so a Redis that exists but
            // is unhealthy would 500 EVERY request carrying the header — the whole
            // app for a bridged client, not just this lookup. Continuing anonymous
            // degrades to a 401 the client can act on.
            let data = null;
            try {
                data = await getSessionToken(sessionToken);
            } catch (err) {
                log.warn('[Sessions] Bridge token lookup failed:', /** @type {Error} */ (err).message);
            }
            if (data) {
                Object.assign(req.session, data);
                // The iframe presents this token on EVERY request (that is the
                // whole point of the bridge — its cookie never reaches us), so
                // the session is rebuilt per request and a persisted row would
                // never be read back. Skip the end-of-response PG write.
                const { suppressSessionPersistence } = deps.establishSession || require('../auth/establishSession');
                suppressSessionPersistence(req);
                // Re-validate license on bridge transfer. Without this the iframe
                // would inherit whatever tier was cached when the parent session
                // was created — possibly stale after a revocation/upgrade. The
                // resolution is memoised on req.session for 30s anyway.
                try {
                    const { resolveBestTierForRequest } = deps.licenseMiddleware || require('../license/middleware');
                    const resolution = await resolveBestTierForRequest(req);
                    req.session._bridgeTier = resolution.tier;
                } catch (err) { defaultLog.debug('non-fatal', err); }
            }
        }
        next();
    });

    // Recheck the login identity even when connected integration credentials change.
    app.use((deps.microsoftSession || require('../auth/microsoftSession')).validateMicrosoftSession);
}

module.exports = { applyCookieSession, applySessionBridge };

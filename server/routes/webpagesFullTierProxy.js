/**
 * Full-tier reverse proxy — GATED, INERT unless webpageRuntimeManager.isEnabled().
 *
 * Forwards preview-iframe document/asset/HMR traffic for webpages running the
 * FULL runtime tier (a real per-project Node/Vite dev container — see
 * server/services/webpageRuntimeManager.js) to that container. The light tier
 * (server/routes/webpagesPreview.js's `/:id/app/*rest`) is untouched by this
 * file — it's a completely separate code path for the isolated-vm `api/*.js`
 * backend, not a reverse proxy.
 *
 * Mount path: /api/webpages-preview/:id/full/* — every webpage's full-tier
 * container is proxied under this SAME path shape
 * (webpageRuntimeManager.fullTierBasePath is the single source of truth both
 * this file and the container's own VITE_BASE_PATH env derive from, so they
 * can't drift apart into two different path strings).
 *
 * Auth model:
 *   - HTTP requests go through the normal Express chain: requirePreviewToken
 *     (Bearer header) → the shared dbBridgeLimiter tier → ensureFullTierTarget
 *     (starts/reuses the container, attaches the resolved target to req) →
 *     the proxy middleware.
 *   - WebSocket upgrades (Vite HMR) bypass Express entirely — Node hands raw
 *     upgrade requests straight to http.Server 'upgrade' listeners. Browsers
 *     also can't set custom headers on a WS handshake, so the token travels
 *     via query string (?token=...) instead of Authorization, and MUST be
 *     verified BEFORE the socket is ever handed to the proxy — never upgrade
 *     first and check after.
 *
 * Known limitation (documented in server/webpage-runner/README.md): a project
 * that ships its OWN vite.config.js won't automatically read VITE_BASE_PATH,
 * so its root-relative asset URLs may 404 behind this sub-path proxy until
 * it's updated to set `base` itself.
 */

const { createProxyMiddleware } = require('http-proxy-middleware');

const { requirePreviewToken, verifyPreviewToken } = require('../auth/webpagePreviewToken');
const { dbBridgeLimiter } = require('./webpagesPreviewRateLimits');
const webpageRuntimeManager = require('../services/webpageRuntimeManager');
const { loadAuthorContext } = require('../core/webpages/webpageBridgeAuth');
const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');

const MOUNT_PATH = '/api/webpages-preview/:id/full';
const UPGRADE_URL_RE = /^\/api\/webpages-preview\/([^/?]+)\/full(?:\/|$)/;

/**
 * Resolves (starting a cold container if needed) the target for a request
 * already authenticated by requirePreviewToken, and attaches it to `req` for
 * the proxy's `router` to read. Kept synchronous-for-the-router by design: a
 * failed/slow ensureRuntime() surfaces as a normal Express error response
 * here, not as an ambiguous proxy-layer failure.
 */
async function ensureFullTierTarget(req, res, next) {
    const claims = req.previewClaims;
    try {
        const ctx = await loadAuthorContext(claims.webpageId);
        if (!ctx) return res.status(404).json({ error: 'Webpage not found' });
        const entry = await webpageRuntimeManager.ensureRuntime({
            webpageId: claims.webpageId,
            userId: ctx.authorUserId,
            orgId: ctx.authorOrgId,
        });
        if (!entry) return res.status(409).json({ error: 'Full-tier runtime is not available for this webpage.' });
        req.fullTierTarget = `http://${entry.reachableHost}`;
        next();
    } catch (err) {
        log.error('[WebpagesFullTier] runtime start failed:', err);
        next(new HttpError(503, 'full_tier_unavailable', 'Failed to start the full-tier runtime.'));
    }
}

function buildProxyMiddleware() {
    return createProxyMiddleware({
        // Synchronous — reads the target ensureFullTierTarget (HTTP) or the
        // upgrade handler (WS) already resolved and attached to req.
        router: (req) => req.fullTierTarget,
        changeOrigin: true,
        ws: true,
        on: {
            error: (err, req, res) => {
                log.error('[WebpagesFullTierProxy] proxy error:', err.message);
                // `res` is a Socket (not an http.ServerResponse) on the WS
                // upgrade path — only http response objects have .headersSent.
                if (res && typeof res.headersSent === 'boolean') {
                    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Full-tier runtime proxy error.' }));
                } else if (res && typeof res.destroy === 'function') {
                    res.destroy();
                }
            },
        },
    });
}

/**
 * Wire the full-tier proxy into the app + its underlying http.Server. Call
 * ONLY when webpageRuntimeManager.isEnabled() — this function does not
 * re-check the gate itself so that requiring http-proxy-middleware (this
 * file's only real cost) stays entirely out of the require graph for
 * installs that never touch the feature. See server/index.js's call site.
 */
function mountFullTierProxy(app, server) {
    const proxy = buildProxyMiddleware();

    app.use(MOUNT_PATH, requirePreviewToken, dbBridgeLimiter, ensureFullTierTarget, proxy);

    server.on('upgrade', (req, socket, head) => {
        const match = typeof req.url === 'string' && req.url.match(UPGRADE_URL_RE);
        if (!match) return; // not a full-tier proxy path — leave it for any other upgrade listener
        const webpageId = decodeURIComponent(match[1]);

        let token = null;
        try { token = new URL(req.url, 'http://internal').searchParams.get('token'); } catch (_) { /* malformed URL */ }
        const claims = verifyPreviewToken(token);
        if (!claims || claims.webpageId !== webpageId) {
            socket.destroy();
            return;
        }

        // Only reuse an ALREADY-running container — HMR connects after the
        // initial HTTP page load already ensured it. Starting one cold from a
        // WS upgrade is both bad UX (no response channel to report progress
        // on) and unnecessary.
        webpageRuntimeManager.getReachableBase(webpageId)
            .then((base) => {
                if (!base) { socket.destroy(); return; }
                req.fullTierTarget = base;
                proxy.upgrade(req, socket, head);
            })
            .catch((err) => {
                log.error('[WebpagesFullTierProxy] upgrade error:', err.message);
                socket.destroy();
            });
    });
}

module.exports = { mountFullTierProxy };

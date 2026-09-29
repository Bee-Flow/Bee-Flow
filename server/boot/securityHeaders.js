/**
 * Response headers applied to every request before any router sees it: the
 * helmet baseline, the Permissions-Policy the clipboard paste depends on, the
 * ETag disable and the no-store rule for dynamic API responses. Mounted by
 * index.js as the first middleware, so the order inside here is the order the
 * app registers them in.
 */

function applySecurityHeaders(app) {
    // ── Security headers (helmet) ─────────────────────────────────────────────────
    const helmet = require('helmet');
    app.use(helmet({
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        contentSecurityPolicy: false,        // Handled by Nginx
        // Match what nginx sends. Both layers were emitting Referrer-Policy with
        // DIFFERENT values (helmet's default `no-referrer` here, and
        // `strict-origin-when-cross-origin` from the template), so every proxied
        // response carried the header twice. Browsers read a repeated
        // Referrer-Policy as a token list and honour the last valid one, which was
        // already nginx's — so agreeing on that value removes the duplicate without
        // changing what any browser actually does. The public-viewer `/p/` block
        // still overrides to `no-referrer` on purpose; nginx appends after us, so
        // that intent survives.
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        crossOriginEmbedderPolicy: false,    // Can break embedded content
        crossOriginResourcePolicy: { policy: 'same-site' },  // Allow cross-subdomain resource loading (server.dev → dev.beeflow.nl)
        permissionsPolicy: false,            // Managed manually below (clipboard needs self)
    }));
    // Allow clipboard access so users can paste screenshots in the conversation area.
    // navigator.clipboard.read() requires this header — without it the browser blocks
    // the API before even showing a permission prompt.
    app.use((req, res, next) => {
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), clipboard-read=(self), clipboard-write=(self)');
        next();
    });

    // Disable Express's automatic ETag on responses. The NC AppAPI PHP/Apache hop
    // can otherwise revalidate a dynamic JSON GET with If-None-Match and replay a
    // stale 304 body even though we send Cache-Control: no-store — which made the
    // chat-history sidebar and other lists show stale data until a hard refresh
    // (BFSF-209). no-store + no ETag means the proxy can't serve a cached body.
    app.disable('etag');

    // Dynamic, per-user API responses must never be cached by the browser or any
    // intermediary. In the Nextcloud connector path (browser → NC AppAPI proxy →
    // connector → here) these JSON GETs carried no Cache-Control, so the browser
    // heuristically cached them and replayed a stale role / group / member list
    // until the cache was cleared — one account saw a change while another did not.
    // Mark them non-cacheable. Image-ish endpoints (icons, branding) are excluded
    // so they keep their own long-lived caching.
    app.use((req, res, next) => {
        if ((req.path.startsWith('/auth/') || req.path.startsWith('/api/')
                || req.path.startsWith('/ai/') || req.path.startsWith('/agents/'))
            && !req.path.startsWith('/api/icons')
            && !req.path.startsWith('/api/branding')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
        }
        next();
    });
}

module.exports = { applySecurityHeaders };

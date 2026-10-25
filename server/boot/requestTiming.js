// @typecheck
/**
 * Per-route latency instrumentation. Mounted by index.js right after the body
 * parser; the counters it fills are read back by /api/admin/metrics.
 */

const { bestEffort } = require('../utils/bestEffort');

const UNMATCHED_ROUTE = '__unmatched__';

function _normalizeRoute(req) {
    // No matched route (404s, scanners, static misses): never fall back to
    // the raw path, or every probed URL becomes its own metric series
    // (BFSF-468).
    if (!req.route) return UNMATCHED_ROUTE;
    // A matched route defined with a RegExp or an array has no template
    // string: label it by its mount point plus a fixed marker.
    const routePath = typeof req.route.path === 'string' ? req.route.path : '/__regex__';
    const full = (req.baseUrl || '') + routePath;
    const norm = full.split('/').filter(Boolean).map(seg => {
        if (/^\d+$/.test(seg)) return ':id';
        if (/^[0-9a-fA-F-]{8,}$/.test(seg)) return ':id';
        if (seg.length > 24) return ':id';
        return seg;
    }).join('/');
    return '/' + norm;
}
function mountRequestTiming(app) {
    // ── Request-timing instrumentation ─────────────────────────────────────────────
    // Records per-route latency into httpMetrics (exposed at /api/admin/metrics).
    // Route labels are normalized to a TEMPLATE (id-like segments → :id) so
    // cardinality stays bounded regardless of how many conversations/agents exist.
    // Long-lived SSE streams are skipped — their duration is the stream length, not
    // request-handling latency, and would swamp the histogram.
    const httpMetrics = require('../telemetry/httpMetrics');
    app.use((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            try {
                const ct = res.getHeader('Content-Type');
                if (typeof ct === 'string' && ct.includes('text/event-stream')) return;
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                httpMetrics.recordHttp({ method: req.method, route: _normalizeRoute(req), status: res.statusCode, ms });
            } catch (err) { bestEffort('boot/requestTiming:mountRequestTiming', err); /* never break the response */ }
        });
        next();
    });
}

module.exports = { mountRequestTiming, UNMATCHED_ROUTE, _normalizeRoute };

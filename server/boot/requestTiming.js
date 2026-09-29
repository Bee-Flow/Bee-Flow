/**
 * Per-route latency instrumentation. Mounted by index.js right after the body
 * parser; the counters it fills are read back by /api/admin/metrics.
 */

function mountRequestTiming(app) {
    // ── Request-timing instrumentation ─────────────────────────────────────────────
    // Records per-route latency into httpMetrics (exposed at /api/admin/metrics).
    // Route labels are normalized to a TEMPLATE (id-like segments → :id) so
    // cardinality stays bounded regardless of how many conversations/agents exist.
    // Long-lived SSE streams are skipped — their duration is the stream length, not
    // request-handling latency, and would swamp the histogram.
    const httpMetrics = require('../telemetry/httpMetrics');
    function _normalizeRoute(req) {
        let full = (req.baseUrl || '') + ((req.route && req.route.path && typeof req.route.path === 'string') ? req.route.path : '');
        if (!full) full = req.path || '';
        const norm = full.split('/').filter(Boolean).map(seg => {
            if (/^\d+$/.test(seg)) return ':id';
            if (/^[0-9a-fA-F-]{8,}$/.test(seg)) return ':id';
            if (seg.length > 24) return ':id';
            return seg;
        }).join('/');
        return '/' + norm;
    }
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            try {
                const ct = res.getHeader('Content-Type');
                if (typeof ct === 'string' && ct.includes('text/event-stream')) return;
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                httpMetrics.recordHttp({ method: req.method, route: _normalizeRoute(req), status: res.statusCode, ms });
            } catch (_) { /* never break the response */ }
        });
        next();
    });
}

module.exports = { mountRequestTiming };

/**
 * Web Vitals API — receives Core Web Vitals beacons from the browser.
 *
 * Log-only (no DB persistence). Each beacon represents one metric reading
 * (CLS, INP, LCP, FCP, TTFB) for one page load, sent fire-and-forget by
 * the client. The goal is to get a real-user perf baseline into the server
 * log so it can be aggregated downstream (Loki / a follow-up dashboard)
 * and so refactor PRs can be compared against a known starting point.
 *
 * Intentionally unauthenticated — TTFB / FCP fire before the session is
 * established and any auth gate produces a 500/401 cascade that never
 * reaches the log. Best-effort userId capture from req.session when one
 * happens to be present.
 *
 * Like its sibling /api/client-errors this makes it a write endpoint anyone
 * who can reach the host may call, whose only effect is appending to the
 * operator's log — i.e. a disk-filler / incident-burier without a limiter.
 * Same per-IP limiter as clientErrors.js, sized for this endpoint's traffic:
 * one page load emits up to five metric beacons (CLS, INP, LCP, FCP, TTFB)
 * where an error report is one — 60/min/IP buys the same page-load headroom
 * that 30/min buys client-errors, while still bounding an abuser to one log
 * line per second. Beacons are fire-and-forget (sendBeacon ignores the 429),
 * so throttled clients lose nothing but the excess telemetry.
 *
 * ── The body stays OPEN, deliberately — no zod schema here ─────────────
 *
 * A schema's job is to tell the sender what was wrong, and nobody here would
 * hear it: sendBeacon never reads the response, and the keepalive fetch
 * fallback discards it. A 400 would only turn a beacon into a lost sample.
 * The payload's shape belongs to the `web-vitals` library, which adds fields
 * between releases. What this route owns is what reaches the log, and that is
 * already closed: an unknown metric name is dropped, an unknown rating is
 * logged as '', numbers that are not numbers become null, and every text field
 * is truncated to a fixed width — nothing the body carries can widen a line.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const log = require('../telemetry/log');

const router = express.Router();

const beaconLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many web-vitals beacons.' },
});

const VALID_METRICS = new Set(['CLS', 'INP', 'LCP', 'FCP', 'TTFB']);
const VALID_RATINGS = new Set(['good', 'needs-improvement', 'poor']);

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

router.post('/', beaconLimiter, (req, res) => {
    try {
        const body = req.body || {};
        const name = String(body.name || '');
        if (!VALID_METRICS.has(name)) {
            // Silently drop unknown metric names — no point in logging spam.
            res.status(204).end();
            return;
        }
        const rating = String(body.rating || '');
        const entry = {
            name,
            value: num(body.value),
            delta: num(body.delta),
            id: truncate(String(body.id || ''), 64),
            rating: VALID_RATINGS.has(rating) ? rating : '',
            navigationType: truncate(String(body.navigationType || ''), 32),
            url: truncate(String(body.url || ''), 512),
            at: truncate(String(body.at || new Date().toISOString()), 48),
            buildSha: truncate(String(body.buildSha || ''), 64),
            userId: req.session?.user?.id || req.session?.user?.username || null,
        };
        log.info('[WebVitals]', JSON.stringify(entry));
    } catch (e) {
        log.error('[WebVitals] handler failed:', e);
    }
    res.status(204).end();
});

module.exports = router;

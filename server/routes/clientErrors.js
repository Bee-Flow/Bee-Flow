/**
 * Client Errors API — receives error reports from the browser ErrorBoundary.
 *
 * Log-only (no DB persistence). The goal is to get minified production stack
 * traces + React component stacks into the server log so they can be decoded
 * against sourcemap CI artifacts. Fire-and-forget from the client side.
 *
 * Intentionally unauthenticated: errors that fire during the boot path (e.g.
 * before the session is established, or while auth is mid-refresh) are
 * exactly the ones most worth capturing. Gating behind requireAuth caused
 * those reports to 500/401 and never reach the log. Best-effort userId
 * capture from the session when one happens to be present.
 *
 * Being unauthenticated makes it the one write endpoint anyone who can reach
 * the host may call, and its effect is to append to the operator's log — so it
 * is also a way to fill a disk, or to bury a real incident under noise. Hence
 * the limiter below. The Android client rate-limits itself as well; that one
 * protects the user's data plan, this one protects the server, and neither
 * substitutes for the other because an attacker does not run our client.
 *
 * ── Why this body has no schema ─────────────────────────────────────
 *
 * Deliberately left OPEN. A refused crash report is a lost crash report, and
 * worse than lost: the web reporter (agent-hub/src/utils/clientErrorReporter.js)
 * queues a report that did not get a 2xx and drains that queue at the next
 * mount, stopping at the first failure — so one payload the server refused
 * would sit at the head of the queue for good and hold back every report
 * behind it. The two clients do not send the same fields either (the phone
 * omits `url`, `userRole` and `featureFlags`), and a client release that adds
 * one must not go dark. Nothing here is a setting that can silently not take:
 * every field is coerced to text, truncated, and logged, so the handler below
 * already is the allow-list — a key it does not name is simply not logged.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const { currentClient } = require('../telemetry/requestClient');
const log = require('../telemetry/log');

const router = express.Router();

// 30/minute/IP. A real client sends a handful per session; a render loop or a
// script sends thousands. Deliberately per-IP rather than per-session: the
// reports worth having are the ones from a client with no session yet.
const reportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many error reports.' },
});

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

router.post('/', reportLimiter, (req, res) => {
    try {
        const body = req.body || {};
        const entry = {
            label: truncate(String(body.label || 'unknown'), 64),
            message: truncate(String(body.message || ''), 2000),
            stack: truncate(String(body.stack || ''), 8000),
            componentStack: truncate(String(body.componentStack || ''), 8000),
            url: truncate(String(body.url || ''), 512),
            userAgent: truncate(String(body.userAgent || ''), 512),
            at: truncate(String(body.at || new Date().toISOString()), 48),
            buildSha: truncate(String(body.buildSha || ''), 64),
            userRole: truncate(String(body.userRole || ''), 64),
            featureFlags: truncate(JSON.stringify(body.featureFlags || {}), 1024),
            userId: req.session?.user?.id || req.session?.user?.username || null,
            // Which client crashed. Without it a report from the phone and one
            // from the browser are indistinguishable in the log, and the two
            // have almost no code in common — so the first question anyone asks
            // about a stack trace is the one the log could not answer.
            client: currentClient(),
        };
        log.error('[ClientError]', JSON.stringify(entry));
    } catch (e) {
        log.error('[ClientError] handler failed:', e);
    }
    res.status(204).end();
});

module.exports = router;

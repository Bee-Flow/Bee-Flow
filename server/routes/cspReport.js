/**
 * CSP violation report sink.
 *
 * When Content-Security-Policy is enabled in report-only mode (either at
 * the Express layer or upstream in Nginx), browsers POST violations here.
 * Log-only — the goal is to surface accidental violations during the
 * pre-rollout soak so we can adjust the policy before flipping to
 * enforcing.
 *
 * No auth: CSP reports are fired by the browser with the Origin set, often
 * without the user's session cookie attached. Rate-limiting + payload size
 * caps keep this endpoint safe to leave open.
 *
 * ── Why this body has no schema ─────────────────────────────────────
 *
 * Deliberately left OPEN: the body is the BROWSER's, in one of two shapes the
 * standards define (the legacy `{ "csp-report": {…} }` and the Reporting API's
 * `[{ type, body }]`), with field names that differ between them and between
 * browser versions. A schema here would refuse reports we did not write the
 * format of — and a browser does not read the answer, so a refusal is just a
 * violation nobody sees. The handler below is the allow-list: it names the
 * fields it logs, and truncates each.
 *
 * What it did NOT bound was the count. Every element of an array body became
 * its own log line, and until this file carried a limiter — the header above
 * always claimed one — nothing bounded the requests either. A body of `{}`s is
 * three bytes an element, and `application/json` is parsed by the app-wide
 * parser (20 MB) before the 32 KB one below is ever consulted: one anonymous
 * request could write millions of log lines. Now: at most
 * MAX_REPORTS_PER_REQUEST lines per request, and the same per-IP limiter shape
 * as /api/web-vitals.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const log = require('../telemetry/log');

const router = express.Router();

const MAX_BODY = 16_384; // 16 KB cap per report.

// A browser batches the violations of one page into a handful of reports; the
// Reporting API's own default batch is a few dozen at most.
const MAX_REPORTS_PER_REQUEST = 20;

// 60/minute/IP: a page load under a report-only policy can raise several
// violations, and a report that is throttled costs a diagnostic, never a user
// anything — the browser does not look at the answer.
const reportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many CSP reports.' },
});

function truncate(s, max) {
    if (typeof s !== 'string') return '';
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

// Browsers send either `application/csp-report` (legacy) or
// `application/reports+json` (Reporting API v2). Accept both — express.json's
// strict parser is forgiving when the Content-Type is set explicitly.
const cspBody = express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '32kb',
});

router.post('/', reportLimiter, cspBody, (req, res) => {
    try {
        const body = req.body || {};
        // Legacy shape: { "csp-report": {...} }
        // Reporting API shape: [{ type: 'csp-violation', body: {...} }, ...]
        const all = Array.isArray(body) ? body.map(r => (r && r.body) || r) : [body['csp-report'] || body];
        const reports = all.slice(0, MAX_REPORTS_PER_REQUEST);
        for (const r of reports) {
            if (!r || typeof r !== 'object') continue;
            const entry = {
                blockedUri: truncate(String(r['blocked-uri'] || r.blockedURL || ''), 512),
                violatedDirective: truncate(String(r['violated-directive'] || r.effectiveDirective || ''), 128),
                documentUri: truncate(String(r['document-uri'] || r.documentURL || ''), 512),
                disposition: truncate(String(r.disposition || ''), 32),
                sourceFile: truncate(String(r['source-file'] || r.sourceFile || ''), 512),
                lineNumber: Number(r['line-number'] || r.lineNumber) || null,
                statusCode: Number(r['status-code'] || r.statusCode) || null,
                userAgent: truncate(String(req.get('user-agent') || ''), 256),
                at: new Date().toISOString(),
            };
            // Cap the cumulative payload so a malformed flood can't fill logs.
            const json = JSON.stringify(entry);
            log.warn('[csp-report]', json.length > MAX_BODY ? json.slice(0, MAX_BODY) : json);
        }
        if (all.length > reports.length) {
            log.warn(`[csp-report] ${all.length - reports.length} more report(s) in this request were not logged`);
        }
    } catch (e) {
        log.warn('[cspReport] parse failed', e);
    }
    res.sendStatus(204);
});

module.exports = router;

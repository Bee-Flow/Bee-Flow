/**
 * Rate limiters for the anonymous public-share AI bridge
 * (server/routes/publicShareBridge.js).
 *
 * Split into its own dependency-free module (only `express-rate-limit`) so it
 * can be unit-tested without importing the full route graph — same rationale as
 * webpagesPreviewRateLimits.js.
 *
 * These endpoints spend the AUTHOR's LLM budget on behalf of anonymous
 * visitors, so two buckets stack:
 *   - per-share  — a leaked bridge token can't be amplified by rotating IPs.
 *   - per-IP     — one NAT/attacker can't fan out across many different shares.
 *
 * Must be mounted AFTER requireShareBridgeToken — the per-share key generator
 * reads req.shareBridgeClaims, which that middleware sets. (The per-IP limiter
 * uses req.ip and works regardless of ordering.)
 */

const rateLimit = require('express-rate-limit');

function shareKey(req) {
    const c = req.shareBridgeClaims;
    return c ? `share:${c.shareId}` : 'anon';
}

const publicAiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: shareKey,
    message: 'Too many AI requests for this page. Please try again in a minute.',
});

const publicIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    // Default keyGenerator (req.ip) — publicViewer already trusts req.ip via its
    // own viewLimiter, so `trust proxy` is configured.
    message: 'Too many AI requests. Please try again in a minute.',
});

module.exports = { shareKey, publicAiLimiter, publicIpLimiter };

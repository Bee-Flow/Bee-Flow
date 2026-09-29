/**
 * Abuse limits for the publicly reachable support endpoints: the anonymous
 * submit limiter, the thread-read limiter that blunts UUID brute-force, and
 * the per-email submit cap. The in-memory hit map is module-level state and
 * lives only here.
 */

const rateLimit = require('express-rate-limit');

const { getUserId } = require('./shared');

const publicCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many submissions from this IP. Try again in a minute.' },
});

// Read-side limiter — defends against UUID brute-force on /threads/:id. Real
// users polling a thread won't hit this; an attacker spraying UUIDs will.
const threadReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down.' },
    // Don't block staff: skip the limiter when the session is authenticated
    // (the limiter only matters for anonymous token-pull traffic).
    skip: (req) => !!getUserId(req),
});

// Per-email anonymous-submit limiter — caps how often the same email can be
// used to probe whether an address is registered. Uses a small in-memory LRU.
// Note: not durable across restarts, but acceptable for an enumeration
// mitigation (an attacker that can survive restarts already has bigger
// problems).
const _emailHits = new Map(); // sha256-hash → [timestamps]
const EMAIL_LIMIT_WINDOW_MS = 60 * 1000;
const EMAIL_LIMIT_MAX = 3;
const _crypto = require('crypto');
function _hashEmail(addr) {
    return _crypto.createHash('sha256').update((addr || '').toLowerCase()).digest('hex');
}
function _emailRateLimitOk(email) {
    if (!email) return true; // logged-in user: skip
    const key = _hashEmail(email);
    const now = Date.now();
    const cutoff = now - EMAIL_LIMIT_WINDOW_MS;
    let hits = _emailHits.get(key) || [];
    hits = hits.filter(t => t > cutoff);
    if (hits.length >= EMAIL_LIMIT_MAX) {
        _emailHits.set(key, hits);
        return false;
    }
    hits.push(now);
    _emailHits.set(key, hits);
    // Crude LRU prune: drop anything stale once we breach 5k entries.
    if (_emailHits.size > 5000) {
        for (const [k, v] of _emailHits) {
            if (!v.some(t => t > cutoff)) _emailHits.delete(k);
        }
    }
    return true;
}

module.exports = {
    publicCreateLimiter,
    threadReadLimiter,
    _emailRateLimitOk,
};

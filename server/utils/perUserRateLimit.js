// @typecheck
// Per-user rate limiter for LLM-backed and studio-app endpoints.
//
// Two backends behind one middleware:
//   • REDIS (when REDIS_URL is configured and the client is ready): a fixed
//     60-second-style window via INCR + PEXPIRE on `rl:{name}:{key}:{window}`.
//     Counts are shared across ALL server replicas, so a documented limit is
//     the real ceiling — with the old in-memory buckets the true limit was
//     N-replicas × max ("adequate as an abuse brake, not an exact quota").
//   • IN-MEMORY sliding window (the original implementation) everywhere else:
//     self-host without Redis keeps working unchanged, and any Redis error
//     FAILS OPEN to this path — a rate limiter must never become an outage.
//
// Usage:
//   const limiter = perUserRateLimit({ windowMs: 60_000, max: 30, name: 'ai-chat' });
//   router.post('/path', limiter, handler);
//
// A route whose requests are not all the same size passes `costFn` and is
// charged per unit of work instead of per request — see below. Such a limiter
// must be mounted AFTER the body parser, since that is where the cost is
// readable.
//
// `name` namespaces the Redis keys AND opts the limiter into the Redis
// backend: an UNNAMED limiter always uses the in-memory path. Deliberate —
// dozens of existing call sites share window/max shapes and would collide in
// one Redis namespace; naming is the explicit, reviewable act of making a
// limit fleet-wide. Name the limiters where the ceiling must be exact across
// replicas (the studio-app set), leave the rest per-replica until named.

const { recordAuthEvent } = require('../telemetry/metrics');
const log = require('../telemetry/log');

let warnedRedisFallback = false;

// `costFn` — how much of the budget THIS request spends. Default 1, i.e. the
// window counts requests, which is what every existing call site means. A
// batching endpoint is the case that breaks that assumption: one request may
// carry twenty-five reads, so a request-counting limiter silently stops
// limiting the work. Such a route passes a costFn and is charged for what it
// actually asks for. A cost must be a positive integer; anything else counts
// as 1 rather than as free, because a limiter that can be zeroed by a
// malformed body is not a limiter.
function normalizeCost(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * @param {{
 *   windowMs?: number, max?: number, keyFn?: (req: any) => string, name?: string,
 *   costFn?: (req: any) => number, _redis?: any,
 * }} [options]
 */
function perUserRateLimit({ windowMs, max, keyFn, name, costFn, _redis } = {}) {
    const buckets = new Map(); // key → array of { t: timestamp ms, cost }
    const ns = name || null;

    // Injected in tests; resolved lazily in prod so the require doesn't drag
    // the pg pool into DB-free suites that stub '../db'.
    function currentRedis() {
        if (_redis !== undefined) return _redis; // test hook (may be null)
        try {
            const { getRedis, redisHealthy } = require('../db');
            return redisHealthy() ? getRedis() : null;
        } catch (_) {
            return null;
        }
    }

    // Periodic cleanup so a quiet user's bucket doesn't sit forever.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [k, arr] of buckets) {
            const filtered = arr.filter(e => e.t > cutoff);
            if (filtered.length === 0) buckets.delete(k);
            else if (filtered.length !== arr.length) buckets.set(k, filtered);
        }
    }, Math.max(60_000, windowMs));
    if (sweep.unref) sweep.unref();

    function deny(res, retryAfterSecs) {
        recordAuthEvent({ kind: 'rate_limit', status: 'blocked' });
        const retryAfter = Math.max(1, retryAfterSecs);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
            error: `Too many requests — limit is ${max} per ${Math.round(windowMs / 1000)}s. Retry in ~${retryAfter}s.`,
        });
    }

    function checkMemory(key, cost, res, next) {
        const now = Date.now();
        const cutoff = now - windowMs;
        const arr = (buckets.get(key) || []).filter(e => e.t > cutoff);
        const spent = arr.reduce((sum, e) => sum + e.cost, 0);
        // `>` not `>=`: a request costing more than the whole budget would
        // otherwise be refused forever rather than merely once per window. The
        // route's own per-batch cap is what keeps a single cost sane.
        if (spent + cost > max) {
            return deny(res, Math.ceil((arr[0].t + windowMs - now) / 1000));
        }
        arr.push({ t: now, cost });
        buckets.set(key, arr);
        next();
    }

    return function rateLimitMiddleware(req, res, next) {
        const key = (typeof keyFn === 'function' ? keyFn(req) : null)
            || req.session?.user?.id
            || req.ip
            || 'anon';
        const cost = typeof costFn === 'function' ? normalizeCost(costFn(req)) : 1;

        const redis = ns ? currentRedis() : null;
        if (!redis) return checkMemory(key, cost, res, next);

        const now = Date.now();
        const windowStart = Math.floor(now / windowMs);
        const redisKey = `rl:${ns}:${key}:${windowStart}`;
        // INCR (or INCRBY when this request costs more than one) + first-hit
        // PEXPIRE. The extra second of expiry absorbs clock skew between
        // replicas; the key dies on its own either way. A cost of 1 stays on
        // plain INCR so the dozens of existing call sites issue byte-identical
        // commands to the ones they always have.
        (cost === 1 ? redis.incr(redisKey) : redis.incrby(redisKey, cost))
            .then(async (count) => {
                if (count === cost) {
                    try { await redis.pexpire(redisKey, windowMs + 1000); } catch (_) {}
                }
                if (count > max) {
                    const windowEnd = (windowStart + 1) * windowMs;
                    return deny(res, Math.ceil((windowEnd - now) / 1000));
                }
                next();
            })
            .catch((err) => {
                if (!warnedRedisFallback) {
                    warnedRedisFallback = true;
                    log.warn(`[RateLimit] Redis error (${err.message}) — falling back to in-memory limits (per replica). This warning logs once.`);
                }
                checkMemory(key, cost, res, next);
            });
    };
}

module.exports = { perUserRateLimit };

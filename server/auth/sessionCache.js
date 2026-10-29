// @typecheck
/**
 * Redis Session Cache — write-through cache layer over connect-pg-simple
 *
 * Strategy:
 *   READ  → check Redis first (cache hit: ~0.3ms, no DB)
 *           on miss → delegate to pgStore → write result back to Redis
 *   WRITE → write to pgStore (durable) + set Redis key with TTL
 *   TOUCH → extend TTL in both stores
 *   DESTROY → delete from both stores
 *
 * PostgreSQL remains the **source of truth** and sessions survive Redis
 * restarts / container wipes. Redis is a pure performance overlay — if it
 * is down, every method falls back transparently to the pgStore.
 *
 * Usage:
 *   const { installRedisCacheWhenReady } = require('./auth/sessionCache');
 *   installRedisCacheWhenReady(sessionStore, pgStore, getRedis());
 *
 * The cache uses the shared ioredis client from db.js (one Redis connection
 * for the whole server). That client fails commands at once while Redis is
 * down (see db.js), so every method below degrades to the pgStore instead of
 * waiting for a reconnect.
 */
const log = require('../telemetry/log');

const CACHE_PREFIX = 'bf:sess:';
const CACHE_TTL_SECONDS = 15 * 60; // 15 min — same order as session prune interval

/**
 * Wrap a connect-pg-simple store with a Redis read-through cache.
 *
 * @param {SessionStore} pgStore    - Instance of connect-pg-simple
 * @param {SessionRedis | null} redis      - the shared ioredis client from db.js (getRedis())
 * @returns {SessionStore}          - A drop-in session store replacement
 */
function wrapWithRedisCache(pgStore, redis) {
    // If Redis is not available return the pgStore unwrapped
    if (!redis) return pgStore;

    const key = (sid) => `${CACHE_PREFIX}${sid}`;

    // IMPORTANT: Save references to the original PG methods BEFORE wrapping.
    // When the caller patches sessionStore.set = cached.set and sessionStore
    // IS the same object as pgStore, we'd get infinite recursion if we called
    // pgStore.set inside the wrapper. These bound copies are immune to that.
    const _pgGet     = pgStore.get.bind(pgStore);
    const _pgSet     = pgStore.set.bind(pgStore);
    const _pgTouch   = pgStore.touch ? pgStore.touch.bind(pgStore) : null;
    const _pgDestroy = pgStore.destroy.bind(pgStore);


    // ── helpers ─────────────────────────────────────────────────────────────────

    async function cacheGet(sid) {
        try {
            const raw = await redis.get(key(sid));
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            // Redis upset — degrade gracefully, fall through to PG
            log.warn('[SessionCache] Redis GET error:', e.message);
            return null;
        }
    }

    async function cacheSet(sid, session, ttl) {
        try {
            const t = ttl || CACHE_TTL_SECONDS;
            // ioredis form: positional 'EX', seconds. (An options object, the
            // node-redis form, is not a TTL to ioredis.)
            await redis.set(key(sid), JSON.stringify(session), 'EX', t);
        } catch (e) {
            log.warn('[SessionCache] Redis SET error:', e.message);
        }
    }

    async function cacheDel(sid) {
        try {
            await redis.del(key(sid));
        } catch (e) {
            log.warn('[SessionCache] Redis DEL error:', e.message);
        }
    }

    function ttlFromSession(session) {
        if (session?.cookie?.expires) {
            const ms = /** @type {any} */ (new Date(session.cookie.expires)) - Date.now();
            if (ms > 0) return Math.min(Math.floor(ms / 1000), CACHE_TTL_SECONDS);
        }
        return CACHE_TTL_SECONDS;
    }

    // ── Cached store ─────────────────────────────────────────────────────────────

    const cachedStore = Object.create(pgStore);

    /**
     * GET — check Redis first, fall back to PG, write back on miss
     */
    cachedStore.get = function (sid, cb) {
        cacheGet(sid).then(cached => {
            if (cached) {
                return cb(null, cached);
            }
            // Cache miss → go to PG
            _pgGet(sid, (err, session) => {
                if (err || !session) return cb(err, session);
                // Write back to Redis so next request is a cache hit
                cacheSet(sid, session, ttlFromSession(session));
                cb(null, session);
            });
        }).catch(_err => {
            // Redis completely failed — fall straight to PG
            _pgGet(sid, cb);
        });
    };

    /**
     * SET — write to PG (durable), then update Redis cache
     */
    cachedStore.set = function (sid, session, cb) {
        _pgSet(sid, session, (err) => {
            if (!err) {
                // Best-effort Redis write — don't block the response on failure
                cacheSet(sid, session, ttlFromSession(session));
            }
            cb(err);
        });
    };

    /**
     * TOUCH — extend expiry in both stores
     */
    cachedStore.touch = function (sid, session, cb) {
        if (!_pgTouch) { if (cb) cb(); return; }
        _pgTouch(sid, session, (err) => {
            if (!err) {
                cacheSet(sid, session, ttlFromSession(session));
            }
            if (cb) cb(err);
        });
    };

    /**
     * DESTROY — delete from Redis first (fast), then from PG
     */
    cachedStore.destroy = function (sid, cb) {
        _pgDestroy(sid, (err) => {
            cacheDel(sid); // best-effort, don't wait
            if (cb) cb(err);
        });
    };

    log.info('[SessionCache] Redis session cache layer active (TTL:', CACHE_TTL_SECONDS, 's)');
    return cachedStore;
}

/**
 * Activate the Redis cache on the live session store once the shared ioredis
 * client is connected. Until then (and for good when Redis never comes up at
 * boot) the store stays PG-only.
 *
 * express-session holds a reference to the store object, so the wrapped
 * methods are copied onto it in place. `liveStore` may be `pgStore` itself:
 * the wrapper keeps bound copies of the original PG methods.
 *
 * ioredis emits 'ready' again after every reconnect; the cache is installed
 * on the first one only.
 *
 * @param {SessionStore} liveStore - the store object handed to express-session
 * @param {SessionStore} pgStore   - the connect-pg-simple store
 * @param {(SessionRedis & { status: string; once: (arg0: string, arg1: () => void) => void; }) | null} redis     - the shared ioredis client, or null without Redis
 * @returns {boolean} whether activation is pending or done
 */
function installRedisCacheWhenReady(liveStore, pgStore, redis) {
    if (!redis) return false;
    const activate = () => {
        log.info('[Sessions] Redis connected — activating session read-through cache');
        const cached = wrapWithRedisCache(pgStore, redis);
        liveStore.get     = cached.get.bind(cached);
        liveStore.set     = cached.set.bind(cached);
        liveStore.touch   = cached.touch.bind(cached);
        liveStore.destroy = cached.destroy.bind(cached);
    };
    if (redis.status === 'ready') activate();
    else redis.once('ready', activate);
    return true;
}

/** The PG rows are gone but a cached copy could not be removed: the session stays valid until its TTL. */
class CacheEvictionError extends Error {}

/** Remove busted sessions from the Redis cache; a failure must reach the caller, never leave a revoked session usable. */
async function evictCached(r, sids) {
    if (!r || !sids.length) return;
    const keys = sids.map(sid => `${CACHE_PREFIX}${sid}`);
    try {
        await r.unlink(...keys).catch(() => r.del(...keys));
    } catch (err) {
        throw new CacheEvictionError(`session cache eviction failed: ${err.message}`);
    }
}

/**
 * Bust all live sessions for a given user. Used after the user's license is
 * revoked, their role is downgraded, or their account is deleted — without
 * this, the existing cookie still validates for up to 30 days.
 *
 * Returns the number of sessions destroyed (PG row count).
 * `db` is the test seam (pool + getRedis, as db.js exports them).
 */
async function bustSessionsForUser(userId, { db = require('../db') } = {}) {
    if (!userId) return 0;
    try {
        const { pool, getRedis } = db;
        const result = await pool.query(
            `DELETE FROM user_sessions
                   WHERE sess::jsonb -> 'user' ->> 'id' = $1
               RETURNING sid`,
            [String(userId)]
        );
        const sids = (result.rows || []).map(r => r.sid);
        await evictCached(getRedis(), sids);
        if (sids.length) {
            log.info(`[SessionCache] bust.user user_id=${userId} sessions=${sids.length}`);
        }
        return sids.length;
    } catch (e) {
        log.error('[SessionCache] bustSessionsForUser error:', e.message);
        if (e instanceof CacheEvictionError) throw e;
        return 0;
    }
}

/**
 * Bust every session belonging to any user in the given org. Used on org-wide
 * license revocation. Walks `users."organizationId"` to enumerate IDs, then
 * delegates per-user to bustSessionsForUser so the Redis bust happens too.
 */
async function bustSessionsForOrg(organizationId, { db = require('../db') } = {}) {
    if (!organizationId) return 0;
    try {
        const { pool, getRedis } = db;
        const result = await pool.query(
            `DELETE FROM user_sessions
                   WHERE sess::jsonb -> 'user' ->> 'organizationId' = $1
                      OR sess::jsonb -> 'user' ->> 'orgId' = $1
               RETURNING sid`,
            [String(organizationId)]
        );
        const sids = (result.rows || []).map(r => r.sid);
        await evictCached(getRedis(), sids);
        if (sids.length) {
            log.info(`[SessionCache] bust.org org_id=${organizationId} sessions=${sids.length}`);
        }
        return sids.length;
    } catch (e) {
        log.error('[SessionCache] bustSessionsForOrg error:', e.message);
        if (e instanceof CacheEvictionError) throw e;
        return 0;
    }
}

module.exports = { wrapWithRedisCache, installRedisCacheWhenReady, bustSessionsForUser, bustSessionsForOrg };

/**
 * @typedef {Record<string, unknown> & { cookie?: { expires?: string | number | Date | null } }} SessionData  a stored session (JSON)
 * @typedef {(err?: unknown) => void} StoreCallback
 * @typedef {{ get: (sid: string, cb: (err: unknown, session?: SessionData | null) => void) => void,
 *   set: (sid: string, session: SessionData, cb: StoreCallback) => void, touch?: (sid: string, session: SessionData, cb?: StoreCallback) => void,
 *   destroy: (sid: string, cb?: StoreCallback) => void }} SessionStore  the express-session store methods the cache wraps
 * @typedef {{ get: (key: string) => Promise<string | null>, set: (key: string, value: string, mode: 'EX', seconds: number) => Promise<unknown>,
 *   del: (...keys: string[]) => Promise<unknown> }} SessionRedis  the ioredis calls the cache makes
 */

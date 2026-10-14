// @typecheck
/**
 * Permissions — the caches behind requireAuth (user exists) and
 * getUserPermissions (permission set): TTLs, the bounded in-memory fallback
 * Maps, the cross-node Redis pub/sub invalidation and the invalidate*
 * functions. All cache state lives in this module.
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const log = require('../telemetry/log');
const { getRedis } = require('../db');
const { buildKey } = require('../utils/buildInfo');
const USER_CHECK_TTL = 5; // seconds
const PERM_CACHE_TTL = 30; // seconds — permission cache TTL

// Cross-process cache keys (bf:perms:/bf:uex:) are stamped with the build
// version via buildKey(): during a rolling deploy, old and new pods share the
// same Redis but may disagree on what a cached permission snapshot means, so
// each build reads and writes only its own keys. The other build's keys simply
// age out on their short TTLs — TTL and invalidation behaviour are unchanged.
// The in-memory fallback Maps below are per-process and need no stamp.

// Bounded in-memory caches. Both are pure fallbacks for when Redis is
// unavailable; Redis remains the canonical store in cloud deployments. The
// LRU bound protects multi-day single-node uptime against unbounded growth
// when user counts run into the high thousands.
const PERM_CACHE_MAX = parseInt(process.env.PERM_CACHE_MAX || '5000', 10);
const USER_EXISTS_CACHE_MAX = parseInt(process.env.USER_EXISTS_CACHE_MAX || '5000', 10);
function _makeBoundedMap(max) {
    const m = new Map();
    m.set = function(k, v) {
        if (this.has(k)) Map.prototype.delete.call(this, k);
        Map.prototype.set.call(this, k, v);
        if (this.size > max) {
            // Map preserves insertion order — oldest key is first.
            const oldest = this.keys().next().value;
            Map.prototype.delete.call(this, oldest);
        }
        return this;
    };
    return m;
}
const _userExistsCache = _makeBoundedMap(USER_EXISTS_CACHE_MAX);
const _permCache = _makeBoundedMap(PERM_CACHE_MAX);

// ─── Cross-node cache invalidation ───────────────────────────────────────────
// Even with Redis as the cache backend, multi-node deploys can end up with
// stale state in two ways:
//   1. Without Redis: each node has its own `_permCache` Map and a delete on
//      node A doesn't fan out.
//   2. With Redis: a read on node B can complete between node A's mutation
//      and node A's `r.del(...)`, so node B briefly held a stale value.
// Publishing the user-id (or '*' for the bulk-clear case) onto a Redis pub/sub
// channel makes every node drop its in-memory copy immediately. Best-effort:
// pub/sub failures are logged and ignored — the existing Redis-key delete
// remains the source of truth.
const PERM_INVALIDATE_CHANNEL = 'bf:perms:invalidate';
const UEX_INVALIDATE_CHANNEL = 'bf:uex:invalidate';
let _subscriberStarted = false;

function _ensureSubscriber() {
    if (_subscriberStarted) return;
    const r = getRedis();
    if (!r || typeof r.duplicate !== 'function') return;
    try {
        const sub = r.duplicate();
        sub.on('error', (e) => log.warn('[Auth] perm invalidate subscriber error:', e.message));
        sub.subscribe(PERM_INVALIDATE_CHANNEL, UEX_INVALIDATE_CHANNEL, (err) => {
            if (err) {
                log.warn('[Auth] perm invalidate subscribe failed:', err.message);
                return;
            }
            _subscriberStarted = true;
        });
        sub.on('message', (channel, message) => {
            try {
                if (channel === PERM_INVALIDATE_CHANNEL) {
                    if (message === '*') _permCache.clear();
                    else _permCache.delete(message);
                } else if (channel === UEX_INVALIDATE_CHANNEL) {
                    if (message === '*') _userExistsCache.clear();
                    else _userExistsCache.delete(message);
                }
            } catch (e) {
                log.warn('[Auth] perm invalidate handler error:', e.message);
            }
        });
    } catch (e) {
        log.warn('[Auth] perm invalidate subscriber setup failed:', e.message);
    }
}

async function _publish(channel, message) {
    const r = getRedis();
    if (!r) return;
    _ensureSubscriber();
    try { await r.publish(channel, message); } catch (_) { /* non-fatal */ }
}

// Eagerly subscribe at module load if Redis is already up. If Redis comes up
// later, the next mutation will trigger _ensureSubscriber() via _publish.
setImmediate(() => { try { _ensureSubscriber(); } catch (_) { /* non-fatal */ } });

/**
 * Invalidate the cached permission set for a specific user.
 * Call this after user/group/role mutations (create, update, delete).
 */
async function invalidatePermissionCache(userId) {
    if (!userId) return;
    // Always clear locally — covers the in-memory fallback and any micro-
    // cache window before pub/sub fans out.
    _permCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(buildKey(`bf:perms:${userId}`)); } catch (_) { }
    }
    await _publish(PERM_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate the user-existence cache used by requireAuth. Until this fires,
 * the cached isAdmin / existence value can outlive the user's actual role
 * by USER_CHECK_TTL (5s). Called from admin endpoints that promote/demote.
 */
async function invalidateUserExistenceCache(userId) {
    if (!userId) return;
    _userExistsCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(buildKey(`bf:uex:${userId}`)); } catch (_) { }
    }
    await _publish(UEX_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate every user's cached permission set. Used on group/role mutations
 * where the affected-user set isn't easily enumerable.
 */
async function invalidateAllPermissionCaches() {
    _permCache.clear();
    const r = getRedis();
    if (r) {
        try {
            let cursor = '0';
            do {
                // Deliberately unstamped pattern: the bulk clear may sweep every
                // build's keys — extra invalidation is always safe.
                const [next, keys] = await r.scan(cursor, 'MATCH', 'bf:perms:*', 'COUNT', 200);
                cursor = next;
                if (keys.length) {
                    try { await r.unlink(...keys); } catch (_) { try { await r.del(...keys); } catch (_) { } }
                }
            } while (cursor !== '0');
        } catch (err) {
            log.warn('[Auth] invalidateAllPermissionCaches scan failed:', err.message);
        }
    }
    await _publish(PERM_INVALIDATE_CHANNEL, '*');
}

module.exports = {
    USER_CHECK_TTL,
    PERM_CACHE_TTL,
    _makeBoundedMap,
    _userExistsCache,
    _permCache,
    invalidatePermissionCache,
    invalidateUserExistenceCache,
    invalidateAllPermissionCaches,
};

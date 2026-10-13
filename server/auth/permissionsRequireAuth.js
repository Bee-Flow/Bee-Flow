// @typecheck
/**
 * Permissions — the session gate (requireAuth) and the "last seen" throttle
 * it drives.
 *
 * Part of auth/permissions.js (the public surface); import from there.
 */

const { dep } = require('./permissionsDeps');
/** @type {typeof import('../stores/userStore')} */
const userStore = dep('userStore');
const { tagGate } = require('./gateMeta');
const log = require('../telemetry/log');
const { getRedis } = require('../db');
const { buildKey } = require('../utils/buildInfo');
const { USER_CHECK_TTL, _makeBoundedMap, _userExistsCache } = require('./permissionsCache');

// ─── "Last seen" throttle (B15) ──────────────────────────────────────────────
// users.last_seen_at is the single source for "when did we last see this
// account" — the session/device list references it rather than keeping a second
// clock. Writing it on every authenticated request would add a write to every
// request in the product for a field nobody reads more precisely than "today",
// so one write per user per window is the whole design.
//
// Two gates, in this order:
//   1. a per-process memo — synchronous, so the overwhelming majority of
//      requests decide "already done" without touching Redis at all;
//   2. `SET key 1 EX <window> NX` on Redis, which makes the window hold across
//      pods: exactly one of them wins the key and performs the UPDATE.
// Without Redis only gate 1 applies, so N pods write at most N times per
// window. For an activity clock that is close enough.
//
// The key is NOT build-stamped, unlike bf:perms:/bf:uex:. Those cache a
// SNAPSHOT that two builds can disagree about; this one is a rate marker with
// no contents, so surviving a rolling deploy is the wanted behaviour — a
// stamped key would reset every window on every deploy and buy nothing.
const LAST_SEEN_WINDOW = parseInt(process.env.LAST_SEEN_WINDOW || '900', 10); // seconds
const LAST_SEEN_CACHE_MAX = parseInt(process.env.LAST_SEEN_CACHE_MAX || '5000', 10);
const _lastSeenCache = _makeBoundedMap(LAST_SEEN_CACHE_MAX);

/**
 * Note activity for an authenticated user. Returns immediately — the write is
 * fire-and-forget, and every failure along the way is swallowed.
 *
 * This is bookkeeping, not a gate: a request must never be slower, and must
 * certainly never fail, because an activity timestamp could not be stored. The
 * memo is claimed BEFORE the async work so that a burst of parallel requests
 * from one browser produces one write and not a dozen.
 */
function noteUserSeen(userId) {
    if (!userId) return;
    const now = Date.now();
    const last = _lastSeenCache.get(userId);
    if (last && (now - last) < LAST_SEEN_WINDOW * 1000) return;
    _lastSeenCache.set(userId, now);

    Promise.resolve().then(async () => {
        const r = getRedis();
        if (r) {
            const won = await r.set(`bf:lseen:${userId}`, '1', 'EX', LAST_SEEN_WINDOW, 'NX');
            if (won !== 'OK') return;   // another pod already stamped this window
        }
        await dep('userStoreNow').touchLastSeen(userId);
    }).catch(() => { /* never let an activity clock break a request */ });
}

// Middleware to check authentication
// NOTE: tagged AFTER definition, not as `tagGate(async () => {...})`. Passing the
// arrow as an argument defeats JS's name inference from the const, which silently
// renamed this to '' — breaking routes/automation.routetable.test.js's frozen
// baseline ('USE:requireAuth' → 'USE:anonymous'), every stack trace through it,
// and the walker's own fn.name fallback for untagged middleware.
const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    let microsoftSessionAccepted = false;
    await dep('microsoftSession').validateMicrosoftSession(req, res, () => { microsoftSessionAccepted = true; });
    if (!microsoftSessionAccepted) return;

    // Verify user still exists in DB (cached for 5s to avoid DB spam)
    const userId = req.session.user?.id;
    if (userId) {
        let exists = null;
        const r = getRedis();
        const cacheKey = buildKey(`bf:uex:${userId}`);

        if (r) {
            try {
                const val = await r.get(cacheKey);
                if (val !== null) exists = val === '1';
            } catch (_) { /* Redis error — fall through to DB */ }
        } else {
            const cached = _userExistsCache.get(userId);
            const now = Date.now();
            if (cached && (now - cached.ts) <= USER_CHECK_TTL * 1000) {
                exists = cached.exists;
            }
        }

        if (exists === null) {
            // Cache miss — check DB
            try {
                const userStore = dep('userStoreNow');
                const user = await userStore.getUser(userId);
                exists = !!user;
                if (r) {
                    try { await r.set(cacheKey, exists ? '1' : '0', 'EX', USER_CHECK_TTL); } catch (_) { }
                } else {
                    _userExistsCache.set(userId, { exists, ts: Date.now() });
                }
            } catch (e) {
                // Without the database nobody can say whether this account still
                // exists; letting it through would keep a deleted user signed in
                // for the length of the outage.
                log.error('[Auth] user existence check failed:', e.message);
                return res.status(503).json({ error: 'auth_unavailable' });
            }
        }

        if (!exists) {
            if (r) { try { await r.del(cacheKey); } catch (_) { } }
            else { _userExistsCache.delete(userId); }
            req.session.destroy(() => { });
            return res.status(401).json({ error: 'User no longer exists' });
        }

        // ── Revalidate isAdmin flag (prevent stale elevation after demotion) ──
        // Piggyback on the user-exists check — we already fetched the user above
        // Re-check every USER_CHECK_TTL seconds alongside the existence check
        try {
            const user = await userStore.getUser(userId);
            if (user) {
                const shouldBeAdmin = user.role === 'admin';
                if (req.session.isAdmin !== shouldBeAdmin) {
                    req.session.isAdmin = shouldBeAdmin;
                    req.session.user.role = user.role;
                    req.session.user.isAdmin = shouldBeAdmin;
                }
            }
        } catch (_) { /* DB error — don't block the request */ }

        // Only here, at the bottom of the authenticated path: an anonymous
        // request has already been turned away with a 401 above, and a session
        // pointing at a deleted account has been destroyed, so neither can move
        // an activity clock. Every authenticated caller passes this line —
        // cookie sessions, the x-session-token bridge and the connector JWT all
        // arrive as a populated req.session — which is why the throttle needs
        // one home and not three.
        noteUserSeen(userId);
    }

    next();
};
tagGate(requireAuth, { axis: 'auth' });

module.exports = {
    requireAuth,
};

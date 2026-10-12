/**
 * Cross-replica fan-out for project live updates.
 *
 * ── The shape, and why ──────────────────────────────────────────────────────
 *
 * POSTGRES IS THE ORDERING AUTHORITY; REDIS IS ONLY A DOORBELL.
 *
 * A durable event is written to `project_events` first (which allocates its
 * per-project `seq`), and only then is a notification published. Subscribers
 * treat that notification as "something happened in project X, read from your
 * cursor" rather than as the payload itself. Three things fall out of that:
 *
 *   - Reconnect and catch-up are the SAME code path as live delivery. A client
 *     that drops for a minute replays by cursor and misses nothing.
 *   - A dropped Redis message costs latency, not data.
 *   - Without Redis at all (self-host, single container) the in-process emitter
 *     covers it, and a slow poll covers the rest.
 *
 * Redis rather than Postgres LISTEN/NOTIFY: NOTIFY needs a dedicated connection
 * held outside the pg pool for the process lifetime, caps payloads at 8 kB, and
 * silently drops notifications across a reconnect. Redis is already a
 * first-class optional dependency here, with a working cross-node pub/sub
 * precedent in auth/permissions.js — including the "no Redis, degrade to local"
 * path that self-host needs.
 *
 * ── Durable vs transient ────────────────────────────────────────────────────
 *
 * Durable events (a message posted, a member removed) get a row and a `seq`.
 * Transient ones (typing, presence, streaming snapshots) do not: they are
 * meaningless a second later, and giving them a cursor position would mean a
 * reconnecting client replayed "Anna is typing" from ten minutes ago.
 */

const { EventEmitter } = require('events');
const db = require('../db');
const log = require('../telemetry/log');

const CHANNEL_PREFIX = 'bf:project:';

// Identifies this process so a replica can ignore the echo of its own publish.
// Random per boot; it never needs to be stable or meaningful.
const _originId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Local fan-in. Every subscriber on THIS replica hangs off it, whether the
// event originated here or arrived over Redis.
const bus = new EventEmitter();
bus.setMaxListeners(0);   // one listener per open SSE stream; the cap is noise

// The Redis handles, replaceable in tests (`_setRedis`) without module mocking.
let _redisDeps = { getRedis: db.getRedis, redisHealthy: db.redisHealthy };
const getRedis = () => _redisDeps.getRedis();

let _subscriber = null;
let _subscriberReady = false;
const _subscribedProjects = new Set();

/**
 * Lazily create the Redis subscriber connection.
 *
 * Mirrors _ensureSubscriber in auth/permissions.js: a duplicated client (a
 * subscriber connection cannot issue normal commands), an error handler so a
 * Redis blip cannot take the process down, and best-effort semantics
 * throughout.
 */
function _ensureSubscriber() {
    if (_subscriber) return _subscriber;
    const r = getRedis();
    if (!r || typeof r.duplicate !== 'function') return null;
    try {
        const sub = r.duplicate();
        sub.on('error', (e) => log.warn('[ProjectEventBus] subscriber error:', e.message));
        // "Distributed" means a subscriber that is actually connected and
        // subscribed, not one that merely exists: `duplicate()` returns before
        // the connection is up, and a connection lost later keeps the object.
        // ioredis re-subscribes every channel itself when it reconnects.
        sub.on('ready', () => { _subscriberReady = true; });
        sub.on('end', () => { _subscriberReady = false; });
        sub.on('close', () => { _subscriberReady = false; });
        sub.on('message', (channel, message) => {
            try {
                const parsed = JSON.parse(message);
                // Redis delivers a publish back to the publishing replica too.
                // The local subscribers already got this one directly, so
                // re-emitting it would duplicate every message in every open
                // stream on the originating replica.
                if (parsed._origin === _originId) return;
                delete parsed._origin;
                bus.emit(channel.slice(CHANNEL_PREFIX.length), parsed);
            } catch (e) {
                log.warn('[ProjectEventBus] bad message on', channel, e.message);
            }
        });
        _subscriber = sub;
        _subscriberReady = sub.status === 'ready';
        return sub;
    } catch (e) {
        log.warn('[ProjectEventBus] subscriber setup failed:', e.message);
        return null;
    }
}

function _channel(projectId) { return `${CHANNEL_PREFIX}${projectId}`; }

/**
 * Subscribe to a project's events on this replica.
 *
 * @param {string} projectId
 * @param {(event: object) => void} handler
 * @returns {() => void} unsubscribe
 */
function subscribeProject(projectId, handler) {
    bus.on(projectId, handler);

    // Subscribe to the Redis channel once per project per replica, however many
    // local listeners it has.
    if (!_subscribedProjects.has(projectId)) {
        const sub = _ensureSubscriber();
        if (sub) {
            _subscribedProjects.add(projectId);
            sub.subscribe(_channel(projectId), (err) => {
                if (err) {
                    _subscribedProjects.delete(projectId);
                    log.warn('[ProjectEventBus] subscribe failed:', err.message);
                }
            });
        }
    }

    return function unsubscribe() {
        bus.off(projectId, handler);
        // Drop the Redis subscription when the last local listener goes, so a
        // long-lived process does not accumulate channels for projects nobody
        // is watching.
        if (bus.listenerCount(projectId) === 0 && _subscribedProjects.has(projectId)) {
            _subscribedProjects.delete(projectId);
            try { _subscriber?.unsubscribe(_channel(projectId)); } catch (_) { /* non-fatal */ }
        }
    };
}

/**
 * Announce an event to every replica.
 *
 * Emits locally first so a single-replica install (and any deployment with no
 * Redis) works identically, then publishes. Redis re-delivers to THIS replica
 * too, so local subscribers would otherwise see doubles — the published copy is
 * stamped with `_origin`, and the receive path drops anything carrying its own id.
 *
 * Never throws: a live-feed notification must not be able to fail the action it
 * is reporting.
 */
async function publishProjectEvent(projectId, event) {
    if (!projectId || !event) return;
    try {
        bus.emit(projectId, event);
    } catch (e) {
        log.warn('[ProjectEventBus] local emit failed:', e.message);
    }

    const r = getRedis();
    if (!r) return;
    // A client that is reconnecting would queue the publish and fail it
    // seconds later with a warning per event; the local emit above already
    // served this replica, and the other replicas' poll covers the gap.
    if (!_isHealthy()) return;
    try {
        _ensureSubscriber();
        await r.publish(_channel(projectId), JSON.stringify({ ...event, _origin: _originId }));
    } catch (e) {
        log.warn('[ProjectEventBus] publish failed:', e.message);
    }
}

/**
 * A transient event: no DB row, no `seq`, no replay.
 *
 * Typing indicators, presence, and the throttled streaming snapshots observers
 * see. Persisting these would bloat project_events and, worse, give them cursor
 * positions — so a reconnecting client would faithfully replay a stale "Anna is
 * typing" from ten minutes ago.
 */
async function publishTransient(projectId, event) {
    return publishProjectEvent(projectId, { ...event, transient: true });
}

/**
 * Honest names for non-project channels. The bus keys on any id string (the
 * Redis channel is `bf:project:<id>`), so a channel such as `doc:<documentId>`
 * cannot collide with a project uuid. Transient only: no row, no replay.
 */
const subscribeChannel = (channel, handler) => subscribeProject(channel, handler);
const publishChannel = (channel, event) => publishTransient(channel, event);

function _isHealthy() {
    try { return typeof _redisDeps.redisHealthy === 'function' ? !!_redisDeps.redisHealthy() : true; } catch (_) { return false; }
}

/** True when cross-replica delivery is actually available. */
function isDistributed() {
    return !!getRedis() && _isHealthy() && _subscriberReady;
}

/** Test seam. */
function _reset() {
    bus.removeAllListeners();
    _subscribedProjects.clear();
    _subscriber = null;
    _subscriberReady = false;
}

/**
 * Test seam: stand-ins for db.getRedis / db.redisHealthy. Pass nothing to
 * restore the real ones.
 * @param {{ getRedis: () => any, redisHealthy: () => boolean }} [deps]
 */
function _setRedis(deps) {
    _redisDeps = deps || { getRedis: db.getRedis, redisHealthy: db.redisHealthy };
    _reset();
}

module.exports = {
    subscribeProject,
    publishProjectEvent,
    publishTransient,
    subscribeChannel,
    publishChannel,
    isDistributed,
    _originId,
    _reset,
    _setRedis,
};

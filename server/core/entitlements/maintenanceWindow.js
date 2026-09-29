/**
 * Deployment / maintenance window announcements.
 *
 * A deploy rolls the Kubernetes Deployments, which severs every open SSE stream
 * and in-flight request on the pods being replaced. Users experience that as an
 * answer that stops mid-sentence. This module lets the deploy pipeline say
 * "going down, back in ~N seconds" BEFORE it patches anything, so the app can
 * warn people instead of dying under them.
 *
 * ── Why configStore, and not a table or a module-level global ───────────────
 *
 *   - configStore already broadcasts invalidations over Postgres LISTEN/NOTIFY
 *     (see CONFIG_INVALIDATE_CHANNEL), so every replica sees the announcement
 *     within milliseconds. A module-level global would only warn the users
 *     load-balanced onto the single replica that happened to receive the POST.
 *   - It outlives the restart it is announcing. A client that reconnects to a
 *     fresh pod mid-window re-reads the window and keeps its banner, instead of
 *     flickering it away the moment the old pod dies.
 *
 * ── Fail-open by construction ───────────────────────────────────────────────
 *
 * The stored window carries an absolute `endsAt` and reads as inactive once
 * that passes. A deploy that dies between announce and clear therefore cannot
 * strand a permanent "we are down" banner in front of every user — the worst
 * case is a stale banner for the remainder of the ETA. That is also why the ETA
 * is clamped: a typo'd `etaSeconds` of 999999 would otherwise outlive the
 * outage by eleven days.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY = 'maintenance.window';

// A rollout that legitimately takes under 10s is not worth interrupting anyone
// for; one that claims to take over an hour is a typo, not a deploy.
const MIN_ETA_SECONDS = 10;
const MAX_ETA_SECONDS = 3600;

/**
 * Clamp a caller-supplied ETA into a range a banner can honestly promise.
 * Returns null for anything that is not a number.
 *
 * The type guard is load-bearing, not defensive noise: `Number(null)`,
 * `Number('')`, `Number([])` and `Number(true)` are all finite, so a bare
 * Number() would quietly turn a missing ETA into a 10-second window and
 * announce an outage nobody asked for. Numeric strings ARE accepted because
 * a JSON body legitimately carries "180".
 */
function _clampEta(etaSeconds) {
    if (typeof etaSeconds !== 'number' && typeof etaSeconds !== 'string') return null;
    if (typeof etaSeconds === 'string' && etaSeconds.trim() === '') return null;
    const n = Number(etaSeconds);
    if (!Number.isFinite(n)) return null;
    return Math.min(MAX_ETA_SECONDS, Math.max(MIN_ETA_SECONDS, Math.round(n)));
}

/**
 * Is this stored window still in force?
 *
 * Exported for tests. `now` is injectable so the expiry boundary can be tested
 * without sleeping.
 */
function _isActive(win, now = Date.now()) {
    if (!win || typeof win !== 'object') return false;
    const endsAt = Date.parse(win.endsAt);
    if (!Number.isFinite(endsAt)) return false;
    return endsAt > now;
}

/**
 * Announce a deployment window.
 *
 * @param {{ etaSeconds: number, reason?: string, ref?: string }} opts
 * @returns {Promise<object>} the stored window
 * @throws {Error} when etaSeconds is not a finite number
 */
async function announce({ etaSeconds, reason = '', ref = '' } = {}) {
    const eta = _clampEta(etaSeconds);
    if (eta === null) throw new Error('etaSeconds must be a finite number');

    const startedAt = new Date();
    const win = {
        startedAt: startedAt.toISOString(),
        endsAt: new Date(startedAt.getTime() + eta * 1000).toISOString(),
        etaSeconds: eta,
        reason: String(reason || '').slice(0, 200),
        ref: String(ref || '').slice(0, 200),
    };

    await configStore.setConfig(CONFIG_KEY, JSON.stringify(win));
    log.info(`[Maintenance] window announced: ${eta}s, ref="${win.ref}"`);
    return win;
}

/** Clear the window early — the rollout finished ahead of its ETA. */
async function clear() {
    await configStore.setConfig(CONFIG_KEY, '');
    log.info('[Maintenance] window cleared');
}

/**
 * The window currently in force, or null.
 *
 * Reads through configStore's cache (60s TTL, invalidated cross-replica on
 * write), so this is cheap enough to call on every client poll.
 */
async function getActiveWindow(now = Date.now()) {
    let raw;
    try {
        raw = await configStore.getConfig(CONFIG_KEY);
    } catch (e) {
        // A banner is a courtesy. Never let its lookup fail a request.
        log.warn('[Maintenance] read failed:', e.message);
        return null;
    }
    if (!raw) return null;

    let win;
    try {
        win = JSON.parse(raw);
    } catch (_e) {
        return null;
    }
    return _isActive(win, now) ? win : null;
}

module.exports = {
    announce,
    clear,
    getActiveWindow,
    CONFIG_KEY,
    MIN_ETA_SECONDS,
    MAX_ETA_SECONDS,
    _clampEta,
    _isActive,
};

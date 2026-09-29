/**
 * One way to write into a project's live feed.
 *
 * ── The ordering rule, which is the whole delivery model ────────────────────
 *
 * PERSIST FIRST, THEN RING THE DOORBELL. The `project_events` row is what
 * assigns the gapless per-project `seq`, and subscribers read forward from
 * their cursor rather than trusting the notification's payload. Publishing
 * first would let a subscriber wake, read, and find nothing.
 *
 * Two things fall out of that, and both are why this must not be reimplemented
 * per caller: reconnect and catch-up become the SAME code path as live
 * delivery, and a dropped publish costs latency rather than data.
 *
 * ── Best-effort, always ─────────────────────────────────────────────────────
 *
 * A live-feed update must never fail the action that produced it. A chat turn
 * that answered correctly has not failed because the sidebar did not blink; a
 * client that misses a beat converges on its next poll. So every failure here
 * is warned and swallowed.
 *
 * `label` only names the subsystem in that warning — it has no effect on
 * delivery, and exists so a log line still says which producer stumbled now
 * that they share one implementation.
 */
const log = require('../telemetry/log');

async function emitProjectEvent(projectId, event, { label = 'Projects' } = {}) {
    if (!projectId) return;
    try {
        const stored = await require('../stores/projectStore').appendProjectEvent(projectId, event);
        if (!stored) return;
        await require('./projectEventBus').publishProjectEvent(projectId, { ...event, ...stored });
    } catch (err) {
        log.warn(`[${label}] project event emit failed:`, err.message);
    }
}

module.exports = { emitProjectEvent };

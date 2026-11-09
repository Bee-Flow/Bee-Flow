// @typecheck strict
/**
 * How long an event- or webhook-started run waits for a busy automation's
 * running marker (runHeartbeat.acquireRunMarker), in ms. Its run row is
 * 'queued' for that long, so the stuck-run reaper (scheduler/reapers.js)
 * allows a queued row this much on top of its stale window. One value, read
 * once, for both.
 */

'use strict';

const CONCURRENT_WAIT_MS = Math.max(0, Number(process.env.AUTOMATION_CONCURRENT_WAIT_MS ?? 300_000) || 0);

module.exports = { CONCURRENT_WAIT_MS };

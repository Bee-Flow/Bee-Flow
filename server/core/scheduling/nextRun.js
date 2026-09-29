/**
 * When should a periodic thing run again?
 *
 * Lifted out of `appStudio/connectorSync.js` (where it was written for
 * connector syncs) because a second scheduler now needs exactly the same
 * three rules — knowledge-base source refresh, `core/kb/sources` — and
 * `core/` may not require a product feature (`layering.test.js`: "core must
 * not depend on a feature"). Copying it instead would have given the two
 * schedulers separately-drifting ideas of what a backoff is, which is the
 * kind of divergence nobody notices until one of them hammers a provider.
 *
 * `connectorSync` keeps `nextRunFor`/`backoffMinutes` as re-export shims, so
 * its callers and its pinned tests are untouched.
 *
 * The three rules, in the order they win:
 *
 *   1. A provider that said WHEN to come back (`Retry-After`) outranks our
 *      own schedule. Ignoring it is how a soft rate-limit becomes a block.
 *   2. A cron schedule, resolved with the SAME parser the routine scheduler
 *      uses (`automation/cron.nextRunAt`) — so a schedule an editor accepted
 *      is one this can actually compute. Skipped while a streak of failures
 *      is running: cron says "every Monday at six", and honouring that after
 *      four failures means four more failures a week apart.
 *   3. Otherwise an interval, widened by the failure streak.
 *
 * Pure and clock-injectable: `fromTs` is a parameter, so every boundary here
 * is testable at the boundary.
 */

/**
 * The ceiling on a widened interval. An hour is long enough to stop being a
 * problem for whoever is being hammered, and short enough that a source
 * whose upstream came back does not sit idle for a working day.
 */
const MAX_BACKOFF_MINUTES = 60;

/** Never double more than this many times, whatever the streak says. */
const MAX_DOUBLINGS = 10;

/**
 * Widen the gap after repeated failures.
 *
 * Without this the catch path reschedules at the NORMAL cadence, so a source
 * that is being throttled, or whose credential was revoked, gets retried at
 * full speed forever — the fastest way to turn a soft failure into a hard
 * provider block.
 */
function backoffMinutes(baseMinutes, consecutiveErrors) {
    const n = Number.isInteger(consecutiveErrors) && consecutiveErrors > 0 ? consecutiveErrors : 0;
    if (!n) return baseMinutes;
    return Math.min(MAX_BACKOFF_MINUTES, baseMinutes * (2 ** Math.min(n, MAX_DOUBLINGS)));
}

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {object|null} schedule  `{ cron?, tz?, everyMinutes? }`
 * @param {number} [fromTs]
 * @param {object} [opts]
 * @param {number} [opts.consecutiveErrors=0]
 * @param {number} [opts.retryAfterMs=0]   a provider's own "come back in N ms"
 * @param {number} [opts.defaultMinutes=60] cadence when the schedule names none
 * @param {number} [opts.floorMinutes=0]    the fastest this kind may ever poll
 * @returns {string} ISO timestamp
 */
function nextRunFor(schedule, fromTs = Date.now(), {
    consecutiveErrors = 0,
    retryAfterMs = 0,
    defaultMinutes = 60,
    floorMinutes = 0,
} = {}) {
    const s = isPlainObject(schedule) ? schedule : null;
    const retryFloor = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? fromTs + retryAfterMs : 0;

    if (s && typeof s.cron === 'string' && s.cron && !consecutiveErrors) {
        try {
            const iso = require('../../automation/cron').nextRunAt(s.cron, s.tz || undefined, fromTs);
            if (iso) {
                return retryFloor && Date.parse(iso) < retryFloor
                    ? new Date(retryFloor).toISOString()
                    : iso;
            }
        } catch { /* an uncomputable cron falls through to the interval */ }
    }

    const base = Number.isInteger(s?.everyMinutes)
        ? Math.max(floorMinutes, s.everyMinutes)
        : defaultMinutes;
    const minutes = backoffMinutes(base, consecutiveErrors);
    return new Date(Math.max(fromTs + minutes * 60_000, retryFloor)).toISOString();
}

module.exports = { nextRunFor, backoffMinutes, MAX_BACKOFF_MINUTES, MAX_DOUBLINGS };

/**
 * The next moment of a repeating Cowork item (next to stores/coworkStore.js, whose advanceSchedule calls this).
 *
 * One step of the repeat is `advanceNextRun` (stores/aiTaskStore.js): the moment after the one that just ran. That is
 * not enough after downtime. A server that was off from Friday to Monday leaves an hourly item three days behind, and
 * one step at a time it then runs once every minute tick until it has caught up: seventy runs, seventy model calls
 * and seventy notifications for work nobody was waiting for.
 *
 * So the rule is: run once, then move to the first moment that is still ahead. The missed moments are skipped, not
 * replayed. A one-off (no repeat) has no next moment and answers null, as before.
 */

/** One step of a repeat: the moment after `current`, or null when the item does not repeat. */
export type AdvanceOnce = (
    current: string | number | Date,
    interval: string | null | undefined,
    daysOfWeek?: readonly string[] | null,
) => string | null;

/**
 * How many steps one catch-up may take. An hourly item that was off for five years stays under it; past it the item
 * is still behind, runs again on the next tick and catches up further, which is slow but never stuck.
 */
export const MAX_CATCH_UP_STEPS = 50_000;

/**
 * The first moment after `currentNextRun` that lies after `now`, or null for a one-off.
 *
 * `advance` is handed in so this file needs nothing from a store.
 */
export function nextRunAfter(
    currentNextRun: string | number | Date,
    interval: string | null | undefined,
    daysOfWeek: readonly string[] | null | undefined,
    advance: AdvanceOnce,
    now: Date = new Date(),
): string | null {
    const limit = now.getTime();
    let next = advance(currentNextRun, interval, daysOfWeek ?? null);
    for (let step = 0; next !== null && step < MAX_CATCH_UP_STEPS; step += 1) {
        const at = new Date(next).getTime();
        // An unreadable date ends the loop rather than spinning on NaN comparisons.
        if (!Number.isFinite(at) || at > limit) break;
        next = advance(next, interval, daysOfWeek ?? null);
    }
    return next;
}

/**
 * Memory, the first kind: "only what is new since last time". Every run of an item knows when its last good run
 * was, and is told to report only what is new since then.
 *
 *   - a plan reads it as trigger data: `{{trigger.output.since}}` (an ISO time; empty on the first run), for a search
 *     "newer than" it, and `{{trigger.output.now}}` (core/cowork/planRun.mts);
 *   - a prompt or an agent run gets one line in its instructions (core/aiTaskRunner.js).
 *
 * A good run is one that ended well, a run that waited for its owner's decision and then ended well included. It is
 * Bee Flow's own bookkeeping, never text from outside.
 */

interface ItemClock { lastRunAt?: string | null; lastStatus?: string | null }

/** When the last good run was, or null (none yet, or the last run did not end well). */
export function lastGoodRunAt(task: ItemClock): string | null {
    if (task.lastStatus !== 'success' || !task.lastRunAt) return null;
    const at = new Date(task.lastRunAt);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The trigger data of a plan run. */
export function sinceTriggerData(task: ItemClock, now: Date = new Date()): { since: string; now: string } {
    return { since: lastGoodRunAt(task) ?? '', now: now.toISOString() };
}

/** The line a prompt or an agent run is given; empty on a first run. */
export function sinceLine(task: ItemClock & { timezone?: string | null }): string {
    const since = lastGoodRunAt(task);
    if (!since) return '';
    let when = since;
    try {
        when = new Date(since).toLocaleString('en-GB', { timeZone: task.timezone || 'Europe/Amsterdam', dateStyle: 'full', timeStyle: 'short' });
    } catch { /* the ISO time stays */ }
    return `\n\n## Since last time\nThe last run that went well was ${when}. Report only what is new since then, and say so plainly when nothing is.`;
}

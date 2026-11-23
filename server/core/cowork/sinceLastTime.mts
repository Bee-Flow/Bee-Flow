/**
 * Memory, the first kind: "only what is new since last time". Every run of an item knows when its last good run
 * was, and is told to report only what is new since then.
 *
 *   - a plan reads it as trigger data: `{{trigger.output.since}}` (an ISO time; empty on the first run), for a search
 *     "newer than" it, and `{{trigger.output.now}}` (core/cowork/planRun.mts);
 *   - a prompt or an agent run gets one line in its instructions (core/aiTaskRunner.js).
 *
 * A good run is one that ended well (it succeeded, or it ended with something for its owner to review), a run that
 * waited for its owner's decision and then ended well included. "Since" is when that run STARTED: what arrived while
 * it ran was not in what it read, so the next run still sees it. A failed run in between moves nothing: the next run
 * reports everything since the last one that went well (stores/coworkStarts.mts reads it from the item's runs). It is
 * Bee Flow's own bookkeeping, never text from outside.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../../utils/bestEffort') as { fallback: <T>(label: string, err: unknown, value: T) => T };

interface ItemClock { id?: string | null }

export interface SinceDeps {
    /** When the item's last run that ended well started (ISO), or null. */
    lastGoodRunStart: (scheduleId: string) => Promise<string | null>;
}

const defaults = (): SinceDeps => ({
    lastGoodRunStart: (id) => (nodeRequire('../../stores/coworkStarts.mts') as typeof import('../../stores/coworkStarts.mts')).coworkStarts().lastGoodRunStart(id),
});

/**
 * When the last good run started, or null (none yet). A read that fails gives null: the run then reports all it
 * finds, which is more than asked but never less.
 */
export async function lastGoodRunAt(task: ItemClock, deps: SinceDeps = defaults()): Promise<string | null> {
    if (!task.id) return null;
    let started: string | null;
    try {
        started = await deps.lastGoodRunStart(task.id);
    } catch (err) {
        started = fallback('core/cowork/sinceLastTime:lastGoodRunAt', err, null);
    }
    if (!started) return null;
    const at = new Date(started);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The trigger data of a plan run. */
export async function sinceTriggerData(task: ItemClock, now: Date = new Date(), deps?: SinceDeps): Promise<{ since: string; now: string }> {
    return { since: (await lastGoodRunAt(task, deps)) ?? '', now: now.toISOString() };
}

/** The line a prompt or an agent run is given; empty on a first run. */
export async function sinceLine(task: ItemClock & { timezone?: string | null }, deps?: SinceDeps): Promise<string> {
    const since = await lastGoodRunAt(task, deps);
    if (!since) return '';
    let when = since;
    try {
        when = new Date(since).toLocaleString('en-GB', { timeZone: task.timezone || 'Europe/Amsterdam', dateStyle: 'full', timeStyle: 'short' });
    } catch { /* the ISO time stays */ }
    return `\n\n## Since last time\nThe last run that went well started ${when}. Report only what is new since then, and say so plainly when nothing is.`;
}

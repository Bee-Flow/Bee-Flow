import { WATCHER_MAX_RUNS_PER_MINUTE } from '@shared/appDefinition/clientTriggers.mjs';

/**
 * The bookkeeping of one watcher (definition.watchers, schema 3), apart from React so it can
 * be tested with a plain clock: what value it saw last, when it ran, whether it is still on.
 *
 *   observe(value, now) → 'baseline' | 'same' | 'changed'
 *       The first defined value is only remembered. A value that differs from the last one
 *       is a change. undefined → a value is not a change: a formula over data that is still
 *       loading reads undefined first, and the arrival of the data is not something the
 *       person did.
 *   allowRun(now) → boolean
 *       Counts a run. More than WATCHER_MAX_RUNS_PER_MINUTE runs inside one minute switch
 *       the watcher off for the rest of the visit (a watcher whose action changes the value
 *       it watches would otherwise loop for ever); it answers false from then on.
 */

const WINDOW_MS = 60_000;
/** Values longer than this as JSON are compared by identity only (a huge record list). */
const MAX_COMPARE_CHARS = 100_000;

export type Observation = 'baseline' | 'same' | 'changed';

/** A comparable form of a formula result. */
function fingerprint(value: unknown): unknown {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    try {
        const text = JSON.stringify(value);
        return text.length > MAX_COMPARE_CHARS ? value : `json:${text}`;
    } catch {
        return value;
    }
}

export class WatcherState {
    private last: unknown = undefined;
    private seen = false;
    private runs: number[] = [];
    disabled = false;

    observe(value: unknown): Observation {
        const print = fingerprint(value);
        if (!this.seen || this.last === undefined) {
            this.last = print;
            this.seen = print !== undefined;
            return 'baseline';
        }
        if (Object.is(print, this.last)) return 'same';
        this.last = print;
        return 'changed';
    }

    allowRun(now: number): boolean {
        if (this.disabled) return false;
        this.runs = this.runs.filter((t) => now - t < WINDOW_MS);
        if (this.runs.length >= WATCHER_MAX_RUNS_PER_MINUTE) {
            this.disabled = true;
            return false;
        }
        this.runs.push(now);
        return true;
    }
}

/**
 * The time limit of one Cowork run.
 *
 * A run had none. The reaper (stores/coworkStore.js reapStaleRuns) closes a history row that has been open for thirty
 * minutes, but it only writes the row: the model loop behind it keeps going, keeps calling tools and keeps spending,
 * while the schedule is already free to start the next run on top of it.
 *
 * So every run carries a deadline. When it passes, the signal aborts: the model call in flight is cancelled (the
 * provider adapters and the agent runtime both take the signal), no further round or tool call starts, and the run
 * closes as failed with a sentence the owner can read. The limit is COWORK_RUN_MAX_MINUTES (default 20), below the
 * reaper's window so the reaper stays what it was meant to be: the backstop for a server that stopped.
 */

import { envInt } from '../../utils/envNumber.mts';

/** Minutes one run may take: 1 minute to 4 hours. */
export const RUN_MAX_MINUTES_ENV = 'COWORK_RUN_MAX_MINUTES';
const DEFAULT_MAX_MINUTES = 20;

export function runMaxMs(): number {
    return envInt(RUN_MAX_MINUTES_ENV, DEFAULT_MAX_MINUTES, { min: 1, max: 240 }) * 60_000;
}

/** The error a run fails with once its deadline passed. */
export class RunDeadlineError extends Error {
    readonly minutes: number;

    constructor(maxMs: number) {
        const minutes = Math.max(1, Math.round(maxMs / 60_000));
        super(`This run was stopped after ${minutes} minute${minutes === 1 ? '' : 's'}: it took longer than a run may take.`);
        this.name = 'RunDeadlineError';
        this.minutes = minutes;
    }
}

export interface RunDeadline {
    /** Aborts when the deadline passes. Hand it to the model call and the agent runtime. */
    readonly signal: AbortSignal;
    /** Has the deadline passed? */
    expired(): boolean;
    /** Throw the deadline error when it passed: called before each model round and each tool call. */
    check(): void;
    /** What a run that failed after the deadline failed with: the deadline error, else the error itself. */
    reasonFor(err: unknown): unknown;
    /** Call the timer off (every exit of a run). */
    clear(): void;
}

/** Start the deadline of one run. `maxMs` is for tests; a run takes the configured limit. */
export function startRunDeadline(maxMs: number = runMaxMs()): RunDeadline {
    const controller = new AbortController();
    const error = new RunDeadlineError(maxMs);
    const timer = setTimeout(() => controller.abort(error), maxMs);
    // A deadline never keeps the process alive on its own.
    timer.unref?.();
    return {
        signal: controller.signal,
        expired: () => controller.signal.aborted,
        check() {
            if (controller.signal.aborted) throw error;
        },
        // An aborted model call surfaces as the SDK's own abort error ("Request was aborted",
        // "Client disconnected..."): the owner should read why it stopped, not how.
        reasonFor: (err) => (controller.signal.aborted ? error : err),
        clear: () => clearTimeout(timer),
    };
}

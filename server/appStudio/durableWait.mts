/**
 * The `wait` step in a run on the server (componentSpecs/steps/wait.js).
 *
 * The browser holds a short wait itself. A run on the server (runOn: 'server', background: true)
 * holds up to INLINE_WAIT_MS in the run, in slices so a cancel or a shutdown is seen within a
 * second; anything longer, and every wait whose moment is more than that away, puts the run on
 * hold (runPause.pauseUntil) and the wake job continues it then. A moment in the past does not
 * wait. Pure apart from the sleep and the clock the host hands in.
 */

import { pauseUntil } from './runPause.mts';
import type { Obj, StepResult } from './sequenceWalkTypes.mts';

/** The longest wait a server run holds in the process (the design's "server inline ≤ 60 s"); longer waits go on hold. */
export const INLINE_WAIT_MS = 60_000;
const SLICE_MS = 1000;

export type WaitHost = {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** True when the run has to stop (a cancel, a shutdown): an inline wait ends early. */
    stopped: () => boolean;
    /** The value of the step's `until` binding in the run's scope. */
    resolveUntil: (binding: unknown) => Promise<unknown>;
};

const fail = (error: string, code: string): StepResult => ({ ok: false, error, code, retryable: false });

/** A moment as epoch ms: a number, a Date or a date-time text. Null when it is none. */
export function momentOf(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? ms : null;
}

/** When the step's wait ends (epoch ms), or a failure when the step names no moment it can read. */
async function targetOf(step: Obj, host: WaitHost): Promise<number | StepResult> {
    if (step.until !== undefined && step.until !== null) {
        let raw: unknown;
        try {
            raw = await host.resolveUntil(step.until);
        } catch (e) {
            return fail((e as Error)?.message || 'The moment to wait until could not be read', 'wait_until_invalid');
        }
        const at = momentOf(raw);
        return at === null ? fail('The moment to wait until is not a date and time', 'wait_until_invalid') : at;
    }
    const seconds = Math.trunc(Number(step.seconds));
    if (!Number.isFinite(seconds) || seconds < 1) return fail('The wait says neither how many seconds nor until when', 'wait_invalid');
    return host.now() + seconds * 1000;
}

/** Run one `wait` step of a server run. */
export async function runServerWait(step: Obj, host: WaitHost): Promise<StepResult> {
    const target = await targetOf(step, host);
    if (typeof target !== 'number') return target;
    let left = target - host.now();
    if (left <= 0) return { ok: true, result: null };
    if (left > INLINE_WAIT_MS) return pauseUntil(target, { result: null });
    // Bounded by slices too: a clock that does not move (a test's) cannot hold the run forever.
    for (let slices = Math.ceil(left / SLICE_MS); left > 0 && slices > 0 && !host.stopped(); slices -= 1) {
        await host.sleep(Math.min(SLICE_MS, left));
        left = target - host.now();
    }
    return { ok: true, result: null };
}

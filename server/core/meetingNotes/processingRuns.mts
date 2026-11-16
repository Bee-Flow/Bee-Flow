/**
 * The meeting-notes runs THIS process is working on (upload and reprocess).
 *
 * Two jobs:
 *
 *   - A heartbeat on a timer. One phase may wait for hours (pyannote polls up
 *     to 2 h, Azure up to 4 h), so beats between the phases alone cannot tell a
 *     dead run from a slow one. Beating every minute, whatever the pipeline is
 *     waiting on, lets the reaper's threshold (and the takeover of a silent
 *     claim in claimForProcessing) sit at minutes.
 *
 *   - A list for the shutdown. A pod that is stopped (a deploy, the cluster
 *     autoscaler) has a short grace period and the run dies with it. On SIGTERM
 *     boot/lifecycle.js calls failInFlight(), which marks these notes failed at
 *     once, so the user sees Retry instead of a spinner.
 *
 * The heartbeat stops after MAX_HEARTBEAT_MS: a pipeline that hangs forever
 * inside a live process must still reach the reaper one day.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const HEARTBEAT_MS = 60_000;
/** Above the longest engine wait (Azure, 4 h) plus the LLM passes. */
export const MAX_HEARTBEAT_MS = 6 * 60 * 60_000;

export interface RunStore {
    heartbeatProcessing(id: string): Promise<boolean>;
    failInterruptedRuns(ids: string[]): Promise<number>;
}

interface TrackOptions {
    intervalMs?: number;
    maxMs?: number;
    store?: RunStore;
    now?: () => number;
}

const inFlight = new Set<string>();

function defaultStore(): RunStore {
    return nodeRequire('../../stores/transcriptionStore') as RunStore;
}

function bestEffort(where: string, err: unknown): void {
    (nodeRequire('../../utils/bestEffort') as { bestEffort: (w: string, e: unknown) => void }).bestEffort(where, err);
}

/**
 * Start tracking a run that holds `id` in 'processing'. Returns the stop
 * function; call it in a `finally`. Calling it twice is harmless.
 */
export function trackProcessing(id: string, { intervalMs = HEARTBEAT_MS, maxMs = MAX_HEARTBEAT_MS, store, now = Date.now }: TrackOptions = {}): () => void {
    if (!id) return () => {};
    inFlight.add(id);
    const startedAt = now();
    const timer = setInterval(() => {
        if (now() - startedAt > maxMs) {
            clearInterval(timer);
            return;
        }
        (store || defaultStore()).heartbeatProcessing(id)
            .then((held) => {
                // The note left processing (finished, reaped, deleted): nothing to keep alive.
                if (!held) clearInterval(timer);
            })
            .catch((err: unknown) => bestEffort('core/meetingNotes/processingRuns:heartbeat', err));
    }, intervalMs);
    timer.unref();
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        inFlight.delete(id);
    };
}

/** The notes this process is processing right now. */
export function inFlightIds(): string[] {
    return [...inFlight];
}

/**
 * Mark every run of this process failed (the reaper's reason), bounded by
 * `timeoutMs` so a slow database cannot hold the shutdown. Returns how many
 * notes were marked; 0 without a database call when nothing is in flight.
 */
export async function failInFlight({ timeoutMs = 5000, store }: { timeoutMs?: number; store?: RunStore } = {}): Promise<number> {
    const ids = inFlightIds();
    if (!ids.length) return 0;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<number>((resolve) => { timer = setTimeout(() => resolve(0), timeoutMs); timer.unref(); });
    try {
        return await Promise.race([(store || defaultStore()).failInterruptedRuns(ids), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

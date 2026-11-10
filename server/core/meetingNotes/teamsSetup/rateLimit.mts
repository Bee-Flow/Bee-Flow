/**
 * One diagnostics run per user per TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS
 * (default 10, 0 = no limit). A run makes several Graph calls and one Entra
 * token request, so a click held down must not become a burst.
 *
 * In-process: each replica counts its own runs, so the real ceiling is one run
 * per interval per replica. That is enough for a brake on a button; it is not
 * a quota. The map is bounded: when it grows past MAX_TRACKED, entries older
 * than the interval are dropped, and if that is not enough the oldest go.
 */

import { minIntervalSeconds } from './limits.mts';

const MAX_TRACKED = 10_000;
const lastRun = new Map<string, number>();

function prune(now: number, intervalMs: number): void {
    for (const [key, at] of lastRun) {
        if (now - at >= intervalMs) lastRun.delete(key);
    }
    while (lastRun.size >= MAX_TRACKED) {
        const oldest = lastRun.keys().next().value;
        if (oldest === undefined) break;
        lastRun.delete(oldest);
    }
}

/**
 * True (and the slot taken) when `key` may run now; false while its last run
 * is less than the interval ago. Callers pass the user id, prefixed when one
 * user has two independent tests.
 */
export function takeDiagnosticsSlot(key: string, now: number = Date.now()): boolean {
    const intervalMs = minIntervalSeconds() * 1000;
    if (intervalMs <= 0) return true;
    const last = lastRun.get(key);
    if (last !== undefined && now - last < intervalMs) return false;
    if (lastRun.size >= MAX_TRACKED) prune(now, intervalMs);
    lastRun.delete(key);
    lastRun.set(key, now);
    return true;
}

/** Tests only: forget every run. */
export function resetDiagnosticsSlots(): void {
    lastRun.clear();
}

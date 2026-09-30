/**
 * Times and durations as a run screen reads them. absoluteTime mirrors
 * agent-hub's formatNextRun, so a schedule reads the same on both clients.
 */

import { formatMoment } from '@/core/i18n';

/**
 * "Today at 09:00", "Tomorrow at 09:00", "Yesterday at 09:00", "12 Mar at
 * 09:00" — the shape agent-hub's formatNextRun uses, so a schedule reads the
 * same on both clients. Past times are phrased as such rather than silently
 * looking future. The words, the clock and the date are the app's language
 * (core/i18n `formatMoment`), not English around the phone's clock.
 */
export function absoluteTime(iso: string | null | undefined): string {
    return formatMoment(iso);
}

/**
 * "400ms", "9.5s", "12s", "3m 04s", "1h 12m". Null durations read as an em
 * dash. (This line used to claim 400ms rendered as "0.4s"; it never has —
 * anything under a second is reported in milliseconds. The test pins it.)
 *
 * NOT the shared helper. features/recording/model/format.ts has a function of the
 * same name that the de-duplication pass deliberately kept separate: it takes
 * SECONDS and renders a clock ("1:05:30") for media positions, where this one
 * takes MILLISECONDS and renders a spoken elapsed for how long a run took.
 * Neither generalises to the other — a clock cannot say "0.4s", and a spoken
 * elapsed cannot be a transcript timecode.
 *
 * The unit is the trap: both are `(number | null | undefined) => string`, so
 * importing the wrong one type-checks and silently renders a 90-second
 * recording as "90ms". Import it from the feature whose screen you are on.
 */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    const total = Math.round(ms / 1000);
    if (total < 60) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Elapsed time of a run, whether or not it has finished.
 *
 * `durationMs` is only written when the run settles, so a running row would
 * otherwise show "—" for as long as it is interesting.
 */
export function runElapsedMs(run: {
    durationMs: number | null;
    startedAt: string | null;
    finishedAt: string | null;
}): number | null {
    if (typeof run.durationMs === 'number') return run.durationMs;
    if (!run.startedAt) return null;
    const start = new Date(run.startedAt).getTime();
    if (Number.isNaN(start)) return null;
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    return Math.max(0, end - start);
}

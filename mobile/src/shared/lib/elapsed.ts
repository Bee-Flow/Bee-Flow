/**
 * How long something has been going, as the web's builders print it — a port
 * of agent-hub/src/components/shared/builder/formatElapsed.js ("42s",
 * "3m 5s", "1h 12m"), pinned by elapsed.test.ts.
 *
 * Not features/automations' formatDuration, which rounds to tenths of a
 * second for a finished run's cost; this one counts whole seconds up from a
 * start, the way a running phase's clock ticks.
 */

/** Whole elapsed seconds as the web's words. */
export function formatSeconds(seconds: number): string {
    const secs = Math.max(0, Math.floor(seconds));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Elapsed since `startedAt` (anything Date.parse reads), or null without a start. */
export function formatElapsed(startedAt: string | null | undefined, now = Date.now()): string | null {
    const start = Date.parse(startedAt || '');
    if (!Number.isFinite(start)) return null;
    return formatSeconds((now - start) / 1000);
}

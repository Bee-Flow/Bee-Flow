/**
 * "12m 33s" — the builders' elapsed format. Seconds under a minute, m+s under
 * an hour, h+m above it; never a bare "0s" from an unparsable start. Shared by
 * the automation canvas (runFocus) and the App Studio build banner.
 */
export function formatElapsed(startedAt, now = Date.now()) {
    const start = Date.parse(startedAt || '');
    if (!Number.isFinite(start)) return null;
    const secs = Math.max(0, Math.floor((now - start) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

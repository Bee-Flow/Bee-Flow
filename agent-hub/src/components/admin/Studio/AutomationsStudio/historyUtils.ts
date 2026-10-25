/**
 * Small formatting + bucketing helpers shared by the History tab pieces
 * (HistoryTab / HistoryRow / RunDetailDrawer). Kept feature-local rather
 * than promoted to a global util — these mirror the existing
 * HistoryTab.formatRelative and RunTabContainer.formatDuration so the feed
 * and the run-detail drawer format times/durations identically.
 */

/** "just now" / "26m ago" / "7h ago" / "3d ago" / locale date for older. */
export function formatRelative(iso: string): string {
    try {
        const t = new Date(iso).getTime();
        const diff = Date.now() - t;
        const m = Math.round(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.round(h / 24);
        if (d < 7) return `${d}d ago`;
        return new Date(iso).toLocaleDateString();
    } catch {
        return iso || '—';
    }
}

/** "120ms" / "1.2s" / "2m 5s". */
export function formatDuration(ms: number | null | undefined): string | null {
    if (ms == null || Number.isNaN(ms)) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
}

/**
 * Future-facing countdown for an awaiting-approval deadline.
 * Returns "expired" once past, else "expires in 5m" / "expires in 2h".
 */
export function formatExpiry(iso: string | number | Date): string | null {
    try {
        const diff = new Date(iso).getTime() - Date.now();
        if (diff <= 0) return 'approval expired';
        const m = Math.round(diff / 60000);
        if (m < 60) return `expires in ${m}m`;
        const h = Math.round(m / 60);
        if (h < 24) return `expires in ${h}h`;
        const d = Math.round(h / 24);
        return `expires in ${d}d`;
    } catch {
        return null;
    }
}

/** Today / Yesterday / Earlier bucket label for a run's start time. */
export function dayBucketLabel(iso: string | number | Date): string {
    try {
        const d = new Date(iso);
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startOfRun = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const dayMs = 86_400_000;
        if (startOfRun >= startOfToday) return 'Today';
        if (startOfRun >= startOfToday - dayMs) return 'Yesterday';
        return 'Earlier';
    } catch {
        return 'Earlier';
    }
}

/** Which filter bucket a run belongs to (matches the HistoryFilters chips). */
function matchesFilter(run: { status?: string; mode?: string }, filter: string): boolean {
    switch (filter) {
        case 'all': return true;
        case 'error': return run.status === 'error';
        case 'running': return run.status === 'running' || run.status === 'queued';
        case 'awaiting': return run.status === 'awaiting_approval' || run.status === 'awaiting_confirm';
        case 'dry_run': return run.mode === 'dry_run';
        default: return true;
    }
}

/** Whether a run started within the last `hours` hours. */
function startedWithinHours(run: { startedAt?: string | null }, hours: number): boolean {
    if (!run.startedAt) return false;
    const t = Date.parse(run.startedAt);
    if (Number.isNaN(t)) return false;
    return t >= Date.now() - hours * 3600 * 1000;
}

/**
 * Absolute timestamp in the APP locale (the product auto-selects nl/de/fr) —
 * for title attributes behind relative times, so "3h ago" can always be
 * pinned down to a real clock time.
 */
export function absoluteTime(iso?: string | number | Date | null, locale: string | undefined = undefined): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleString(locale, {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
    } catch {
        return String(iso);
    }
}

/** Just the clock time, locale-aware — for dense per-day listings. */
function shortClock(iso?: string | number | Date | null, locale: string | undefined = undefined): string {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return String(iso);
    }
}

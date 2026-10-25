/**
 * The parts of the vertical timeline: the numbered dot, the connecting line
 * and the duration pill.
 *
 * They stood as markup in `ToolsUsedTimeline`. The trail panel (A4 part C)
 * shows the same kind of list, steps one under another with the duration beside
 * them, and it must look the same. Two lists that stand next to each other in the
 * builder but do NOT share the same dots and pills read as two different kinds of
 * evidence, while it is one stream.
 *
 * Hence they live here, copied literally, and both use them.
 *
 * `formatDurationMs` is the only one that decides anything: under a second in
 * whole milliseconds, above that to one decimal. That choice was hidden in a
 * ternary in `ToolsUsedTimeline`, and the heading of the trail panel ("· 1.8 s")
 * must use exactly the same rounding, otherwise 1.8 s stands above a row that
 * says 1750 ms.
 */


/**
 * `1750` → `'1.8s'`, `840` → `'840ms'`, anything that is not a number → null.
 *
 * Negative durations do not exist. A clock that ran backwards is not a
 * measurement, so it comes out as null rather than as '-3ms'.
 */
function formatDurationMs(ms: number) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The numbered dot to the left of a step. */
interface StepBadgeProps {
    n: number;
    muted?: boolean;
}

export function StepBadge({ n, muted = false }: StepBadgeProps) {
    return (
        <div className="flex-shrink-0 w-5.5 h-5.5 mt-0.5 z-10 relative">
            <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{
                    background: 'var(--bg-secondary)',
                    border: muted ? '1.5px dashed var(--border-subtle)' : '1.5px solid var(--border-subtle)',
                    color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                }}
            >
                {n}
            </div>
        </div>
    );
}

/**
 * The vertical line behind the dots. It belongs in a `relative` parent and only
 * appears with two or more steps. One dot with a line attached suggests a step
 * that is not there.
 */
interface TimelineRailProps {
    show?: boolean;
}

export function TimelineRail({ show = true }: TimelineRailProps) {
    if (!show) return null;
    return (
        <div
            className="absolute left-[11px] top-4 bottom-4 w-px bg-[var(--border-subtle)]"
            aria-hidden="true"
        />
    );
}

/** The duration on the right of a row. No measurement means no pill. */
interface DurationPillProps {
    ms: number | null;
    title?: string;
}

export function DurationPill({ ms, title }: DurationPillProps) {
    const label = formatDurationMs(ms as number);
    if (!label) return null;
    return (
        <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
            data-testid="duration-pill"
            title={title}
        >
            {label}
        </span>
    );
}

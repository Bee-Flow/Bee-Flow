import React from 'react';
import { SEGMENT } from './curriculum';

/**
 * SegmentedProgress — THE one progress idiom of the redesigned Learning
 * Center (handoff artboard 1a, point 4): a row of equal segments where a
 * segment is a lesson, a course or a level, painted
 *
 *   gold    = mastered      (--learn-mastered)
 *   green   = complete      (--learn-complete)
 *   grey    = open          (--bg-tertiary)
 *   dashed  = locked        (1px dashed --text-tertiary, no fill)
 *
 * Rings, percentage bars and "1 of 9" chips all fold into this. `segments`
 * is an array of SEGMENT values; `width` is the fixed pixel width the
 * artboard gives each context (60 on a course card, 36 in the rail, 28 in a
 * column header, 30 in the course header chip) — omit it to let the bar
 * fill its container.
 */
const FILL = {
    [SEGMENT.MASTERED]: { background: 'var(--learn-mastered)' },
    [SEGMENT.COMPLETE]: { background: 'var(--learn-complete)' },
    [SEGMENT.OPEN]: { background: 'var(--bg-tertiary)' },
    [SEGMENT.LOCKED]: { border: '1px dashed var(--text-tertiary)', boxSizing: 'border-box' },
};

export default function SegmentedProgress({ segments, width, height = 4, gap = 2, radius = 1, className = '', title }) {
    const list = Array.isArray(segments) ? segments : [];
    if (!list.length) return null;
    return (
        <span
            className={`inline-flex flex-shrink-0 ${className}`.trim()}
            style={{ gap, width: width ?? '100%' }}
            role="img"
            aria-label={title}
            title={title}
            data-testid="segmented-progress"
        >
            {list.map((seg, i) => (
                <span key={i} data-segment={seg} style={{ flex: 1, height, borderRadius: radius, ...(FILL[seg] || FILL[SEGMENT.OPEN]) }} />
            ))}
        </span>
    );
}

/** n segments of one state — for "lessons still locked" bars where nothing is known yet. */
export function repeatSegments(n, state = SEGMENT.OPEN) {
    return Array.from({ length: Math.max(0, n | 0) }, () => state);
}

/** done-of-total as a simple complete/open bar (certificates, capstone course count). */
export function countSegments(done, total, doneState = SEGMENT.COMPLETE) {
    const t = Math.max(0, total | 0);
    const d = Math.max(0, Math.min(t, done | 0));
    return Array.from({ length: t }, (_, i) => (i < d ? doneState : SEGMENT.OPEN));
}

// A thin bar made of coloured parts, each a percentage of the track. The
// widths are data, so they are set on the element through its ref (no
// inline style object), the way shell/SegmentBar does it.

import { paint } from '../shell';

export interface BarPart {
    /** 0..100 of the track. */
    pct: number;
    /** A theme variable such as `var(--text-primary)`. */
    color: string;
}

interface ShareBarProps {
    parts: BarPart[];
    /** Track height in px; 6 by default. */
    height?: number;
    /** Track width cap in px. */
    maxWidth?: number;
}

export function ShareBar({ parts, height = 6, maxWidth }: ShareBarProps) {
    return (
        <span
            aria-hidden="true"
            ref={el => paint(el, { height: `${height}px`, ...(maxWidth ? { 'max-width': `${maxWidth}px` } : {}) })}
            className="flex w-full gap-px overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
        >
            {parts.map((p, i) => (
                <span key={i} ref={el => paint(el, { width: `${Math.max(0, Math.min(100, p.pct))}%`, 'background-color': p.color })} className="block h-full" />
            ))}
        </span>
    );
}

/** Input and output tokens read the same way everywhere on the page. */
export const IN_COLOR = 'var(--text-primary)';
export const OUT_COLOR = 'var(--text-tertiary)';

/** The in/out split of a row as bar parts, scaled to `sharePct` of the track. */
export function inOutParts(inCost: number, outCost: number, sharePct: number): BarPart[] {
    const total = inCost + outCost;
    if (total <= 0) return [];
    return [
        { pct: (inCost / total) * sharePct, color: IN_COLOR },
        { pct: (outCost / total) * sharePct, color: OUT_COLOR },
    ];
}

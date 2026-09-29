/**
 * The pane's small data-driven shapes, drawn in SVG.
 *
 * Every size here comes from data, and SVG takes it as an ATTRIBUTE (width,
 * height, x, fill) — so none of these needs an inline style object, which a
 * flex bar sized from data would. `preserveAspectRatio="none"` lets one
 * viewBox stretch to whatever width the card gives it.
 */

import React from 'react';

export interface Segment {
    key: string;
    value: number;
    fill: string;
    /** Drawn faded (another segment is the selected one). */
    dim?: boolean;
    /** A hairline outline, for a fill too quiet to see on its own. */
    outline?: boolean;
}

/** Outline attributes for a quiet segment; the stroke keeps its width however the SVG stretches. */
export const OUTLINE = { stroke: 'var(--border-default)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' } as const;

const W = 1000;

/**
 * A horizontal stacked bar: each segment's width is its share of the total,
 * with a hairline gap between segments. Empty segments take no room.
 */
export function SegmentBar({ segments, height, gap = 3, className = '' }: {
    segments: Segment[];
    height: number;
    /** In viewBox units of a 1000-wide bar. */
    gap?: number;
    className?: string;
}) {
    const shown = segments.filter(s => s.value > 0);
    const total = shown.reduce((n, s) => n + s.value, 0);
    const room = W - gap * Math.max(0, shown.length - 1);
    let x = 0;
    return (
        <svg
            aria-hidden="true"
            width="100%"
            height={height}
            viewBox={`0 0 ${W} ${height}`}
            preserveAspectRatio="none"
            className={`block ${className}`}
        >
            {total === 0 && <rect x={0} y={0} width={W} height={height} fill="var(--bg-tertiary)" />}
            {shown.map(s => {
                const w = (room * s.value) / total;
                const rect = <rect key={s.key} x={x} y={0} width={w} height={height} fill={s.fill} opacity={s.dim ? 0.3 : 1} {...(s.outline ? OUTLINE : {})} />;
                x += w + gap;
                return rect;
            })}
        </svg>
    );
}

/** A row of tiny bars, one per day, for a KPI card. */
export function Sparkline({ values, fill, selected = null, height = 22 }: {
    values: number[];
    fill: string;
    /** Index of the selected day; the others are drawn faded. */
    selected?: number | null;
    height?: number;
}) {
    const max = Math.max(1, ...values);
    const step = 10;
    return (
        <svg
            aria-hidden="true"
            width="100%"
            height={height}
            viewBox={`0 0 ${Math.max(1, values.length) * step} ${height}`}
            preserveAspectRatio="none"
            className="block"
        >
            {values.map((v, i) => {
                const h = Math.max(2, Math.round((height * v) / max));
                const faded = selected !== null && selected !== i;
                return (
                    <rect
                        key={i}
                        x={i * step + 1.5}
                        y={height - h}
                        width={step - 3}
                        height={h}
                        rx={1}
                        fill={v ? fill : 'var(--bg-tertiary)'}
                        opacity={faded ? 0.35 : 1}
                    />
                );
            })}
        </svg>
    );
}

/** A thin share bar under a ranked row. */
export function RankBar({ share, active }: { share: number; active: boolean }) {
    const pct = Math.max(0, Math.min(1, share)) * 100;
    return (
        <svg aria-hidden="true" width="100%" height={4} className="block">
            <rect x={0} y={0} width="100%" height={4} rx={2} fill="var(--bg-secondary)" />
            {pct > 0 && <rect x={0} y={0} width={`${pct}%`} height={4} rx={2} fill={active ? 'var(--info-ink)' : 'var(--text-secondary)'} />}
        </svg>
    );
}
